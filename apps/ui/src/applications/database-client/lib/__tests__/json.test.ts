/**
 * JSON export tests (Spec #2950, ST-6; R-4.4, PO decision 6).
 *
 * Pins object keys from the columns, value/null fidelity, duplicate-name
 * disambiguation, JSON escaping and the secret-free contract.
 */
import { describe, expect, it } from 'vitest';

import { toJson } from '../json';
import type { DbColumn } from '../types';

const columns: DbColumn[] = [
  { name: 'id', typeName: 'int4' },
  { name: 'name', typeName: 'text' },
];

describe('toJson — object keys + values (R-4.4)', () => {
  it('emits an array of objects keyed by column name', () => {
    const parsed = JSON.parse(toJson(columns, [[1, 'alice'], [2, 'bob']]));
    expect(parsed).toEqual([
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ]);
  });

  it('emits an empty array when there are no loaded rows', () => {
    expect(toJson(columns, [])).toBe('[]');
  });

  it('preserves JSON null (not the string "null") and nested values', () => {
    const parsed = JSON.parse(
      toJson(
        [
          { name: 'a', typeName: 'text' },
          { name: 'b', typeName: 'jsonb' },
        ],
        [[null, { nested: [1, 2] }]],
      ),
    );
    expect(parsed).toEqual([{ a: null, b: { nested: [1, 2] } }]);
  });

  it('escapes quotes and unicode safely', () => {
    const parsed = JSON.parse(toJson([{ name: 'v', typeName: 'text' }], [['a"b\n日本']]));
    expect(parsed).toEqual([{ v: 'a"b\n日本' }]);
  });

  it('disambiguates duplicate column names instead of losing a column', () => {
    const parsed = JSON.parse(
      toJson(
        [
          { name: 'x', typeName: 'int4' },
          { name: 'x', typeName: 'int4' },
        ],
        [[1, 2]],
      ),
    );
    expect(parsed).toEqual([{ x: 1, x_2: 2 }]);
  });

  it('adds no keys beyond those supplied — no DSN/host/credential metadata', () => {
    const parsed = JSON.parse(toJson(columns, [[1, 'alice']]));
    expect(Object.keys(parsed[0])).toEqual(['id', 'name']);
    expect(toJson(columns, [[1, 'alice']]).toLowerCase()).not.toContain('password');
  });
});
