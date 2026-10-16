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

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getClient, QboApiError } from "../utils/client.js";
import { flattenReport, type FlatReport } from "./report-rows.js";
import { assertDate, escapeQboString } from "../utils/qbo-sql.js";
import {
  buildLaborContext,
  isLaborLine,
  parseExtraLaborAccounts,
  type LaborContext,
  type QboAccountLite,
  type QboEmployeeLite,
} from "./labor.js";
import { computeProjectHours, type TimeActivityLite } from "./project-hours.js";

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
      "unrecognised amount format in report — refusing to return partial totals"
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

const PROJECT_ARGS = {
  type: "object" as const,
  properties: {
    project_id: { type: "string", description: "QuickBooks project (customer) id — see qbo_projects_list" },
    start_date: { type: "string", description: "YYYY-MM-DD" },
    end_date: { type: "string", description: "YYYY-MM-DD" },
  },
  required: ["project_id", "start_date", "end_date"],
};

export const projectFinancialsTools: Tool[] = [
  {
    name: "qbo_project_get_financials",
    description:
      "Project financials for one project and period: revenue lines, non-labor cost lines, and labor as a SINGLE total. Individual pay, paychecks and employee names are never returned.",
    inputSchema: {
      ...PROJECT_ARGS,
      properties: {
        ...PROJECT_ARGS.properties,
        accounting_method: { type: "string", enum: ["Cash", "Accrual"] },
      },
    },
  },
  {
    name: "qbo_project_get_financials_nonlabor",
    description:
      "Project revenue and non-labor cost lines for one project and period. Labor is excluded entirely; netExcludingLabor is NOT the project's profit.",
    inputSchema: {
      ...PROJECT_ARGS,
      properties: {
        ...PROJECT_ARGS.properties,
        accounting_method: { type: "string", enum: ["Cash", "Accrual"] },
      },
    },
  },
  {
    name: "qbo_project_get_hours",
    description:
      "Hours logged on one project per person (from time entries) for a period. Never returns pay or billing rates. Counts only time logged directly against this project id (not sub-projects).",
    inputSchema: PROJECT_ARGS,
  },
];

/** Columns requested from ProfitAndLossDetail. `cust_name` is what lets every
 *  row be checked against the project; if QBO drops it, computeProjectFinancials
 *  errors rather than skip the check. */
const PNL_DETAIL_COLUMNS = "tx_date,txn_type,doc_num,name,memo,subt_nat_amount,cust_name";

/** Large enough for a project-year of detail; computeProjectFinancials errors if exceeded. */
const MAX_DETAIL_ROWS = 50_000;

function parseProjectArgs(args: Record<string, unknown>) {
  if (args.accounting_method !== undefined && args.accounting_method !== "Cash" && args.accounting_method !== "Accrual") {
    throw new Error('accounting_method must be "Cash" or "Accrual"');
  }
  const id = String(args.project_id ?? "");
  if (!/^\d+$/.test(id)) throw new Error("project_id must be a numeric QuickBooks id");
  const start = assertDate(String(args.start_date ?? ""), "start_date");
  const end = assertDate(String(args.end_date ?? ""), "end_date");
  return { id, period: { start, end } };
}

async function loadProject(id: string): Promise<ProjectRef> {
  const res = (await getClient().query(
    `SELECT * FROM Customer WHERE Id = '${escapeQboString(id)}'`
  )) as { QueryResponse?: { Customer?: { Id?: string; DisplayName?: string; FullyQualifiedName?: string }[] } };
  const c = res?.QueryResponse?.Customer?.[0];
  if (!c?.Id) throw new Error(`No QuickBooks project or customer with id ${id}`);
  return { id: c.Id, name: c.DisplayName ?? "", fullyQualifiedName: c.FullyQualifiedName ?? c.DisplayName ?? "" };
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

async function runProjectTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const { id, period } = parseProjectArgs(args);
  const client = getClient();
  const project = await loadProject(id);

  if (name === "qbo_project_get_hours") {
    const acts = (await client.getPaginated(
      `SELECT * FROM TimeActivity WHERE TxnDate >= '${period.start}' AND TxnDate <= '${period.end}'`
    )) as TimeActivityLite[];
    return text(computeProjectHours(acts, project, period));
  }

  if (name !== "qbo_project_get_financials" && name !== "qbo_project_get_financials_nonlabor") {
    return { content: [{ type: "text", text: `Unknown project tool: ${name}` }], isError: true };
  }

  // Inactive rows matter: a departed executive's paychecks and a retired bonus
  // account must still be recognised as labor.
  const [accounts, employees] = await Promise.all([
    client.getPaginated("SELECT * FROM Account WHERE Active IN (true, false)") as Promise<QboAccountLite[]>,
    client.getPaginated("SELECT * FROM Employee WHERE Active IN (true, false)") as Promise<QboEmployeeLite[]>,
  ]);
  const ctx = buildLaborContext(accounts, employees, parseExtraLaborAccounts(process.env.QBO_EXTRA_LABOR_ACCOUNTS));

  const params: Record<string, string> = {
    start_date: period.start,
    end_date: period.end,
    customer: project.id,
    columns: PNL_DETAIL_COLUMNS,
  };
  if (args.accounting_method === "Cash" || args.accounting_method === "Accrual") {
    params.accounting_method = String(args.accounting_method);
  }
  const flat = flattenReport(await client.get("reports/ProfitAndLossDetail", params), MAX_DETAIL_ROWS);

  try {
    return text(
      computeProjectFinancials(flat, project, period, ctx, name === "qbo_project_get_financials")
    );
  } catch (err) {
    if (err instanceof ProjectFilterError) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    throw err;
  }
}

export async function handleProjectFinancialsTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    return await runProjectTool(name, args);
  } catch (err) {
    // Upstream fault bodies must not pass through a payroll-sensitive tool.
    if (err instanceof QboApiError) {
      // Rebuilt with an empty body: the response body is withheld, but the
      // error stays a QboApiError so a 401 still gets mcp-server's
      // QBO_UNAUTHORIZED: prefix (the gateway's refresh-and-retry signal).
      throw new QboApiError(err.status, err.method, err.path, "");
    }
    throw err;
  }
}
