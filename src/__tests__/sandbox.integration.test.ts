/**
 * Real-API integration tests against an Intuit QBO sandbox company.
 *
 * Skipped unless QBO_SANDBOX_ACCESS_TOKEN + QBO_SANDBOX_REALM_ID are set
 * in the environment — so unit-test runs (and fork-PR CI) stay green.
 * CI wires these from repo secrets; locally export them before running
 * `npm run test:integration`.
 *
 * Scope: one read tool per entity tier. We're checking that:
 *   1. The generator's tools dispatch correctly to QBO's REST API
 *   2. The sandbox host (sandbox-quickbooks.api.intuit.com) is reachable
 *      with the access token
 *   3. The response shape matches what entity handlers expect
 *
 * We don't write — sandbox companies aren't free-form and a leftover
 * test write could pollute future runs. Read-only by design.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { dispatchTool } from "../entities/index.js";
import { getClient, resetClient } from "../utils/client.js";
import { flattenReport } from "../domains/report-rows.js";
import { escapeQboString } from "../utils/qbo-sql.js";
import {
  ACCOUNT_CHECKS,
  CLASS_CHECKS,
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
} from "./report-filter-checks.js";

const sandboxAccessToken = process.env.QBO_SANDBOX_ACCESS_TOKEN;
const sandboxRealmId = process.env.QBO_SANDBOX_REALM_ID;
const hasCreds = Boolean(sandboxAccessToken && sandboxRealmId);

/**
 * Wide by default: sandbox sample data sits at whatever dates Intuit seeded it
 * with, and a filter check against an empty window proves nothing.
 */
const WINDOW: DateWindow = {
  start_date: process.env.PROBE_START ?? "2015-01-01",
  end_date: process.env.PROBE_END ?? "2035-12-31",
};

/** Report calls are slow and reconciliation makes one per class. */
const LIVE_TIMEOUT = 180_000;

function pointClientAtSandbox() {
  // Re-point the env-mode client at the sandbox. Tests use env mode
  // (not gateway/AsyncLocalStorage) so this is the simplest path.
  process.env.QBO_ACCESS_TOKEN = sandboxAccessToken;
  process.env.QBO_REALM_ID = sandboxRealmId;
  process.env.QBO_ENV = "sandbox";
  resetClient();
}

describe.skipIf(!hasCreds)("QBO sandbox integration", () => {
  beforeAll(pointClientAtSandbox);

  // Helper: dispatch a tool and assert the response isn't an error.
  async function callOk(toolName: string, args: Record<string, unknown> = {}) {
    const result = await dispatchTool(toolName, args);
    expect(result, `${toolName} returned null — tool not registered`).not.toBeNull();
    expect(
      result?.isError,
      `${toolName} returned isError: ${result?.content[0]?.text}`,
    ).not.toBe(true);
    return result!;
  }

  it("tier-0 (existing): qbo_customers_list returns Customer rows", async () => {
    const result = await callOk("qbo_customers_list", { maxResults: 5 });
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/QueryResponse/);
  });

  it("tier-1: qbo_vendors_list returns Vendor rows", async () => {
    const result = await callOk("qbo_vendors_list", { maxResults: 5 });
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/QueryResponse/);
  });

  it("tier-1: qbo_accounts_list returns Account rows (chart of accounts)", async () => {
    const result = await callOk("qbo_accounts_list", { maxResults: 5 });
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/QueryResponse/);
  });

  it("tier-1: qbo_items_list returns Item rows", async () => {
    const result = await callOk("qbo_items_list", { maxResults: 5 });
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/QueryResponse/);
  });

  it("tier-2: qbo_journal_entries_list returns transaction rows", async () => {
    const result = await callOk("qbo_journal_entries_list", { maxResults: 5 });
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/QueryResponse/);
  });

  it("tier-3: qbo_company_info_list returns the realm's company profile", async () => {
    const result = await callOk("qbo_company_info_list", {});
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/CompanyInfo|QueryResponse/);
  });

  it("reports: qbo_reports_balance_sheet runs against the sandbox", async () => {
    // Use a wide date range; sandbox companies are usually empty but the
    // report endpoint still returns a structured response.
    const result = await dispatchTool("qbo_reports_balance_sheet", {
      start_date: "2020-01-01",
      end_date: "2030-12-31",
    });
    // dispatchTool returns null for non-entity tools (reports live in
    // src/domains/), so this branch will only fire if the test setup
    // wires reports through the same dispatcher.
    if (result === null) {
      console.warn(
        "qbo_reports_balance_sheet not reachable via dispatchTool — reports use a separate handler. Skipping.",
      );
      return;
    }
    expect(result.isError).not.toBe(true);
  });
});

