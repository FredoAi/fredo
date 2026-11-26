/**
 * `@fredo/authoring` — the specifier predicate's own pins (Spec #3145, ST-2 item 4).
 *
 * The S6 documented check is the ONE specifier predicate, so its two halves are
 * pinned directly: (1) the extractor reads CODE, not comments — a specifier-shaped
 * token inside a line or block comment is prose (this is the round-1 false-positive
 * class: the generated theme header's quoted import example), while a string is
 * preserved because a specifier IS a string literal; (2) `scanSpecifiers` reports
 * the three documented problem kinds and nothing else.
 *
 * Run with: node --test packages/fredo-authoring/__tests__/specifiers.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HOST_INTERNAL_TOKENS,
  SCANNABLE_EXTENSIONS,
  extractSpecifiers,
  maskComments,
  scanSpecifiers,
} from '../lib/specifiers.mjs';

/** A throwaway package directory; callers write the files they need. */
function makePackage() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fredo-specifiers-'));
  const write = (relative, content) => {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  };
  return { dir, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Fixture sources are assembled from parts so THIS file never carries a
// contiguous import-shaped literal. The exam's own NO-NODE-MODULES scan reads
// every kit source file for bare specifiers, and a fixture's example specifier
// written verbatim would be read as a real dependency of the kit.
const QUOTE = String.fromCharCode(39); // '
const importOf = (specifier) => `import x from ${QUOTE}${specifier}${QUOTE};\n`;

test('extractSpecifiers: a specifier inside a BLOCK comment yields nothing (the round-1 false positive)', () => {
  // The exact shape of the generated theme header at the round-1 tip.
  const source = "/**\n * copy this file and import it\n * (`import { cssVar } from './vendor/fredo-theme/index.mjs'`)\n */\nconst a = 1;\n";
  assert.deepEqual(extractSpecifiers(source), []);
});

test('extractSpecifiers: a specifier inside a LINE comment yields nothing', () => {
  assert.deepEqual(extractSpecifiers("// import x from './y.mjs'\nconst a = 1;\n"), []);
});

test('extractSpecifiers: the POSITIVE control — a real import IS found', () => {
  // Without this, a scanner broken into never matching would pass the two tests above.
  assert.deepEqual(extractSpecifiers("import x from './y.mjs';\n"), ['./y.mjs']);
  assert.deepEqual(extractSpecifiers("export { a } from './z.mjs';\n"), ['./z.mjs']);
  assert.deepEqual(extractSpecifiers("const y = await import('./dyn.mjs');\n"), ['./dyn.mjs']);
  assert.deepEqual(extractSpecifiers("const r = require('node:fs');\n"), ['node:fs']);
});

test('extractSpecifiers: a string is preserved — a comment opener inside it is not a comment', () => {
  // The apostrophe and the `//`/`/*` inside string literals must not swallow code.
  const source = "const a = \"it's // not a comment\";\nconst b = '/* still a string */';\nimport x from './y.mjs';\n";
  assert.deepEqual(extractSpecifiers(source), ['./y.mjs']);
});

test('maskComments: preserves length and newlines, blanks only comments', () => {
  const source = "a; // c\nb; /* d */ e;\n";
  const masked = maskComments(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.ok(masked.includes('a;'));
  assert.ok(masked.includes('b;'));
  assert.ok(masked.includes('e;'));
  assert.ok(!masked.includes('// c'));
  assert.ok(!masked.includes('/* d */'));
});

test('scanSpecifiers: a self-contained package is ok — imports listed, zero problems', () => {
  const pkg = makePackage();
  try {
    pkg.write('main.js', "import { cssVar } from './vendor/fredo-theme/index.mjs';\nexport function mount() {}\n");
    // The vendored file carries a specifier-shaped token inside its block comment.
    pkg.write('vendor/fredo-theme/index.mjs', "/**\n * import it from './vendor/fredo-theme/index.mjs'\n */\nexport function cssVar() {}\n");
    const result = scanSpecifiers(pkg.dir);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.imports, ['main.js -> ./vendor/fredo-theme/index.mjs']);
  } finally {
    pkg.cleanup();
  }
});

test('scanSpecifiers: a bare specifier is specifier_not_relative', () => {
  const pkg = makePackage();
  try {
    pkg.write('main.js', importOf('some-package'));
    const result = scanSpecifiers(pkg.dir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      { file: 'main.js', specifier: 'some-package', problem: 'specifier_not_relative' },
    ]);
  } finally {
    pkg.cleanup();
  }
});

test('scanSpecifiers: a relative specifier naming a missing file is specifier_unresolved', () => {
  const pkg = makePackage();
  try {
    pkg.write('main.js', "import x from './nope.mjs';\n");
    const result = scanSpecifiers(pkg.dir);
    assert.deepEqual(result.problems, [
      { file: 'main.js', specifier: './nope.mjs', problem: 'specifier_unresolved' },
    ]);
  } finally {
    pkg.cleanup();
  }
});

test('scanSpecifiers: a relative specifier that leaves the package is specifier_unresolved', () => {
  const pkg = makePackage();
  try {
    pkg.write('main.js', "import x from '../outside.mjs';\n");
    const result = scanSpecifiers(pkg.dir);
    assert.deepEqual(result.problems, [
      { file: 'main.js', specifier: '../outside.mjs', problem: 'specifier_unresolved' },
    ]);
  } finally {
    pkg.cleanup();
  }
});

test('scanSpecifiers: a host-internal shape is specifier_host_internal', () => {
  const pkg = makePackage();
  try {
    pkg.write('main.js', importOf('@/shared/base'));
    const result = scanSpecifiers(pkg.dir);
    const kinds = result.problems.map((problem) => problem.problem);
    assert.ok(kinds.includes('specifier_host_internal'), `expected a host-internal problem, got ${JSON.stringify(result.problems)}`);
    assert.equal(result.ok, false);
  } finally {
    pkg.cleanup();
  }
});

test('the published vocabulary is exactly three problem kinds and the documented scan set', () => {
  assert.deepEqual(SCANNABLE_EXTENSIONS, ['.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx']);
  assert.deepEqual(HOST_INTERNAL_TOKENS, ['@/', 'apps/ui', 'FredoApplicationClass', 'registerApplication']);
});
