/**
 * Labor classification for the payroll-tier project tools.
 *
 * The gateway's PM and Staff roles may see project financials but never an
 * individual's pay. The project tools therefore sort every P&L-detail line into
 * labor / non-labor INSIDE this container and only ever return labor as one
 * total. This module decides "is this line labor?".
 *
 * The rule is a deliberate UNION — any one signal makes a line labor — because
 * a mis-filed paycheck shown as a cost line is a leak, while a mis-filed vendor
 * bill folded into the labor total is merely a less detailed report.
 */

export interface QboAccountLite {
  Id?: string;
  Name?: string;
  FullyQualifiedName?: string;
  AccountSubType?: string;
}

export interface QboEmployeeLite {
  Id?: string;
  DisplayName?: string;
  GivenName?: string;
  FamilyName?: string;
}

export interface LaborContext {
  /** Lower-cased leaf names AND fully-qualified names of labor accounts. */
  laborAccountKeys: Set<string>;
  /** Lower-cased employee display names (and "given family"). */
  employeeNames: Set<string>;
}

/** QBO AccountSubType values that hold pay. Unknown strings are harmless. */
export const LABOR_ACCOUNT_SUBTYPES = new Set([
  "PayrollExpenses",
  "PayrollTaxExpenses",
  "CostOfLabor",
  "CostOfLaborCos",
  "OfficersCompensation",
  "GuaranteedPayments",
]);

/** Account-name signals, for pay booked to a generically-typed account. */
// Word-bounded so "Meals & Beverages" is not "wage"; 401(k) is matched apart
// because \b cannot follow ")".
const LABOR_ACCOUNT_NAME =
  /\b(payroll|wages?|salary|salaries|bonus|bonuses|compensation|pension|commissions?|employee benefits?)\b|401\s*\(?k\)?/i;

/** Transaction types that are always payroll. */
const LABOR_TXN_TYPE = /paycheck|payroll/i;

const SECTION_SEPARATOR = " > ";

const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

export function parseExtraLaborAccounts(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function buildLaborContext(
  accounts: QboAccountLite[],
  employees: QboEmployeeLite[],
  extraAccountIds: Set<string>
): LaborContext {
  const laborAccountKeys = new Set<string>();
  for (const a of accounts) {
    const labor =
      LABOR_ACCOUNT_SUBTYPES.has(a.AccountSubType ?? "") ||
      extraAccountIds.has(a.Id ?? "") ||
      LABOR_ACCOUNT_NAME.test(a.Name ?? "") ||
      LABOR_ACCOUNT_NAME.test(a.FullyQualifiedName ?? "");
    if (!labor) continue;
    if (norm(a.Name)) laborAccountKeys.add(norm(a.Name));
    if (norm(a.FullyQualifiedName)) laborAccountKeys.add(norm(a.FullyQualifiedName));
  }

  const employeeNames = new Set<string>();
  for (const e of employees) {
    if (norm(e.DisplayName)) employeeNames.add(norm(e.DisplayName));
    const full = norm(`${e.GivenName ?? ""} ${e.FamilyName ?? ""}`);
    if (full) employeeNames.add(full);
  }

  return { laborAccountKeys, employeeNames };
}

export function isLaborLine(
  line: { section: string; name: string; txnType: string },
  ctx: LaborContext
): boolean {
  if (LABOR_TXN_TYPE.test(line.txnType)) return true;
  if (norm(line.name) && ctx.employeeNames.has(norm(line.name))) return true;

  // P&L detail nests account sections ("Expenses > Payroll Expenses > Wages"),
  // so ANY segment matching a labor account — or a labor-sounding name —
  // makes the line labor. That also covers children of a labor parent.
  const segments = line.section.split(SECTION_SEPARATOR).map(norm).filter(Boolean);
  return segments.some((s) => ctx.laborAccountKeys.has(s) || LABOR_ACCOUNT_NAME.test(s));
}
