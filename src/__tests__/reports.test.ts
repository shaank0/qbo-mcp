import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { handleReportTool, reportTools } from "../domains/reports.js";

describe("QBO API minor version", () => {
  it("pins minorversion 75 — 1-74 were deprecated in August 2025", () => {
    // Asserted against the source rather than a live call: this is a pinned
    // constant, and IsProject (used by qbo_projects_list) is gated on it.
    const src = readFileSync(new URL("../utils/client.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const MINOR_VERSION = "75"/);
  });
});

/** The report body `captureClient`'s stub returns, so output shape is assertable. */
const CAPTURED_REPORT = {
  Header: { ReportName: "x" },
  Columns: { Column: [{ ColTitle: "Total" }] },
  Rows: { Row: [{ ColData: [{ value: "1.00" }] }] },
};

/** Capture the path + params handed to the QBO client. */
function captureClient() {
  const calls: { path: string; params: Record<string, string> }[] = [];
  vi.doMock("../utils/client.js", () => ({
    getClient: () => ({
      get: async (path: string, params: Record<string, string>) => {
        calls.push({ path, params });
        return CAPTURED_REPORT;
      },
      query: async () => ({ QueryResponse: {} }),
    }),
  }));
  return calls;
}

describe("qbo_reports_profit_and_loss: dimension filters", () => {
  it("advertises the class and summarize_column_by arguments", () => {
    const tool = reportTools.find((t) => t.name === "qbo_reports_profit_and_loss")!;
    const props = (tool.inputSchema as any).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "start_date", "end_date", "accounting_method",
        "summarize_column_by", "class", "department", "customer", "vendor", "item",
      ])
    );
    expect(props.summarize_column_by.enum).toEqual(
      expect.arrayContaining(["Total", "Month", "Quarter", "Year", "Classes"])
    );
  });

  it("passes class through as the `class` wire parameter for ProfitAndLoss", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    await handle("qbo_reports_profit_and_loss", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      class: "5000000000000001",
      summarize_column_by: "Classes",
    });

    expect(calls[0].path).toBe("reports/ProfitAndLoss");
    // ProfitAndLoss uses `class`; ProfitAndLossDetail uses `classid`. Intuit is
    // inconsistent between the two — see Task 4 and the Task 7 probe.
    expect(calls[0].params.class).toBe("5000000000000001");
    expect(calls[0].params.summarize_column_by).toBe("Classes");
  });

  it("omits filters that were not supplied rather than sending empties", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    await handle("qbo_reports_profit_and_loss", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
    });

    // An empty-string filter is NOT the same as no filter: QBO may treat it as
    // "match nothing" and silently return an empty report.
    expect(calls[0].params).toEqual({ start_date: "2026-01-01", end_date: "2026-03-31" });
  });
});

