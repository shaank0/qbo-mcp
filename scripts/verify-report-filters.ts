/**
 * Differential filter probe — the MANUAL escape hatch.
 *
 * The durable path is `src/__tests__/sandbox.integration.test.ts`, which runs
 * these same checks automatically in CI the moment the QBO_SANDBOX_* secrets
 * exist. This script is for running them by hand against an arbitrary realm
 * (notably PRODUCTION, which CI never touches) with an access token in hand.
 *
 * Both front ends share one implementation, `src/__tests__/report-filter-checks.ts`
 * — see that file for why any of this is necessary. The short version:
 * QuickBooks does not error on an unrecognised report parameter. It ignores it
 * and returns the full unfiltered report, which looks exactly as legitimate as
 * a correctly filtered one.
 *
 * What is checked, in order:
 *   0. Every report endpoint this fork introduces RESOLVES.
 *   1-3. Each filter NARROWS its report (filtered != unfiltered).
 *   4. Summing every leaf class's filtered total RECONCILES to the unfiltered
 *      total. Step 3 only proves the parameter did something; step 4 proves it
 *      did the right thing.
 *   5. Each `summarize_column_by` value the P&L schema advertises actually
 *      changes the report's columns.
 *
 * Run:
 *   QBO_ACCESS_TOKEN=... QBO_REALM_ID=... QBO_ENV=sandbox \
 *     npx tsx scripts/verify-report-filters.ts
 *
 * Optional:
 *   PROBE_START=YYYY-MM-DD PROBE_END=YYYY-MM-DD   (default: current calendar year)
 *   PROBE_TOLERANCE=0.01                          (reconciliation tolerance)
 *
 * Exit codes:
 *   0  every check that could be run passed — PASS
 *   1  an endpoint name doesn't resolve, a filter parameter was proven
 *      IGNORED, or a class reconciliation failed — fix src/domains/reports.ts
 *   3  nothing was proven wrong, but the realm didn't have enough data to
 *      prove everything — INCOMPLETE, not a pass
 */

// getClient() builds an env-mode client straight from QBO_ACCESS_TOKEN /
// QBO_REALM_ID / QBO_ENV — there is no separate initialiser to call.
import { getClient } from "../src/utils/client.js";
import { flattenReport } from "../src/domains/report-rows.js";
import { escapeQboString } from "../src/utils/qbo-sql.js";
import {
  ACCOUNT_CHECKS,
  CLASS_CHECKS,
  DEFAULT_TOLERANCE,
  FORK_REPORT_ENDPOINTS,
  SUMMARIZE_COLUMN_CHECKS,
  accountCandidates,
  columnSignature,
  countEntity,
  filterNarrows,
  leafClasses,
  listAllClasses,
  reconcileClassTotals,
  reconciliationAdvice,
  resolveAccountId,
  type DateWindow,
  type ProbeClient,
} from "../src/__tests__/report-filter-checks.js";

const WINDOW: DateWindow = {
  start_date: process.env.PROBE_START ?? "2026-01-01",
  end_date: process.env.PROBE_END ?? "2026-12-31",
};
const TOLERANCE = Number(process.env.PROBE_TOLERANCE ?? DEFAULT_TOLERANCE);

/** Anything proven WRONG. Any entry here is an exit-1 failure. */
const failures: string[] = [];
/** Anything that could not be proven either way. Never a pass; exit 3. */
const insufficient: string[] = [];

async function verifyEndpoints(client: ProbeClient): Promise<boolean> {
  let allOk = true;
  for (const path of FORK_REPORT_ENDPOINTS) {
    try {
      await client.get(path, { ...WINDOW });
      console.log(`RESOLVES ✅  ${path}`);
    } catch (e: any) {
      allOk = false;
      console.log(`BAD NAME ❌  ${path} — ${e?.message ?? e}`);
    }
  }
  console.log("");
  return allOk;
}

