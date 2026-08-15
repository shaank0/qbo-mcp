/**
 * Reports domain tools for QBO MCP Server
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../utils/client.js";
import { flattenReport } from "./report-rows.js";

/** Tool name → QBO report endpoint name for reports sharing the
 * start_date / end_date / accounting_method shape. */
const datedReportEndpoints: Record<string, string> = {
  qbo_reports_cash_flow: "CashFlow",
  qbo_reports_trial_balance: "TrialBalance",
  qbo_reports_general_ledger: "GeneralLedger",
  qbo_reports_vendor_expenses: "VendorExpenses",
};

/**
 * Report domain tool definitions
 */
export const reportTools: Tool[] = [
  {
    name: "qbo_reports_profit_and_loss",
    description:
      "Get a Profit and Loss (Income Statement) report for a given date range. Shows revenue, expenses, and net income.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date for the report period (YYYY-MM-DD format)",
        },
        end_date: {
          type: "string",
          description: "End date for the report period (YYYY-MM-DD format)",
        },
        accounting_method: {
          type: "string",
          enum: ["Cash", "Accrual"],
          description: "Accounting method (default: Accrual)",
        },
        summarize_column_by: {
          type: "string",
          enum: ["Total", "Month", "Quarter", "Year", "Classes", "Departments", "Customers"],
          description:
            "How to break the report into columns. Use 'Classes' to get one column per class — the way to see every class at once rather than filtering to one. NOTE: 'Departments' and 'Customers' are taken from Intuit's own MCP server and are UNVERIFIED against a live realm — if QuickBooks does not recognise a value it ignores the parameter and returns a single-column Total report that reads as entirely legitimate. See docs/FILTER-VERIFICATION.md.",
        },
        class: {
          type: "string",
          description:
            "Filter to one or more class IDs (comma-separated). Class IDs, not names — resolve names first with qbo_classes_list.",
        },
        department: { type: "string", description: "Filter by department ID(s), comma-separated" },
        customer: { type: "string", description: "Filter by customer ID(s), comma-separated" },
        vendor: { type: "string", description: "Filter by vendor ID(s), comma-separated" },
        item: { type: "string", description: "Filter by item ID(s), comma-separated" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_balance_sheet",
    description:
      "Get a Balance Sheet report as of a given date range. Shows assets, liabilities, and equity.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date for the report period (YYYY-MM-DD format)",
        },
        end_date: {
          type: "string",
          description: "End date for the report period (YYYY-MM-DD format)",
        },
        accounting_method: {
          type: "string",
          enum: ["Cash", "Accrual"],
          description: "Accounting method (default: Accrual)",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_aged_receivables",
    description:
      "Get an Aged Receivables (A/R Aging Summary) report. Shows outstanding customer balances grouped by age.",
    inputSchema: {
      type: "object",
      properties: {
        report_date: {
          type: "string",
          description: "Report as-of date (YYYY-MM-DD format, default: today)",
        },
        customer: { type: "string", description: "Filter by customer ID(s)" },
        aging_method: { type: "string", enum: ["Current", "Report_Date"] },
        days_per_aging_period: { type: "number", description: "Default 30" },
        num_periods: { type: "number", description: "Default 4" },
      },
    },
  },
  {
    name: "qbo_reports_aged_payables",
    description:
      "Get an Aged Payables (A/P Aging Summary) report. Shows outstanding vendor balances grouped by age.",
    inputSchema: {
      type: "object",
      properties: {
        report_date: {
          type: "string",
          description:
            "Report as-of date (YYYY-MM-DD format, default: today)",
        },
      },
    },
  },
  {
    name: "qbo_reports_customer_sales",
    description:
      "Get a Customer Sales report for a given date range. Shows sales totals broken down by customer.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date for the report period (YYYY-MM-DD format)",
        },
        end_date: {
          type: "string",
          description: "End date for the report period (YYYY-MM-DD format)",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_cash_flow",
    description:
      "Get a Cash Flow Statement for a given date range. Shows cash inflows and outflows from operating, investing, and financing activities.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_trial_balance",
    description:
      "Get a Trial Balance report as of a given date. Lists all accounts with their debit/credit balances to verify the books balance.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        accounting_method: {
          type: "string",
          enum: ["Cash", "Accrual"],
          description: "Accounting method (default: Accrual)",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_general_ledger",
    description:
      "Get a General Ledger report for a given date range. Shows every posted transaction grouped by account.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        accounting_method: {
          type: "string",
          enum: ["Cash", "Accrual"],
          description: "Accounting method (default: Accrual)",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_customer_balance",
    description:
      "Get a Customer Balance report as of a given date. Lists the outstanding balance owed by each customer.",
    inputSchema: {
      type: "object",
      properties: {
        report_date: {
          type: "string",
          description: "Report as-of date (YYYY-MM-DD, default: today)",
        },
      },
    },
  },
  {
    name: "qbo_reports_vendor_expenses",
    description:
      "Get a Vendor Expenses report for a given date range. Shows expense totals broken down by vendor.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_profit_and_loss_detail",
    description:
      "Line-level Profit and Loss: every transaction behind the P&L totals, filterable by class and account. Use when the summary P&L raises a 'what is in this number?' question.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        accounting_method: { type: "string", enum: ["Cash", "Accrual"] },
        class: {
          type: "string",
          description: "Filter to one or more class IDs (comma-separated)",
        },
        account: { type: "string", description: "Filter to account ID(s), comma-separated" },
        customer: { type: "string", description: "Filter by customer ID(s)" },
        vendor: { type: "string", description: "Filter by vendor ID(s)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_transaction_list",
    description:
      "Every transaction in a date range, filterable by account, account type, transaction type and class. This is the closest thing to a queryable transaction ledger.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        account: { type: "string", description: "Account ID(s), comma-separated" },
        source_account_type: {
          type: "string",
          description: "Account TYPE filter, e.g. Expense, Income, Bank — use when you want a category of accounts rather than named ones",
        },
        transaction_type: {
          type: "string",
          description: "e.g. Bill, Invoice, JournalEntry, Payment, Deposit",
        },
        class: { type: "string", description: "Filter to class ID(s), comma-separated" },
        customer: { type: "string", description: "Filter by customer ID(s)" },
        vendor: { type: "string", description: "Filter by vendor ID(s)" },
        max_rows: {
          type: "number",
          description: "Cap on returned rows (default 2000). Truncation is reported explicitly.",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_aged_receivable_detail",
    description:
      "Invoice-level A/R aging: every unpaid invoice with its due date and age bucket, as of a date.",
    inputSchema: {
      type: "object",
      properties: {
        report_date: { type: "string", description: "As-of date (YYYY-MM-DD, default today)" },
        customer: { type: "string", description: "Filter by customer ID(s)" },
        aging_method: { type: "string", enum: ["Current", "Report_Date"] },
        days_per_aging_period: { type: "number", description: "Default 30" },
        num_periods: { type: "number", description: "Default 4" },
      },
    },
  },
  {
    name: "qbo_reports_class_sales",
    description: "Sales totalled by class for a date range — revenue per division at a glance.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        accounting_method: { type: "string", enum: ["Cash", "Accrual"] },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "qbo_reports_journal_report",
    description:
      "Every journal entry line in a date range, in debit/credit form. Use for audit-trail and data-integrity work.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        max_rows: { type: "number", description: "Cap on returned rows (default 2000)" },
      },
      required: ["start_date", "end_date"],
    },
  },
];

