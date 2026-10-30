/** PurchaseOrder entity config — non-posting purchase orders sent to vendors. */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../utils/client.js";
import {
  assertDate,
  assertPositiveInt,
  assertStartPosition,
  buildLikeClause,
} from "../utils/qbo-sql.js";
import { jsonText } from "./generator.js";
import type { EntityConfig, EntityExtras, EntityField, ToolResult } from "./types.js";

const purchaseOrderFields: EntityField[] = [
  {
    name: "VendorRef",
    type: "object",
    required: true,
    description: 'Vendor receiving the PO, e.g. {"value": "56"}',
  },
  {
    name: "Line",
    type: "array",
    required: true,
    description:
      'PO lines, same shape as Bill.Line: {Amount, DetailType, AccountBasedExpenseLineDetail | ItemBasedExpenseLineDetail}.',
    items: { type: "object" },
  },
  { name: "TxnDate", type: "string", description: "PO date (YYYY-MM-DD)" },
  { name: "DueDate", type: "string", description: "Expected delivery date" },
  { name: "DocNumber", type: "string", description: "PO number" },
  {
    name: "POStatus",
    type: "string",
    description: 'Status: "Open" or "Closed"',
  },
  {
    name: "ShipAddr",
    type: "object",
    description: "Ship-to address (Line1, City, CountrySubDivisionCode, PostalCode)",
  },
  {
    name: "VendorAddr",
    type: "object",
    description: "Vendor address override",
  },
  { name: "Memo", type: "string", description: "Memo printed on the PO" },
  { name: "PrivateNote", type: "string", description: "Private internal note" },
];

export const purchaseOrderConfig: EntityConfig = {
  name: "PurchaseOrder",
  toolPrefix: "qbo_purchase_orders",
  description:
    "Purchase orders - list, get, create, update, search, close, and delete (with preview/confirm) non-posting POs to vendors",
  list: { dateRange: true },
  get: { idParam: "purchaseOrderId" },
  create: { fields: purchaseOrderFields },
  update: { idParam: "purchaseOrderId", fields: purchaseOrderFields },
};

// ---------------------------------------------------------------------------
// Fork additions (gateway): search, close, and a server-enforced two-step
// delete. Tool names carry the verb the MCP gateway's RBAC classifier reads:
// `search` → read, `close` → modify (unknown verb), `delete` → delete.
// ---------------------------------------------------------------------------

/** Most vendors a `vendorName` filter may resolve to before we ask to narrow. */
export const MAX_VENDOR_MATCHES = 100;

const PO_STATUSES = ["Open", "Closed"] as const;

interface PurchaseOrderRecord {
  Id?: string;
  SyncToken?: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  POStatus?: string;
  VendorRef?: { value?: string; name?: string };
  Line?: Array<Record<string, unknown>>;
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
}

const searchTool: Tool = {
  name: "qbo_purchase_orders_search",
  description:
    "Search purchase orders by vendor (name contains and/or vendor id), PO number (contains), status (Open/Closed), TxnDate range, and total amount range. All filters are optional and combine with AND; with none it lists every PO. Read-only.",
  annotations: {
    title: "Search purchase orders",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      vendorName: {
        type: "string",
        description:
          "Vendor display name contains this text (case-insensitive LIKE '%text%'; '%' is ignored). Resolved to vendor ids first.",
      },
      vendorId: { type: "string", description: "Exact vendor id (VendorRef value)" },
      docNumber: {
        type: "string",
        description: "PO number (DocNumber) contains this text",
      },
      status: {
        type: "string",
        enum: [...PO_STATUSES],
        description: "PO status (POStatus)",
      },
      startDate: { type: "string", description: "TxnDate on or after (YYYY-MM-DD)" },
      endDate: { type: "string", description: "TxnDate on or before (YYYY-MM-DD)" },
      minAmount: { type: "number", description: "TotalAmt greater than or equal to" },
      maxAmount: { type: "number", description: "TotalAmt less than or equal to" },
      startPosition: {
        type: "number",
        description: "Starting position for pagination (1-based, default: 1)",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default: 100, max: 1000)",
      },
    },
  },
};

const closeTool: Tool = {
  name: "qbo_purchase_orders_close",
  description:
    "Close an open purchase order (sets POStatus to Closed). Fetches the current SyncToken itself. Refuses a PO that is already closed. Returns the closed PO's id, number, vendor, total and status.",
  annotations: {
    title: "Close purchase order",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      purchaseOrderId: { type: "string", description: "The PurchaseOrder ID to close" },
    },
    required: ["purchaseOrderId"],
  },
};

