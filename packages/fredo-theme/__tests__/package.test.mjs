/**
 * @fredo/theme — the package's own pins (Binding Names).
 *
 * These are the export contract: the package name, the 38 published names,
 * `cssVar()` on a direct var AND on the five name-only aliases (an alias must
 * return its OWN published `color-mix()` expression, never a bare `var()` and
 * never a neighbour's mix), the artifact drift gate, and the zero-colour-literal
 * scan over `dist/`.
 *
 * Run with: node --test packages/fredo-theme/__tests__/package.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildArtifacts } from '../scripts/build-theme.mjs';
import {
  SEMANTIC_TOKENS,
  THEME_EXCLUSIONS,
  THEME_STYLESHEET,
  TOKEN_NAMES,
  cssVar,
  tokensByName,
} from '../dist/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

const ALIAS_NAMES = [
  'accent.subtle',
  'accent.muted',
  'accent.tint',
  'status.errorTint',
  'status.errorStrong',
];

/**
 * The EXACT published expression each name-only alias must resolve to.
 *
 * Provenance: the committed published contract artifact `dist/tokens.json` (the
 * same file the drift gate pins to the regenerated output; its `value` for each
 * alias is the `color-mix()` this package publishes). These are LITERALS on
 * purpose — the shape-only half of the pin below cannot tell one alias's mix
 * from another's, so an alias that returned a NEIGHBOUR's expression would sail
 * through every "starts with color-mix(" / "operands are var()s" assertion. An
 * anchor INDEPENDENT of the generated set is what makes a swap fail; reading the
 * value back from `tokens.json` would only compare the artifact with itself. The
 * cross-check inside the test proves these literals still equal what the
 * committed contract publishes, so the anchor cannot rot into a stale copy.
 */
const EXPECTED_ALIAS_EXPRESSIONS = {
  'accent.subtle': 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
  'accent.muted': 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
  'accent.tint': 'color-mix(in srgb, var(--accent-primary) 10%, var(--body-bg) 90%)',
  'status.errorTint': 'color-mix(in srgb, var(--status-error) 15%, var(--body-bg) 85%)',
  'status.errorStrong': 'color-mix(in srgb, var(--status-error) 50%, var(--text-primary) 50%)',
};

test('the package is named @fredo/theme and every export path resolves', () => {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@fredo/theme');
  assert.equal(manifest.type, 'module');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], 'the package is dependency-free');

  for (const [key, target] of Object.entries(manifest.exports)) {
    const resolved = typeof target === 'string' ? target : target.import ?? target.types;
    if (key === './package.json') continue;
    assert.ok(
      statSync(path.join(PACKAGE_ROOT, resolved)).isFile(),
      `exports["${key}"] must resolve to a committed file (${resolved})`,
    );
  }
});

test('exactly 38 published names: 33 var-carrying and the 5 name-only aliases', () => {
  assert.equal(SEMANTIC_TOKENS.length, 38);
  const aliases = SEMANTIC_TOKENS.filter((token) => token.class === 'N').map((t) => t.name);
  assert.deepEqual(aliases, ALIAS_NAMES, 'the alias class is exactly the five documented names');
  assert.equal(SEMANTIC_TOKENS.length - aliases.length, 33);
  assert.deepEqual(TOKEN_NAMES, SEMANTIC_TOKENS.map((token) => token.name));
  assert.equal(Object.keys(tokensByName).length, 38);
});

test('every published name is non-empty in tokens.json and names a custom property', () => {
  const published = JSON.parse(readFileSync(path.join(DIST_DIR, 'tokens.json'), 'utf8'));
  assert.equal(published.counts.tokens, 38);
  assert.equal(published.counts.varCarrying, 33);
  assert.equal(published.counts.aliases, 5);
  for (const token of published.tokens) {
    assert.match(token.varName, /^--[a-z0-9-]+$/, `${token.name} names a custom property`);
    assert.ok(token.value.length > 0, `${token.name} carries a value`);
  }
  // The exclusion list is part of the published contract (UI/UX's ask).
  const excluded = published.exclusions.map((entry) => entry.varName);
  for (const varName of [
    '--footer-bg',
    '--gradient-text',
    '--gradient-button',
    '--node-bg',
    '--node-box-shadow',
    '--edge-gradient',
    '--shadow-dialog',
    '--font-family',
    '--font-mono',
  ]) {
    assert.ok(excluded.includes(varName), `${varName} must be listed as not published`);
  }
  assert.equal(THEME_EXCLUSIONS.length, 9);
});

test('cssVar(): the direct-var case', () => {
  assert.equal(cssVar('bg.surface'), 'var(--card-bg)');
  assert.equal(cssVar('bg.canvas'), 'var(--body-bg)');
  assert.equal(cssVar('fg.default'), 'var(--text-primary)');
  assert.equal(cssVar('border.default'), 'var(--border-strong)');
  assert.equal(cssVar('--card-bg'), 'var(--card-bg)', 'a raw custom property composes too');
});

