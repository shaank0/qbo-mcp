/**
 * Shared differential-filter checks for QuickBooks reports.
 *
 * NOT a test file (no `.test.` in the name, so vitest never collects it). It
 * holds the probe logic used by BOTH:
 *
 *   - `scripts/verify-report-filters.ts` — the manual escape hatch, run by an
 *     operator against a realm with an access token in hand.
 *   - `src/__tests__/sandbox.integration.test.ts` — the durable path, run
 *     automatically by CI whenever the QBO_SANDBOX_* secrets exist.
 *
 * One implementation, two front ends: the alternative was duplicating ~150
 * lines of QuickBooks-specific reasoning across a script and a test and letting
 * them drift.
 *
 * ## Why any of this exists
 *
 * QuickBooks does not error on an unrecognised report parameter. It ignores it
 * and returns the full, unfiltered report — which looks exactly as legitimate
 * as a correctly filtered one. If `class` should have been `classid` on some
 * report, a caller asking for one division's P&L silently receives the whole
 * company's figures labelled as that division. No unit test can catch that:
 * the bug is in what Intuit accepts, not in what this codebase sends.
 *
 * The spec's acceptance is a four-step differential assertion:
 *
 *   1. Fetch the report unfiltered for a period.
 *   2. Fetch it filtered to a single class.
 *   3. Assert the totals DIFFER.            -> `filterNarrows`
 *   4. Assert that summing every class's filtered total reconciles to the
 *      unfiltered total.                    -> `reconcileClassTotals`
 *
 * Step 3 only proves the parameter DID SOMETHING. Step 4 proves it did the
 * RIGHT thing — it is what catches a parameter that is accepted but
 * interpreted differently than intended (wrong ID space, first-match-only,
 * name-vs-ID coercion). A filter that returns one arbitrary class's data when
 * asked for another passes step 3 cleanly and fails step 4.
 */

import type { QboReport, QboRow } from "../domains/report-rows.js";

/** The subset of the QBO client these checks need. */
export interface ProbeClient {
  get(path: string, params: Record<string, string>): Promise<unknown>;
  query(sql: string): Promise<unknown>;
}

export interface DateWindow {
  start_date: string;
  end_date: string;
}

export interface CheckSpec {
  /** Human-facing report name. */
  report: string;
  /** The WIRE parameter name under test — the thing that might be wrong. */
  param: string;
  /** Endpoint path handed to the client. */
  path: string;
}

/**
 * Every report endpoint this fork introduces. Verified to RESOLVE before any
 * filter is probed: a filter result against a report name that 404s proves
 * nothing. `ProfitAndLoss` is included even though it is pre-existing, because
 * the class checks fetch it and an unresolvable path should report as a bad
 * name rather than crash the probe with a stack trace.
 */
export const FORK_REPORT_ENDPOINTS = [
  "reports/ProfitAndLoss",
  "reports/ProfitAndLossDetail",
  "reports/TransactionList",
  "reports/AgedReceivableDetail",
  "reports/ClassSales",
  "reports/JournalReport",
] as const;

/**
 * Class-filter checks. Note ProfitAndLoss takes `class` while
 * ProfitAndLossDetail takes `classid` — Intuit is inconsistent between the two,
 * which is the whole reason this probe exists.
 */
export const CLASS_CHECKS: CheckSpec[] = [
  { report: "ProfitAndLoss", param: "class", path: "reports/ProfitAndLoss" },
  { report: "ProfitAndLossDetail", param: "classid", path: "reports/ProfitAndLossDetail" },
  { report: "TransactionList", param: "class", path: "reports/TransactionList" },
];

/**
 * Both reports this fork exposes an `account` filter on. These exist because
 * Intuit already demonstrates the `class`/`classid` inconsistency — `account`
 * could just as plausibly need to be `accountid` on one of them.
 */
export const ACCOUNT_CHECKS: CheckSpec[] = [
  { report: "ProfitAndLossDetail", param: "account", path: "reports/ProfitAndLossDetail" },
  { report: "TransactionList", param: "account", path: "reports/TransactionList" },
];