const deleteTool: Tool = {
  name: "qbo_purchase_orders_delete",
  description:
    "Permanently delete a purchase order. Two steps, enforced by the server: " +
    "(1) call with just purchaseOrderId — nothing is deleted; you get a preview (number, vendor, date, total, status, lines, SyncToken). " +
    "Show it to the user. (2) Only after they agree, call again with confirm: true and expected_sync_token set to the preview's syncToken. " +
    "If the PO changed since the preview, the delete is refused.",
  annotations: {
    title: "Delete purchase order",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      purchaseOrderId: { type: "string", description: "The PurchaseOrder ID to delete" },
      confirm: {
        type: "boolean",
        description:
          "Must be exactly true to delete. Omit (or false) to get the preview only.",
      },
      expected_sync_token: {
        type: "string",
        description:
          "Required with confirm: true — the syncToken from the preview. A mismatch means the PO changed and the delete is refused.",
      },
    },
    required: ["purchaseOrderId"],
  },
};

function requireId(args: Record<string, unknown>): string {
  const id = args.purchaseOrderId;
  if (typeof id !== "string" || !/^\d+$/.test(id)) {
    throw new Error(
      `Invalid purchaseOrderId: expected a numeric id string, got ${JSON.stringify(id)}`
    );
  }
  return id;
}

function assertVendorId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(
      `Invalid vendorId: expected a numeric id string, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

function assertAmount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field}: expected a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function errorText(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function fetchPurchaseOrder(id: string): Promise<PurchaseOrderRecord> {
  const result = (await getClient().get(`purchaseorder/${id}`)) as {
    PurchaseOrder?: PurchaseOrderRecord;
  } | null;
  const record = result?.PurchaseOrder;
  if (!record) throw new Error(`PurchaseOrder ${id} not found`);
  return record;
}

function summarize(record: PurchaseOrderRecord) {
  return {
    id: record.Id,
    docNumber: record.DocNumber,
    vendor: { id: record.VendorRef?.value, name: record.VendorRef?.name },
    totalAmt: record.TotalAmt,
    status: record.POStatus,
    syncToken: record.SyncToken,
  };
}

function summarizeLine(line: Record<string, unknown>) {
  const out: Record<string, unknown> = { amount: line.Amount };
  if (typeof line.Description === "string") out.description = line.Description;
  const item = line.ItemBasedExpenseLineDetail as
    | { ItemRef?: { name?: string; value?: string }; Qty?: number }
    | undefined;
  const account = line.AccountBasedExpenseLineDetail as
    | { AccountRef?: { name?: string; value?: string } }
    | undefined;
  if (item) {
    out.item = item.ItemRef?.name ?? item.ItemRef?.value;
    if (item.Qty !== undefined) out.qty = item.Qty;
  }
  if (account) out.account = account.AccountRef?.name ?? account.AccountRef?.value;
  return out;
}

/** Vendor ids whose DisplayName contains `name`. Throws when too broad. */
async function resolveVendorIds(name: string): Promise<string[]> {
  const sql = `SELECT Id FROM Vendor WHERE ${buildLikeClause("DisplayName", name)} MAXRESULTS ${MAX_VENDOR_MATCHES + 1}`;
  const result = (await getClient().query(sql)) as {
    QueryResponse?: { Vendor?: Array<{ Id?: string }> };
  } | null;
  const ids = (result?.QueryResponse?.Vendor ?? [])
    .map((v) => v.Id)
    .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id));
  if (ids.length > MAX_VENDOR_MATCHES) {
    throw new Error(
      `vendorName ${JSON.stringify(name)} matches more than ${MAX_VENDOR_MATCHES} vendors — use a longer name or vendorId.`
    );
  }
  return ids;
}

async function searchPurchaseOrders(args: Record<string, unknown>): Promise<ToolResult> {
  // Validate everything before any QBO call.
  const startPosition = assertStartPosition(args.startPosition ?? 1);
  const maxResults = assertPositiveInt(args.maxResults ?? 100, "maxResults");
  const vendorId = args.vendorId !== undefined ? assertVendorId(args.vendorId) : undefined;
  if (args.status !== undefined && !PO_STATUSES.includes(args.status as never)) {
    throw new Error(
      `Invalid status: expected "Open" or "Closed", got ${JSON.stringify(args.status)}`
    );
  }
  const startDate =
    args.startDate !== undefined ? assertDate(String(args.startDate), "startDate") : undefined;
  const endDate =
    args.endDate !== undefined ? assertDate(String(args.endDate), "endDate") : undefined;
  const minAmount =
    args.minAmount !== undefined ? assertAmount(args.minAmount, "minAmount") : undefined;
  const maxAmount =
    args.maxAmount !== undefined ? assertAmount(args.maxAmount, "maxAmount") : undefined;
  const vendorName =
    typeof args.vendorName === "string" && args.vendorName.trim() !== ""
      ? args.vendorName
      : undefined;
  const docNumber =
    typeof args.docNumber === "string" && args.docNumber.trim() !== ""
      ? args.docNumber
      : undefined;

  const conditions: string[] = [];
  if (vendorName !== undefined) {
    let ids = await resolveVendorIds(vendorName);
    if (vendorId !== undefined) ids = ids.filter((id) => id === vendorId);
    if (ids.length === 0) {
      return jsonText({
        QueryResponse: { PurchaseOrder: [] },
        note: `No vendor matches ${JSON.stringify(vendorName)}${vendorId ? ` with id ${vendorId}` : ""}.`,
      });
    }
    conditions.push(`VendorRef IN (${ids.map((id) => `'${id}'`).join(", ")})`);
  } else if (vendorId !== undefined) {
    conditions.push(`VendorRef = '${vendorId}'`);
  }
  if (docNumber !== undefined) conditions.push(buildLikeClause("DocNumber", docNumber));
  if (args.status !== undefined) conditions.push(`POStatus = '${args.status as string}'`);
  if (startDate) conditions.push(`TxnDate >= '${startDate}'`);
  if (endDate) conditions.push(`TxnDate <= '${endDate}'`);
  if (minAmount !== undefined) conditions.push(`TotalAmt >= '${minAmount}'`);
  if (maxAmount !== undefined) conditions.push(`TotalAmt <= '${maxAmount}'`);

  let sql = "SELECT * FROM PurchaseOrder";
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += ` STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
  return jsonText(await getClient().query(sql));
}