test('cssVar(): each name-only alias returns ITS OWN exact published color-mix() expression', () => {
  // The committed contract artifact the literals above are anchored to.
  const published = JSON.parse(readFileSync(path.join(DIST_DIR, 'tokens.json'), 'utf8'));
  const publishedByName = new Map(published.tokens.map((token) => [token.name, token.value]));
  for (const name of ALIAS_NAMES) {
    const value = cssVar(name);
    assert.equal(typeof value, 'string', `${name} must resolve`);
    assert.notEqual(value, undefined, `${name} must not be undefined`);
    assert.ok(value.startsWith('color-mix('), `${name} must be a color-mix() expression, got ${value}`);
    assert.ok(
      !/^var\(/.test(value),
      `${name} must not be a bare var() — that is the alias defect this pin exists for`,
    );
    // The EXACT expression — a swapped alias (this name returning a neighbour's
    // mix) reddens here; the shape assertions above cannot see it.
    assert.equal(
      value,
      EXPECTED_ALIAS_EXPRESSIONS[name],
      `${name} must resolve to its OWN published expression, not another alias's`,
    );
    // The literal anchor IS the contract: the committed tokens.json still
    // publishes it (so the anchor cannot drift into a stale second source).
    assert.equal(
      publishedByName.get(name),
      EXPECTED_ALIAS_EXPRESSIONS[name],
      `${name}: dist/tokens.json must publish the pinned expression`,
    );
    // Every operand is a var() (or the single documented `transparent` stop).
    const inner = value.slice('color-mix(in srgb, '.length, -1);
    for (const stop of inner.split(', ')) {
      assert.match(
        stop,
        /^(var\(--[a-z0-9-]+\)( \d+%)?|transparent)$/,
        `${name} has a non-var operand: ${stop}`,
      );
    }
  }
});

test('cssVar(): every one of the 38 names resolves, and none is undefined', () => {
  const unresolved = SEMANTIC_TOKENS.filter((token) => {
    const value = cssVar(token.name);
    return typeof value !== 'string' || value.length === 0;
  }).map((token) => token.name);
  assert.deepEqual(unresolved, []);
  const vars = SEMANTIC_TOKENS.filter((token) => cssVar(token.name).startsWith('var('));
  const mixes = SEMANTIC_TOKENS.filter((token) => cssVar(token.name).startsWith('color-mix('));
  assert.equal(vars.length, 33);
  assert.equal(mixes.length, 5);
});

test('cssVar() throws for an unknown name instead of returning something', () => {
  assert.throws(() => cssVar('bg.nope'), /not one of the published theme tokens/);
});

test('THEME_STYLESHEET carries every alias expression', () => {
  // Compare LF-normalised (G-481): a Windows checkout materialises the committed
  // file with CRLF, and the generated string is LF.
  const committedCss = readFileSync(path.join(DIST_DIR, 'theme.css'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(THEME_STYLESHEET.replace(/\r\n/g, '\n'), committedCss);
  for (const name of ALIAS_NAMES) {
    assert.ok(
      THEME_STYLESHEET.includes(cssVar(name)),
      `the stylesheet must publish the ${name} expression`,
    );
  }
});

test('dist/ contains no colour literal (across every emitted artifact)', () => {
  const allowed = new Set(['transparent', 'inherit', 'currentcolor', 'none']);
  const namedColours = [
    'white',
    'black',
    'red',
    'green',
    'blue',
    'gray',
    'grey',
    'silver',
    'maroon',
    'olive',
    'lime',
    'aqua',
    'teal',
    'navy',
    'fuchsia',
    'purple',
    'orange',
    'yellow',
    'magenta',
    'cyan',
  ];
  const violations = [];
  for (const file of readdirSync(DIST_DIR)) {
    const full = path.join(DIST_DIR, file);
    if (!statSync(full).isFile()) continue;
    const text = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      violations.push(`${file}: hex ${match[0]}`);
    }
    for (const match of text.matchAll(/\b(?:rgb|rgba|hsl|hsla)\(/g)) {
      violations.push(`${file}: ${match[0]}`);
    }
    for (const match of text.matchAll(/\b[a-zA-Z]+\b/g)) {
      const word = match[0].toLowerCase();
      if (namedColours.includes(word) && !allowed.has(word)) {
        violations.push(`${file}: named colour ${match[0]}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the committed dist/ is current (the drift gate, run from this suite)', () => {
  const output = execFileSync(
    process.execPath,
    [path.join(PACKAGE_ROOT, 'scripts', 'build-theme.mjs'), '--check'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.match(output, /DRIFT OK/);
});

test('the regenerated artifacts deep-equal the committed ones', () => {
  const artifacts = buildArtifacts();
  const tokens = JSON.parse(
    artifacts.find((artifact) => artifact.file === 'tokens.json').content,
  );
  assert.deepEqual(
    tokens.tokens.map((token) => [token.name, token.varName, token.value]),
    SEMANTIC_TOKENS.map((token) => [token.name, token.varName, token.value]),
  );
});
