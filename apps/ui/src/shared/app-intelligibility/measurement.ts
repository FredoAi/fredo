/**
 * Spec #3244 ST-6 — the screen-read MEASUREMENT surface (AC-4).
 *
 * # What this module owns
 *
 * AC-4: *"The amount of screen Fredo can act on is **measured**, not asserted — the
 * small-model limit is a recorded number, not a hope."* This module is the ONE
 * place the recorded number's SHAPE is defined and produced from a run's inputs:
 *
 *   - the AC-4 NUMBER is the OUTLINE leg's measured size — its UTF-8 byte count,
 *     carried with its node count, its truncation flag, the derived headroom
 *     against the byte cap and the derived cap that bound first; and
 *   - the SCREENSHOT leg's size — the engine's ENCODED visual-token count
 *     (`MediaPlan::image_tokens`), read back from the turn's `telemetry_spans`
 *     `companion.injection` record — is recorded as **rig-cost context for NFR-1**.
 *
 * # Why the image-token count is NOT the AC-4 number (schema v2)
 *
 * `image_tokens` is the sum of the multimodal image chunks' token counts for a
 * fixed-size window capture, so it is a constant of *(projector, image
 * dimensions)* — **density-invariant by construction**. A live round observed
 * `840` on every turn regardless of screen (11 outline nodes and 68 alike), so it
 * cannot express a screen-read LIMIT even with a perfectly working uplink. The
 * outline's byte/node size *does* vary with the screen, so that is the number AC-4
 * records; the image-token count is retained (deleting it would remove the only
 * recorded bound on the image leg) and DEMOTED to rig-cost context.
 *
 * # Derived from a run, never hand-authored (G-511)
 *
 * Every recorded number is derived from the outline the run actually projected and
 * the image-token count the engine actually encoded (passed in from
 * `telemetry_spans`). [`screenReadRecord`] therefore REFUSES a missing count — a
 * fabricated or placeholder number is worse than no record, so the surface fails
 * closed rather than writing a `0`.
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

/**
 * The record format's version.
 *
 * **v2** re-defined the recorded number: `outline.utf8Bytes` is the AC-4 number
 * and `outline` carries `truncated` / `bytesHeadroom` / `bindingCap`, while
 * `screenshot.encodedImageTokens` is demoted to rig-cost context. v1 records are
 * REFUSED — the old premise ("the image-token count is the limit") must not be
 * re-blessable by a stale file.
 */
export const SCREEN_READ_RECORD_SCHEMA_VERSION = 2;

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

/**
 * Which cap limited what actually crossed the turn.
 *
 * One rule, stated here only (so the suite cannot drift from it):
 *   - `none` — nothing was truncated;
 *   - `nodes` — truncated AND the node count reached the node cap;
 *   - `bytes` — truncated with the node count under the node cap, i.e. the byte
 *     fitter trimmed nodes below the cap and was the last binder. This is also
 *     the meaningful one, because it is the cap that limited what crossed.
 */
export type ScreenReadBindingCap = 'bytes' | 'nodes' | 'none';