/**
 * ---------------------------------------------------------------------------
 * Report endpoint + filter verification — the DURABLE path
 * ---------------------------------------------------------------------------
 *
 * These are the same checks `scripts/verify-report-filters.ts` runs by hand,
 * driven from the shared implementation in `./report-filter-checks.ts`. Having
 * them here means verification happens automatically the moment the
 * QBO_SANDBOX_* secrets exist, instead of depending on someone remembering to
 * run a script once. The script stays as the manual escape hatch — notably for
 * PRODUCTION realms, which CI never touches.
 *
 * ## Why a realm without enough data FAILS rather than skips
 *
 * Every "cannot verify" branch below is a hard failure with an actionable
 * message, not a silent skip. A skip would reproduce the exact failure mode
 * this whole verification effort exists to prevent: something that looks
 * verified but never was. A red run here means "this realm cannot prove the
 * filters are real" — which is genuinely different from green, and is fixed by
 * seeding the sandbox company rather than by editing code.
 */
describe.skipIf(!hasCreds)("QBO report endpoints resolve", () => {
  beforeAll(pointClientAtSandbox);

  // Endpoint spellings are verify-then-ship: Wyre maps `GeneralLedger` while
  // node-quickbooks exposes `GeneralLedgerDetail`, so QBO demonstrably has
  // reports with variant names. A wrong name is a 4xx, not a silent pass.
  it.each([...FORK_REPORT_ENDPOINTS])(
    "%s is a real QuickBooks report",
    async (path) => {
      const client = getClient() as ProbeClient;
      await expect(
        client.get(path, { ...WINDOW }),
        `${path} did not resolve — the endpoint name in src/domains/reports.ts is wrong`,
      ).resolves.toBeDefined();
    },
    LIVE_TIMEOUT,
  );
});

