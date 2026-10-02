/**
 * CSV serialization for the Postgres client (Spec #2950, ST-6).
 *
 * R-4.4: turns the **currently loaded** result rows into a CSV document with a
 * header row. It is a pure function of `columns` + `rows` — it has no access to
 * connection metadata, the DSN or credentials, so an export can never leak a
 * secret (the only inputs are the visible grid contents).
 *
 * RFC 4180 escaping: a field is quoted only when it contains a comma, a double
 * quote, CR or LF; embedded quotes are doubled. Values are otherwise preserved
 * verbatim (no formula-prefix rewriting — that would corrupt the data and make
 * the export disagree with the grid).
 */

import type { DbColumn } from './types';

/** RFC 4180 line terminator. */
export const CSV_LINE_BREAK = '\r\n';

/**
 * Render one cell value for CSV. `null`/`undefined` become an EMPTY field (the
 * standard CSV representation of SQL NULL, matching JSON's `null`); objects are
 * JSON-encoded so structured column values survive the round-trip.
 */
export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Quote a field when RFC 4180 requires it; double any embedded quotes. */
export function escapeCsvField(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialize a result set to CSV: one header row of column names followed by one
 * row per loaded row, in column order.
 */
export function toCsv(columns: DbColumn[], rows: unknown[][]): string {
  const header = columns.map((column) => escapeCsvField(column.name)).join(',');
  const body = rows.map((row) =>
    columns.map((_, index) => escapeCsvField(formatCsvValue(row[index]))).join(','),
  );
  return [header, ...body].join(CSV_LINE_BREAK);
}
