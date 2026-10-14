/**
 * Table-reference helpers for the schema-explorer actions submenu (Spec #3050,
 * ST-A).
 *
 * Pure, IPC-free derivations from a `SchemaNode` — the ONE qualification rule
 * the schema-explorer actions consume (G-255). No backend/wire change is needed:
 * a table/view node's `id` carries both the schema and the relation
 * (`db/<schema>/(t|v)/<relation>`, `schema.rs:139-142`).
 */

import type { DbObjectKind, SchemaNode } from './types';

/**
 * Fallback row bound when the supplied limit is non-finite or `<= 0`. Mirrors
 * the backend's first-page default (`query.rs` DEFAULT_PAGE = 100).
 */
export const DEFAULT_TABLE_DATA_LIMIT = 100;

const DATA_KINDS: ReadonlySet<DbObjectKind> = new Set<DbObjectKind>(['table', 'view']);

/** `true` for the object kinds whose rows can be opened (`table`, `view`). */
export function isDataNode(kind: DbObjectKind): boolean {
  return DATA_KINDS.has(kind);
}

/** Double-quote a SQL identifier, doubling any embedded `"` (R-2b). */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Parse `db/<schema>/(t|v)/<relation>` into its qualified parts. The id scheme
 * cannot represent a name containing `/` (`parse_parent` rejects it), so the
 * well-formed case is exactly four segments. The fallback is defensive — callers
 * only invoke this for a reached table/view node (`isDataNode`).
 */
function relationRef(node: SchemaNode): { schema: string; relation: string } {
  const segments = node.id.split('/');
  const isRelationId =
    segments.length === 4 &&
    segments[0] === 'db' &&
    (segments[2] === 't' || segments[2] === 'v');
  if (isRelationId) {
    return { schema: segments[1], relation: segments[3] };
  }
  return { schema: segments[1] ?? '', relation: node.name };
}

/**
 * Build the bounded, read-only statement for a table/view node (R-2b):
 *
 *   SELECT * FROM "<schema>"."<relation>" LIMIT <n>
 *
 * Identifiers are always double-quoted with an embedded `"` doubled, so the
 * statement works for any table name. Per the UI/UX binding contract there is
 * **no trailing semicolon**. `n` is floored to an integer; a non-finite or
 * `<= 0` limit falls back to {@link DEFAULT_TABLE_DATA_LIMIT}. The statement is
 * always a bare `SELECT` — never DML/DDL. Callers guard with `isDataNode`.
 */
export function buildTableDataSql(node: SchemaNode, limit: number): string {
  const { schema, relation } = relationRef(node);
  const bounded =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TABLE_DATA_LIMIT;
  return `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(relation)} LIMIT ${bounded}`;
}