/**
 * The non-obvious `summarize_column_by` values the P&L schema advertises.
 *
 * Same silent-ignore trap, one level down: if `Departments` is not a value
 * QuickBooks recognises, it ignores the parameter and returns a single Total
 * column — a report that reads as entirely legitimate. `entity` is the QBO
 * entity that must exist in the realm for the value to be demonstrable at all.
 */
export const SUMMARIZE_COLUMN_CHECKS: { value: string; entity: string }[] = [
  { value: "Classes", entity: "Class" },
  { value: "Departments", entity: "Department" },
  { value: "Customers", entity: "Customer" },
];

// ---------------------------------------------------------------------------
// Report shape helpers
// ---------------------------------------------------------------------------

/**
 * A coarse fingerprint of a report, for "did this change at all?" comparisons.
 *
 * QBO puts the grand total in the last top-level summary row; fall back to a
 * length fingerprint so a purely structural difference still registers. Which
 * branch fires depends on the report and that is expected, not a bug: summary
 * reports (ProfitAndLoss, ProfitAndLossDetail) carry a `Summary.ColData`
 * grand-total row; `TransactionList` is a bare listing with no summary row and
 * always falls through to the length fingerprint, where a shorter or longer
 * body is still a valid signal that the filtered response differs.
 */
export function reportFingerprint(report: unknown): string {
  const rows: QboRow[] = (report as QboReport)?.Rows?.Row ?? [];
  const summary = rows[rows.length - 1]?.Summary?.ColData;
  if (Array.isArray(summary)) return summary.map((c) => c?.value ?? "").join("|");
  return JSON.stringify(report).length.toString();
}

/**
 * Parse a QBO money string. Handles thousands separators, a currency symbol,
 * and accounting-style negatives — `(1,234.56)` is -1234.56, and reading that
 * as +1234.56 would silently invert a reconciliation.
 */
export function parseAmount(value: string): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const negative = raw.startsWith("(") && raw.endsWith(")");
  const cleaned = raw.replace(/[(),$\s]/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * The report's grand total as a number: the LAST numeric cell of the last
 * top-level `Summary.ColData` row. Returns null for reports with no grand
 * total at all (TransactionList), which is a legitimate "cannot reconcile
 * this one" rather than a failure.
 */
export function numericGrandTotal(report: unknown): number | null {
  const rows: QboRow[] = (report as QboReport)?.Rows?.Row ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const summary = rows[i]?.Summary?.ColData;
    if (!Array.isArray(summary)) continue;
    for (let c = summary.length - 1; c >= 0; c--) {
      const n = parseAmount(summary[c]?.value ?? "");
      if (n !== null) return n;
    }
  }
  return null;
}

/** Column titles, as a comparable signature. */
export function columnSignature(report: unknown): string {
  const cols = (report as QboReport)?.Columns?.Column;
  if (!Array.isArray(cols)) return "";
  return cols.map((c) => String(c?.ColTitle ?? "")).join("|");
}

// ---------------------------------------------------------------------------
// Realm inventory
// ---------------------------------------------------------------------------

export interface QboClass {
  Id: string;
  Name?: string;
  ParentRef?: { value?: string };
}

/**
 * Every class in the realm, paginated. QBO caps a query page at 1000, and step
 * 4 needs ALL of them — a truncated list would under-sum and report a
 * reconciliation failure that is really a pagination bug.
 */
export async function listAllClasses(client: ProbeClient): Promise<QboClass[]> {
  const page = 1000;
  const out: QboClass[] = [];
  for (let start = 1; ; start += page) {
    const resp = (await client.query(
      `SELECT * FROM Class STARTPOSITION ${start} MAXRESULTS ${page}`
    )) as { QueryResponse?: { Class?: QboClass[] } };
    const batch: QboClass[] = resp?.QueryResponse?.Class ?? [];
    out.push(...batch);
    if (batch.length < page) return out;
  }
}

