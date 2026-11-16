/**
 * Spec #3033 ST-4 (round-1 addendum) — the raw-colour dimension's evaluation
 * semantics: the exact mirror of `evaluate.ts` for the raw-colour scan.
 *
 * `scanRawColors` is POLICY-FREE (it returns every matched literal — the
 * `buildContrastMatrix` stage); THIS module owns BOTH excuse layers in ONE
 * place, so there is a single source of "what is a raw-colour violation":
 *   1. The **allowlist filter** runs first: a hit is permitted iff some entry
 *      pins its exact `{file, literal}` pair (`normalizeRawLiteral`-normalised).
 *      The allowlist is the ONLY permanent permit and it is literal-pinned, so
 *      an allowlisted file does NOT license an unpinned literal.
 *   2. The **three baseline rules** on the surviving non-allowlisted hits —
 *      identical to `evaluateContrast`:
 *        - a hit whose `{file, literal}` is absent from the baseline →
 *          `violations` (NEW ⇒ FAIL);
 *        - a baseline entry that matches no surviving hit → `staleBaseline`
 *          (ratchet-down ⇒ FAIL);
 *        - `baseline.length <= max` else FAIL (no growth), and every entry must
 *          cite a live issue number.
 *
 * Both layers are `{file, literal}`-pinned, so a UI-chrome literal added to a
 * listed/baselined file is a NEW literal ⇒ neither pinned nor baselined ⇒ FAIL
 * — anti-widening is preserved.
 *
 * A caller FAILS the gate when any of: `violations` is non-empty, `staleBaseline`
 * is non-empty, or this function throws.
 *
 * Pure and deterministic — no filesystem/browser/random access. Read-only: it
 * never writes the allowlist, the baseline or any source.
 */
import { normalizeRawLiteral, type RawColorHit } from './rawColorScan';
import type { RawColorAllowlistEntry } from './rawColorAllowlist';

/** A single excused pre-existing raw-colour hit, keyed to the issue that owns the fix. */
export interface RawColorBaselineEntry {
  /** POSIX-relative path from the repo root; exact match. */
  readonly file: string;
  /** `normalizeRawLiteral`-normalised literal. */
  readonly literal: string;
  /** Live defect issue that owns the fix (e.g. #3035). */
  readonly issue: number;
  /** `file:line` + render context. */
  readonly note: string;
}

/** The pure evaluation result — the raw-colour gate's sole oracle. */
export interface RawColorEvaluation {
  /** Non-allowlisted, UNBASELINED hits → FAIL. */
  violations: RawColorHit[];
  /** Non-allowlisted hits the #3035 ledger excuses. */
  baselined: RawColorHit[];
  /** Baseline entries that match no live hit → FAIL (ratchet-down). */
  staleBaseline: RawColorBaselineEntry[];
}

/** A collision-free identity for a `{file, literal}` pair. */
function hitKey(file: string, literal: string): string {
  return `${file}\u0000${literal}`;
}

/**
 * Apply the allowlist filter, then evaluate the surviving hits against the
 * committed baseline.
 *
 * @throws if a baseline entry lacks a live issue number, or the baseline grew
 *         past `max` (the frozen day-one cap).
 */
export function evaluateRawColors(
  hits: readonly RawColorHit[],
  allowlist: readonly RawColorAllowlistEntry[],
  baseline: readonly RawColorBaselineEntry[],
  max: number,
): RawColorEvaluation {
  for (const entry of baseline) {
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
      throw new Error(
        `raw-colour baseline entry "${entry.file}:${entry.literal}" must reference a live issue number, got ${String(entry.issue)}`,
      );
    }
  }
  if (baseline.length > max) {
    throw new Error(
      `raw-colour baseline grew to ${baseline.length} entries, over the frozen cap RAW_COLOR_BASELINE_MAX=${max}`,
    );
  }

  const allowedKeys = new Set<string>();
  for (const entry of allowlist) {
    for (const literal of entry.literals) {
      allowedKeys.add(hitKey(entry.file, normalizeRawLiteral(literal)));
    }
  }

  const surviving = hits.filter((hit) => !allowedKeys.has(hitKey(hit.file, hit.literal)));
  const survivingKeys = new Set(surviving.map((hit) => hitKey(hit.file, hit.literal)));
  const baselineKeys = new Set(baseline.map((entry) => hitKey(entry.file, entry.literal)));

  return {
    violations: surviving.filter((hit) => !baselineKeys.has(hitKey(hit.file, hit.literal))),
    baselined: surviving.filter((hit) => baselineKeys.has(hitKey(hit.file, hit.literal))),
    staleBaseline: baseline.filter((entry) => !survivingKeys.has(hitKey(entry.file, entry.literal))),
  };
}
