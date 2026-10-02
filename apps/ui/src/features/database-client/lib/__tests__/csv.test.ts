/**
 * CSV export tests (Spec #2950, ST-6; R-4.4).
 *
 * Pins the header row, RFC 4180 escaping, NULL/object handling and the
 * secret-free contract: `toCsv` is a pure function of the visible columns and
 * rows and cannot add connection metadata or a DSN.
 */
import { describe, expect, it } from 'vitest';

import { CSV_LINE_BREAK, escapeCsvField, formatCsvValue, toCsv } from '../csv';
import type { DbColumn } from '../types';

const columns: DbColumn[] = [
  { name: 'id', typeName: 'int4' },
  { name: 'name', typeName: 'text' },
];

describe('toCsv — header + rows (R-4.4)', () => {
  it('emits a header row then one row per loaded row, in column order', () => {
    const csv = toCsv(columns, [
      [1, 'alice'],
      [2, 'bob'],
    ]);
    expect(csv.split(CSV_LINE_BREAK)).toEqual(['id,name', '1,alice', '2,bob']);
  });

  it('emits only the header when there are columns but no loaded rows', () => {
    expect(toCsv(columns, [])).toBe('id,name');
  });

  it('emits an empty document when there are no columns', () => {
    expect(toCsv([], [])).toBe('');
  });

  it('renders NULL/undefined as an empty field and JSON-encodes objects', () => {
    expect(formatCsvValue(null)).toBe('');
    expect(formatCsvValue(undefined)).toBe('');
    expect(formatCsvValue({ a: 1 })).toBe('{"a":1}');
    expect(toCsv([{ name: 'a', typeName: 'text' }, { name: 'b', typeName: 'text' }], [[null, 'x']]))
      .toBe('a,b\r\n,x');
  });

  it('preserves numbers, booleans and unicode verbatim', () => {
    expect(toCsv([{ name: 'v', typeName: 'text' }], [[0], [false], ['héllo 日本']]))
      .toBe('v\r\n0\r\nfalse\r\nhéllo 日本');
  });
});

describe('CSV escaping (RFC 4180)', () => {
  it('quotes fields containing a comma, quote, CR or LF and doubles quotes', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('')).toBe('');
  });

  it('keeps a CSV-injection-style value structurally contained', () => {
    const csv = toCsv([{ name: 'formula', typeName: 'text' }], [['=SUM(A1:A2)'], ['+1'], ['-1']]);
    const lines = csv.split(CSV_LINE_BREAK);
    // Values are preserved verbatim (no silent rewriting) but never break columns.
    expect(lines).toEqual(['formula', '=SUM(A1:A2)', '+1', '-1']);
  });

  it('quotes a header containing a comma', () => {
    expect(toCsv([{ name: 'a,b', typeName: 'text' }], [['x']])).toBe('"a,b"\r\nx');
  });
});

describe('secret-free contract (R-4.4)', () => {
  it('adds no columns beyond those supplied — no DSN/host/credential metadata', () => {
    const csv = toCsv(columns, [[1, 'alice']]);
    const header = csv.split(CSV_LINE_BREAK)[0];
    expect(header).toBe('id,name');
    expect(csv.toLowerCase()).not.toContain('dsn');
    expect(csv.toLowerCase()).not.toContain('password');
    expect(csv.toLowerCase()).not.toContain('host=');
  });
});