describe("new report tools", () => {
  it("registers every tool the gateway's role allow-list names", () => {
    const names = reportTools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "qbo_reports_profit_and_loss_detail",
        "qbo_reports_transaction_list",
        "qbo_reports_aged_receivable_detail",
        "qbo_reports_class_sales",
        "qbo_reports_journal_report",
      ])
    );
  });

  it("ProfitAndLossDetail uses `classid`, NOT `class`", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    await handle("qbo_reports_profit_and_loss_detail", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      class: "5000000000000001",
    });

    expect(calls[0].path).toBe("reports/ProfitAndLossDetail");
    // The whole point of this test: the caller-facing argument is `class` for
    // both reports, but the wire name differs. If these ever converge, this
    // test is what tells you.
    expect(calls[0].params.classid).toBe("5000000000000001");
    expect(calls[0].params.class).toBeUndefined();
  });

  it("TransactionList passes account and date range through", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    await handle("qbo_reports_transaction_list", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      account: "82,83",
      source_account_type: "Expense",
      transaction_type: "Bill",
    });

    expect(calls[0].path).toBe("reports/TransactionList");
    expect(calls[0].params).toMatchObject({
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      account: "82,83",
      source_account_type: "Expense",
      transaction_type: "Bill",
    });
  });

  it("AgedReceivableDetail resolves to the detail endpoint, not the summary one", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    await handle("qbo_reports_aged_receivable_detail", {
      report_date: "2026-03-31",
      aging_method: "Report_Date",
    });

    // Endpoint spellings are verify-then-ship: QBO has both AgedReceivables
    // and AgedReceivableDetail (cf. GeneralLedger vs GeneralLedgerDetail), and
    // a typo here ships green unless the PATH itself is asserted.
    expect(calls[0].path).toBe("reports/AgedReceivableDetail");
    expect(calls[0].params).toMatchObject({
      report_date: "2026-03-31",
      aging_method: "Report_Date",
    });
  });

  it("ClassSales resolves to the ClassSales endpoint", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    await handle("qbo_reports_class_sales", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      accounting_method: "Accrual",
    });

    expect(calls[0].path).toBe("reports/ClassSales");
    expect(calls[0].params).toMatchObject({
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      accounting_method: "Accrual",
    });
  });

  it("JournalReport resolves to the JournalReport endpoint", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    await handle("qbo_reports_journal_report", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
    });

    expect(calls[0].path).toBe("reports/JournalReport");
    expect(calls[0].params).toEqual({ start_date: "2026-01-01", end_date: "2026-03-31" });
  });

  it("aged receivables gains the aging controls without breaking its old shape", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    const res = await handle("qbo_reports_aged_receivables", {
      report_date: "2026-03-31",
      customer: "42",
      aging_method: "Report_Date",
      num_periods: "4",
    });

    expect(calls[0].path).toBe("reports/AgedReceivables");
    expect(calls[0].params).toMatchObject({
      report_date: "2026-03-31",
      customer: "42",
      aging_method: "Report_Date",
      num_periods: "4",
    });
    // "without breaking its old shape" is a claim about the OUTPUT, and this
    // handler was rewritten (passThrough) — so assert it, or wrapping this
    // report in flatText would leave the test green under a broken promise.
    expect(res.content[0].text).toBe(JSON.stringify(CAPTURED_REPORT, null, 2));
  });

  it("profit and loss keeps its pre-existing nested output despite the new filters", async () => {
    vi.resetModules();
    const calls = captureClient();
    const { handleReportTool: handle } = await import("../domains/reports.js");

    const res = await handle("qbo_reports_profit_and_loss", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      class: "5000000000000001",
    });

    expect(calls[0].path).toBe("reports/ProfitAndLoss");
    // The other handler this fork rewrote. Flattening it would be a breaking
    // change for every existing caller AND would sink the upstream PR's
    // "purely additive" claim.
    expect(res.content[0].text).toBe(JSON.stringify(CAPTURED_REPORT, null, 2));
  });

  it("new tools return flattened rows, not the raw nested report", async () => {
    vi.resetModules();
    vi.doMock("../utils/client.js", () => ({
      getClient: () => ({
        get: async () => ({
          Columns: { Column: [{ ColTitle: "Date" }, { ColTitle: "Amount" }] },
          Rows: { Row: [{ ColData: [{ value: "2026-01-05" }, { value: "10.00" }] }] },
        }),
        query: async () => ({ QueryResponse: {} }),
      }),
    }));
    const { handleReportTool: handle } = await import("../domains/reports.js");

    const res = await handle("qbo_reports_transaction_list", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
    });
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed.rows).toEqual([
      { Date: "2026-01-05", Amount: "10.00", section: "", rowType: "data" },
    ]);
    expect(parsed.truncated).toBe(false);
    // The nested original must NOT be echoed alongside it.
    expect(parsed.Rows).toBeUndefined();
  });

  it("plumbs max_rows from the tool arguments through to the flattener", async () => {
    // `typeof a.max_rows === "number"` is the whole point of the argument. A
    // typo'd key (a.maxRows) leaves every report silently pinned at the 2000
    // default with every other test still green — silent truncation policy
    // failure, the same class of harm as a silently ignored filter.
    vi.resetModules();
    vi.doMock("../utils/client.js", () => ({
      getClient: () => ({
        get: async () => ({
          Columns: { Column: [{ ColTitle: "Date" }] },
          Rows: {
            Row: [
              { ColData: [{ value: "2026-01-01" }] },
              { ColData: [{ value: "2026-01-02" }] },
              { ColData: [{ value: "2026-01-03" }] },
            ],
          },
        }),
        query: async () => ({ QueryResponse: {} }),
      }),
    }));
    const { handleReportTool: handle } = await import("../domains/reports.js");

    for (const tool of ["qbo_reports_transaction_list", "qbo_reports_journal_report"]) {
      const res = await handle(tool, {
        start_date: "2026-01-01",
        end_date: "2026-03-31",
        max_rows: 2,
      });
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.rows, `${tool} ignored max_rows`).toHaveLength(2);
      expect(parsed.truncated, `${tool} truncated silently`).toBe(true);
      expect(parsed.totalRows, `${tool} lost the pre-truncation count`).toBe(3);
    }
  });

  it("leaves the pre-existing balance-sheet output untouched", async () => {
    vi.resetModules();
    const nested = {
      Columns: { Column: [{ ColTitle: "X" }] },
      Rows: { Row: [{ ColData: [{ value: "1" }] }] },
    };
    vi.doMock("../utils/client.js", () => ({
      getClient: () => ({ get: async () => nested, query: async () => ({}) }),
    }));
    const { handleReportTool: handle } = await import("../domains/reports.js");

    const res = await handle("qbo_reports_balance_sheet", {
      start_date: "2026-01-01",
      end_date: "2026-03-31",
    });
    // Byte-identical to upstream: pretty-printed raw report, not flattened.
    expect(res.content[0].text).toBe(JSON.stringify(nested, null, 2));
  });
});

