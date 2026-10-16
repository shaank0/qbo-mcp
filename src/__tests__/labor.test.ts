import { describe, it, expect } from "vitest";
import { buildLaborContext, isLaborLine, parseExtraLaborAccounts } from "../domains/labor.js";

const accounts = [
  { Id: "1", Name: "Payroll Expenses", FullyQualifiedName: "Payroll Expenses", AccountSubType: "PayrollExpenses" },
  { Id: "2", Name: "Wages", FullyQualifiedName: "Payroll Expenses:Wages", AccountSubType: "PayrollExpenses" },
  { Id: "3", Name: "Office Supplies", FullyQualifiedName: "Office Supplies", AccountSubType: "SuppliesMaterials" },
  { Id: "4", Name: "Executive Incentive", FullyQualifiedName: "Executive Incentive", AccountSubType: "OtherMiscellaneousServiceCost" },
  { Id: "5", Name: "Contract Labor", FullyQualifiedName: "Contract Labor", AccountSubType: "OtherMiscellaneousServiceCost" },
  { Id: "6", Name: "Officer Bonus", FullyQualifiedName: "Officer Bonus", AccountSubType: "OtherMiscellaneousServiceCost" },
  { Id: "7", Name: "Direct Labor", FullyQualifiedName: "Direct Labor", AccountSubType: "CostOfLaborCos" },
];
const employees = [{ Id: "654", DisplayName: "William Spence", GivenName: "William", FamilyName: "Spence" }];

describe("parseExtraLaborAccounts", () => {
  it("splits, trims and drops empties", () => {
    expect([...parseExtraLaborAccounts(" 5, ,9 ")]).toEqual(["5", "9"]);
    expect(parseExtraLaborAccounts(undefined).size).toBe(0);
  });
});

describe("isLaborLine", () => {
  const ctx = buildLaborContext(accounts, employees, new Set(["5"]));
  const line = (section: string, name = "Staples", txnType = "Bill") => ({ section, name, txnType });

  it("labor by account subtype, including a child section under a labor parent", () => {
    expect(isLaborLine(line("Expenses > Payroll Expenses > Wages"), ctx)).toBe(true);
    expect(isLaborLine(line("Cost of Goods Sold > Direct Labor"), ctx)).toBe(true);
  });
  it("labor by operator-listed extra account id", () => {
    expect(isLaborLine(line("Expenses > Contract Labor"), ctx)).toBe(true);
  });
  it("labor by account-name pattern (bonus/salary/wage/payroll/compensation)", () => {
    expect(isLaborLine(line("Expenses > Officer Bonus"), ctx)).toBe(true);
  });
  it("labor when the Name is an employee, on any account (reimbursement)", () => {
    expect(isLaborLine(line("Expenses > Office Supplies", "William Spence", "Expense"), ctx)).toBe(true);
    expect(isLaborLine(line("Expenses > Office Supplies", "  william spence ", "Check"), ctx)).toBe(true);
  });
  it("labor by payroll transaction type", () => {
    expect(isLaborLine(line("Expenses > Office Supplies", "", "Paycheck"), ctx)).toBe(true);
    expect(isLaborLine(line("Expenses > Office Supplies", "", "Payroll Adjustment"), ctx)).toBe(true);
  });
  it("not labor: an ordinary vendor bill, or a name that merely contains a pay word", () => {
    expect(isLaborLine(line("Expenses > Office Supplies"), ctx)).toBe(false);
    expect(isLaborLine(line("Expenses > Meals & Beverages"), ctx)).toBe(false);
    expect(isLaborLine(line("Expenses > Executive Incentive Travel"), ctx)).toBe(false);
  });
});
