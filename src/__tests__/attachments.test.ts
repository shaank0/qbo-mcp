import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: string[] = [];
let byId: Record<string, unknown[]> = {};
let recent: unknown[] = [];

vi.mock("../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/client.js")>()),
  getClient: () => ({
    query: async (sql: string) => {
      queries.push(sql);
      const m = sql.match(/EntityRef\.value = '(\d+)'/);
      return { QueryResponse: { Attachable: m ? byId[m[1]] ?? [] : recent } };
    },
  }),
}));

const {
  attachmentTools,
  handleAttachmentTool,
  buildRecentAttachmentsSql,
  buildTransactionAttachmentsSql,
  MAX_TRANSACTION_IDS,
} = await import("../domains/attachments.js");

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  queries.length = 0;
  byId = {};
  recent = [];
});

describe("qbo_attachments_search", () => {
  it("is one tool with a read verb in its name", () => {
    expect(attachmentTools.map((t) => t.name)).toEqual(["qbo_attachments_search"]);
  });

  it("checks each transaction and reports which have files", async () => {
    byId["101"] = [
      {
        Id: "9",
        FileName: "receipt.jpg",
        ContentType: "image/jpeg",
        MetaData: { CreateTime: "2026-09-01T10:00:00-07:00" },
        AttachableRef: [{ EntityRef: { type: "Purchase", value: "101" } }],
      },
    ];
    const out = parse(
      await handleAttachmentTool("qbo_attachments_search", {
        transactionType: "Purchase",
        transactionIds: ["101", "102", "101"],
      })
    );
    expect(queries).toEqual([
      "SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = 'Purchase' AND AttachableRef.EntityRef.value = '101'",
      "SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = 'Purchase' AND AttachableRef.EntityRef.value = '102'",
    ]);
    expect(out.checked).toBe(2);
    expect(out.withAttachments).toBe(1);
    expect(out.transactions[0]).toMatchObject({
      transactionId: "101",
      hasAttachment: true,
      attachments: [{ id: "9", fileName: "receipt.jpg", createdAt: "2026-09-01T10:00:00-07:00", attachedTo: [{ type: "Purchase", id: "101" }] }],
    });
    expect(out.transactions[1]).toEqual({ transactionId: "102", hasAttachment: false, attachments: [] });
  });

  it("accepts numeric ids", async () => {
    await handleAttachmentTool("qbo_attachments_search", { transactionType: "Bill", transactionIds: [7] });
    expect(queries[0]).toContain("EntityRef.value = '7'");
  });

  it("rejects injection-shaped input before running any query", async () => {
    await expect(
      handleAttachmentTool("qbo_attachments_search", { transactionType: "Purchase", transactionIds: ["1", "2' OR '1'='1"] })
    ).rejects.toThrow(/Invalid transaction id/);
    await expect(
      handleAttachmentTool("qbo_attachments_search", { transactionType: "Purchase'--", transactionIds: ["1"] })
    ).rejects.toThrow(/Invalid transactionType/);
    expect(queries).toEqual([]);
  });

  it("requires a type with ids, and caps the batch", async () => {
    await expect(handleAttachmentTool("qbo_attachments_search", { transactionIds: ["1"] })).rejects.toThrow(/transactionType is required/);
    await expect(handleAttachmentTool("qbo_attachments_search", { transactionType: "Purchase", transactionIds: [] })).rejects.toThrow(/non-empty/);
    const many = Array.from({ length: MAX_TRANSACTION_IDS + 1 }, (_, i) => String(i + 1));
    await expect(handleAttachmentTool("qbo_attachments_search", { transactionType: "Purchase", transactionIds: many })).rejects.toThrow(/at most/);
  });

  it("date mode lists newest first by default", async () => {
    recent = [{ Id: "50", FileName: "new.pdf" }];
    const out = parse(await handleAttachmentTool("qbo_attachments_search", { createdAfter: "2025-01-01" }));
    expect(queries[0]).toBe(
      "SELECT * FROM Attachable WHERE MetaData.CreateTime >= '2025-01-01' ORDERBY MetaData.CreateTime DESC STARTPOSITION 1 MAXRESULTS 100"
    );
    expect(out.count).toBe(1);
  });

  it("date mode builds range, ascending order, and offsets past 1000", () => {
    expect(
      buildRecentAttachmentsSql({ createdAfter: "2025-01-01", createdBefore: "2025-03-31", newestFirst: false, startPosition: 2001, maxResults: 500 })
    ).toBe(
      "SELECT * FROM Attachable WHERE MetaData.CreateTime >= '2025-01-01' AND MetaData.CreateTime <= '2025-03-31T23:59:59' ORDERBY MetaData.CreateTime ASC STARTPOSITION 2001 MAXRESULTS 500"
    );
    expect(() => buildRecentAttachmentsSql({ createdAfter: "Jan 1" })).toThrow(/YYYY-MM-DD/);
    expect(() => buildRecentAttachmentsSql({ maxResults: 1001 })).toThrow();
  });

  it("validates the per-transaction builder directly", () => {
    expect(() => buildTransactionAttachmentsSql("Purchase", "abc")).toThrow();
  });
});
