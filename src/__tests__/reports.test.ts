import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("QBO API minor version", () => {
  it("pins minorversion 75 — 1-74 were deprecated in August 2025", () => {
    // Asserted against the source rather than a live call: this is a pinned
    // constant, and IsProject (used by qbo_projects_list) is gated on it.
    const src = readFileSync(new URL("../utils/client.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const MINOR_VERSION = "75"/);
  });
});
