/**
 * Project financials for the gateway's payroll data tiers.
 *
 * PM and Staff roles never hold the general ledger, P&L detail, or employee
 * tools. These tools are how they see a project's money: revenue and non-labor
 * cost lines in full, labor only as ONE total (or not at all, for the
 * `_nonlabor` variant). Raw paycheck rows are fetched and classified here and
 * never leave the container.
 *
 * Fail closed: QuickBooks silently ignores a filter it does not recognise and
 * returns the whole company's report (docs/QBO_BACKEND.md §7 in the gateway).
 * Every data row is therefore checked against the requested project, and any
 * doubt is an error — never company-wide totals presented as a project's.
 */

import type { FlatReport } from "./report-rows.js";
import { isLaborLine, type LaborContext } from "./labor.js";

export interface ProjectRef {
  id: string;
  name: string;
  fullyQualifiedName: string;
}

export const FILTER_NOT_APPLIED =
  "project filter was not applied — refusing to return unfiltered data";

export class ProjectFilterError extends Error {}

export interface FinancialLine {
  date: string;
  type: string;
  num: string;
  name: string;
  memo: string;
  account: string;
  amount: number;
}

const SECTION_SEPARATOR = " > ";
const REVENUE_SECTION = /^(income|other income)$/i;

const COLUMN_PATTERNS = {
  date: /^date$/i,
  type: /^transaction type$/i,
  num: /^num$/i,
  name: /^name$/i,
  memo: /^memo/i,
  amount: /^amount$/i,
  customer: /^customer$/i,
} as const;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function findColumn(columns: string[], key: keyof typeof COLUMN_PATTERNS): string {
  const found = columns.find((c) => COLUMN_PATTERNS[key].test(c.trim()));
  if (!found) {
    throw new ProjectFilterError(
      `report has no ${key} column — cannot verify the project filter; ${FILTER_NOT_APPLIED}`
    );
  }
  return found;
}

export function belongsToProject(customer: string, project: ProjectRef): boolean {
  const c = customer.trim();
  if (!c) return false;
  const fqn = project.fullyQualifiedName.trim();
  return c === project.name.trim() || c === fqn || c.startsWith(`${fqn}:`);
}

/**
 * Blank amounts return null (the row is skipped). A non-empty amount that is
 * not a plain finite number, such as "$1,200.00" or "(100.00)", throws: a
 * silently dropped row would make the totals quietly disagree with the report.
 */
function parseAmount(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const n = Number(v.replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    throw new ProjectFilterError(
      `unrecognised amount "${v}" in report — refusing to return partial totals`
    );
  }
  return n;
}

export function computeProjectFinancials(
  flat: FlatReport,
  project: ProjectRef,
  period: { start: string; end: string },
  ctx: LaborContext,
  includeLabor: boolean
): object {
  if (flat.truncated) {
    throw new ProjectFilterError(
      `report was truncated at ${flat.rows.length} of ${flat.totalRows} rows — narrow the date range`
    );
  }
  const col = {
    date: findColumn(flat.columns, "date"),
    type: findColumn(flat.columns, "type"),
    num: findColumn(flat.columns, "num"),
    name: findColumn(flat.columns, "name"),
    memo: findColumn(flat.columns, "memo"),
    amount: findColumn(flat.columns, "amount"),
    customer: findColumn(flat.columns, "customer"),
  };

  const revenue: FinancialLine[] = [];
  const costs: FinancialLine[] = [];
  let labor = 0;

  for (const r of flat.rows) {
    if (r.rowType !== "data") continue;
    if (!belongsToProject(r[col.customer] ?? "", project)) {
      throw new ProjectFilterError(FILTER_NOT_APPLIED);
    }
    const amount = parseAmount(r[col.amount] ?? "");
    if (amount === null) continue;

    const section = r.section ?? "";
    const segments = section.split(SECTION_SEPARATOR).map((s) => s.trim());
    const line: FinancialLine = {
      date: r[col.date] ?? "",
      type: r[col.type] ?? "",
      num: r[col.num] ?? "",
      name: r[col.name] ?? "",
      memo: r[col.memo] ?? "",
      account: segments[segments.length - 1] ?? "",
      amount,
    };

    // Labor is checked FIRST, on every line: an employee-named or payroll-typed
    // line is labor even under an income or ordinary-expense account.
    if (isLaborLine({ section, name: line.name, txnType: line.type }, ctx)) {
      labor += amount;
    } else if (segments.some((s) => REVENUE_SECTION.test(s))) {
      revenue.push(line);
    } else {
      costs.push(line);
    }
  }

  const revenueTotal = round2(revenue.reduce((s, l) => s + l.amount, 0));
  const costTotal = round2(costs.reduce((s, l) => s + l.amount, 0));
  const base = {
    project: { id: project.id, name: project.name },
    period,
    revenue: { total: revenueTotal, lines: revenue },
    nonLaborCosts: { total: costTotal, lines: costs },
  };

  if (!includeLabor) {
    return { ...base, netExcludingLabor: round2(revenueTotal - costTotal) };
  }
  const laborTotal = round2(labor);
  return { ...base, labor: { total: laborTotal }, net: round2(revenueTotal - costTotal - laborTotal) };
}