/**
 * Response shape for the tools added for the gateway: flattened rows instead of
 * QBO's nested tree. Pre-existing tools deliberately keep `JSON.stringify(report,
 * null, 2)` so this stays an additive change upstream.
 */
function flatText(report: unknown, maxRows?: number) {
  const flat = flattenReport(report, maxRows);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(flat, null, 2) }],
  };
}

/** Copy `keys` from args into params when present. Empty string is NOT sent. */
function passThrough(
  args: Record<string, unknown>,
  params: Record<string, string>,
  keys: string[]
): void {
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && String(v) !== "") params[k] = String(v);
  }
}

/**
 * Handle report domain tool calls
 */
export async function handleReportTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const client = getClient();

  switch (name) {
    case "qbo_reports_profit_and_loss": {
      const {
        start_date,
        end_date,
        accounting_method,
        summarize_column_by,
        class: klass,
        department,
        customer,
        vendor,
        item,
      } = args as Record<string, string | undefined>;

      const params: Record<string, string> = {
        start_date: start_date!,
        end_date: end_date!,
      };
      if (accounting_method) params.accounting_method = accounting_method;
      if (summarize_column_by) params.summarize_column_by = summarize_column_by;
      // NOTE the wire name: ProfitAndLoss takes `class`, ProfitAndLossDetail
      // takes `classid`. Intuit is inconsistent between the two. A wrong name
      // is NOT an error — QBO silently ignores it and returns the full
      // unfiltered report. scripts/verify-report-filters.ts proves which.
      if (klass) params.class = klass;
      if (department) params.department = department;
      if (customer) params.customer = customer;
      if (vendor) params.vendor = vendor;
      if (item) params.item = item;

      const report = await client.get("reports/ProfitAndLoss", params);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "qbo_reports_balance_sheet": {
      const { start_date, end_date, accounting_method } = args as {
        start_date: string;
        end_date: string;
        accounting_method?: string;
      };

      const params: Record<string, string> = {
        start_date,
        end_date,
      };
      if (accounting_method) params.accounting_method = accounting_method;

      const report = await client.get("reports/BalanceSheet", params);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "qbo_reports_aged_receivables": {
      const a = args as Record<string, unknown>;
      const params: Record<string, string> = {};
      passThrough(a, params, [
        "report_date",
        "customer",
        "aging_method",
        "days_per_aging_period",
        "num_periods",
      ]);

      const report = await client.get("reports/AgedReceivables", params);
      // Pre-existing tool: output shape unchanged.
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "qbo_reports_aged_payables": {
      const { report_date } = args as { report_date?: string };

      const params: Record<string, string> = {};
      if (report_date) params.report_date = report_date;

      const report = await client.get("reports/AgedPayables", params);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "qbo_reports_customer_sales": {
      const { start_date, end_date } = args as {
        start_date: string;
        end_date: string;
      };

      const params: Record<string, string> = {
        start_date,
        end_date,
      };

      const report = await client.get("reports/CustomerSales", params);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "qbo_reports_cash_flow":
    case "qbo_reports_trial_balance":
    case "qbo_reports_general_ledger":
    case "qbo_reports_vendor_expenses": {
      const { start_date, end_date, accounting_method } = args as {
        start_date: string;
        end_date: string;
        accounting_method?: string;
      };
      const params: Record<string, string> = { start_date, end_date };
      if (accounting_method) params.accounting_method = accounting_method;
      const report = await client.get(`reports/${datedReportEndpoints[name]}`, params);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "qbo_reports_customer_balance": {
      const { report_date } = args as { report_date?: string };
      const params: Record<string, string> = {};
      if (report_date) params.report_date = report_date;
      const report = await client.get("reports/CustomerBalance", params);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "qbo_reports_profit_and_loss_detail": {
      const a = args as Record<string, unknown>;
      const params: Record<string, string> = {
        start_date: String(a.start_date),
        end_date: String(a.end_date),
      };
      passThrough(a, params, ["accounting_method", "account", "customer", "vendor"]);
      // `classid` here, NOT `class` — Intuit uses a different name on the
      // detail report than on the summary. See Task 3's note.
      if (a.class) params.classid = String(a.class);

      return flatText(await client.get("reports/ProfitAndLossDetail", params));
    }

    case "qbo_reports_transaction_list": {
      const a = args as Record<string, unknown>;
      const params: Record<string, string> = {
        start_date: String(a.start_date),
        end_date: String(a.end_date),
      };
      passThrough(a, params, [
        "account",
        "source_account_type",
        "transaction_type",
        "class",
        "customer",
        "vendor",
      ]);

      const maxRows = typeof a.max_rows === "number" ? a.max_rows : undefined;
      return flatText(await client.get("reports/TransactionList", params), maxRows);
    }

    case "qbo_reports_aged_receivable_detail": {
      const a = args as Record<string, unknown>;
      const params: Record<string, string> = {};
      passThrough(a, params, [
        "report_date",
        "customer",
        "aging_method",
        "days_per_aging_period",
        "num_periods",
      ]);
      return flatText(await client.get("reports/AgedReceivableDetail", params));
    }

    case "qbo_reports_class_sales": {
      const a = args as Record<string, unknown>;
      const params: Record<string, string> = {
        start_date: String(a.start_date),
        end_date: String(a.end_date),
      };
      passThrough(a, params, ["accounting_method"]);
      return flatText(await client.get("reports/ClassSales", params));
    }

    case "qbo_reports_journal_report": {
      const a = args as Record<string, unknown>;
      const params: Record<string, string> = {
        start_date: String(a.start_date),
        end_date: String(a.end_date),
      };
      const maxRows = typeof a.max_rows === "number" ? a.max_rows : undefined;
      return flatText(await client.get("reports/JournalReport", params), maxRows);
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown report tool: ${name}` }],
        isError: true,
      };
  }
}
