import { describe, it, expect, vi, beforeEach } from "vitest";

const { query, post, get } = vi.hoisted(() => ({
  query: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../utils/client.js", () => ({
  getClient: () => ({ query, post, get }),
}));

import { makeEntityDispatcher, entityTools } from "../entities/generator.js";
import {
  purchaseOrderConfig,
  purchaseOrderExtras,
  MAX_VENDOR_MATCHES,
} from "../entities/purchase-order.js";

const dispatch = makeEntityDispatcher(purchaseOrderConfig, purchaseOrderExtras);
const tools = entityTools(purchaseOrderConfig, purchaseOrderExtras);

function po(overrides: Record<string, unknown> = {}) {
  return {
    Id: "42",
    SyncToken: "3",
    DocNumber: "PO-1001",
    TxnDate: "2026-10-01",
    TotalAmt: 250.5,
    POStatus: "Open",
    VendorRef: { value: "7", name: "Acme Supply" },
    Line: [
      {
        Amount: 200,
        Description: "Widgets",
        DetailType: "ItemBasedExpenseLineDetail",
        ItemBasedExpenseLineDetail: { ItemRef: { value: "1", name: "Widget" }, Qty: 4 },
      },
      {
        Amount: 50.5,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: "9", name: "Freight" } },
      },
    ],
    ...overrides,
  };
}

function payload(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  query.mockReset();
  post.mockReset();
  get.mockReset();
});

describe("purchase-order tool surface", () => {
  it("adds search, close and delete alongside the generated CRUD tools", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "qbo_purchase_orders_list",
      "qbo_purchase_orders_get",
      "qbo_purchase_orders_create",
      "qbo_purchase_orders_update",
      "qbo_purchase_orders_search",
      "qbo_purchase_orders_close",
      "qbo_purchase_orders_delete",
    ]);
  });

  it("annotates search read-only, close idempotent, delete destructive", () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.qbo_purchase_orders_search.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(byName.qbo_purchase_orders_close.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.qbo_purchase_orders_delete.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("delete schema requires the id and exposes confirm + expected_sync_token", () => {
    const del = tools.find((t) => t.name === "qbo_purchase_orders_delete")!;
    const schema = del.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["purchaseOrderId"]);
    expect(schema.properties).toHaveProperty("confirm");
    expect(schema.properties).toHaveProperty("expected_sync_token");
  });
});