async function closePurchaseOrder(args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireId(args);
  const current = await fetchPurchaseOrder(id);
  if (current.POStatus === "Closed") {
    return errorText(
      `PurchaseOrder ${id} (${current.DocNumber ?? "no number"}) is already closed; nothing was changed.`
    );
  }
  const result = (await getClient().post("purchaseorder", {
    Id: id,
    SyncToken: current.SyncToken,
    sparse: true,
    POStatus: "Closed",
  })) as { PurchaseOrder?: PurchaseOrderRecord } | null;
  return jsonText({ closed: true, purchaseOrder: summarize(result?.PurchaseOrder ?? current) });
}

async function deletePurchaseOrder(args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireId(args);
  // Only the boolean `true` deletes — never "true", 1, or any truthy value.
  const confirmed = args.confirm === true;

  if (confirmed && typeof args.expected_sync_token !== "string") {
    return errorText(
      "Refusing to delete: confirm: true requires expected_sync_token (the syncToken from the preview). Call without confirm first to get the preview."
    );
  }

  // Always re-read: the preview needs it, and the confirm step must compare
  // against the PO as it is NOW, not as the caller remembers it.
  const current = await fetchPurchaseOrder(id);

  if (!confirmed) {
    const linked = (current.LinkedTxn ?? []).map((t) => ({ id: t.TxnId, type: t.TxnType }));
    const preview: Record<string, unknown> = {
      id: current.Id,
      docNumber: current.DocNumber,
      vendor: { id: current.VendorRef?.value, name: current.VendorRef?.name },
      txnDate: current.TxnDate,
      totalAmt: current.TotalAmt,
      status: current.POStatus,
      syncToken: current.SyncToken,
      lineCount: current.Line?.length ?? 0,
      lines: (current.Line ?? []).map(summarizeLine),
    };
    if (linked.length > 0) preview.linkedTransactions = linked;
    const out: Record<string, unknown> = {
      deleted: false,
      preview,
      next: `Nothing was deleted. To delete this purchase order, show this preview to the user and, only if they agree, call qbo_purchase_orders_delete again with purchaseOrderId: "${id}", confirm: true, expected_sync_token: "${current.SyncToken}".`,
    };
    if (linked.length > 0) {
      out.warning =
        "This PO is linked to other transactions; QuickBooks may refuse the delete or the links will be removed.";
    }
    return jsonText(out);
  }

  if (current.SyncToken !== args.expected_sync_token) {
    return errorText(
      `Refusing to delete: PurchaseOrder ${id} has changed since the preview (SyncToken is now ${current.SyncToken}, expected ${args.expected_sync_token as string}). Nothing was deleted — preview it again.`
    );
  }

  const result = await getClient().post(
    "purchaseorder",
    { Id: id, SyncToken: current.SyncToken },
    { operation: "delete" }
  );
  return jsonText({ deleted: true, purchaseOrder: summarize(current), response: result });
}

export const purchaseOrderExtras: EntityExtras = {
  tools: [searchTool, closeTool, deleteTool],
  handlers: {
    qbo_purchase_orders_search: searchPurchaseOrders,
    qbo_purchase_orders_close: closePurchaseOrder,
    qbo_purchase_orders_delete: deletePurchaseOrder,
  },
};
