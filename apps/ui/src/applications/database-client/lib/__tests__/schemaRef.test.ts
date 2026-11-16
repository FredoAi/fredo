/**
 * schemaRef unit pins (Spec #3050, ST-A).
 *
 * Pins the ONE table-reference rule the schema-explorer actions consume:
 * `isDataNode` (table/view predicate, R-5) and `buildTableDataSql` (R-2b) —
 * exactly one bounded, read-only `SELECT`, schema-qualified with double-quoted
 * identifiers and embedded `"` doubled. F-39 (unit pin — AC2 support, non-AC).
 */
import { describe, expect, it } from 'vitest';
import { buildTableDataSql, isDataNode, DEFAULT_TABLE_DATA_LIMIT } from '../schemaRef';
import type { DbObjectKind, SchemaNode } from '../types';

function node(kind: DbObjectKind, id: string, name: string): SchemaNode {
  return { kind, id, name, detail: null, hasChildren: kind === 'table' || kind === 'view' };
}

describe('isDataNode — table/view predicate (R-5)', () => {
  it('is true only for table and view', () => {
    expect(isDataNode('table')).toBe(true);
    expect(isDataNode('view')).toBe(true);
  });

  it('is false for every non-data kind', () => {
    const others: DbObjectKind[] = ['database', 'schema', 'column', 'index', 'key', 'function'];
    for (const kind of others) {
      expect(isDataNode(kind)).toBe(false);
    }
  });
});

describe('buildTableDataSql — bounded read-only SELECT (R-2b)', () => {
  it('emits the schema-qualified, double-quoted statement for a table', () => {
    expect(buildTableDataSql(node('table', 'db/public/t/users', 'users'), 100)).toBe(
      'SELECT * FROM "public"."users" LIMIT 100',
    );
  });

  it('emits the same shape for a view', () => {
    expect(buildTableDataSql(node('view', 'db/public/v/v_users', 'v_users'), 25)).toBe(
      'SELECT * FROM "public"."v_users" LIMIT 25',
    );
  });

  it('preserves mixed-case identifiers by quoting them', () => {
    expect(
      buildTableDataSql(node('table', 'db/QA_3050/t/Mixed Case', 'Mixed Case'), 100),
    ).toBe('SELECT * FROM "QA_3050"."Mixed Case" LIMIT 100');
  });

  it('quotes a reserved-word relation name', () => {
    expect(buildTableDataSql(node('table', 'db/public/t/order', 'order'), 7)).toBe(
      'SELECT * FROM "public"."order" LIMIT 7',
    );
  });

  it('doubles an embedded double-quote in the relation name', () => {
    expect(buildTableDataSql(node('table', 'db/public/t/a"b', 'a"b'), 100)).toBe(
      'SELECT * FROM "public"."a""b" LIMIT 100',
    );
  });

  it('doubles an embedded double-quote in the schema name', () => {
    expect(buildTableDataSql(node('table', 'db/we"ird/t/users', 'users'), 100)).toBe(
      'SELECT * FROM "we""ird"."users" LIMIT 100',
    );
  });

  it('never emits a trailing semicolon', () => {
    expect(buildTableDataSql(node('table', 'db/public/t/users', 'users'), 100).endsWith(';')).toBe(
      false,
    );
  });

  it('is always a bare SELECT — never DML/DDL', () => {
    const sql = buildTableDataSql(node('table', 'db/public/t/users', 'users'), 100);
    expect(sql.startsWith('SELECT ')).toBe(true);
    expect(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b/i.test(sql)).toBe(
      false,
    );
  });

  it('floors a fractional limit to an integer', () => {
    expect(buildTableDataSql(node('table', 'db/public/t/users', 'users'), 2.9)).toBe(
      'SELECT * FROM "public"."users" LIMIT 2',
    );
  });

  it('falls back to the default for non-positive / non-finite limits', () => {
    const n = node('table', 'db/public/t/users', 'users');
    const expected = `SELECT * FROM "public"."users" LIMIT ${DEFAULT_TABLE_DATA_LIMIT}`;
    expect(buildTableDataSql(n, 0)).toBe(expected);
    expect(buildTableDataSql(n, -5)).toBe(expected);
    expect(buildTableDataSql(n, Number.NaN)).toBe(expected);
    expect(buildTableDataSql(n, Number.POSITIVE_INFINITY)).toBe(expected);
  });
});
