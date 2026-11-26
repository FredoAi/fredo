/**
 * Spec #3244 ST-6 — the screen-read MEASUREMENT surface (AC-4).
 *
 * # What this module owns
 *
 * AC-4: *"The amount of screen Fredo can act on is **measured**, not asserted — the
 * small-model limit is a recorded number, not a hope."* This module is the ONE
 * place the recorded number's SHAPE is defined and produced from a run's inputs:
 *
 *   - the OUTLINE leg's size — its UTF-8 byte count AND its node count
 *     (`screenOutline.ts`), for the screen the run actually projected; and
 *   - the SCREENSHOT leg's size — the engine's ENCODED visual-token count
 *     (`MediaPlan::image_tokens`), read back from the turn's `telemetry_spans`
 *     `companion.injection` record.
 *
 * # Derived from a run, never hand-authored (G-511)
 *
 * The bytes and nodes are derived from the outline the run produced. The
 * image-token count is NOT derivable here: the projector computes it while
 * ENCODING the screenshot inside the engine, so it is passed in as the value read
 * back from `telemetry_spans`. [`screenReadRecord`] therefore REFUSES a missing
 * count — a fabricated or placeholder number is worse than no record, so the
 * surface fails closed rather than writing a `0`.
 *
 * # The committed record
 *
 * [`serializeScreenReadRecord`] renders the exact JSON committed under
 * `.opencode/tests/app-intelligibility/measurement/` (see that directory's
 * README). The tester's AC-4 live leg fills it from a real run.
 *
 * Pure by construction: no React, no DOM, no IPC, no side effects.
 */

import {
  SCREEN_OUTLINE_MAX_BYTES,
  SCREEN_OUTLINE_MAX_NODES,
  outlineBytes,
  type ScreenOutline,
} from './screenOutline';

/** The record format's version — bumped only when the shape changes. */
export const SCREEN_READ_RECORD_SCHEMA_VERSION = 1;

/** The acceptance criterion this record answers. */
export const SCREEN_READ_RECORD_AC = 'AC-4';

/** Who/where/when produced the measurement — the run identity. */
export interface ScreenReadRunIdentity {
  /** The spec-branch commit the run measured (40-hex). */
  readonly commit: string;
  /** When the run captured the pair (ISO 8601). */
  readonly capturedAt: string;
  /** The target application the measured turn was aimed at. */
  readonly appId: string;
  /** The `span_id` of the `companion.injection` record this was read from. */
  readonly injectionSpanId: string;
}

/** The recorded amount of screen Fredo can act on (AC-4). */
export interface ScreenReadRecord {
  readonly schemaVersion: number;
  readonly ac: typeof SCREEN_READ_RECORD_AC;
  readonly runIdentity: ScreenReadRunIdentity;
  /** The injected outline leg's size. */
  readonly outline: {
    /** UTF-8 bytes of the serialized outline. */
    readonly utf8Bytes: number;
    /** How many nodes the outline carries. */
    readonly nodeCount: number;
    /** Whether a cap bit (the outline was truncated). */
    readonly truncated: boolean;
  };
  /** The injected screenshot leg's size. */
  readonly screenshot: {
    /** The engine's `MediaPlan::image_tokens` for the run. */
    readonly encodedImageTokens: number;
  };
  /** The caps the run's outline was produced under. */
  readonly capsInForce: {
    readonly maxNodes: number;
    readonly maxBytes: number;
  };
}

/** The inputs a run provides to the measurement surface. */
export interface ScreenReadRunInput {
  readonly runIdentity: ScreenReadRunIdentity;
  /** The outline the run actually projected into the turn. */
  readonly outline: ScreenOutline;
  /**
   * The engine's encoded image-token count, read back from `telemetry_spans`.
   * `null` when the run produced no image leg — which REFUSES a record.
   */
  readonly encodedImageTokens: number | null;
}

/**
 * Build the AC-4 record from a run's inputs.
 *
 * Throws when the run carries no engine image-token readout: the record must be
 * DERIVED FROM A RUN, so a missing measurement is a loud failure, never a
 * placeholder `0` (G-511).
 */
export function screenReadRecord(input: ScreenReadRunInput): ScreenReadRecord {
  const tokens = input.encodedImageTokens;
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) {
    throw new Error(
      'the screen-read record needs the engine\'s encoded image-token count, read back from ' +
        'telemetry_spans (the companion.injection record). Never hand-author a number (G-511).',
    );
  }
  return {
    schemaVersion: SCREEN_READ_RECORD_SCHEMA_VERSION,
    ac: SCREEN_READ_RECORD_AC,
    runIdentity: input.runIdentity,
    outline: {
      utf8Bytes: outlineBytes(input.outline),
      nodeCount: input.outline.nodes.length,
      truncated: input.outline.truncated,
    },
    screenshot: { encodedImageTokens: Math.round(tokens) },
    capsInForce: {
      maxNodes: SCREEN_OUTLINE_MAX_NODES,
      maxBytes: SCREEN_OUTLINE_MAX_BYTES,
    },
  };
}

/** The exact committed JSON text for a record (stable key order, 2-space indent). */
export function serializeScreenReadRecord(record: ScreenReadRecord): string {
  return JSON.stringify(record, null, 2);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parse a committed record, refusing a malformed or placeholder one.
 *
 * A record whose numbers are absent (a hand-written stub) or non-numeric FAILS —
 * so a fabricated file cannot masquerade as a measurement.
 */
export function parseScreenReadRecord(text: string): ScreenReadRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the screen-read record is not valid JSON');
  }
  const record = parsed as Partial<ScreenReadRecord>;
  if (
    record.schemaVersion !== SCREEN_READ_RECORD_SCHEMA_VERSION ||
    record.ac !== SCREEN_READ_RECORD_AC ||
    typeof record.runIdentity !== 'object' ||
    record.runIdentity === null ||
    typeof record.outline !== 'object' ||
    record.outline === null ||
    typeof record.screenshot !== 'object' ||
    record.screenshot === null ||
    typeof record.capsInForce !== 'object' ||
    record.capsInForce === null
  ) {
    throw new Error('the screen-read record does not match the AC-4 schema');
  }
  if (
    !isFiniteNumber(record.outline.utf8Bytes) ||
    !isFiniteNumber(record.outline.nodeCount) ||
    typeof record.outline.truncated !== 'boolean' ||
    !isFiniteNumber(record.screenshot.encodedImageTokens) ||
    !isFiniteNumber(record.capsInForce.maxNodes) ||
    !isFiniteNumber(record.capsInForce.maxBytes)
  ) {
    throw new Error(
      'the screen-read record carries no measured number (a hand-authored stub is not a measurement)',
    );
  }
  return record as ScreenReadRecord;
}
