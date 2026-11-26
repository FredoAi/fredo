/**
 * The CONFORMANCE corpus pin (Spec #3145, ST-2; NFR-6).
 *
 * For every committed fixture manifest, the kit's `check` (the validator built on
 * the published schema) and the recorded Rust-parser expectation in
 * `package-fixtures.expected.json` must produce the SAME code — in the fixture
 * ORDER of that file. A same-set reorder, a one-sided edit, or a fixture whose
 * bytes were regenerated against a different schema reddens here.
 *
 * Two controls make the pin non-vacuous:
 *   - the D1 CONTROL: `capabilities` set to an ARRAY (the old fixture's bytes)
 *     classifies `manifest_invalid_field`, NOT `manifest_unknown_field` — which is
 *     exactly why the drift existed;
 *   - the POSITIVE CONTROL: a legal `capabilities` object is never
 *     `manifest_unknown_field` (the invariant the drift violated).
 *
 * Run with: node --test packages/fredo-authoring/__tests__/conformance.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { refusalCodes, validateManifest } from '../lib/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, '.opencode', 'tests', 'installable-apps', 'fixtures');

const corpus = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'package-fixtures.expected.json'), 'utf8'));
const generatorUrl = new URL(
  `file:///${path.join(FIXTURES_DIR, 'build-package-fixtures.mjs').replace(/\\/g, '/')}`,
);
const { FIXTURES, MANIFEST_CLASSIFIABLE_CODES, manifestFor } = await import(generatorUrl.href);

/** The code the kit's validator reports for a fixture's manifest (or null). */
function classify(fixture) {
  if (fixture.omitManifest) return 'no_manifest';
  const violation = validateManifest(manifestFor(fixture), {})[0] ?? null;
  return violation === null ? null : violation.code;
}

test('the corpus and the generator describe the same fixture set, in order', () => {
  assert.deepEqual(
    corpus.fixtures.map((item) => item.id),
    FIXTURES.map((fixture) => fixture.id),
    'the committed corpus and the generator must name the same fixtures in the same order',
  );
});

test('every fixture classifies as its recorded code, or is schema-legal where the code is not a manifest rule', () => {
  const failures = [];
  for (const [index, fixture] of FIXTURES.entries()) {
    const recorded = corpus.fixtures[index];
    const code = classify(fixture);
    if (MANIFEST_CLASSIFIABLE_CODES.has(fixture.expects) || fixture.omitManifest) {
      if (code !== fixture.expects) {
        failures.push(`${fixture.id}: the kit says ${code}, the corpus records ${fixture.expects}`);
      }
    } else if (code !== null) {
      failures.push(`${fixture.id}: its manifest must be schema-legal, the kit says ${code}`);
    }
    if (recorded.expects !== fixture.expects) {
      failures.push(`${fixture.id}: corpus ${recorded.expects} vs generator ${fixture.expects}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('every recorded code is one of the frozen 22 wire strings', () => {
  const known = new Set(refusalCodes());
  for (const item of corpus.fixtures) {
    if (item.expects === null) continue;
    assert.ok(known.has(item.expects), `${item.id} records an unknown code ${item.expects}`);
  }
});

test('D1 control: `capabilities` as an ARRAY is manifest_invalid_field, never manifest_unknown_field', () => {
  const manifest = manifestFor(FIXTURES.find((fixture) => fixture.id === 'qa3147-valid'));
  const legacy = { ...manifest, capabilities: ['read:settings'] };
  const violation = validateManifest(legacy, {})[0];
  assert.equal(violation.code, 'manifest_invalid_field');
  assert.equal(violation.field, 'capabilities');
  assert.notEqual(violation.code, 'manifest_unknown_field');
});

test('D1 invariant: a legal `capabilities` object is accepted and is never an unknown field', () => {
  const manifest = manifestFor(FIXTURES.find((fixture) => fixture.id === 'qa3147-valid'));
  const legal = {
    ...manifest,
    capabilities: {
      version: 1,
      data: {
        tables: [
          {
            name: 'notes',
            primaryKey: ['id'],
            columns: [{ name: 'id', type: 'TEXT', nullable: false, owner: 'application' }],
          },
        ],
      },
      highRisk: ['high-risk.process-spawn'],
    },
  };
  const violations = validateManifest(legal, {});
  assert.deepEqual(violations, []);
});

test('the repaired bad-manifest fixture uses a genuinely-unknown key', () => {
  const bad = FIXTURES.find((fixture) => fixture.id === 'qa3147-bad-manifest');
  assert.equal(bad.unknownField, 'sandbox');
  assert.notEqual(bad.unknownField, 'capabilities');
  const recorded = corpus.fixtures.find((item) => item.id === 'qa3147-bad-manifest');
  assert.equal(recorded.badManifestShape, 'sandbox');
  assert.equal(recorded.expects, 'manifest_unknown_field');
});

test('the required-field fixture exists and drives manifest_invalid_field on displayName', () => {
  const missing = FIXTURES.find((fixture) => fixture.id === 'qa3145-missing-field');
  assert.ok(missing, 'qa3145-missing-field must be in the corpus');
  assert.equal(missing.expects, 'manifest_invalid_field');
  assert.equal(missing.missingField, 'displayName');
  const violation = validateManifest(manifestFor(missing), {})[0];
  assert.equal(violation.code, 'manifest_invalid_field');
  assert.equal(violation.field, 'displayName');
});
