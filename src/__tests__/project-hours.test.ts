import { describe, it, expect } from "vitest";
import { activityHours, computeProjectHours } from "../domains/project-hours.js";

const project = { id: "77", name: "Project X", fullyQualifiedName: "Acme:Project X" };
const period = { start: "2026-01-01", end: "2026-09-30" };

const acts = [
  { CustomerRef: { value: "77" }, EmployeeRef: { name: "William Spence" }, Hours: 6, Minutes: 30, BillableStatus: "Billable", HourlyRate: 175, CostRate: 92.5, Description: "salary talk" },
  { CustomerRef: { value: "77" }, EmployeeRef: { name: "William Spence" }, StartTime: "2026-03-02T08:00:00-05:00", EndTime: "2026-03-02T17:00:00-05:00", BreakHours: 1, BillableStatus: "NotBillable" },
  { CustomerRef: { value: "77" }, VendorRef: { name: "Temp Co" }, Hours: 4 },
  { CustomerRef: { value: "88" }, EmployeeRef: { name: "Taylor" }, Hours: 40 },
];

describe("activityHours", () => {
  it("uses Hours+Minutes, else End-Start minus breaks, else 0", () => {
    expect(activityHours(acts[0])).toBe(6.5);
    expect(activityHours(acts[1])).toBe(8);
    expect(activityHours({})).toBe(0);
  });
});

describe("computeProjectHours", () => {
  const out = computeProjectHours(acts, project, period);
  const text = JSON.stringify(out);

  it("counts only this project's entries, per person, sorted by hours", () => {
    expect(out.people).toEqual([
      { name: "William Spence", hours: 14.5, billableHours: 6.5 },
      { name: "Temp Co", hours: 4, billableHours: 0 },
    ]);
    expect(out.totalHours).toBe(18.5);
    expect(text).not.toContain("Taylor");
  });
  it("never emits rates, dollars or descriptions", () => {
    for (const leak of ["175", "92.5", "Rate", "salary talk", "Description"]) {
      expect(text).not.toContain(leak);
    }
  });
});
