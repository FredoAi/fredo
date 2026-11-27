#!/usr/bin/env node
/**
 * build-ac4-record.mjs -- Spec #3244 ST-6: write the AC-4 screen-read measurement
 * record from a LIVE run's capture.
 *
 * WHAT THIS IS
 *   AC-4 requires the amount of screen Fredo can act on to be a RECORDED NUMBER
 *   derived from a run, never asserted and never hand-authored (G-511). This
 *   generator takes a run CAPTURE (the values read back from a real companion
 *   turn's `telemetry_spans` `companion.injection` record plus the run identity)
 *   and writes the committed record at the path below. It REFUSES a capture that
 *   is missing any measured number -- a placeholder is not a measurement.
 *
 * SCHEMA v2 -- WHAT THE NUMBER IS, AND WHAT IT IS NOT
 *   The AC-4 NUMBER is `outline.utf8Bytes`: the outline leg's measured size, which
 *   VARIES with the screen (the observed ladder: 8029 bytes / 68 nodes vs 1049 /
 *   11). It is carried with `nodeCount`, `truncated`, a DERIVED `bytesHeadroom`
 *   and a DERIVED `bindingCap`.
 *   `screenshot.encodedImageTokens` is RETAINED but DEMOTED to rig-cost context
 *   for NFR-1: it is the engine's encoded visual-token count for one fixed-size
 *   window capture, so it is DENSITY-INVARIANT by construction (observed 840 on
 *   every turn regardless of outline size). It cannot express a screen-read
 *   limit, so it is not the AC-4 number -- v1's premise, retired here.
 *   A v1 capture/record is REFUSED by the parser
 *   (`parseScreenReadRecord`, apps/ui/src/shared/app-intelligibility/measurement.ts).
 *
 * WHERE THE NUMBERS COME FROM (the tester's live leg)
 *   `outline.utf8Bytes` / `outline.nodeCount` -- the injection span's
 *     `simplifiedHtmlBytes` / `simplifiedHtmlNodes` attributes.
 *   `outline.truncated`                       -- the injection span's
 *     `simplifiedHtmlTruncated` attribute (a REQUIRED boolean on the span itself;
 *     before this rework the span carried no such field, so a capture could only
 *     assert it by invention).
 *   `screenshot.encodedImageTokens`           -- the injection span's
 *     `imageTokens` attribute (the engine's `MediaPlan::image_tokens`), rig context.
 *   `bytesHeadroom` / `bindingCap`            -- DERIVED here from the outline and
 *     the caps (never read from the span).
 *   `appId` / `injectionSpanId`                -- the span's `session_id` /
 *     `span_id`.
 *   `commit` / `capturedAt`                     -- the run identity (the spec
 *     branch tip the tested tree was served at, and when the pair was captured).
 *   `capsInForce`                               -- `SCREEN_OUTLINE_MAX_NODES` /
 *     `SCREEN_OUTLINE_MAX_BYTES` as they stood at `commit` (read them from
 *     `apps/ui/src/shared/app-intelligibility/screenOutline.ts`).
 *
 *   The `--self-check` leg proves the FORMAT deterministically without a live app
 *   (Node built-ins only, no network, no npm package). It does NOT invent a
 *   measurement; it only exercises the writer, the derivation and the refusal
 *   guards.
 *
 * Usage:
 *   node .opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs --capture <capture.json>
 *   node .opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs --capture <c.json> --out <record.json>
 *   node .opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs --self-check
 *   node .opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs --help
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, 'ac4-screen-read-record.json');

const SCHEMA_VERSION = 2;
const AC = 'AC-4';

/** The only values `bindingCap` may take. */
const BINDING_CAPS = ['bytes', 'nodes', 'none'];

/** A finite, non-negative integer, or `null` when the value is missing/invalid. */
function asCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/**
 * THE `bindingCap` rule, stated once (mirrors `deriveBindingCap` in
 * `apps/ui/src/shared/app-intelligibility/measurement.ts` -- the product owns the
 * rule; this writer restates it rather than inventing a second meaning):
 *   - `none`  -- nothing was truncated;
 *   - `nodes` -- truncated AND the node count reached the node cap;
 *   - `bytes` -- truncated with the node count under the node cap, i.e. the byte
 *     fitter was the last binder and is the cap that limited what crossed.
 */
export function deriveBindingCap(truncated, nodeCount, maxNodes) {
  if (!truncated) return 'none';
  if (nodeCount >= maxNodes) return 'nodes';
  return 'bytes';
}