/**
 * Classes with no children.
 *
 * Reconciliation must sum LEAF classes only. QuickBooks' class filter on a
 * parent class includes its sub-classes, so summing parents and children
 * together double-counts every sub-class and manufactures a failure.
 */
export function leafClasses(all: QboClass[]): QboClass[] {
  const parents = new Set(
    all.map((c) => c.ParentRef?.value).filter((v): v is string => Boolean(v))
  );
  return all.filter((c) => !parents.has(c.Id));
}

/** How many rows of an entity the realm has, for "can this even be tested?". */
export async function countEntity(client: ProbeClient, entity: string): Promise<number> {
  const resp = (await client.query(`SELECT COUNT(*) FROM ${entity}`)) as {
    QueryResponse?: { totalCount?: number };
  };
  const n = resp?.QueryResponse?.totalCount;
  return typeof n === "number" ? n : 0;
}

// ---------------------------------------------------------------------------
// Step 3 — does the filter narrow the report at all?
// ---------------------------------------------------------------------------

export interface NarrowOutcome {
  report: string;
  param: string;
  value: string;
  /** True means filtered == unfiltered, i.e. QBO IGNORED the parameter. */
  same: boolean;
}

export async function filterNarrows(
  client: ProbeClient,
  spec: CheckSpec,
  value: string,
  window: DateWindow
): Promise<NarrowOutcome> {
  const unfiltered = await client.get(spec.path, { ...window });
  const filtered = await client.get(spec.path, { ...window, [spec.param]: value });
  return {
    report: spec.report,
    param: spec.param,
    value,
    same: reportFingerprint(unfiltered) === reportFingerprint(filtered),
  };
}

// ---------------------------------------------------------------------------
// Step 4 — does the filter do the RIGHT thing?
// ---------------------------------------------------------------------------

/**
 * Cents. Every per-class total QBO returns is already rounded to cents, and a
 * sum of cent values is exact, so anything beyond this is a real discrepancy.
 */
export const DEFAULT_TOLERANCE = 0.01;

export interface ReconcileOutcome {
  report: string;
  param: string;
  /** Null when the report has no grand total to reconcile (TransactionList). */
  unfilteredTotal: number | null;
  summedTotal: number;
  delta: number;
  classesSummed: number;
  /** Classes whose filtered fetch produced no numeric total — reported, not hidden. */
  classesWithoutTotal: string[];
  tolerance: number;
  /** Null when the report has no grand total, i.e. not applicable. */
  reconciles: boolean | null;
}

/**
 * Spec acceptance step 4: sum every (leaf) class's filtered grand total and
 * assert it reconciles to the unfiltered grand total.
 *
 * This is the check that catches a parameter QuickBooks ACCEPTS but interprets
 * differently than intended — wrong ID space, first-match-only, name-vs-ID
 * coercion. Such a filter changes the total (passing step 3) while returning
 * the wrong rows, and only the sum-of-parts exposes it.
 *
 * Two benign causes of a mismatch, which the caller must surface rather than
 * bury, because neither is a code bug:
 *   - transactions with NO class land in QuickBooks' "Not Specified" bucket and
 *     belong to no class's filtered total;
 *   - transactions classed directly to a PARENT class are not counted by any
 *     leaf class's filter.
 */
export async function reconcileClassTotals(
  client: ProbeClient,
  spec: CheckSpec,
  classes: QboClass[],
  window: DateWindow,
  tolerance: number = DEFAULT_TOLERANCE
): Promise<ReconcileOutcome> {
  const unfiltered = await client.get(spec.path, { ...window });
  const unfilteredTotal = numericGrandTotal(unfiltered);

  let summedTotal = 0;
  const classesWithoutTotal: string[] = [];

  for (const klass of classes) {
    const filtered = await client.get(spec.path, { ...window, [spec.param]: klass.Id });
    const total = numericGrandTotal(filtered);
    if (total === null) {
      classesWithoutTotal.push(`${klass.Name ?? "?"} (${klass.Id})`);
      continue;
    }
    summedTotal += total;
  }

  const delta = unfilteredTotal === null ? 0 : summedTotal - unfilteredTotal;
  return {
    report: spec.report,
    param: spec.param,
    unfilteredTotal,
    summedTotal,
    delta,
    classesSummed: classes.length - classesWithoutTotal.length,
    classesWithoutTotal,
    tolerance,
    reconciles: unfilteredTotal === null ? null : Math.abs(delta) <= tolerance,
  };
}

