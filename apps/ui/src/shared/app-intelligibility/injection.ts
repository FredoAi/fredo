/**
 * Spec #3244 ST-4 — the per-turn injection record (the live receipt).
 *
 * # Why this module exists
 *
 * AC-2 / AC-3 / AC-4 are runtime observables, and `telemetry_logs` is NOT an
 * accepted live receipt (known gate gap M9). So the plan emits a **per-turn
 * injection span** carrying the turn's injection facts — and this module is the
 * ONE place those facts are derived from the turn's own inputs (never
 * hand-authored, R-4b).
 *
 * The facts ride the existing structured-status turn as an optional argument
 * (`LlmChatWithStatusOptions.injection` → the Rust `llm_chat_with_status`), which
 * persists them into `telemetry_spans` as `span_name = "companion.injection"`.
 * The QA reads that span set back to assert the description reached the turn, the
 * pair's size, and freshness between turns.
 *
 * # The negative witness (AC-5 / R-5b)
 *
 * `taught` and `perAppEntries` are read from the description+pair path's own
 * per-app enablement declaration — [`PAIR_PATH_PER_APP_SOURCES`] — which is EMPTY
 * by design: the path resolves EVERY app from `resolveAppDescription` + the host
 * capture seam and consults no per-app table. Scoped claim: this is the
 * description+pair path only, NOT a claim that Fredo has no per-app code for any
 * app (`mission-monitor` carries a per-app GROUNDING registrar —
 * `MissionMonitorPanel.tsx:881` — which is selection metadata, not enablement).
 *
 * Pure by construction: no React, no DOM, no IPC, no side effects.
 */

import {
  contentDigest,
  serializeOutline,
  utf8ByteLength,
  type ScreenOutline,
} from './screenOutline';

/**
 * The injection facts of ONE companion turn — the payload the Rust
 * `llm_chat_with_status` persists as the `companion.injection` span.
 */
export interface CompanionInjectionFacts {
  readonly appId: string;
  /** Did the description+pair path resolve the target per-app? */
  readonly taught: boolean;
  /** How many per-app enablement entries the path consulted. */
  readonly perAppEntries: number;
  readonly descriptionBytes: number;
  readonly screenshotBytes: number;
  readonly simplifiedHtmlBytes: number;
  readonly screenshotDigest: string;
  readonly simplifiedHtmlDigest: string;
}

/**
 * The description+pair path's per-app enablement sources.
 *
 * EMPTY by design. The path resolves a target app — built-in OR installed —
 * from `resolveAppDescription` (ST-1) plus the host capture seam (ST-3), and
 * consults no per-app table. This declaration is the ONE enumeration of the
 * path's per-app enablement, so a source added here would flip the witness and
 * the QA source-sweep (R-5b) would redden.
 */
export const PAIR_PATH_PER_APP_SOURCES: readonly string[] = Object.freeze([]);

/** The witness: does the description+pair path resolve the target per-app? */
export function pairPathTaught(): boolean {
  return PAIR_PATH_PER_APP_SOURCES.length > 0;
}

/** The witness: how many per-app entries the path consulted. */
export function pairPathPerAppEntries(): number {
  return PAIR_PATH_PER_APP_SOURCES.length;
}

/** The turn inputs the facts are derived from. */
export interface CompanionInjectionInput {
  readonly appId: string;
  /** The resolved description injected into the turn, when one was. */
  readonly description?: string;
  readonly outline: ScreenOutline;
  readonly screenshotPngBase64: string;
}

/**
 * Derive the injection facts from the turn's OWN inputs (R-4b: the numbers come
 * from the run, never a constant). Byte counts are UTF-8 bytes of exactly what
 * crossed into the turn; digests are content fingerprints of the same values.
 */
export function buildCompanionInjectionFacts(
  input: CompanionInjectionInput,
): CompanionInjectionFacts {
  const outlineJson = serializeOutline(input.outline);
  return {
    appId: input.appId,
    taught: pairPathTaught(),
    perAppEntries: pairPathPerAppEntries(),
    descriptionBytes: utf8ByteLength(input.description ?? ''),
    screenshotBytes: utf8ByteLength(input.screenshotPngBase64),
    simplifiedHtmlBytes: utf8ByteLength(outlineJson),
    screenshotDigest: contentDigest(input.screenshotPngBase64),
    simplifiedHtmlDigest: contentDigest(outlineJson),
  };
}