describe("qbo_purchase_orders_search", () => {
  it("lists every PO when no filter is given", async () => {
    query.mockResolvedValueOnce({ QueryResponse: { PurchaseOrder: [po()] } });
    await dispatch("qbo_purchase_orders_search", {});
    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM PurchaseOrder STARTPOSITION 1 MAXRESULTS 100"
    );
  });

  it("combines id, number, status, date and amount filters", async () => {
    query.mockResolvedValueOnce({ QueryResponse: {} });
    await dispatch("qbo_purchase_orders_search", {
      vendorId: "7",
      docNumber: "PO-10",
      status: "Open",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      minAmount: 100,
      maxAmount: 5000.25,
      startPosition: 1001,
      maxResults: 50,
    });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toBe(
      "SELECT * FROM PurchaseOrder WHERE VendorRef = '7' AND DocNumber LIKE '%PO-10%' AND POStatus = 'Open' AND TxnDate >= '2026-01-01' AND TxnDate <= '2026-12-31' AND TotalAmt >= '100' AND TotalAmt <= '5000.25' STARTPOSITION 1001 MAXRESULTS 50"
    );
    expect(sql).not.toMatch(/ESCAPE/i);
  });

  it("resolves a vendor name to vendor ids via a LIKE on Vendor.DisplayName with no ESCAPE", async () => {
    query
      .mockResolvedValueOnce({ QueryResponse: { Vendor: [{ Id: "7" }, { Id: "12" }] } })
      .mockResolvedValueOnce({ QueryResponse: { PurchaseOrder: [po()] } });
    const result = await dispatch("qbo_purchase_orders_search", {
      vendorName: "O'Brien 50%",
    });
    const vendorSql = String(query.mock.calls[0][0]);
    expect(vendorSql).toBe(
      `SELECT Id FROM Vendor WHERE DisplayName LIKE '%O''Brien 50%' MAXRESULTS ${MAX_VENDOR_MATCHES + 1}`
    );
    expect(vendorSql).not.toMatch(/ESCAPE/i);
    expect(String(query.mock.calls[1][0])).toBe(
      "SELECT * FROM PurchaseOrder WHERE VendorRef IN ('7', '12') STARTPOSITION 1 MAXRESULTS 100"
    );
    expect(payload(result!).QueryResponse.PurchaseOrder).toHaveLength(1);
  });

  it("intersects a vendor name with a vendor id", async () => {
    query
      .mockResolvedValueOnce({ QueryResponse: { Vendor: [{ Id: "7" }, { Id: "12" }] } })
      .mockResolvedValueOnce({ QueryResponse: {} });
    await dispatch("qbo_purchase_orders_search", { vendorName: "Acme", vendorId: "12" });
    expect(String(query.mock.calls[1][0])).toContain("VendorRef IN ('12')");
  });

  it("returns an empty result without querying POs when no vendor matches", async () => {
    query.mockResolvedValueOnce({ QueryResponse: {} });
    const result = await dispatch("qbo_purchase_orders_search", { vendorName: "Nobody" });
    expect(query).toHaveBeenCalledTimes(1);
    const body = payload(result!);
    expect(body.QueryResponse.PurchaseOrder).toEqual([]);
    expect(body.note).toMatch(/No vendor/);
  });

  it("refuses a vendor name that matches too many vendors", async () => {
    const many = Array.from({ length: MAX_VENDOR_MATCHES + 1 }, (_, i) => ({ Id: String(i) }));
    query.mockResolvedValueOnce({ QueryResponse: { Vendor: many } });
    await expect(
      dispatch("qbo_purchase_orders_search", { vendorName: "a" })
    ).rejects.toThrow(/more than/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid status, date, amount or vendor id before querying", async () => {
    await expect(
      dispatch("qbo_purchase_orders_search", { status: "Pending" })
    ).rejects.toThrow(/status/);
    await expect(
      dispatch("qbo_purchase_orders_search", { startDate: "10/01/2026" })
    ).rejects.toThrow(/startDate/);
    await expect(
      dispatch("qbo_purchase_orders_search", { minAmount: "1 OR 1=1" })
    ).rejects.toThrow(/minAmount/);
    await expect(
      dispatch("qbo_purchase_orders_search", { vendorId: "7' OR '1'='1" })
    ).rejects.toThrow(/vendorId/);
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps a quote in the PO number inside the literal", async () => {
    query.mockResolvedValueOnce({ QueryResponse: {} });
    await dispatch("qbo_purchase_orders_search", { docNumber: "x' OR '1'='1" });
    expect(String(query.mock.calls[0][0])).toContain(
      "DocNumber LIKE '%x'' OR ''1''=''1%'"
    );
  });
});

