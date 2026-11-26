/**
 * `fredo-app check` / `fredo-app pack` — the CLI's own pins (Binding Names).
 *
 * Every case drives the REAL command through `node <bin>` (never an import of its
 * internals), because the exam and QA's rows invoke it that way: the verb set,
 * the exit codes, the `--json` payload shape, the shipped refusal codes with
 * their field paths, the deterministic pack, and the refused-before-written
 * guarantee.
 *
 * Run with: node --test packages/fredo-authoring/__tests__/cli.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BIN = path.join(PACKAGE_ROOT, 'bin', 'fredo-app.mjs');
const TMP_ROOT = path.join(REPO_ROOT, '.opencode', 'tmp', '3145', 'authoring-test');

/** Run the CLI and capture { status, stdout, stderr }. */
function run(args, cwd = REPO_ROOT) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

/** Write a package directory. */
function writePackage(root, { manifest, files = {} }) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'fredo-app.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body></body></html>\n', 'utf8');
  writeFileSync(path.join(root, 'main.js'), "export function mount(ctx) { ctx.root.textContent = 'ok'; }\n", 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel.split('/').join(path.sep));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

function validManifest(overrides = {}) {
  return {
    manifestVersion: 1,
    id: 'com.example.notes',
    displayName: 'Notes',
    version: '1.0.0',
    engines: { fredo: '>=0.1.0' },
    entry: { document: 'index.html', module: 'main.js' },
    description: 'A sample package.',
    ...overrides,
  };
}

let caseRoot = null;

test.before(() => {
  mkdirSync(TMP_ROOT, { recursive: true });
  caseRoot = mkdtempSync(path.join(TMP_ROOT, 'cli-'));
});

test.after(() => {
  if (caseRoot !== null) rmSync(caseRoot, { recursive: true, force: true });
});

test('--help lists exactly the two verbs', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /check <dir>/);
  assert.match(stdout, /pack\s+<dir> --out <file>/);
  for (const forbidden of [/\binit\b/i, /\bnew\b/i, /scaffold/i, /template/i, /starter/i]) {
    assert.ok(!forbidden.test(stdout), `the help must not offer ${forbidden}`);
  }
});

test('check: a valid package exits 0 with an empty violation list', () => {
  const dir = path.join(caseRoot, 'valid');
  writePackage(dir, { manifest: validManifest() });
  const { status, stdout } = run(['check', dir, '--json']);
  assert.equal(status, 0);
  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.violations, []);
  assert.equal(payload.valid, true);
  assert.equal(payload.notChecked.length, 1, 'the unchecked range rule must be stated');
  assert.match(payload.notChecked[0], /engines\.fredo/);
});

test('check: a missing displayName is manifest_invalid_field naming the field', () => {
  const dir = path.join(caseRoot, 'missing-display-name');
  const manifest = validManifest();
  delete manifest.displayName;
  writePackage(dir, { manifest });
  const { status, stdout } = run(['check', dir, '--json']);
  assert.notEqual(status, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.violations.length, 1);
  assert.equal(payload.violations[0].code, 'manifest_invalid_field');
  assert.equal(payload.violations[0].field, 'displayName');
  assert.equal(payload.violations[0].detail, 'displayName is required');
});

test('check: a malformed engines range and an excluding range drive DIFFERENT codes', () => {
  const malformed = path.join(caseRoot, 'range-malformed');
  writePackage(malformed, { manifest: validManifest({ engines: { fredo: '>=' } }) });
  const malformedRun = run(['check', malformed, '--json']);
  assert.notEqual(malformedRun.status, 0);
  const malformedPayload = JSON.parse(malformedRun.stdout);
  assert.equal(malformedPayload.violations[0].code, 'engines_range_invalid');
  assert.equal(malformedPayload.violations[0].field, 'engines.fredo');

  const excluding = path.join(caseRoot, 'range-excludes');
  writePackage(excluding, { manifest: validManifest({ engines: { fredo: '>=999.0.0' } }) });
  const excludingRun = run(['check', excluding, '--fredo', '0.2.5', '--json']);
  assert.notEqual(excludingRun.status, 0);
  const excludingPayload = JSON.parse(excludingRun.stdout);
  assert.equal(excludingPayload.violations[0].code, 'host_incompatible');
  assert.equal(excludingPayload.violations[0].field, 'engines.fredo');
  assert.match(excludingPayload.violations[0].detail, />=999\.0\.0/);
  assert.match(excludingPayload.violations[0].detail, /0\.2\.5/);
  assert.deepEqual(excludingPayload.notChecked, [], 'with --fredo nothing is left unchecked');
});

