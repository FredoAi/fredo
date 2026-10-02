/**
 * JSON serialization for the Postgres client (Spec #2950, ST-6).
 *
 * R-4.4 (PO decision 6): turns the **currently loaded** result rows into a JSON
 * array of objects keyed by column name. Like `csv.ts` it is a pure function of
 * `columns` + `rows` — it never receives connection metadata or the DSN, so an
 * export cannot leak a credential.
 */

import type { DbColumn } from './types';

/**
 * Resolve a JSON object key for a column, disambiguating duplicate column names
 * (e.g. `SELECT 1 AS x, 2 AS x`) so no column silently overwrites another.
 */
function uniqueKey(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let suffix = 2;
  let candidate = `${name}_${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${name}_${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Serialize a result set to a JSON document: an array with one object per
 * loaded row, each keyed by its column name, in column order.
 */
export function toJson(columns: DbColumn[], rows: unknown[][]): string {
  const used = new Set<string>();
  const keys = columns.map((column) => uniqueKey(column.name, used));
  const records = rows.map((row) => {
    const record: Record<string, unknown> = {};
    keys.forEach((key, index) => {
      record[key] = row[index] ?? null;
    });
    return record;
  });
  return JSON.stringify(records, null, 2);
}
