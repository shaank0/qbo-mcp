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

/** Capture the path + params handed to the QBO client. */
function captureClient() {
  const calls: { path: string; params: Record<string, string> }[] = [];
  vi.doMock("../utils/client.js", () => ({
    getClient: () => ({
      get: async (path: string, params: Record<string, string>) => {
        calls.push({ path, params });
        return { Header: { ReportName: "x" }, Columns: { Column: [] }, Rows: {} };
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
