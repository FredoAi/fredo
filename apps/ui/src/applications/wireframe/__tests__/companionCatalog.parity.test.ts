/**
 * Companion catalog parity (Spec #3070, ST-7, C4 / R-6.1 / F-43).
 *
 * The Rust catalog and the TS command table must be the SAME 25 actions with the
 * SAME descriptions, or the Companion's list reply would disagree with the
 * toolbar it invokes. This is a STATIC SOURCE PIN (the `featureHotkeyKeys`
 * pattern): it reads `wireframe_catalog.rs` and compares it with
 * `WIREFRAME_ACTIONS`.
 *
 * The pin ALSO asserts the declared argument contract: `action` required;
 * `action`, `app_name`, `summary` are the only declared string properties — an
 * undeclared key must keep failing closed in Rust.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { WIREFRAME_ACTIONS } from '../actions/wireframeActions';

const RUST_CATALOG = resolve(
  process.cwd(),
  '../../apps/tauri/src-tauri/src/infrastructure/companion/wireframe_catalog.rs',
);

const source = readFileSync(RUST_CATALOG, 'utf8');

/** The catalogue literal block, from `WIREFRAME_ACTIONS` to its closing `];`. */
function catalogBlock(): string {
  const start = source.indexOf('pub const WIREFRAME_ACTIONS');
  expect(start, 'WIREFRAME_ACTIONS must exist in the Rust catalog').toBeGreaterThan(-1);
  const end = source.indexOf('\n];', start);
  expect(end, 'the catalogue literal must close with `];`').toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every `("id", "description")` tuple in the block (descriptions may span lines). */
function rustActions(): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const match of catalogBlock().matchAll(
    /\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,?\s*\)/g,
  )) {
    pairs.push([match[1], match[2]]);
  }
  return pairs;
}

/** The `wireframe_parameters()` body (up to the test module). */
function parametersBlock(): string {
  const start = source.indexOf('pub fn wireframe_parameters()');
  expect(start, 'wireframe_parameters() must exist').toBeGreaterThan(-1);
  const end = source.indexOf('#[cfg(test)]', start);
  return source.slice(start, end > start ? end : undefined);
}

describe('Rust catalog <-> TS command table parity', () => {
  it('declares the same 25 ids, in the same order', () => {
    const rustIds = rustActions().map(([id]) => id);
    const tsIds = WIREFRAME_ACTIONS.map((action) => action.id);

    expect(rustIds).toHaveLength(25);
    expect(rustIds).toEqual(tsIds);
  });

  it('uses character-for-character identical descriptions', () => {
    const rust = rustActions();
    for (const action of WIREFRAME_ACTIONS) {
      const entry = rust.find(([id]) => id === action.id);
      expect(entry, `${action.id} must exist in the Rust catalog`).toBeDefined();
      expect(entry?.[1], action.id).toBe(action.description);
    }
  });

  it('declares `action` as the only required argument', () => {
    const required = [
      ...parametersBlock().matchAll(/"required"\s*:\s*\[([^\]]*)\]/g),
    ].flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((inner) => inner[1]));

    expect(required).toEqual(['action']);
  });

  it('declares exactly the three string arguments action/app_name/summary', () => {
    const properties = [
      ...parametersBlock().matchAll(
        /"([a-z_]+)"\s*:\s*\{\s*"type"\s*:\s*"string"\s*\}/g,
      ),
    ].map((match) => match[1]);

    expect(properties).toEqual(['action', 'app_name', 'summary']);
  });

  it('pins the binding skill name', () => {
    expect(source).toContain('pub const WIREFRAME_SKILL: &str = "wireframe";');
  });
});
