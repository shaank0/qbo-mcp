/**
 * Flatten a QBO report into column-keyed rows.
 *
 * QBO returns reports as a recursive structure: `Rows.Row[]`, where each entry
 * is either a data row (`ColData[]`) or a section carrying its own nested
 * `Rows`. Pretty-printing that whole tree — what the pre-existing report tools
 * do — is unusable for anything the size of a year of transactions.
 *
 * Used by the tools added for the gateway ONLY. The pre-existing tools keep
 * their original output so this stays an additive change upstream.
 */

interface FlatReport {
  columns: string[];
  rows: Record<string, string>[];
  /** True when `rows` was cut at maxRows. Never silent. */
  truncated: boolean;
  /** Row count BEFORE truncation. */
  totalRows: number;
}

/** Default cap. Generous enough for a quarter of detail, small enough to read. */
const DEFAULT_MAX_ROWS = 2000;

function columnTitles(report: any): string[] {
  const cols = report?.Columns?.Column;
  if (!Array.isArray(cols)) return [];
  return cols.map((c: any, i: number) => String(c?.ColTitle ?? `col_${i}`));
}

/** Walk the recursive Row tree, collecting only actual data rows. */
function collectRows(node: any, out: string[][]): void {
  const rows = node?.Rows?.Row;
  if (!Array.isArray(rows)) return;

  for (const row of rows) {
    if (Array.isArray(row?.ColData)) {
      out.push(row.ColData.map((c: any) => String(c?.value ?? "")));
    }
    // A section carries its own Rows; recurse regardless of whether it also
    // had ColData of its own (a section header row is legitimate data).
    if (row?.Rows) collectRows(row, out);
  }
}

export function flattenReport(report: unknown, maxRows: number = DEFAULT_MAX_ROWS): FlatReport {
  const columns = columnTitles(report);

  const raw: string[][] = [];
  collectRows(report, raw);

  const truncated = raw.length > maxRows;
  const kept = truncated ? raw.slice(0, maxRows) : raw;

  const rows = kept.map((cells) => {
    const obj: Record<string, string> = {};
    columns.forEach((name, i) => {
      obj[name] = cells[i] ?? "";
    });
    return obj;
  });

  return { columns, rows, truncated, totalRows: raw.length };
}
