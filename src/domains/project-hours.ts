/**
 * Hours by person for one project — the PM tier's "who is working on my
 * project" view. Built field-by-field into a fresh object so that HourlyRate,
 * CostRate and Description can never ride along: nothing from the source
 * entity is spread into the output.
 *
 * Rows are matched to the project in code (CustomerRef.value === project.id)
 * rather than through a QBO query filter, so there is no filter for QuickBooks
 * to silently ignore.
 */

import type { ProjectRef } from "./project-financials.js";

export interface TimeActivityLite {
  TxnDate?: string;
  CustomerRef?: { value?: string };
  EmployeeRef?: { name?: string };
  VendorRef?: { name?: string };
  Hours?: number;
  Minutes?: number;
  StartTime?: string;
  EndTime?: string;
  BreakHours?: number;
  BreakMinutes?: number;
  BillableStatus?: string;
  HourlyRate?: number;
  CostRate?: number;
  Description?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function activityHours(a: TimeActivityLite): number {
  if (typeof a.Hours === "number" || typeof a.Minutes === "number") {
    return (a.Hours ?? 0) + (a.Minutes ?? 0) / 60;
  }
  if (a.StartTime && a.EndTime) {
    const span = (Date.parse(a.EndTime) - Date.parse(a.StartTime)) / 3_600_000;
    const breaks = (a.BreakHours ?? 0) + (a.BreakMinutes ?? 0) / 60;
    return Number.isFinite(span) ? Math.max(0, span - breaks) : 0;
  }
  return 0;
}

export function computeProjectHours(
  activities: TimeActivityLite[],
  project: ProjectRef,
  period: { start: string; end: string }
) {
  const byPerson = new Map<string, { hours: number; billableHours: number }>();
  for (const a of activities) {
    if (a.CustomerRef?.value !== project.id) continue;
    const name = a.EmployeeRef?.name ?? a.VendorRef?.name ?? "(unnamed)";
    const h = activityHours(a);
    const entry = byPerson.get(name) ?? { hours: 0, billableHours: 0 };
    entry.hours += h;
    if (a.BillableStatus === "Billable") entry.billableHours += h;
    byPerson.set(name, entry);
  }

  const people = [...byPerson.entries()]
    .map(([name, e]) => ({ name, hours: round2(e.hours), billableHours: round2(e.billableHours) }))
    .sort((x, y) => y.hours - x.hours);

  return {
    project: { id: project.id, name: project.name },
    period,
    people,
    totalHours: round2(people.reduce((s, p) => s + p.hours, 0)),
  };
}
