/**
 * Differential filter probe.
 *
 * A filter that silently does nothing is indistinguishable from a filter that
 * works, if you only look at one response. So for each filter we fetch the
 * report BOTH ways — unfiltered and filtered — and compare: if the filtered
 * and unfiltered totals are identical, the parameter was almost certainly
 * ignored by QuickBooks (it does NOT error on an unrecognized report
 * parameter; it just returns the full unfiltered report).
 *
 * Covers two filter families:
 *   - `class` / `classid` on ProfitAndLoss, ProfitAndLossDetail, TransactionList
 *   - `account` on ProfitAndLossDetail, TransactionList
 *
 * The `account` coverage exists because Intuit already demonstrates the same
 * inconsistency with `class` vs `classid` — `account` could just as easily
 * turn out to be `accountid` on one of the two reports that accept it, and no
 * unit test can catch that (the bug is in what Intuit's API accepts, not in
 * what this fork sends).
 *
 * Run:
 *   QBO_ACCESS_TOKEN=... QBO_REALM_ID=... QBO_ENV=sandbox \
 *     npx tsx scripts/verify-report-filters.ts
 *
 * Optional:
 *   PROBE_START=YYYY-MM-DD PROBE_END=YYYY-MM-DD   (default: current calendar year)
 *
 * Exit codes:
 *   0  every filter that could be tested narrowed its report — PASS
 *   1  at least one endpoint name doesn't resolve, OR at least one filter
 *      parameter was proven to be IGNORED — fix src/domains/reports.ts
 *   3  no filter was proven wrong, but the realm didn't have enough data
 *      (fewer than 2 classes, or fewer than 2 active accounts on a given
 *      report) to prove the ones that were skipped — INCOMPLETE, not a pass
 */

// getClient() builds an env-mode client straight from QBO_ACCESS_TOKEN /
// QBO_REALM_ID / QBO_ENV — there is no separate initialiser to call.
import { getClient } from "../src/utils/client.js";
import { flattenReport } from "../src/domains/report-rows.js";
import { escapeQboString } from "../src/utils/qbo-sql.js";

type Client = ReturnType<typeof getClient>;

const START = process.env.PROBE_START ?? "2026-01-01";
const END = process.env.PROBE_END ?? "2026-12-31";

interface ResultRow {
  report: string;
  param: string;
  same: boolean;
}

interface CheckSpec {
  report: string;
  param: string;
  path: string;
}

/** QBO puts the grand total in the last summary row; fall back to a crude
 * fingerprint so a structural difference still registers. */
function total(report: unknown): string {
  const r = report as any;
  const rows = r?.Rows?.Row ?? [];
  const last = rows[rows.length - 1];
  const summary = last?.Summary?.ColData;
  if (Array.isArray(summary)) return summary.map((c: any) => c?.value ?? "").join("|");
  return JSON.stringify(report).length.toString();
}

/**
 * The spec requires endpoint spellings be verified live, not assumed: Wyre maps
 * `GeneralLedger` while node-quickbooks exposes `GeneralLedgerDetail`, so at
 * least one QBO report has two variants and a wrong name is a 4xx, not a
 * silent pass. Check every endpoint this fork introduces before testing filters.
 */
async function verifyEndpoints(client: Client): Promise<boolean> {
  const endpoints = [
    "reports/ProfitAndLossDetail",
    "reports/TransactionList",
    "reports/AgedReceivableDetail",
    "reports/ClassSales",
    "reports/JournalReport",
  ];

  let allOk = true;
  for (const path of endpoints) {
    try {
      await client.get(path, { start_date: START, end_date: END });
      console.log(`RESOLVES ✅  ${path}`);
    } catch (e: any) {
      allOk = false;
      console.log(`BAD NAME ❌  ${path} — ${e?.message ?? e}`);
    }
  }
  console.log("");
  return allOk;
}

const classChecks: CheckSpec[] = [
  { report: "ProfitAndLoss", param: "class", path: "reports/ProfitAndLoss" },
  { report: "ProfitAndLossDetail", param: "classid", path: "reports/ProfitAndLossDetail" },
  { report: "TransactionList", param: "class", path: "reports/TransactionList" },
];

/** Both reports this fork exposes an `account` filter on. */
const accountChecks: CheckSpec[] = [
  { report: "ProfitAndLossDetail", param: "account", path: "reports/ProfitAndLossDetail" },
  { report: "TransactionList", param: "account", path: "reports/TransactionList" },
];

async function runClassChecks(
  client: Client
): Promise<{ results: ResultRow[]; insufficient: string[] }> {
  const results: ResultRow[] = [];
  const insufficient: string[] = [];

  const classesResp = (await client.query("SELECT * FROM Class MAXRESULTS 5")) as any;
  const list = classesResp?.QueryResponse?.Class ?? [];
  if (list.length < 2) {
    insufficient.push(
      `Need at least 2 classes in this realm to prove a class filter narrows results ` +
        `(found ${list.length}). With only one class, a working filter and a broken one ` +
        `look identical — the single class already covers 100% of the data. Add a class in QuickBooks first.`
    );
    return { results, insufficient };
  }
  const classId = list[0].Id;
  console.log(`Probing class filters with class ${classId} (${list[0].Name}) of ${list.length} found\n`);

  for (const c of classChecks) {
    const base = { start_date: START, end_date: END };
    const unfiltered = await client.get(c.path, base);
    const filtered = await client.get(c.path, { ...base, [c.param]: classId });

    const same = total(unfiltered) === total(filtered);
    results.push({ report: c.report, param: c.param, same });
    console.log(
      `${same ? "IGNORED ❌" : "FILTERS ✅"}  ${c.report} via \`${c.param}\`` +
        (same ? "  <-- parameter had NO effect; the name is wrong" : "")
    );
  }

  return { results, insufficient };
}

