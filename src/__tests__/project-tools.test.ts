import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: string[] = [];
const gets: { path: string; params: Record<string, string> }[] = [];
let report: unknown;
let timeActivities: unknown[] = [];
let getError: Error | null = null;

vi.mock("../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/client.js")>()),
  getClient: () => ({
    get: async (path: string, params: Record<string, string>) => {
      gets.push({ path, params });
      if (getError) throw getError;
      return report;
    },
    query: async (sql: string) => {
      queries.push(sql);
      return { QueryResponse: { Customer: [{ Id: "77", DisplayName: "Project X", FullyQualifiedName: "Acme:Project X" }] } };
    },
    getPaginated: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM Account")) return [{ Id: "2", Name: "Wages", FullyQualifiedName: "Payroll Expenses:Wages", AccountSubType: "PayrollExpenses" }];
      if (sql.includes("FROM Employee")) return [{ Id: "654", DisplayName: "William Spence" }];
      if (sql.includes("FROM TimeActivity")) return timeActivities;
      return [];
    },
  }),
}));

const { QboApiError } = await import("../utils/client.js");
const { projectFinancialsTools, handleProjectFinancialsTool } = await import("../domains/project-financials.js");

const col = (t: string) => ({ ColTitle: t });
const cells = (...v: string[]) => v.map((value) => ({ value }));
function qboReport(customer = "Acme:Project X", payAmount = "900.50") {
  return {
    Columns: { Column: ["Date", "Transaction Type", "Num", "Name", "Memo/Description", "Amount", "Customer"].map(col) },
    Rows: { Row: [
      { Header: { ColData: cells("Income") }, Rows: { Row: [{ ColData: cells("2026-03-01", "Invoice", "1", "Acme:Project X", "", "1000.00", customer) }] } },
      { Header: { ColData: cells("Payroll Expenses") }, Rows: { Row: [{ Header: { ColData: cells("Wages") }, Rows: { Row: [
        { ColData: cells("2026-03-05", "Paycheck", "", "William Spence", "", payAmount, "Acme:Project X") },
        { ColData: cells("2026-03-19", "Paycheck", "", "William Spence", "", "923.57", "Acme:Project X") },
      ] } }] } },
    ] },
  };
}

beforeEach(() => {
  queries.length = 0;
  gets.length = 0;
  report = qboReport();
  timeActivities = [];
  getError = null;
});

const args = { project_id: "77", start_date: "2026-01-01", end_date: "2026-09-30" };

describe("tool definitions", () => {
  it("defines exactly the three read-verb tools", () => {
    expect(projectFinancialsTools.map((t) => t.name)).toEqual([
      "qbo_project_get_financials",
      "qbo_project_get_financials_nonlabor",
      "qbo_project_get_hours",
    ]);
  });
});

describe("qbo_project_get_financials", () => {
  it("requests P&L detail filtered to the project WITH the customer column", async () => {
    await handleProjectFinancialsTool("qbo_project_get_financials", args);
    expect(gets[0].path).toBe("reports/ProfitAndLossDetail");
    expect(gets[0].params.customer).toBe("77");
    expect(gets[0].params.columns).toContain("cust_name");
  });
  it("loads inactive accounts and employees too", async () => {
    await handleProjectFinancialsTool("qbo_project_get_financials", args);
    expect(queries.find((q) => q.includes("FROM Account"))).toContain("Active IN (true, false)");
    expect(queries.find((q) => q.includes("FROM Employee"))).toContain("Active IN (true, false)");
  });
  it("returns labor as a total and never the paycheck row", async () => {
    const res = await handleProjectFinancialsTool("qbo_project_get_financials", args);
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).not.toContain("William");
    expect(text).not.toContain("900.5");
    expect(text).not.toContain("923.57");
    expect(JSON.parse(text).labor).toEqual({ total: 1824.07 });
  });
  it("is an error, not data, when QuickBooks ignored the filter", async () => {
    report = qboReport("Some Other Customer");
    const res = await handleProjectFinancialsTool("qbo_project_get_financials", args);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("project filter was not applied");
  });
  it("rejects a non-numeric project id and bad dates before calling QuickBooks", async () => {
    await expect(handleProjectFinancialsTool("qbo_project_get_financials", { ...args, project_id: "1' OR 1=1" })).rejects.toThrow();
    await expect(handleProjectFinancialsTool("qbo_project_get_financials", { ...args, start_date: "yesterday" })).rejects.toThrow();
    expect(gets).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });
});

describe("leak prevention", () => {
  it("an unparseable paycheck amount is an error that does not echo the value or name", async () => {
    report = qboReport("Acme:Project X", "$923.57");
    const res = await handleProjectFinancialsTool("qbo_project_get_financials", args);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain("923.57");
    expect(res.content[0].text).not.toContain("William");
  });
  it("withholds QuickBooks fault bodies", async () => {
    getError = new QboApiError(400, "GET", "reports/ProfitAndLossDetail", "SECRET-BODY");
    const p = handleProjectFinancialsTool("qbo_project_get_financials", args);
    await expect(p).rejects.toThrow("HTTP 400");
    await expect(p).rejects.not.toThrow("SECRET-BODY");
  });
  it("rejects an invalid accounting_method before any QuickBooks call", async () => {
    await expect(
      handleProjectFinancialsTool("qbo_project_get_financials", { ...args, accounting_method: "cash" })
    ).rejects.toThrow('accounting_method must be "Cash" or "Accrual"');
    expect(gets).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });
});

describe("qbo_project_get_financials_nonlabor", () => {
  it("has no labor key", async () => {
    const res = await handleProjectFinancialsTool("qbo_project_get_financials_nonlabor", args);
    expect(JSON.parse(res.content[0].text)).not.toHaveProperty("labor");
  });
});

describe("qbo_project_get_hours", () => {
  it("queries time activities by date only and filters to the project in code", async () => {
    timeActivities = [
      { CustomerRef: { value: "77" }, EmployeeRef: { name: "William Spence" }, Hours: 2, CostRate: 92.5 },
      { CustomerRef: { value: "88" }, EmployeeRef: { name: "Taylor" }, Hours: 9 },
    ];
    const res = await handleProjectFinancialsTool("qbo_project_get_hours", args);
    const q = queries.find((s) => s.includes("FROM TimeActivity"))!;
    expect(q).toContain("TxnDate >= '2026-01-01'");
    expect(res.content[0].text).not.toContain("Taylor");
    expect(res.content[0].text).not.toContain("92.5");
    const out = JSON.parse(res.content[0].text);
    expect(out.people).toEqual([{ name: "William Spence", hours: 2, billableHours: 0 }]);
    expect(out.totalHours).toBe(2);
  });
});
