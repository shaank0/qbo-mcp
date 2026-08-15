import { describe, it, expect } from "vitest";
import { flattenReport } from "../domains/report-rows.js";

// Shape mirrors a real QBO report: Columns.Column[].ColTitle, then Rows.Row[]
// where a Row is either a data row (ColData[]) or a Section carrying nested Rows.
//
// NOTE this fixture is itself a SECTION-GROUPED report: the second entry's
// header reads "Consulting". On ProfitAndLossDetail that header is the ACCOUNT
// the line belongs to and appears nowhere else in the row, so a flattener that
// drops it silently strips the report's grouping dimension.
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
      { Date: "2026-01-05", Name: "Acme", Amount: "100.00", section: "", rowType: "data" },
      {
        Date: "2026-01-09",
        Name: "Globex",
        Amount: "250.00",
        section: "Consulting",
        rowType: "data",
      },
    ]);
    expect(out.truncated).toBe(false);
    expect(out.totalRows).toBe(2);
  });

  it("keeps the section label, which is the only place the grouping lives", () => {
    // On ProfitAndLossDetail this label IS the account: the row's own Split
    // column is the contra account, so losing the header loses account
    // attribution outright. Same story for AgedReceivableDetail's aging bucket
    // and JournalReport's transaction identity.
    const out = flattenReport(report);
    const nested = out.rows.find((r) => r.Name === "Globex")!;
    expect(nested.section).toBe("Consulting");
    // A top-level row is not falsely attributed to a section it isn't under.
    expect(out.rows.find((r) => r.Name === "Acme")!.section).toBe("");
  });

  it("joins nested section headers into a path", () => {
    const nestedReport = {
      Columns: { Column: [{ ColTitle: "Name" }, { ColTitle: "Amount" }] },
      Rows: {
        Row: [
          {
            Header: { ColData: [{ value: "Income" }] },
            Rows: {
              Row: [
                {
                  Header: { ColData: [{ value: "Consulting" }] },
                  Rows: { Row: [{ ColData: [{ value: "Globex" }, { value: "250.00" }] }] },
                },
              ],
            },
          },
        ],
      },
    };
    expect(flattenReport(nestedReport).rows[0].section).toBe("Income > Consulting");
  });

  it("emits section subtotals inline, marked, so a summary-only report is never empty", () => {
    // ClassSales can carry its values ONLY in section summaries. Dropping
    // Summary.ColData would make that tool return rows: [] — a report that
    // reads as "no sales".
    const summaryReport = {
      Columns: { Column: [{ ColTitle: "Name" }, { ColTitle: "Amount" }] },
      Rows: {
        Row: [
          {
            Header: { ColData: [{ value: "Consulting" }] },
            Rows: { Row: [{ ColData: [{ value: "Globex" }, { value: "250.00" }] }] },
            Summary: { ColData: [{ value: "Total Consulting" }, { value: "250.00" }] },
          },
        ],
      },
    };
    const out = flattenReport(summaryReport);
    expect(out.rows).toEqual([
      { Name: "Globex", Amount: "250.00", section: "Consulting", rowType: "data" },
      {
        Name: "Total Consulting",
        Amount: "250.00",
        section: "Consulting",
        rowType: "summary",
      },
    ]);
    // The marker is what lets a consumer exclude subtotals rather than
    // double-counting them against the data rows they summarise.
    expect(out.rows.filter((r) => r.rowType === "data")).toHaveLength(1);
  });

  it("never lets the section metadata overwrite a real QBO column", () => {
    const collides = {
      Columns: { Column: [{ ColTitle: "section" }, { ColTitle: "rowType" }] },
      Rows: {
        Row: [
          {
            Header: { ColData: [{ value: "Consulting" }] },
            Rows: { Row: [{ ColData: [{ value: "real-data" }, { value: "also-real" }] }] },
          },
        ],
      },
    };
    const row = flattenReport(collides).rows[0];
    expect(row.section).toBe("real-data");
    expect(row.rowType).toBe("also-real");
    expect(row._section).toBe("Consulting");
    expect(row._rowType).toBe("data");
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
    expect(flattenReport(ragged).rows).toEqual([
      { A: "only-a", B: "", section: "", rowType: "data" },
    ]);
  });
});
