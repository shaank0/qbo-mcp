/**
 * Unit tests for the differential-probe logic.
 *
 * The probe can only be RUN against a live realm, but its reasoning is pure
 * and testable here: which classes get summed, how a grand total is parsed,
 * where account candidates come from. Shipping that reasoning unrun — and
 * therefore unverified — is exactly the failure this whole verification effort
 * exists to prevent, so the parts that don't need QuickBooks are pinned here.
 */

import { describe, it, expect } from "vitest";
import {
  accountCandidates,
  columnSignature,
  filterNarrows,
  leafClasses,
  listAllClasses,
  numericGrandTotal,
  parseAmount,
  reconcileClassTotals,
  type ProbeClient,
  type QboClass,
} from "./report-filter-checks.js";
import { flattenReport } from "../domains/report-rows.js";

const WINDOW = { start_date: "2026-01-01", end_date: "2026-12-31" };

/** A report whose grand total is `total`, in QBO's summary-row shape. */
function reportWithTotal(total: string) {
  return {
    Columns: { Column: [{ ColTitle: "Name" }, { ColTitle: "Total" }] },
    Rows: {
      Row: [
        { ColData: [{ value: "a line" }, { value: total }] },
        { Summary: { ColData: [{ value: "TOTAL" }, { value: total }] } },
      ],
    },
  };
}

describe("parseAmount", () => {
  it("reads plain and comma-grouped amounts", () => {
    expect(parseAmount("1234.56")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("$1,234.56")).toBe(1234.56);
  });

  it("reads accounting-style negatives as negative", () => {
    // Reading (1,234.56) as +1234.56 would silently invert a reconciliation
    // and turn a real discrepancy into a passing sum.
    expect(parseAmount("(1,234.56)")).toBe(-1234.56);
    expect(parseAmount("-1234.56")).toBe(-1234.56);
  });

  it("returns null for things that are not amounts", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("Consulting")).toBeNull();
    expect(parseAmount(undefined as unknown as string)).toBeNull();
  });
});

describe("numericGrandTotal", () => {
  it("takes the last numeric cell of the last top-level summary row", () => {
    expect(numericGrandTotal(reportWithTotal("250.00"))).toBe(250);
  });

  it("returns null when the report has no grand total at all", () => {
    // TransactionList is a bare listing. Null means "cannot reconcile this
    // one", which the caller must report — not treat as zero.
    const listing = {
      Columns: { Column: [{ ColTitle: "Date" }] },
      Rows: { Row: [{ ColData: [{ value: "2026-01-05" }] }] },
    };
    expect(numericGrandTotal(listing)).toBeNull();
  });

  it("skips non-numeric summary labels to find the amount", () => {
    const report = {
      Rows: { Row: [{ Summary: { ColData: [{ value: "TOTAL" }, { value: "" }] } }] },
    };
    expect(numericGrandTotal(report)).toBeNull();
  });
});

describe("leafClasses", () => {
  it("drops parent classes so reconciliation cannot double-count", () => {
    // QuickBooks' class filter on a PARENT includes its sub-classes. Summing
    // parent and children together double-counts every sub-class and
    // manufactures a reconciliation failure out of correct code.
    const classes: QboClass[] = [
      { Id: "1", Name: "Divisions" },
      { Id: "2", Name: "North", ParentRef: { value: "1" } },
      { Id: "3", Name: "South", ParentRef: { value: "1" } },
      { Id: "4", Name: "Standalone" },
    ];
    expect(leafClasses(classes).map((c) => c.Id)).toEqual(["2", "3", "4"]);
  });

  it("keeps every class when the hierarchy is flat", () => {
    const classes: QboClass[] = [{ Id: "1" }, { Id: "2" }];
    expect(leafClasses(classes)).toHaveLength(2);
  });
});

describe("listAllClasses", () => {
  it("pages until a short page, so a >1000-class realm is not truncated", async () => {
    // A truncated class list under-sums and reports a reconciliation failure
    // that is really a pagination bug.
    const queries: string[] = [];
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1) }));
    const page2 = [{ Id: "1001" }];
    const client: ProbeClient = {
      get: async () => ({}),
      query: async (sql: string) => {
        queries.push(sql);
        return { QueryResponse: { Class: queries.length === 1 ? page1 : page2 } };
      },
    };

    const all = await listAllClasses(client);
    expect(all).toHaveLength(1001);
    expect(queries[0]).toContain("STARTPOSITION 1");
    expect(queries[1]).toContain("STARTPOSITION 1001");
  });
});

describe("filterNarrows", () => {
  it("flags an identical response as IGNORED", async () => {
    const client: ProbeClient = {
      get: async () => reportWithTotal("100.00"),
      query: async () => ({}),
    };
    const out = await filterNarrows(
      client,
      { report: "ProfitAndLoss", param: "class", path: "reports/ProfitAndLoss" },
      "5",
      WINDOW,
    );
    expect(out.same).toBe(true);
  });

  it("sends the filter parameter under the wire name being tested", async () => {
    const calls: Record<string, string>[] = [];
    const client: ProbeClient = {
      get: async (_path, params) => {
        calls.push(params);
        return reportWithTotal(params.classid ? "40.00" : "100.00");
      },
      query: async () => ({}),
    };
    const out = await filterNarrows(
      client,
      { report: "ProfitAndLossDetail", param: "classid", path: "reports/ProfitAndLossDetail" },
      "5",
      WINDOW,
    );
    expect(calls[0]).toEqual(WINDOW);
    expect(calls[1].classid).toBe("5");
    expect(out.same).toBe(false);
  });
});

