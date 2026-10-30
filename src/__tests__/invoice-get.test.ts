import { describe, it, expect, vi } from "vitest";

const { query, post, get } = vi.hoisted(() => ({
  query: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../utils/client.js", () => ({
  getClient: () => ({ query, post, get }),
}));

import { makeEntityDispatcher } from "../entities/generator.js";
import { invoiceConfig, invoiceExtras } from "../entities/invoice.js";

const dispatch = makeEntityDispatcher(invoiceConfig, invoiceExtras);

// Gateway clients (Claude, ChatGPT) read the text content, not always
// structuredContent — so the full invoice must be in the text too, or the
// assistant sees only "Retrieved invoice #1001".
describe("qbo_invoices_get", () => {
  it("returns the full invoice in the text content, not just a summary", async () => {
    get.mockResolvedValueOnce({
      Invoice: {
        Id: "5",
        DocNumber: "1001",
        TotalAmt: 300,
        Balance: 120,
        CustomerRef: { value: "3", name: "Contoso" },
        Line: [{ Amount: 300, Description: "Managed services" }],
      },
    });
    const res = (await dispatch("qbo_invoices_get", { invoiceId: "5" })) as {
      content: { type: string; text: string }[];
      structuredContent: Record<string, unknown>;
    };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("Retrieved invoice #1001 (balance: 120).");
    expect(text).toContain("Managed services");
    expect(text).toContain("Contoso");
    expect(text).not.toContain("_card");
    expect(res.structuredContent.Invoice).toBeDefined();
  });
});