async function runClassChecks(client: ProbeClient): Promise<void> {
  const all = await listAllClasses(client);
  if (all.length < 2) {
    insufficient.push(
      `Need at least 2 classes in this realm to prove a class filter narrows results ` +
        `(found ${all.length}). With only one class, a working filter and a broken one look ` +
        `identical — the single class already covers 100% of the data. Add a class in QuickBooks first.`
    );
    return;
  }

  const leaves = leafClasses(all);
  const probeClass = leaves[0];
  console.log(
    `Probing class filters with class ${probeClass.Id} (${probeClass.Name}); ` +
      `${all.length} classes found, ${leaves.length} of them leaves\n`
  );

  // --- Steps 1-3: does the filter narrow the report at all? ---
  for (const spec of CLASS_CHECKS) {
    const outcome = await filterNarrows(client, spec, probeClass.Id, WINDOW);
    console.log(
      `${outcome.same ? "IGNORED ❌" : "FILTERS ✅"}  ${spec.report} via \`${spec.param}\`` +
        (outcome.same ? "  <-- parameter had NO effect; the name is wrong" : "")
    );
    if (outcome.same) {
      failures.push(`${spec.report}: the \`${spec.param}\` parameter was ignored by QuickBooks.`);
    }
  }

  // --- Step 4: do the parts sum to the whole? ---
  //
  // A filter can pass step 3 (it changed the report) while returning the WRONG
  // class's data. Only the sum-of-parts catches that.
  console.log("\n--- Class reconciliation (spec acceptance step 4) ---\n");

  for (const spec of CLASS_CHECKS) {
    const outcome = await reconcileClassTotals(client, spec, leaves, WINDOW, TOLERANCE);

    if (outcome.reconciles === null) {
      console.log(
        `NO TOTAL ⚠️  ${spec.report} via \`${spec.param}\` — this report has no grand-total ` +
          `summary row, so its per-class totals cannot be summed. Step 3 (above) is the only ` +
          `differential evidence available for it.`
      );
      insufficient.push(
        `${spec.report}: no grand total to reconcile against; step 4 could not be run.`
      );
      continue;
    }

    if (outcome.classesWithoutTotal.length > 0) {
      console.log(
        `         ⚠️  ${outcome.classesWithoutTotal.length} class(es) returned no numeric total ` +
          `and were left out of the sum: ${outcome.classesWithoutTotal.join(", ")}`
      );
    }

    if (outcome.reconciles) {
      console.log(
        `RECONCILES ✅  ${spec.report} via \`${spec.param}\` — ${outcome.classesSummed} leaf ` +
          `class totals sum to ${outcome.summedTotal.toFixed(2)} vs unfiltered ` +
          `${(outcome.unfilteredTotal ?? 0).toFixed(2)}`
      );
    } else {
      console.log(`RECONCILE ❌  ${reconciliationAdvice(outcome)}`);
      failures.push(reconciliationAdvice(outcome));
    }
  }
}

async function runAccountChecks(client: ProbeClient): Promise<void> {
  for (const spec of ACCOUNT_CHECKS) {
    const unfiltered = await client.get(spec.path, { ...WINDOW });
    const flat = flattenReport(unfiltered);

    // ProfitAndLossDetail has no "Account" column — it groups BY account in
    // section headers, which the flattener now preserves as `section`. Reading
    // a literal "Account" column off it (what this probe used to do) could
    // never resolve on any realm.
    const source = flat.columns.includes("Account") ? '"Account" column' : "section headers";
    const distinct = accountCandidates(flat);

    if (distinct.length < 2) {
      insufficient.push(
        `${spec.report}: only ${distinct.length} distinct account(s) show activity between ` +
          `${WINDOW.start_date} and ${WINDOW.end_date} (read from ${source}) — cannot prove the ` +
          `\`${spec.param}\` filter narrows results. Same reasoning as the class check: with one ` +
          `active account, a working filter and a broken one return the same total. Widen ` +
          `PROBE_START/PROBE_END or use a realm with more transaction variety.`
      );
      continue;
    }

    // Try candidates in turn: a section path segment can be a pure grouping
    // header ("Income") rather than an account name, and only a live lookup
    // distinguishes the two.
    let accountName: string | null = null;
    let accountId: string | null = null;
    for (const candidate of distinct) {
      const id = await resolveAccountId(client, candidate, escapeQboString);
      if (id) {
        accountName = candidate;
        accountId = id;
        break;
      }
    }

    if (!accountId || !accountName) {
      insufficient.push(
        `${spec.report}: none of the ${distinct.length} candidate account name(s) taken from ` +
          `${source} resolved via SELECT * FROM Account (tried Name and FullyQualifiedName): ` +
          `${distinct.slice(0, 5).join(", ")}. The report may render account names differently ` +
          `from QBO's Name field — resolve one by hand and re-run.`
      );
      continue;
    }

    const outcome = await filterNarrows(client, spec, accountId, WINDOW);
    console.log(
      `${outcome.same ? "IGNORED ❌" : "FILTERS ✅"}  ${spec.report} via \`${spec.param}\` ` +
        `(account "${accountName}", id ${accountId}, from ${source})` +
        (outcome.same ? "  <-- parameter had NO effect; the name is wrong" : "")
    );
    if (outcome.same) {
      failures.push(`${spec.report}: the \`${spec.param}\` parameter was ignored by QuickBooks.`);
    }
  }
}

