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
 * WHERE THE NUMBERS COME FROM (the tester's live leg)
 *   `outline.utf8Bytes` / `outline.nodeCount` -- the injection span's
 *     `simplifiedHtmlBytes` / `simplifiedHtmlNodes` attributes.
 *   `screenshot.encodedImageTokens`            -- the injection span's
 *     `imageTokens` attribute (the engine's `MediaPlan::image_tokens`).
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
 *   measurement; it only exercises the writer + the refusal guard.
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

const SCHEMA_VERSION = 1;
const AC = 'AC-4';

/** A finite, non-negative integer, or `null` when the value is missing/invalid. */
function asCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
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

  return {
    schemaVersion: SCHEMA_VERSION,
    ac: AC,
    runIdentity: {
      commit: runIdentity.commit,
      capturedAt: runIdentity.capturedAt,
      appId: runIdentity.appId,
      injectionSpanId: runIdentity.injectionSpanId,
    },
    outline: { utf8Bytes, nodeCount, truncated: outline.truncated },
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
      `imageTokens=${record.screenshot.encodedImageTokens}\n`,
  );
  return 0;
}

function selfCheck() {
  // (1) A capture missing the engine's encoded image-token count is REFUSED.
  let refused = false;
  try {
    buildRecord({
      runIdentity: {
        commit: 'a'.repeat(40),
        capturedAt: '2026-11-26T00:00:00.000Z',
        appId: 'mission-monitor',
        injectionSpanId: 'span',
      },
      outline: { utf8Bytes: 10, nodeCount: 1, truncated: false },
      screenshot: {},
      capsInForce: { maxNodes: 120, maxBytes: 8192 },
    });
  } catch {
    refused = true;
  }
  if (!refused) {
    process.stderr.write('SELF-CHECK FAILED: a capture with no image tokens must be refused\n');
    return 1;
  }

  // (2) A complete capture builds deterministically (two runs byte-identical) and
  //     carries every declared key.
  const capture = {
    runIdentity: {
      commit: 'b'.repeat(40),
      capturedAt: '2026-11-26T00:00:00.000Z',
      appId: 'mission-monitor',
      injectionSpanId: 'span-1',
    },
    outline: { utf8Bytes: 1234, nodeCount: 37, truncated: false },
    screenshot: { encodedImageTokens: 1120 },
    capsInForce: { maxNodes: 120, maxBytes: 8192 },
  };
  const first = serializeRecord(buildRecord(capture));
  const second = serializeRecord(buildRecord(capture));
  if (first !== second) {
    process.stderr.write('SELF-CHECK FAILED: the record is not deterministic\n');
    return 1;
  }
  const parsed = JSON.parse(first);
  for (const key of ['schemaVersion', 'ac', 'runIdentity', 'outline', 'screenshot', 'capsInForce']) {
    if (!(key in parsed)) {
      process.stderr.write(`SELF-CHECK FAILED: the record is missing \`${key}\`\n`);
      return 1;
    }
  }
  if (parsed.screenshot.encodedImageTokens !== 1120) {
    process.stderr.write('SELF-CHECK FAILED: the image-token number did not survive\n');
    return 1;
  }

  process.stdout.write('SELF-CHECK OK: the writer refuses a missing number and is deterministic\n');
  return 0;
}

process.exit(main(process.argv.slice(2)));
