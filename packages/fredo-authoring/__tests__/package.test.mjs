/**
 * `@fredo/authoring` — the package pins (Binding Names).
 *
 *   - the package name, its exports and its dependency-free shape (NFR-3);
 *   - the schema artifact is the generated one (`$id`, additionalProperties
 *     false everywhere, the frozen 22-code vocabulary);
 *   - the published TYPES agree with the shipped product, in order: the 8
 *     `FredoAction` members equal `DISPATCH_TABLE`'s action column, and the 6
 *     `FredoRefusalCode` members equal `CapabilityRefusalCode::ALL`.
 *
 * Run with: node --test packages/fredo-authoring/__tests__/package.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSchema, refusalCodes, topLevelKeys } from '../lib/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MANIFEST = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const DTS = readFileSync(path.join(PACKAGE_ROOT, 'dist', 'index.d.ts'), 'utf8');

test('the package is named @fredo/authoring, dependency-free, and every export resolves', () => {
  assert.equal(MANIFEST.name, '@fredo/authoring');
  assert.equal(MANIFEST.type, 'module');
  assert.deepEqual(Object.keys(MANIFEST.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(MANIFEST.devDependencies ?? {}), []);
  for (const [key, target] of Object.entries(MANIFEST.exports)) {
    if (key === './package.json') continue;
    const resolved = typeof target === 'string' ? target : target.types ?? target.import;
    assert.ok(statSync(path.join(PACKAGE_ROOT, resolved)).isFile(), `exports["${key}"] must resolve`);
  }
  assert.ok(statSync(path.join(PACKAGE_ROOT, MANIFEST.bin['fredo-app'])).isFile());
});

test('the schema artifact is the generated one', () => {
  const schema = loadSchema();
  assert.equal(schema.$id, 'https://fredo.dev/schemas/fredo-app-1.json');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);

  // additionalProperties is false at EVERY object level (a closed schema).
  const walk = (node, where) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${where}[${index}]`));
      return;
    }
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${where} must be closed`);
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${where}/${key}`);
  };
  walk(schema, '$');

  assert.deepEqual(topLevelKeys().sort(), [
    'capabilities',
    'description',
    'displayName',
    'engines',
    'entry',
    'id',
    'manifestVersion',
    'version',
  ]);
  assert.equal(refusalCodes().length, 22);
});

test('the frozen refusal vocabulary agrees with the committed corpus record', () => {
  const corpus = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        '.opencode',
        'tests',
        'installable-apps',
        'fixtures',
        'package-fixtures.expected.json',
      ),
      'utf8',
    ),
  );
  assert.deepEqual(refusalCodes(), corpus.refusalCodes);
});

/** The string members of a published union in dist/index.d.ts, in order. */
function unionMembers(name) {
  const start = DTS.indexOf(`export type ${name} =`);
  assert.ok(start >= 0, `${name} must be declared`);
  const body = DTS.slice(start, DTS.indexOf(';', start));
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('FredoAction equals DISPATCH_TABLE, in order', () => {
  const dispatchSource = readFileSync(
    path.join(
      REPO_ROOT,
      'apps',
      'tauri',
      'src-tauri',
      'src',
      'applications',
      'installed_apps',
      'dispatch.rs',
    ),
    'utf8',
  );
  const start = dispatchSource.indexOf('pub const DISPATCH_TABLE');
  assert.ok(start >= 0);
  const block = dispatchSource.slice(start, dispatchSource.indexOf('];', start));
  const fromProduct = [...block.matchAll(/\("([a-z_]+)",\s*CapabilityId::/g)].map((match) => match[1]);
  assert.equal(fromProduct.length, 8);
  assert.deepEqual(unionMembers('FredoAction'), fromProduct);
});

test('FredoRefusalCode equals CapabilityRefusalCode::ALL, in order', () => {
  const authoritySource = readFileSync(
    path.join(
      REPO_ROOT,
      'apps',
      'tauri',
      'src-tauri',
      'src',
      'applications',
      'installed_apps',
      'authority.rs',
    ),
    'utf8',
  );
  const start = authoritySource.indexOf('pub const ALL: [Self; 6]');
  assert.ok(start >= 0);
  const block = authoritySource.slice(start, authoritySource.indexOf('];', start));
  const variants = [...block.matchAll(/Self::(\w+)/g)].map((match) => match[1]);
  const snakeCase = (variant) =>
    variant
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
      .toLowerCase();
  assert.equal(variants.length, 6);
  assert.deepEqual(unionMembers('FredoRefusalCode'), variants.map(snakeCase));
});

test('the published types carry the absent-not-null contract and the snapshot note', () => {
  assert.match(DTS, /readonly capability\?:/, 'capability is OPTIONAL — absent, never null');
  assert.match(
    DTS,
    /SNAPSHOT, NOT A LIVE HANDLE/,
    'ctx.theme must be documented as a mount-time snapshot',
  );
  assert.match(DTS, /readonly root: HTMLElement/, 'mount(ctx) receives the root element');
  assert.ok(!/unmount/.test(DTS), 'there is no unmount hook');
});