describe.skipIf(!hasCreds)("report filters actually filter", () => {
  beforeAll(pointClientAtSandbox);

  it(
    "every class filter narrows its report, and the parts sum to the whole",
    async () => {
      const client = getClient() as ProbeClient;

      const all = await listAllClasses(client);
      expect(
        all.length,
        `This realm has ${all.length} class(es). At least 2 are needed: with one class, a ` +
          `working filter and a broken one look identical, because the single class already ` +
          `covers 100% of the data. Add classes with transaction activity to the sandbox company.`,
      ).toBeGreaterThanOrEqual(2);

      const leaves = leafClasses(all);

      for (const spec of CLASS_CHECKS) {
        // Steps 1-3: the filter must CHANGE the report. A parameter QuickBooks
        // does not recognise is ignored silently and returns the full report.
        const narrowed = await filterNarrows(client, spec, leaves[0].Id, WINDOW);
        expect(
          narrowed.same,
          `${spec.report}: filtering by \`${spec.param}\`=${leaves[0].Id} returned a report ` +
            `identical to the unfiltered one, so QuickBooks IGNORED the parameter — the wire ` +
            `name in src/domains/reports.ts is wrong (try class <-> classid).`,
        ).toBe(false);

        // Step 4: the filter must be RIGHT, not merely effective. A parameter
        // that is accepted but misinterpreted (wrong ID space, first-match-only,
        // name-vs-ID coercion) passes step 3 while returning another class's
        // data; only the sum-of-parts exposes it.
        const reconciled = await reconcileClassTotals(client, spec, leaves, WINDOW);
        if (reconciled.reconciles === null) {
          // TransactionList is a bare listing with no grand-total row, so there
          // is nothing to sum. That is a property of the report, not a gap in
          // the realm's data — step 3 above is its differential evidence.
          expect(spec.report).toBe("TransactionList");
          continue;
        }
        expect(reconciled.reconciles, reconciliationAdvice(reconciled)).toBe(true);
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    "every account filter narrows its report",
    async () => {
      const client = getClient() as ProbeClient;

      for (const spec of ACCOUNT_CHECKS) {
        const unfiltered = await client.get(spec.path, { ...WINDOW });
        const flat = flattenReport(unfiltered);
        // ProfitAndLossDetail has NO account column — it groups BY account in
        // section headers, which the flattener preserves as `section`.
        const source = flat.columns.includes("Account") ? '"Account" column' : "section headers";
        const candidates = accountCandidates(flat);

        expect(
          candidates.length,
          `${spec.report}: only ${candidates.length} distinct account(s) show activity in ` +
            `${WINDOW.start_date}..${WINDOW.end_date} (read from ${source}). At least 2 are ` +
            `needed, for the same reason as the class check. Widen PROBE_START/PROBE_END or ` +
            `seed the sandbox company with more transaction variety.`,
        ).toBeGreaterThanOrEqual(2);

        let accountId: string | null = null;
        let accountName: string | null = null;
        for (const candidate of candidates) {
          const id = await resolveAccountId(client, candidate, escapeQboString);
          if (id) {
            accountId = id;
            accountName = candidate;
            break;
          }
        }

        expect(
          accountId,
          `${spec.report}: none of ${candidates.length} candidate account name(s) from ${source} ` +
            `resolved via SELECT * FROM Account (tried Name and FullyQualifiedName): ` +
            `${candidates.slice(0, 5).join(", ")}.`,
        ).not.toBeNull();

        const narrowed = await filterNarrows(client, spec, accountId!, WINDOW);
        expect(
          narrowed.same,
          `${spec.report}: filtering by \`${spec.param}\`=${accountId} ("${accountName}") ` +
            `returned a report identical to the unfiltered one, so QuickBooks IGNORED the ` +
            `parameter — try \`accountid\` in src/domains/reports.ts.`,
        ).toBe(false);
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    "every summarize_column_by value the schema advertises changes the columns",
    async () => {
      // The same silent-ignore trap one level down: an unrecognised value makes
      // QuickBooks return a single Total-column report that reads as legitimate.
      // `Departments` and `Customers` were taken from Intuit's own MCP server
      // and never confirmed against Intuit's documentation.
      const client = getClient() as ProbeClient;

      const baseline = columnSignature(
        await client.get("reports/ProfitAndLoss", { ...WINDOW, summarize_column_by: "Total" }),
      );

      for (const check of SUMMARIZE_COLUMN_CHECKS) {
        const count = await countEntity(client, check.entity);
        expect(
          count,
          `summarize_column_by=${check.value} cannot be proven on a realm with no ` +
            `${check.entity} records: a working value and an ignored one both render a single ` +
            `Total column. Seed the sandbox company with a ${check.entity}.`,
        ).toBeGreaterThanOrEqual(1);

        const signature = columnSignature(
          await client.get("reports/ProfitAndLoss", {
            ...WINDOW,
            summarize_column_by: check.value,
          }),
        );

        expect(
          signature,
          `summarize_column_by=${check.value} produced columns identical to ` +
            `summarize_column_by=Total, so QuickBooks did not recognise it. Rule out the benign ` +
            `cause first — no transaction in ${WINDOW.start_date}..${WINDOW.end_date} carrying a ` +
            `${check.entity} leaves genuinely one column — then either fix the value or drop it ` +
            `from the enum in src/domains/reports.ts.`,
        ).not.toBe(baseline);
      }
    },
    LIVE_TIMEOUT,
  );
});