/**
 * `summarize_column_by` is the same silent-ignore trap one level down: if a
 * value is not one QuickBooks recognises, it ignores the parameter and returns
 * a single Total-column report that reads as entirely legitimate. The schema
 * advertises Departments and Customers, neither confirmed against Intuit's
 * documentation.
 */
async function runSummarizeColumnChecks(client: ProbeClient): Promise<void> {
  const baseline = await client.get("reports/ProfitAndLoss", {
    ...WINDOW,
    summarize_column_by: "Total",
  });
  const baselineSignature = columnSignature(baseline);

  for (const check of SUMMARIZE_COLUMN_CHECKS) {
    const count = await countEntity(client, check.entity);
    if (count < 1) {
      insufficient.push(
        `summarize_column_by=${check.value}: this realm has no ${check.entity} records, so a ` +
          `working value and an ignored one both produce a single Total column. Cannot be ` +
          `proven here — add a ${check.entity} with transaction activity, or use another realm.`
      );
      continue;
    }

    const report = await client.get("reports/ProfitAndLoss", {
      ...WINDOW,
      summarize_column_by: check.value,
    });
    const signature = columnSignature(report);
    const same = signature === baselineSignature;

    console.log(
      `${same ? "IGNORED ❌" : "SPLITS  ✅"}  summarize_column_by=${check.value} ` +
        `(${count} ${check.entity} record(s) in realm)` +
        (same ? "  <-- columns identical to Total; the value is not recognised" : "")
    );

    if (same) {
      failures.push(
        `summarize_column_by=${check.value} produced columns identical to summarize_column_by=Total, ` +
          `so QuickBooks did not recognise it. Before removing it from the schema, rule out the ` +
          `benign cause: no transaction in ${WINDOW.start_date}..${WINDOW.end_date} carries a ` +
          `${check.entity}, in which case there is genuinely only one column to render. Confirm ` +
          `in the QuickBooks UI, then either fix the value in src/domains/reports.ts or drop it ` +
          `from the enum.`
      );
    }
  }
}

async function main() {
  const client = getClient() as ProbeClient;

  if (!(await verifyEndpoints(client))) {
    console.error(
      "At least one endpoint name is wrong. Fix it in src/domains/reports.ts " +
        "before probing filters — a filter test against a non-existent report proves nothing."
    );
    process.exit(1);
  }

  console.log("=== Class filters ===\n");
  await runClassChecks(client);

  console.log("\n=== Account filters ===\n");
  await runAccountChecks(client);

  console.log("\n=== summarize_column_by values ===\n");
  await runSummarizeColumnChecks(client);

  console.log(
    "\nIf a report shows FILTERS but returns zero rows, check the value shape " +
      "(IDs not names, comma-separated for multiples)."
  );

  if (insufficient.length > 0) {
    console.log("\n=== Could not verify ===");
    for (const msg of insufficient) console.log(`SKIPPED ⚠️  ${msg}`);
    console.log(
      "\nAny SKIPPED line above is NOT a pass. Re-run with a realm/date-range that has enough " +
        "data to actually exercise that check before trusting it."
    );
  }

  if (failures.length > 0) {
    console.log("\n=== Proven wrong ===");
    for (const msg of failures) console.log(`FAILED ❌  ${msg}`);
    console.log(
      "\nRESULT: at least one check FAILED — fix src/domains/reports.ts, update the " +
        "corresponding unit test's expectation, and re-run this probe from scratch."
    );
    process.exit(1);
  }
  if (insufficient.length > 0) {
    console.log(
      "\nRESULT: nothing was proven wrong, but not everything could be tested. INCOMPLETE — " +
        "do not record this as a pass for the skipped check(s)."
    );
    process.exit(3);
  }
  console.log("\nRESULT: every check passed. PASS.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
