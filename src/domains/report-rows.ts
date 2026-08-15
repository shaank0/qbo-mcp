/**
 * Flatten a QBO report into column-keyed rows.
 *
 * QBO returns reports as a recursive structure: `Rows.Row[]`, where each entry
 * is either a data row (`ColData[]`) or a section carrying its own nested
 * `Rows`. Pretty-printing that whole tree — what the pre-existing report tools
 * do — is unusable for anything the size of a year of transactions.
 *
 * ## Section context is data, not decoration
 *
 * QBO puts a section's label in `row.Header.ColData` and that section's
 * subtotal in `row.Summary.ColData`. For several reports the section label is
 * the *only* place a whole dimension of the report lives:
 *
 *   - `ProfitAndLossDetail` groups by **account**; the row's own `Split`
 *     column is the CONTRA account, so dropping the header loses account
 *     attribution entirely and it is not recoverable from the row.
 *   - `AgedReceivableDetail` carries the aging bucket in the header.
 *   - `JournalReport` carries transaction identity in the header; child lines
 *     come back with blank Date/Type.
 *   - `ClassSales` may carry its values only in section summaries.
 *
 * Silently losing the grouping dimension of a financial report is the same
 * class of harm as a silently ignored filter, so every emitted row carries:
 *
 *   - `section`  — the `>`-joined header path it sits under (`""` at top level)
 *   - `rowType`  — `"data"` for a `ColData` row, `"summary"` for a section's
 *                  `Summary.ColData` subtotal (and the report's grand total)
 *
 * Summary rows are emitted **inline, in document order, with a marker** rather
 * than being collected into a separate field. Two reasons: it is how QBO itself
 * renders the report (line items then their subtotal), so one ordered table
 * stays readable; and it means a report whose values live only in summaries —
 * `ClassSales` — can never come back as `rows: []`, i.e. as "no sales". The
 * cost of inlining is double-counting if a consumer naively sums the column,
 * which is exactly what the explicit `rowType` marker exists to prevent.
 *
 * If a real QBO column is literally titled `section` or `rowType`, the QBO
 * column wins and ours moves to `_section` / `_rowType` — report data is never
 * overwritten by metadata.
 *
 * Used by the tools added for the gateway ONLY. The pre-existing tools keep
 * their original output so this stays an additive change upstream.
 */

/**
 * QuickBooks' report tree, typed structurally. Every field is optional because
 * the shape genuinely varies by report — a row is a data row, a section, a
 * subtotal, or several at once — and this is untrusted API output, not a
 * contract. Narrow instead of asserting `any`.
 */
export interface QboColData {
  value?: string | null;
}

export interface QboRow {
  /** A data row's cells. */
  ColData?: QboColData[];
  /** A section's label row. */
  Header?: { ColData?: QboColData[] };
  /** A section's subtotal row (and, at top level, the grand total). */
  Summary?: { ColData?: QboColData[] };
  /** A section's children. */
  Rows?: { Row?: QboRow[] };
}

export interface QboReport {
  Columns?: { Column?: { ColTitle?: string }[] };
  Rows?: { Row?: QboRow[] };
}

interface FlatReport {
  /** QBO's own column titles. `section`/`rowType` are added per row on top. */
  columns: string[];
  rows: Record<string, string>[];
  /** True when `rows` was cut at maxRows. Never silent. */
  truncated: boolean;
  /** Row count BEFORE truncation. */
  totalRows: number;
}

/** Default cap. Generous enough for a quarter of detail, small enough to read. */
const DEFAULT_MAX_ROWS = 2000;

/** Separator for nested section paths, e.g. `Income > Consulting`. */
const SECTION_SEPARATOR = " > ";

type RowType = "data" | "summary";

interface RawRow {
  cells: string[];
  section: string;
  rowType: RowType;
}

function columnTitles(report: QboReport): string[] {
  const cols = report?.Columns?.Column;
  if (!Array.isArray(cols)) return [];
  return cols.map((c, i) => String(c?.ColTitle ?? `col_${i}`));
}

function cellValues(colData: QboColData[]): string[] {
  return colData.map((c) => String(c?.value ?? ""));
}

/**
 * A section's label: the first non-empty value in `Header.ColData`. QBO pads
 * the header row out to the full column count, so the label is followed by
 * empties — only the first cell is the name.
 */
function headerLabel(row: QboRow): string | null {
  const colData = row?.Header?.ColData;
  if (!Array.isArray(colData)) return null;
  for (const cell of colData) {
    const value = String(cell?.value ?? "").trim();
    if (value) return value;
  }
  return null;
}

/**
 * Walk the recursive Row tree, carrying the enclosing section path down.
 *
 * Emission order matches QBO's own rendering: a section's data rows, then its
 * nested sections, then its subtotal. A section header is NOT emitted as a data
 * row of its own — it is a label, and emitting it would put a class or account
 * name in the Date column. It is preserved as `section` on the rows beneath it.
 */
function collectRows(node: QboReport | QboRow, out: RawRow[], section: string): void {
  const rows = node?.Rows?.Row;
  if (!Array.isArray(rows)) return;

  for (const row of rows) {
    // A row can legitimately carry BOTH its own ColData and nested Rows.
    if (Array.isArray(row?.ColData)) {
      out.push({ cells: cellValues(row.ColData), section, rowType: "data" });
    }

    const label = headerLabel(row);
    const childSection = label ? (section ? `${section}${SECTION_SEPARATOR}${label}` : label) : section;

    if (row?.Rows) collectRows(row, out, childSection);

    // The subtotal closes the section it belongs to, so it is tagged with that
    // section — the data rows tagged the same way are the ones that sum to it.
    if (Array.isArray(row?.Summary?.ColData)) {
      out.push({ cells: cellValues(row.Summary.ColData), section: childSection, rowType: "summary" });
    }
  }
}

export function flattenReport(report: unknown, maxRows: number = DEFAULT_MAX_ROWS): FlatReport {
  const typed = (report ?? {}) as QboReport;
  const columns = columnTitles(typed);

  const raw: RawRow[] = [];
  collectRows(typed, raw, "");

  const truncated = raw.length > maxRows;
  const kept = truncated ? raw.slice(0, maxRows) : raw;

  // Metadata keys never clobber a real QBO column of the same title.
  const sectionKey = columns.includes("section") ? "_section" : "section";
  const rowTypeKey = columns.includes("rowType") ? "_rowType" : "rowType";

  const rows = kept.map((raw) => {
    const obj: Record<string, string> = {};
    columns.forEach((name, i) => {
      obj[name] = raw.cells[i] ?? "";
    });
    obj[sectionKey] = raw.section;
    obj[rowTypeKey] = raw.rowType;
    return obj;
  });

  return { columns, rows, truncated, totalRows: raw.length };
}