test('check: an unknown top-level key is refused, and capabilities is NOT unknown', () => {
  const unknown = path.join(caseRoot, 'unknown-key');
  writePackage(unknown, { manifest: validManifest({ sandbox: { allow: true } }) });
  const unknownRun = run(['check', unknown, '--json']);
  assert.notEqual(unknownRun.status, 0);
  const unknownPayload = JSON.parse(unknownRun.stdout);
  assert.equal(unknownPayload.violations[0].code, 'manifest_unknown_field');
  assert.equal(unknownPayload.violations[0].field, 'sandbox');

  const legal = path.join(caseRoot, 'legal-capabilities');
  writePackage(legal, {
    manifest: validManifest({
      capabilities: {
        version: 1,
        data: {
          tables: [
            {
              name: 'notes',
              primaryKey: ['id'],
              columns: [
                { name: 'id', type: 'TEXT', nullable: false, owner: 'application' },
              ],
            },
          ],
        },
        highRisk: ['high-risk.database-query'],
      },
    }),
  });
  const legalRun = run(['check', legal, '--json']);
  assert.equal(legalRun.status, 0, legalRun.stdout + legalRun.stderr);
  assert.deepEqual(JSON.parse(legalRun.stdout).violations, []);
});

test('check: entry_missing names the field whose file is absent', () => {
  const dir = path.join(caseRoot, 'entry-missing');
  writePackage(dir, {
    manifest: validManifest({ entry: { document: 'index.html', module: 'absent.js' } }),
  });
  const { status, stdout } = run(['check', dir, '--json']);
  assert.notEqual(status, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.violations[0].code, 'entry_missing');
  assert.equal(payload.violations[0].field, 'entry.module');
});

test('pack: two packs of the same directory print the same sha256, and vendor/ is packed', () => {
  const dir = path.join(caseRoot, 'pack-me');
  writePackage(dir, {
    manifest: validManifest(),
    files: { 'vendor/fredo-theme/index.mjs': "export const cssVar = (name) => 'var(--' + name + ')';\n" },
  });
  const first = run(['pack', dir, '--out', path.join(caseRoot, 'out', 'a.zip'), '--json']);
  const second = run(['pack', dir, '--out', path.join(caseRoot, 'out', 'b.zip'), '--json']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const firstPayload = JSON.parse(first.stdout);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(firstPayload.sha256, secondPayload.sha256);
  assert.ok(firstPayload.names.includes('vendor/fredo-theme/index.mjs'), 'the vendored file is packed');
  assert.deepEqual(firstPayload.names, [
    'fredo-app.json',
    'index.html',
    'main.js',
    'vendor/fredo-theme/index.mjs',
  ]);
  assert.deepEqual(
    readFileSync(path.join(caseRoot, 'out', 'a.zip')),
    readFileSync(path.join(caseRoot, 'out', 'b.zip')),
  );
});

test('pack: a package that would be refused is never written', () => {
  const dir = path.join(caseRoot, 'refused');
  const manifest = validManifest();
  delete manifest.displayName;
  writePackage(dir, { manifest });
  const out = path.join(caseRoot, 'out', 'refused.zip');
  const { status, stdout } = run(['pack', dir, '--out', out, '--json']);
  assert.notEqual(status, 0);
  assert.equal(JSON.parse(stdout).packed, false);
  assert.equal(existsSync(out), false, 'nothing may be written for a refused package');
});

test('pack: a __fredo/ file is refused as reserved_path', () => {
  const dir = path.join(caseRoot, 'reserved');
  writePackage(dir, {
    manifest: validManifest(),
    files: { '__fredo/bootstrap.js': '// host-owned\n' },
  });
  const out = path.join(caseRoot, 'out', 'reserved.zip');
  const { status, stdout } = run(['pack', dir, '--out', out, '--json']);
  assert.notEqual(status, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.packed, false);
  assert.equal(payload.violations[0].code, 'reserved_path');
  assert.equal(existsSync(out), false);
});

test('an unknown verb is refused (the kit is not a scaffolder)', () => {
  const { status, stderr } = run(['scaffold', path.join(caseRoot, 'x')]);
  assert.equal(status, 2);
  assert.match(stderr, /the verbs are exactly: check, pack/);
});