/** The standard explanation of a reconciliation miss, shared by both front ends. */
export function reconciliationAdvice(outcome: ReconcileOutcome): string {
  return (
    `${outcome.report} via \`${outcome.param}\`: summing all ${outcome.classesSummed} leaf ` +
    `class totals gave ${outcome.summedTotal.toFixed(2)} but the unfiltered report totals ` +
    `${(outcome.unfilteredTotal ?? 0).toFixed(2)} — a delta of ${outcome.delta.toFixed(2)} ` +
    `(tolerance ${outcome.tolerance}). The parameter changed the report (so it is not being ` +
    `ignored) but the parts do not sum to the whole, which is what a parameter that is ` +
    `ACCEPTED but misinterpreted looks like — wrong ID space, first-match-only, or ` +
    `name-vs-ID coercion. Before changing any code, rule out the two benign causes: ` +
    `(a) transactions with no class at all, which QuickBooks buckets as "Not Specified" and ` +
    `which belong to no class's total — check the Not Specified column of a P&L run with ` +
    `summarize_column_by=Classes; and (b) transactions classed directly to a PARENT class, ` +
    `which no leaf class's filter counts. If neither explains the delta, the wire parameter ` +
    `name is wrong.`
  );
}

// ---------------------------------------------------------------------------
// Account candidates — driven by section context, not a column that isn't there
// ---------------------------------------------------------------------------

/**
 * Distinct account names that show real activity in a report for the window.
 *
 * The two reports differ in WHERE the account lives, and this is exactly the
 * trap the previous version of this probe fell into:
 *
 *   - `TransactionList` is flat and has a literal "Account" column.
 *   - `ProfitAndLossDetail` has NO account column — it GROUPS by account in
 *     section headers. Reading a column titled "Account" off it therefore
 *     found nothing on every realm regardless of data, so that check reported
 *     SKIPPED forever while advising the operator to widen the date range,
 *     advice that could never work.
 *
 * So: prefer the "Account" column when the report has one, and otherwise fall
 * back to the section path the flattener now preserves, taking its LEAF segment
 * (`Income > Consulting` -> `Consulting`). Only `rowType: "data"` rows are
 * considered, so a subtotal label is never mistaken for an account.
 */
export function accountCandidates(flat: {
  columns: string[];
  rows: Record<string, string>[];
}): string[] {
  const names = new Set<string>();
  const useColumn = flat.columns.includes("Account");

  for (const row of flat.rows) {
    if (row.rowType !== "data") continue;
    const value = useColumn ? row["Account"] : (row.section ?? "").split(" > ").pop();
    const trimmed = String(value ?? "").trim();
    // A section path can be a pure grouping header ("Income") rather than an
    // account; resolving it against the Account table is what filters those out.
    if (trimmed) names.add(trimmed);
  }
  return [...names];
}

/**
 * Resolve an account name to its Id via a live query — never guess, never
 * reuse a cached id. Tries `Name` (the leaf name QBO renders in a section
 * header) and then `FullyQualifiedName` (the `Parent:Sub` display path some
 * reports render instead).
 */
export async function resolveAccountId(
  client: ProbeClient,
  name: string,
  escape: (s: string) => string
): Promise<string | null> {
  for (const field of ["Name", "FullyQualifiedName"]) {
    const resp = (await client.query(
      `SELECT * FROM Account WHERE ${field} = '${escape(name)}' MAXRESULTS 1`
    )) as { QueryResponse?: { Account?: { Id?: string }[] } };
    const id = resp?.QueryResponse?.Account?.[0]?.Id;
    if (id) return String(id);
  }
  return null;
}