describe("reconcileClassTotals (spec acceptance step 4)", () => {
  const spec = { report: "ProfitAndLoss", param: "class", path: "reports/ProfitAndLoss" };
  const leaves: QboClass[] = [
    { Id: "1", Name: "North" },
    { Id: "2", Name: "South" },
  ];

  /** Filtered totals per class id; unfiltered is whatever `total` says. */
  function clientReturning(unfiltered: string, perClass: Record<string, string>): ProbeClient {
    return {
      get: async (_path, params) =>
        reportWithTotal(params.class ? perClass[params.class] : unfiltered),
      query: async () => ({}),
    };
  }

  it("reconciles when the parts sum to the whole", async () => {
    const client = clientReturning("100.00", { "1": "60.00", "2": "40.00" });
    const out = await reconcileClassTotals(client, spec, leaves, WINDOW);
    expect(out.reconciles).toBe(true);
    expect(out.summedTotal).toBeCloseTo(100, 2);
    expect(out.classesSummed).toBe(2);
  });

  it("FAILS a filter that is accepted but returns the wrong class's data", async () => {
    // The case step 3 cannot catch: every filtered call changed the report
    // (so `filterNarrows` is happy), but the filter answered with the SAME
    // class both times — first-match-only, or a wrong ID space. The parts
    // then don't sum to the whole.
    const client = clientReturning("100.00", { "1": "60.00", "2": "60.00" });
    const out = await reconcileClassTotals(client, spec, leaves, WINDOW);
    expect(out.reconciles).toBe(false);
    expect(out.delta).toBeCloseTo(20, 2);
  });

  it("reports classes with no numeric total instead of counting them as zero", async () => {
    const client: ProbeClient = {
      get: async (_path, params) =>
        params.class === "2"
          ? { Rows: { Row: [{ ColData: [{ value: "x" }] }] } }
          : reportWithTotal(params.class ? "60.00" : "100.00"),
      query: async () => ({}),
    };
    const out = await reconcileClassTotals(client, spec, leaves, WINDOW);
    expect(out.classesWithoutTotal).toEqual(["South (2)"]);
    expect(out.classesSummed).toBe(1);
    // Silently treating a missing total as 0.00 would let a broken filter
    // reconcile by luck on a realm where some class returns nothing.
    expect(out.reconciles).toBe(false);
  });

  it("is not applicable to a report with no grand total", async () => {
    const client: ProbeClient = {
      get: async () => ({ Rows: { Row: [{ ColData: [{ value: "x" }] }] } }),
      query: async () => ({}),
    };
    const out = await reconcileClassTotals(client, spec, leaves, WINDOW);
    expect(out.reconciles).toBeNull();
  });

  it("tolerates only sub-cent drift", async () => {
    const client = clientReturning("100.00", { "1": "60.00", "2": "40.50" });
    const out = await reconcileClassTotals(client, spec, leaves, WINDOW);
    expect(out.reconciles).toBe(false);
  });
});

describe("accountCandidates", () => {
  it("uses the Account column when the report has one (TransactionList)", () => {
    const flat = flattenReport({
      Columns: { Column: [{ ColTitle: "Date" }, { ColTitle: "Account" }] },
      Rows: {
        Row: [
          { ColData: [{ value: "2026-01-05" }, { value: "Checking" }] },
          { ColData: [{ value: "2026-01-06" }, { value: "Consulting Income" }] },
        ],
      },
    });
    expect(accountCandidates(flat).sort()).toEqual(["Checking", "Consulting Income"]);
  });

  it("falls back to section headers when there is no Account column (ProfitAndLossDetail)", () => {
    // This is the check that could NEVER resolve before: ProfitAndLossDetail
    // groups BY account in section headers and has no "Account" column, so
    // reading one off it found nothing on every realm regardless of data.
    const flat = flattenReport({
      Columns: { Column: [{ ColTitle: "Date" }, { ColTitle: "Split" }] },
      Rows: {
        Row: [
          {
            Header: { ColData: [{ value: "Income" }] },
            Rows: {
              Row: [
                {
                  Header: { ColData: [{ value: "Consulting Income" }] },
                  Rows: {
                    Row: [{ ColData: [{ value: "2026-01-05" }, { value: "Checking" }] }],
                  },
                  Summary: { ColData: [{ value: "Total Consulting Income" }, { value: "" }] },
                },
                {
                  Header: { ColData: [{ value: "Product Income" }] },
                  Rows: {
                    Row: [{ ColData: [{ value: "2026-01-06" }, { value: "Checking" }] }],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    // The LEAF of the section path is the account; the outer "Income" grouping
    // is not. And "Total Consulting Income" is a summary row, never a candidate.
    expect(accountCandidates(flat).sort()).toEqual(["Consulting Income", "Product Income"]);
  });

  it("ignores summary rows so a subtotal label is never taken for an account", () => {
    const flat = flattenReport({
      Columns: { Column: [{ ColTitle: "Amount" }] },
      Rows: {
        Row: [
          {
            Header: { ColData: [{ value: "Consulting Income" }] },
            Rows: { Row: [{ ColData: [{ value: "10.00" }] }] },
            Summary: { ColData: [{ value: "250.00" }] },
          },
        ],
      },
    });
    expect(accountCandidates(flat)).toEqual(["Consulting Income"]);
  });
});

describe("columnSignature", () => {
  it("distinguishes a per-class breakdown from a single Total column", () => {
    // How the summarize_column_by check detects a silently ignored value.
    const total = { Columns: { Column: [{ ColTitle: "Total" }] } };
    const classes = {
      Columns: { Column: [{ ColTitle: "North" }, { ColTitle: "South" }, { ColTitle: "Total" }] },
    };
    expect(columnSignature(total)).not.toBe(columnSignature(classes));
  });
});