describe("qbo_purchase_orders_close", () => {
  it("fetches the current SyncToken and sparse-updates POStatus to Closed", async () => {
    get.mockResolvedValueOnce({ PurchaseOrder: po({ SyncToken: "5" }) });
    post.mockResolvedValueOnce({
      PurchaseOrder: po({ SyncToken: "6", POStatus: "Closed" }),
    });
    const result = await dispatch("qbo_purchase_orders_close", { purchaseOrderId: "42" });
    expect(get).toHaveBeenCalledWith("purchaseorder/42");
    expect(post).toHaveBeenCalledWith("purchaseorder", {
      Id: "42",
      SyncToken: "5",
      sparse: true,
      POStatus: "Closed",
    });
    expect(result!.isError).toBeUndefined();
    expect(payload(result!)).toEqual({
      closed: true,
      purchaseOrder: {
        id: "42",
        docNumber: "PO-1001",
        vendor: { id: "7", name: "Acme Supply" },
        totalAmt: 250.5,
        status: "Closed",
        syncToken: "6",
      },
    });
  });

  it("refuses a PO that is already closed and writes nothing", async () => {
    get.mockResolvedValueOnce({ PurchaseOrder: po({ POStatus: "Closed" }) });
    const result = await dispatch("qbo_purchase_orders_close", { purchaseOrderId: "42" });
    expect(post).not.toHaveBeenCalled();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toMatch(/already closed/i);
  });

  it("requires a purchaseOrderId", async () => {
    await expect(dispatch("qbo_purchase_orders_close", {})).rejects.toThrow(
      /purchaseOrderId/
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe("qbo_purchase_orders_delete", () => {
  it("without confirm returns a preview and never deletes", async () => {
    get.mockResolvedValueOnce({ PurchaseOrder: po() });
    const result = await dispatch("qbo_purchase_orders_delete", { purchaseOrderId: "42" });
    expect(post).not.toHaveBeenCalled();
    expect(result!.isError).toBeUndefined();
    const body = payload(result!);
    expect(body.deleted).toBe(false);
    expect(body.preview).toEqual({
      id: "42",
      docNumber: "PO-1001",
      vendor: { id: "7", name: "Acme Supply" },
      txnDate: "2026-10-01",
      totalAmt: 250.5,
      status: "Open",
      syncToken: "3",
      lineCount: 2,
      lines: [
        { amount: 200, description: "Widgets", item: "Widget", qty: 4 },
        { amount: 50.5, account: "Freight" },
      ],
    });
    expect(body.next).toMatch(/confirm: true/);
    expect(body.next).toMatch(/expected_sync_token: "3"/);
  });

  it("treats confirm: false, 'true' (string) and 1 as a preview", async () => {
    for (const confirm of [false, "true", 1]) {
      get.mockResolvedValueOnce({ PurchaseOrder: po() });
      const result = await dispatch("qbo_purchase_orders_delete", {
        purchaseOrderId: "42",
        confirm,
        expected_sync_token: "3",
      });
      expect(payload(result!).deleted).toBe(false);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("with confirm but no expected_sync_token refuses without fetching or deleting", async () => {
    const result = await dispatch("qbo_purchase_orders_delete", {
      purchaseOrderId: "42",
      confirm: true,
    });
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toMatch(/expected_sync_token/);
    expect(post).not.toHaveBeenCalled();
  });

  it("with confirm re-fetches the SyncToken and refuses if the PO changed since preview", async () => {
    get.mockResolvedValueOnce({ PurchaseOrder: po({ SyncToken: "4" }) });
    const result = await dispatch("qbo_purchase_orders_delete", {
      purchaseOrderId: "42",
      confirm: true,
      expected_sync_token: "3",
    });
    expect(get).toHaveBeenCalledWith("purchaseorder/42");
    expect(post).not.toHaveBeenCalled();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toMatch(/changed since/);
  });

  it("with confirm and a matching SyncToken deletes via operation=delete", async () => {
    get.mockResolvedValueOnce({ PurchaseOrder: po() });
    post.mockResolvedValueOnce({
      PurchaseOrder: { Id: "42", status: "Deleted", domain: "QBO" },
    });
    const result = await dispatch("qbo_purchase_orders_delete", {
      purchaseOrderId: "42",
      confirm: true,
      expected_sync_token: "3",
    });
    expect(post).toHaveBeenCalledWith(
      "purchaseorder",
      { Id: "42", SyncToken: "3" },
      { operation: "delete" }
    );
    const body = payload(result!);
    expect(body.deleted).toBe(true);
    expect(body.purchaseOrder).toMatchObject({ id: "42", docNumber: "PO-1001" });
  });

  it("flags linked transactions in the preview", async () => {
    get.mockResolvedValueOnce({
      PurchaseOrder: po({ LinkedTxn: [{ TxnId: "88", TxnType: "Bill" }] }),
    });
    const body = payload(
      (await dispatch("qbo_purchase_orders_delete", { purchaseOrderId: "42" }))!
    );
    expect(body.preview.linkedTransactions).toEqual([{ id: "88", type: "Bill" }]);
    expect(body.warning).toMatch(/linked/i);
    expect(post).not.toHaveBeenCalled();
  });
});