describe("qbo_projects_list", () => {
  it("queries Customer filtered on IsProject", async () => {
    vi.resetModules();
    const queries: string[] = [];
    vi.doMock("../utils/client.js", () => ({
      getClient: () => ({
        get: async () => ({}),
        query: async (sql: string) => {
          queries.push(sql);
          return {
            QueryResponse: {
              Customer: [
                {
                  Id: "7",
                  DisplayName: "Acme — Roof Replacement",
                  Active: true,
                  ParentRef: { value: "3", name: "Acme" },
                },
              ],
            },
          };
        },
      }),
    }));

    const { handleProjectTool } = await import("../domains/projects.js");
    const res = await handleProjectTool("qbo_projects_list", {});

    expect(queries[0]).toContain("FROM Customer");
    expect(queries[0]).toContain("IsProject = true");

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.projects).toEqual([
      {
        id: "7",
        name: "Acme — Roof Replacement",
        active: true,
        parentCustomerId: "3",
        parentCustomerName: "Acme",
      },
    ]);
  });

  it("returns an empty list rather than throwing when a realm has no projects", async () => {
    vi.resetModules();
    vi.doMock("../utils/client.js", () => ({
      getClient: () => ({ get: async () => ({}), query: async () => ({ QueryResponse: {} }) }),
    }));

    const { handleProjectTool } = await import("../domains/projects.js");
    const res = await handleProjectTool("qbo_projects_list", {});
    expect(JSON.parse(res.content[0].text)).toEqual({ projects: [], count: 0 });
  });

  it("rejects an out-of-range maxResults with a clear error, not an upstream failure", async () => {
    vi.resetModules();
    vi.doMock("../utils/client.js", () => ({
      getClient: () => ({ get: async () => ({}), query: async () => ({ QueryResponse: {} }) }),
    }));

    const { handleProjectTool } = await import("../domains/projects.js");
    await expect(handleProjectTool("qbo_projects_list", { maxResults: 999999 })).rejects.toThrow(
      /maxResults/
    );
  });

  it("composes active_only with the IsProject filter", async () => {
    vi.resetModules();
    const queries: string[] = [];
    vi.doMock("../utils/client.js", () => ({
      getClient: () => ({
        get: async () => ({}),
        query: async (sql: string) => {
          queries.push(sql);
          return { QueryResponse: {} };
        },
      }),
    }));

    const { handleProjectTool } = await import("../domains/projects.js");
    await handleProjectTool("qbo_projects_list", { active_only: true });

    expect(queries[0]).toContain("IsProject = true");
    expect(queries[0]).toContain("Active = true");
    expect(queries[0]).toMatch(/IsProject = true AND Active = true/);
  });
});