/** Resolve an account's Id via a live query — never guess or reuse a cached id. */
async function resolveAccountId(client: Client, name: string): Promise<string | null> {
  const sql = `SELECT * FROM Account WHERE Name = '${escapeQboString(name)}' MAXRESULTS 1`;
  const res = (await client.query(sql)) as any;
  const list = res?.QueryResponse?.Account ?? [];
  return list[0]?.Id ?? null;
}

/**
 * For each report, fetch the unfiltered baseline, find the distinct accounts
 * that actually show activity IN THAT REPORT for the probe window (via the
 * "Account" column QBO already returns), and — same reasoning as the class
 * check — require at least 2 distinct accounts before trusting the result.
 * Picking an account that appears in the unfiltered report guarantees the
 * account has real activity in-window, rather than trusting an arbitrary row
 * from `SELECT * FROM Account` that might have zero transactions here.
 */
async function runAccountChecks(
  client: Client
): Promise<{ results: ResultRow[]; insufficient: string[] }> {
  const results: ResultRow[] = [];
  const insufficient: string[] = [];

  for (const c of accountChecks) {
    const base = { start_date: START, end_date: END };
    const unfiltered = await client.get(c.path, base);
    const flat = flattenReport(unfiltered);

    const names = new Set<string>();
    if (flat.columns.includes("Account")) {
      for (const row of flat.rows) {
        const v = row["Account"];
        if (v) names.add(v);
      }
    }
    const distinct = [...names];

    if (distinct.length < 2) {
      insufficient.push(
        `${c.report}: only ${distinct.length} distinct account(s) show activity between ${START} and ` +
          `${END} — cannot prove the \`${c.param}\` filter narrows results (same reasoning as the class ` +
          `check: with one active account, a working filter and a broken one return the same total). ` +
          `Widen PROBE_START/PROBE_END or pick a realm with more transaction variety.`
      );
      continue;
    }

    const accountName = distinct[0];
    const accountId = await resolveAccountId(client, accountName);
    if (!accountId) {
      insufficient.push(
        `${c.report}: account "${accountName}" appears in the report but did not resolve via ` +
          `SELECT * FROM Account WHERE Name = '...' — skipping (name may contain characters the ` +
          `report renders differently than QBO's Name field, e.g. a parent:sub display path).`
      );
      continue;
    }

    const filtered = await client.get(c.path, { ...base, [c.param]: accountId });
    const same = total(unfiltered) === total(filtered);
    results.push({ report: c.report, param: c.param, same });
    console.log(
      `${same ? "IGNORED ❌" : "FILTERS ✅"}  ${c.report} via \`${c.param}\` ` +
        `(account "${accountName}", id ${accountId})` +
        (same ? "  <-- parameter had NO effect; the name is wrong" : "")
    );
  }

  return { results, insufficient };
}

async function main() {
  const client = getClient();

  const endpointsOk = await verifyEndpoints(client);
  if (!endpointsOk) {
    console.error(
      "At least one endpoint name is wrong. Fix it in src/domains/reports.ts " +
        "before probing filters — a filter test against a non-existent report proves nothing."
    );
    process.exit(1);
  }

  console.log("=== Class filters ===\n");
  const classOutcome = await runClassChecks(client);

  console.log("\n=== Account filters ===\n");
  const accountOutcome = await runAccountChecks(client);

  const allResults = [...classOutcome.results, ...accountOutcome.results];
  const anyIgnored = allResults.some((r) => r.same);

  console.log(
    "\nIf a report shows FILTERS but returns zero rows, check the value shape " +
      "(IDs not names, comma-separated for multiples)."
  );

  const insufficient = [...classOutcome.insufficient, ...accountOutcome.insufficient];
  if (insufficient.length > 0) {
    console.log("\n=== Could not verify ===");
    for (const msg of insufficient) console.log(`SKIPPED ⚠️  ${msg}`);
    console.log(
      "\nAny SKIPPED line above is NOT a pass. Re-run with a realm/date-range that has enough data " +
        "to actually exercise that filter before trusting it."
    );
  }

  if (anyIgnored) {
    console.log(
      "\nRESULT: at least one filter parameter is WRONG — fix it in src/domains/reports.ts, " +
        "update the corresponding unit test's expectation, and re-run this probe."
    );
    process.exit(1);
  }
  if (insufficient.length > 0) {
    console.log(
      "\nRESULT: no filter was proven wrong, but not everything could be tested. INCOMPLETE — " +
        "do not record this as a pass for the skipped filter(s)."
    );
    process.exit(3);
  }
  console.log("\nRESULT: every tested filter narrowed its report. PASS.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