/** The recorded amount of screen Fredo can act on (AC-4). */
export interface ScreenReadRecord {
  readonly schemaVersion: number;
  readonly ac: typeof SCREEN_READ_RECORD_AC;
  readonly runIdentity: ScreenReadRunIdentity;
  /** The injected outline leg's size — the pair's screen-read limit. */
  readonly outline: {
    /** **The AC-4 NUMBER** — UTF-8 bytes of the outline the turn carried. */
    readonly utf8Bytes: number;
    /** How many nodes the outline carries. */
    readonly nodeCount: number;
    /** Whether a cap bit (the outline was truncated). */
    readonly truncated: boolean;
    /** DERIVED: bytes still available under the byte cap (clamped at 0). */
    readonly bytesHeadroom: number;
    /** DERIVED: which cap bound first (see {@link ScreenReadBindingCap}). */
    readonly bindingCap: ScreenReadBindingCap;
  };
  /**
   * The injected screenshot leg's encoded cost — **rig context for NFR-1, NOT the
   * AC-4 number** (it is density-invariant; see this module's header).
   */
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
 * The ONE `bindingCap` rule (see {@link ScreenReadBindingCap}).
 *
 * Exported so the writer's self-check and any reader apply the same derivation
 * instead of re-deriving it a second, drifting way.
 */
export function deriveBindingCap(
  truncated: boolean,
  nodeCount: number,
  maxNodes: number,
): ScreenReadBindingCap {
  if (!truncated) return 'none';
  if (nodeCount >= maxNodes) return 'nodes';
  return 'bytes';
}

/**
 * Build the AC-4 record from a run's inputs.
 *
 * Throws when the run carries no engine image-token readout: the record must be
 * DERIVED FROM A RUN, so a missing measurement is a loud failure, never a
 * placeholder `0` (G-511). Throws when the outline claims more than the caps
 * allow — a record can never assert that an over-cap outline crossed.
 */
export function screenReadRecord(input: ScreenReadRunInput): ScreenReadRecord {
  const tokens = input.encodedImageTokens;
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) {
    throw new Error(
      'the screen-read record needs the engine\'s encoded image-token count, read back from ' +
        'telemetry_spans (the companion.injection record). Never hand-author a number (G-511).',
    );
  }
  const utf8Bytes = outlineBytes(input.outline);
  const nodeCount = input.outline.nodes.length;
  if (utf8Bytes > SCREEN_OUTLINE_MAX_BYTES) {
    throw new Error(
      `the outline is ${utf8Bytes} bytes, over the ${SCREEN_OUTLINE_MAX_BYTES}-byte cap: an ` +
        'over-cap outline cannot have crossed a turn, so this is not a measurement',
    );
  }
  if (nodeCount > SCREEN_OUTLINE_MAX_NODES) {
    throw new Error(
      `the outline carries ${nodeCount} nodes, over the ${SCREEN_OUTLINE_MAX_NODES}-node cap: an ` +
        'over-cap outline cannot have crossed a turn, so this is not a measurement',
    );
  }
  return {
    schemaVersion: SCREEN_READ_RECORD_SCHEMA_VERSION,
    ac: SCREEN_READ_RECORD_AC,
    runIdentity: input.runIdentity,
    outline: {
      utf8Bytes,
      nodeCount,
      truncated: input.outline.truncated,
      bytesHeadroom: Math.max(0, SCREEN_OUTLINE_MAX_BYTES - utf8Bytes),
      bindingCap: deriveBindingCap(
        input.outline.truncated,
        nodeCount,
        SCREEN_OUTLINE_MAX_NODES,
      ),
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

/** The only values `bindingCap` may take. */
const BINDING_CAPS: readonly ScreenReadBindingCap[] = ['bytes', 'nodes', 'none'];

/**
 * Parse a committed record, refusing a malformed, placeholder or v1 one.
 *
 * A record whose numbers are absent (a hand-written stub) or non-numeric FAILS —
 * so a fabricated file cannot masquerade as a measurement. A **v1** record is
 * refused too: v1 recorded the image-token count as the AC-4 number, a premise
 * this schema retired, and a stale file must not be re-blessed by parsing it.
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
    throw new Error(
      `the screen-read record does not match the AC-4 schema (v${SCREEN_READ_RECORD_SCHEMA_VERSION})`,
    );
  }
  if (
    !isFiniteNumber(record.outline.utf8Bytes) ||
    !isFiniteNumber(record.outline.nodeCount) ||
    typeof record.outline.truncated !== 'boolean' ||
    !isFiniteNumber(record.outline.bytesHeadroom) ||
    !BINDING_CAPS.includes(record.outline.bindingCap as ScreenReadBindingCap) ||
    !isFiniteNumber(record.screenshot.encodedImageTokens) ||
    !isFiniteNumber(record.capsInForce.maxNodes) ||
    !isFiniteNumber(record.capsInForce.maxBytes)
  ) {
    throw new Error(
      'the screen-read record carries no measured number (a hand-authored stub is not a measurement)',
    );
  }
  // The derived fields must agree with the stated caps and flag — a record whose
  // headroom or binding cap contradicts its own numbers is self-inconsistent, and
  // a self-consistent-but-wrong number is exactly the shape schema v2 retires.
  if (record.outline.utf8Bytes > record.capsInForce.maxBytes) {
    throw new Error(
      'the screen-read record claims an over-cap outline crossed: utf8Bytes exceeds capsInForce.maxBytes',
    );
  }
  if (record.outline.nodeCount > record.capsInForce.maxNodes) {
    throw new Error(
      'the screen-read record claims an over-cap outline crossed: nodeCount exceeds capsInForce.maxNodes',
    );
  }
  const headroom = Math.max(0, record.capsInForce.maxBytes - record.outline.utf8Bytes);
  if (record.outline.bytesHeadroom !== headroom) {
    throw new Error(
      'the screen-read record\'s bytesHeadroom contradicts its own bytes and cap ' +
        `(${record.outline.bytesHeadroom} !== ${headroom})`,
    );
  }
  const binding = deriveBindingCap(
    record.outline.truncated,
    record.outline.nodeCount,
    record.capsInForce.maxNodes,
  );
  if (record.outline.bindingCap !== binding) {
    throw new Error(
      `the screen-read record's bindingCap contradicts its own numbers ` +
        `(${record.outline.bindingCap} !== ${binding})`,
    );
  }
  return record as ScreenReadRecord;
}
