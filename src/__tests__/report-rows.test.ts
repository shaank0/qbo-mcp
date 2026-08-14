import { describe, it, expect } from "vitest";
import { flattenReport } from "../domains/report-rows.js";

// Shape mirrors a real QBO report: Columns.Column[].ColTitle, then Rows.Row[]
// where a Row is either a data row (ColData[]) or a Section carrying nested Rows.
const report = {
  Header: { ReportName: "TransactionList" },
  Columns: { Column: [{ ColTitle: "Date" }, { ColTitle: "Name" }, { ColTitle: "Amount" }] },
  Rows: {
    Row: [
      { ColData: [{ value: "2026-01-05" }, { value: "Acme" }, { value: "100.00" }] },
      {
        Header: { ColData: [{ value: "Consulting" }] },
        Rows: {
          Row: [{ ColData: [{ value: "2026-01-09" }, { value: "Globex" }, { value: "250.00" }] }],
        },
      },
    ],
  },
};

describe("flattenReport", () => {
  it("flattens nested sections into column-keyed rows", () => {
    const out = flattenReport(report);
    expect(out.columns).toEqual(["Date", "Name", "Amount"]);
    expect(out.rows).toEqual([
      { Date: "2026-01-05", Name: "Acme", Amount: "100.00" },
      { Date: "2026-01-09", Name: "Globex", Amount: "250.00" },
    ]);
    expect(out.truncated).toBe(false);
    expect(out.totalRows).toBe(2);
  });

  it("reports truncation explicitly rather than silently cutting", () => {
    const out = flattenReport(report, 1);
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(true);
    // totalRows is the PRE-truncation count: a silently shortened financial
    // report is the same class of error as a silently ignored filter.
    expect(out.totalRows).toBe(2);
  });

  it("survives a report with no rows", () => {
    const empty = { Columns: { Column: [{ ColTitle: "Date" }] }, Rows: {} };
    const out = flattenReport(empty);
    expect(out.rows).toEqual([]);
    expect(out.totalRows).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it("pads short rows so every row has every column key", () => {
    const ragged = {
      Columns: { Column: [{ ColTitle: "A" }, { ColTitle: "B" }] },
      Rows: { Row: [{ ColData: [{ value: "only-a" }] }] },
    };
    expect(flattenReport(ragged).rows).toEqual([{ A: "only-a", B: "" }]);
  });
});
