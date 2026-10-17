/**
 * Attachments domain — find receipts/files by the transaction they're on, or
 * by when they were added.
 *
 * The generated qbo_attachables_list can only page through every Attachable
 * oldest-first, and a transaction's own record doesn't say whether anything
 * is attached. Answering "which of these 38 charges have a receipt?" therefore
 * meant reading the company's entire attachment history. This tool asks QBO
 * the question directly:
 *
 *   SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = 'Purchase'
 *     AND AttachableRef.EntityRef.value = '123'
 *
 * Read-only (QBO SELECT only). Classifies as `read` in the gateway's RBAC —
 * its name carries the `search` verb.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../utils/client.js";
import { assertDate, assertPositiveInt, assertStartPosition } from "../utils/qbo-sql.js";

/** Most ids one call may check — each is its own QBO query. */
export const MAX_TRANSACTION_IDS = 100;

export const attachmentTools: Tool[] = [
  {
    name: "qbo_attachments_search",
    description:
      "Find file attachments (receipts, invoices, documents). Two modes: " +
      "(1) pass transactionType + transactionIds to check which of those transactions have files attached — " +
      "one call answers 'do these charges have receipts?'; " +
      "(2) omit transactionIds to list attachments by date added, newest first by default, " +
      "optionally limited with createdAfter/createdBefore.",
    inputSchema: {
      type: "object",
      properties: {
        transactionType: {
          type: "string",
          description:
            'QBO entity type the files are attached to, e.g. "Purchase" (expenses/credit-card charges), "Bill", "Invoice", "JournalEntry". Required with transactionIds.',
        },
        transactionIds: {
          type: "array",
          items: { type: "string" },
          description: `Transaction ids to check (max ${MAX_TRANSACTION_IDS}). Every id is returned, with an empty attachments list when nothing is attached.`,
        },
        createdAfter: {
          type: "string",
          description: "Date mode: only attachments added on or after this date (YYYY-MM-DD)",
        },
        createdBefore: {
          type: "string",
          description: "Date mode: only attachments added on or before this date (YYYY-MM-DD)",
        },
        newestFirst: {
          type: "boolean",
          description: "Date mode: newest first (default true)",
        },
        startPosition: { type: "number", description: "Date mode: 1-based offset (default 1)" },
        maxResults: { type: "number", description: "Date mode: page size (default 100, max 1000)" },
      },
    },
  },
];

interface QboAttachable {
  Id?: string;
  FileName?: string;
  ContentType?: string;
  Size?: number;
  Note?: string;
  Category?: string;
  MetaData?: { CreateTime?: string };
  AttachableRef?: { EntityRef?: { type?: string; value?: string } }[];
}

const summarize = (a: QboAttachable) => ({
  id: a.Id ?? "",
  fileName: a.FileName ?? null,
  contentType: a.ContentType ?? null,
  size: a.Size ?? null,
  note: a.Note ?? null,
  category: a.Category ?? null,
  createdAt: a.MetaData?.CreateTime ?? null,
  attachedTo: (a.AttachableRef ?? [])
    .map((r) => r.EntityRef)
    .filter((r): r is { type?: string; value?: string } => !!r)
    .map((r) => ({ type: r.type ?? null, id: r.value ?? null })),
});

const ENTITY_TYPE = /^[A-Za-z]{1,40}$/;
const ENTITY_ID = /^\d{1,20}$/;

/** Build the per-transaction query. Inputs are validated, never escaped. */
export function buildTransactionAttachmentsSql(type: string, id: string): string {
  if (!ENTITY_TYPE.test(type)) throw new Error(`Invalid transactionType: ${JSON.stringify(type)}`);
  if (!ENTITY_ID.test(id)) throw new Error(`Invalid transaction id: ${JSON.stringify(id)}`);
  return (
    `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '${type}' ` +
    `AND AttachableRef.EntityRef.value = '${id}'`
  );
}

/** Build the date-mode query (filter + order on MetaData.CreateTime). */
export function buildRecentAttachmentsSql(args: Record<string, unknown>): string {
  const conditions: string[] = [];
  if (args.createdAfter != null) {
    conditions.push(`MetaData.CreateTime >= '${assertDate(String(args.createdAfter), "createdAfter")}'`);
  }
  if (args.createdBefore != null) {
    // Inclusive of the whole day.
    conditions.push(
      `MetaData.CreateTime <= '${assertDate(String(args.createdBefore), "createdBefore")}T23:59:59'`
    );
  }
  const startPosition = assertStartPosition(args.startPosition ?? 1);
  const maxResults = assertPositiveInt(args.maxResults ?? 100, "maxResults");
  const order = args.newestFirst === false ? "ASC" : "DESC";
  let sql = "SELECT * FROM Attachable";
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += ` ORDERBY MetaData.CreateTime ${order} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
  return sql;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

async function queryAttachables(sql: string): Promise<QboAttachable[]> {
  const result = (await getClient().query(sql)) as {
    QueryResponse?: { Attachable?: QboAttachable[] };
  };
  return result?.QueryResponse?.Attachable ?? [];
}

export async function handleAttachmentTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (name !== "qbo_attachments_search") {
    return { content: [{ type: "text", text: `Unknown attachments tool: ${name}` }], isError: true };
  }

  if (args.transactionIds != null) {
    const ids = args.transactionIds;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === "string" || typeof i === "number")) {
      throw new Error("transactionIds must be a non-empty array of ids");
    }
    if (ids.length > MAX_TRANSACTION_IDS) {
      throw new Error(`transactionIds: at most ${MAX_TRANSACTION_IDS} per call, got ${ids.length}`);
    }
    if (typeof args.transactionType !== "string") {
      throw new Error('transactionType is required with transactionIds, e.g. "Purchase"');
    }
    const type = args.transactionType;
    const unique = [...new Set(ids.map(String))];
    // Validate everything before the first query, so a bad id never leaves a
    // half-answered batch.
    const queries = unique.map((id) => ({ id, sql: buildTransactionAttachmentsSql(type, id) }));

    const transactions = [];
    for (const { id, sql } of queries) {
      const attachments = (await queryAttachables(sql)).map(summarize);
      transactions.push({ transactionId: id, hasAttachment: attachments.length > 0, attachments });
    }
    return text({
      transactionType: type,
      checked: transactions.length,
      withAttachments: transactions.filter((t) => t.hasAttachment).length,
      transactions,
    });
  }

  const sql = buildRecentAttachmentsSql(args);
  const attachments = (await queryAttachables(sql)).map(summarize);
  return text({ count: attachments.length, attachments });
}