/** Validate a capture and project it into the record shape (fixed key order). */
export function buildRecord(capture) {
  const runIdentity = capture && capture.runIdentity ? capture.runIdentity : {};
  const outline = capture && capture.outline ? capture.outline : {};
  const screenshot = capture && capture.screenshot ? capture.screenshot : {};
  const caps = capture && capture.capsInForce ? capture.capsInForce : {};

  const utf8Bytes = asCount(outline.utf8Bytes);
  const nodeCount = asCount(outline.nodeCount);
  const encodedImageTokens = asCount(screenshot.encodedImageTokens);
  const maxNodes = asCount(caps.maxNodes);
  const maxBytes = asCount(caps.maxBytes);

  const missing = [];
  if (utf8Bytes === null) missing.push('outline.utf8Bytes');
  if (nodeCount === null) missing.push('outline.nodeCount');
  if (encodedImageTokens === null) missing.push('screenshot.encodedImageTokens');
  if (maxNodes === null) missing.push('capsInForce.maxNodes');
  if (maxBytes === null) missing.push('capsInForce.maxBytes');
  // The truncation flag is NOT optional: it is what makes `bindingCap` a derived
  // fact. Before the rework the injection span carried no such field, so a capture
  // naming one could only be invented -- the writer refuses rather than guesses.
  if (typeof outline.truncated !== 'boolean') missing.push('outline.truncated');
  for (const key of ['commit', 'capturedAt', 'appId', 'injectionSpanId']) {
    if (typeof runIdentity[key] !== 'string' || runIdentity[key].trim() === '') {
      missing.push(`runIdentity.${key}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `the AC-4 capture is missing a measured value: ${missing.join(', ')}. ` +
        'The record must be DERIVED FROM A RUN -- never hand-author a number (G-511).',
    );
  }

  // An over-cap outline cannot have crossed a turn: a record claiming one is not a
  // measurement of anything the product did (and would make `bytesHeadroom` a lie).
  if (utf8Bytes > maxBytes) {
    throw new Error(
      `the AC-4 capture claims an over-cap outline crossed: outline.utf8Bytes=${utf8Bytes} ` +
        `exceeds capsInForce.maxBytes=${maxBytes}. An outline over the cap cannot have crossed ` +
        'a turn, so this is not a measurement (G-511).',
    );
  }
  if (nodeCount > maxNodes) {
    throw new Error(
      `the AC-4 capture claims an over-cap outline crossed: outline.nodeCount=${nodeCount} ` +
        `exceeds capsInForce.maxNodes=${maxNodes}. An outline over the cap cannot have crossed ` +
        'a turn, so this is not a measurement (G-511).',
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    ac: AC,
    runIdentity: {
      commit: runIdentity.commit,
      capturedAt: runIdentity.capturedAt,
      appId: runIdentity.appId,
      injectionSpanId: runIdentity.injectionSpanId,
    },
    outline: {
      utf8Bytes,
      nodeCount,
      truncated: outline.truncated,
      // DERIVED, never captured.
      bytesHeadroom: Math.max(0, maxBytes - utf8Bytes),
      bindingCap: deriveBindingCap(outline.truncated, nodeCount, maxNodes),
    },
    screenshot: { encodedImageTokens },
    capsInForce: { maxNodes, maxBytes },
  };
}

/** The exact committed JSON text (2-space indent, stable key order). */
export function serializeRecord(record) {
  return JSON.stringify(record, null, 2) + '\n';
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'usage: build-ac4-record.mjs --capture <capture.json> [--out <record.json>]\n' +
        '       build-ac4-record.mjs --self-check\n',
    );
    return 0;
  }

  if (argv.includes('--self-check')) {
    return selfCheck();
  }

  const captureIndex = argv.indexOf('--capture');
  if (captureIndex === -1 || !argv[captureIndex + 1]) {
    process.stderr.write('BLOCKED: --capture <capture.json> is required\n');
    return 2;
  }
  const capturePath = argv[captureIndex + 1];
  const outIndex = argv.indexOf('--out');
  const outPath = outIndex !== -1 && argv[outIndex + 1] ? argv[outIndex + 1] : DEFAULT_OUT;

  let capture;
  try {
    capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  } catch (error) {
    process.stderr.write(`BLOCKED: the capture could not be read: ${error.message}\n`);
    return 2;
  }

  let record;
  try {
    record = buildRecord(capture);
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    return 1;
  }

  writeFileSync(outPath, serializeRecord(record), 'utf8');
  process.stdout.write(
    `wrote ${outPath}\n  appId=${record.runIdentity.appId} ` +
      `outlineBytes=${record.outline.utf8Bytes} outlineNodes=${record.outline.nodeCount} ` +
      `truncated=${record.outline.truncated} headroom=${record.outline.bytesHeadroom} ` +
      `bindingCap=${record.outline.bindingCap} ` +
      `imageTokens=${record.screenshot.encodedImageTokens} (rig context, not the limit)\n`,
  );
  return 0;
}

/** A capture with every measured value present, parameterised so controls can vary it. */
function completeCapture(overrides = {}) {
  return {
    runIdentity: {
      commit: 'b'.repeat(40),
      capturedAt: '2026-11-26T00:00:00.000Z',
      appId: 'qa3244-dense-160',
      injectionSpanId: 'span-1',
    },
    outline: { utf8Bytes: 1234, nodeCount: 37, truncated: false },
    screenshot: { encodedImageTokens: 840 },
    capsInForce: { maxNodes: 120, maxBytes: 8192 },
    ...overrides,
  };
}

function selfCheck() {
  const fail = (message) => {
    process.stderr.write(`SELF-CHECK FAILED: ${message}\n`);
    return 1;
  };

  /** Did `buildRecord` refuse this capture? */
  const refuses = (capture) => {
    try {
      buildRecord(capture);
      return false;
    } catch {
      return true;
    }
  };

  // (a) A capture with NO `outline.truncated` is REFUSED — `bindingCap` cannot be
  //     derived from a flag that was never measured.
  const noTruncated = completeCapture();
  delete noTruncated.outline.truncated;
  if (!refuses(noTruncated)) {
    return fail('a capture with no outline.truncated must be refused');
  }

  // (b) A capture missing the engine's encoded image-token count is REFUSED.
  if (!refuses(completeCapture({ screenshot: {} }))) {
    return fail('a capture with no image tokens must be refused');
  }

  // (c) An OVER-CAP capture (utf8Bytes > maxBytes) is REFUSED.
  if (
    !refuses(
      completeCapture({ outline: { utf8Bytes: 8193, nodeCount: 40, truncated: true } }),
    )
  ) {
    return fail('a capture whose outline exceeds the byte cap must be refused');
  }

  // (d) THE DISCRIMINATOR — two captures with IDENTICAL encodedImageTokens but
  //     different utf8Bytes produce different AC-4 NUMBERS. This is the whole point
  //     of schema v2, proven deterministically with no live app: the rig constant
  //     does not move while the measured amount of screen does.
  const small = buildRecord(
    completeCapture({ outline: { utf8Bytes: 1049, nodeCount: 11, truncated: false } }),
  );
  const dense = buildRecord(
    completeCapture({ outline: { utf8Bytes: 8029, nodeCount: 68, truncated: true } }),
  );
  if (small.screenshot.encodedImageTokens !== dense.screenshot.encodedImageTokens) {
    return fail('the discriminator control requires an IDENTICAL image-token count');
  }
  if (small.outline.utf8Bytes === dense.outline.utf8Bytes) {
    return fail('the AC-4 number must differ when the outline differs');
  }
  if (!(dense.outline.bytesHeadroom < small.outline.bytesHeadroom)) {
    return fail('the denser outline must have less byte headroom');
  }

  // (e) `bindingCap` derives all three branches by ONE rule.
  if (deriveBindingCap(false, 10, 120) !== 'none') {
    return fail('bindingCap must be `none` when nothing was truncated');
  }
  if (deriveBindingCap(true, 120, 120) !== 'nodes') {
    return fail('bindingCap must be `nodes` when the node cap was reached');
  }
  if (deriveBindingCap(true, 68, 120) !== 'bytes') {
    return fail('bindingCap must be `bytes` when the byte fitter trimmed under the node cap');
  }

  // (f) A complete capture builds deterministically (two runs byte-identical), and
  //     carries every declared key — including the v2 additions.
  const capture = completeCapture();
  const first = serializeRecord(buildRecord(capture));
  const second = serializeRecord(buildRecord(capture));
  if (first !== second) {
    return fail('the record is not deterministic');
  }
  const parsed = JSON.parse(first);
  for (const key of ['schemaVersion', 'ac', 'runIdentity', 'outline', 'screenshot', 'capsInForce']) {
    if (!(key in parsed)) {
      return fail(`the record is missing \`${key}\``);
    }
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return fail(`the record must declare schemaVersion ${SCHEMA_VERSION}`);
  }
  for (const key of ['utf8Bytes', 'nodeCount', 'truncated', 'bytesHeadroom', 'bindingCap']) {
    if (!(key in parsed.outline)) {
      return fail(`the outline leg is missing \`${key}\``);
    }
  }
  if (!BINDING_CAPS.includes(parsed.outline.bindingCap)) {
    return fail(`bindingCap is not one of ${BINDING_CAPS.join('|')}`);
  }
  if (parsed.outline.bytesHeadroom !== parsed.capsInForce.maxBytes - parsed.outline.utf8Bytes) {
    return fail('the derived bytesHeadroom does not match bytes and the byte cap');
  }

  process.stdout.write(
    'SELF-CHECK OK: the writer refuses a missing number (image tokens, truncation flag, over-cap ' +
      'outline), derives bytesHeadroom/bindingCap, is deterministic, and its AC-4 number ' +
      'discriminates two screens with an IDENTICAL image-token count\n',
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
