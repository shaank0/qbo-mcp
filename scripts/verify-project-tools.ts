/**
 * Manual live check for the payroll-tier project tools.
 *
 * Run against a realm with a project that has both labor and non-labor costs:
 *   QBO_ACCESS_TOKEN=... QBO_REALM_ID=... QBO_ENV=production \
 *   PROJECT_ID=123 PROBE_START=2026-01-01 PROBE_END=2026-09-30 \
 *     npx tsx scripts/verify-project-tools.ts
 *
 * PASS means: each tool returned data (the filter verified and the Customer
 * column came back). Then reconcile the printed totals BY HAND against the
 * QuickBooks UI's Project → Profit and Loss for the same dates. A tool error
 * containing "project filter was not applied" means QBO ignored `customer` or
 * `columns` — fix PNL_DETAIL_COLUMNS / params in src/domains/project-financials.ts.
 *
 * A thrown "QuickBooks request failed" error means an API or auth problem
 * (bad token, wrong realm, QBO fault), NOT a filter problem. Upstream fault
 * bodies are withheld by design, so check the token, realm and QBO_ENV first.
 *
 * Exit: 0 all three returned data; 1 any tool failed (returned isError or threw),
 * or PROJECT_ID was missing or not numeric.
 */
import { handleProjectFinancialsTool } from "../src/domains/project-financials.js";

const projectId = process.env.PROJECT_ID ?? "";
if (!/^\d+$/.test(projectId)) {
  console.error("PROJECT_ID must be set to a numeric QuickBooks project (customer) id. Nothing was called.");
  process.exit(1);
}

const args = {
  project_id: projectId,
  start_date: process.env.PROBE_START ?? `${new Date().getFullYear()}-01-01`,
  end_date: process.env.PROBE_END ?? `${new Date().getFullYear()}-12-31`,
};

let failed = false;
for (const tool of ["qbo_project_get_financials", "qbo_project_get_financials_nonlabor", "qbo_project_get_hours"]) {
  try {
    const res = await handleProjectFinancialsTool(tool, args);
    if (res.isError) {
      failed = true;
      console.log(`❌ ${tool}: ${res.content[0].text}`);
      continue;
    }
    const out = JSON.parse(res.content[0].text);
    const summary =
      tool === "qbo_project_get_hours"
        ? { people: out.people.length, totalHours: out.totalHours }
        : {
            revenue: out.revenue.total,
            nonLaborCosts: out.nonLaborCosts.total,
            ...(out.labor ? { labor: out.labor.total, net: out.net } : { netExcludingLabor: out.netExcludingLabor }),
          };
    console.log(`✅ ${tool}`, summary);
  } catch (err) {
    failed = true;
    console.log(`❌ ${tool}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed ? 1 : 0);
