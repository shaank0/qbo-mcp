import { describe, it, expect } from "vitest";
import type { FlatReport } from "../domains/report-rows.js";
import { buildLaborContext } from "../domains/labor.js";
import {
  belongsToProject,
  computeProjectFinancials,
  FILTER_NOT_APPLIED,
  ProjectFilterError,
} from "../domains/project-financials.js";

const project = { id: "77", name: "Project X", fullyQualifiedName: "Acme:Project X" };
const period = { start: "2026-01-01", end: "2026-09-30" };
const ctx = buildLaborContext(
  [
    { Id: "2", Name: "Wages", FullyQualifiedName: "Payroll Expenses:Wages", AccountSubType: "PayrollExpenses" },
    { Id: "6", Name: "Officer Bonus", FullyQualifiedName: "Officer Bonus", AccountSubType: "OtherMiscellaneousServiceCost" },
    { Id: "5", Name: "Contract Labor", FullyQualifiedName: "Contract Labor", AccountSubType: "OtherMiscellaneousServiceCost" },
    { Id: "3", Name: "Office Supplies", FullyQualifiedName: "Office Supplies", AccountSubType: "SuppliesMaterials" },
  ],
  [{ Id: "654", DisplayName: "William Spence" }],
  new Set(["5"])
);

const COLUMNS = ["Date", "Transaction Type", "Num", "Name", "Memo/Description", "Amount", "Customer"];

function row(section: string, type: string, name: string, memo: string, amount: string, customer = "Acme:Project X") {
  return {
    Date: "2026-03-01", "Transaction Type": type, Num: "1", Name: name, "Memo/Description": memo,
    Amount: amount, Customer: customer, section, rowType: "data",
  };
}

/** One project: a leadership paycheck, a bonus, an employee reimbursement,
 *  a manual check to an employee, contract labor, a vendor bill, an invoice. */
function fixture(extra: Record<string, string>[] = []): FlatReport {
  const rows = [
    row("Ordinary Income/Expenses > Income > Services", "Invoice", "Acme:Project X", "Phase 1", "10000.00"),
    row("Ordinary Income/Expenses > Expenses > Payroll Expenses > Wages", "Paycheck", "William Spence", "Wk 35", "1824.07"),
    row("Ordinary Income/Expenses > Expenses > Officer Bonus", "Journal Entry", "William Spence", "Q3 bonus", "5000.00"),
    row("Ordinary Income/Expenses > Expenses > Office Supplies", "Expense", "William Spence", "Reimb", "43.21"),
    row("Ordinary Income/Expenses > Expenses > Office Supplies", "Check", "William Spence", "Manual pay", "900.00"),
    row("Ordinary Income/Expenses > Expenses > Contract Labor", "Bill", "Temp Co", "Crew", "1200.00"),
    row("Ordinary Income/Expenses > Expenses > Office Supplies", "Bill", "Staples", "Paper", "100.00"),
    { ...row("Ordinary Income/Expenses > Expenses", "", "", "", "9067.28"), rowType: "summary" },
    ...extra,
  ];
  return { columns: COLUMNS, rows, truncated: false, totalRows: rows.length };
}

describe("belongsToProject", () => {
  it("accepts the project name, its FQN and its children", () => {
    expect(belongsToProject("Project X", project)).toBe(true);
    expect(belongsToProject("Acme:Project X", project)).toBe(true);
    expect(belongsToProject("Acme:Project X:Phase 2", project)).toBe(true);
  });
  it("rejects blanks, other customers and same-prefix siblings", () => {
    expect(belongsToProject("", project)).toBe(false);
    expect(belongsToProject("Acme:Project Y", project)).toBe(false);
    expect(belongsToProject("Acme:Project XL", project)).toBe(false);
  });
});

describe("computeProjectFinancials (with labor)", () => {
  const out = computeProjectFinancials(fixture(), project, period, ctx, true) as any;
  const text = JSON.stringify(out);

  it("never leaks an employee name, pay amount or pay memo", () => {
    for (const leak of ["William", "Spence", "1824.07", "5000", "43.21", "900", "Wk 35", "Q3 bonus", "Manual pay", "Temp Co"]) {
      expect(text).not.toContain(leak);
    }
  });
  it("labor carries only the total of exactly the labor lines", () => {
    expect(Object.keys(out.labor)).toEqual(["total"]);
    expect(out.labor.total).toBe(8967.28);
  });
  it("revenue and non-labor costs keep line detail; net subtracts both", () => {
    expect(out.revenue.total).toBe(10000);
    expect(out.revenue.lines).toHaveLength(1);
    expect(out.nonLaborCosts.lines.map((l: any) => l.name)).toEqual(["Staples"]);
    expect(out.nonLaborCosts.lines[0].account).toBe("Office Supplies");
    expect(out.nonLaborCosts.total).toBe(100);
    expect(out.net).toBe(932.72);
  });
});

describe("computeProjectFinancials (nonlabor)", () => {
  const out = computeProjectFinancials(fixture(), project, period, ctx, false) as any;
  it("has no labor key, and labor is excluded from every total", () => {
    expect(out).not.toHaveProperty("labor");
    expect(out).not.toHaveProperty("net");
    expect(out.netExcludingLabor).toBe(9900);
    expect(JSON.stringify(out)).not.toContain("8967");
  });
});

describe("computeProjectFinancials fails closed", () => {
  it("errors if any data row belongs to another customer", () => {
    const flat = fixture([row("Ordinary Income/Expenses > Expenses > Office Supplies", "Bill", "Staples", "", "5.00", "Other Co")]);
    expect(() => computeProjectFinancials(flat, project, period, ctx, true)).toThrow(FILTER_NOT_APPLIED);
  });
  it("errors if the Customer column is missing", () => {
    const flat = fixture();
    flat.columns = COLUMNS.filter((c) => c !== "Customer");
    expect(() => computeProjectFinancials(flat, project, period, ctx, true)).toThrow(ProjectFilterError);
  });
  it("errors if the report was truncated", () => {
    const flat = { ...fixture(), truncated: true };
    expect(() => computeProjectFinancials(flat, project, period, ctx, true)).toThrow(ProjectFilterError);
  });
});
