/**
 * Spec #3033 ST-2 — the contrast gate's evaluation semantics.
 *
 * Given the built matrix and the committed baseline, `evaluateContrast` applies
 * the day-one-green rules:
 *   1. `violations` = every row below its absolute floor.
 *   2. `baselined`  = the violating rows the baseline excuses (key identity).
 *   3. `staleBaseline` = baseline entries whose row is NOT a violation any more
 *      (the ratchet-down rule — a fixed pair must leave the baseline).
 *   4. The baseline may never grow past the frozen cap; an entry without a live
 *      issue number is invalid. Both are hard contract breaches and THROW (they
 *      have no representation in the returned `Evaluation`).
 *
 * A caller FAILS the gate when any of: `violations` has a key absent from the
 * baseline, `staleBaseline` is non-empty, or this function throws.
 *
 * Pure and deterministic — no filesystem/browser/random access. Read-only: it
 * never writes the baseline or any source.
 */
import type { MatrixRow, MatrixRowKey } from './matrix';

/** A single excused pre-existing violation, keyed to the issue that owns the fix. */
export interface ContrastBaselineEntry {
  readonly key: MatrixRowKey;
  readonly ratio: number;
  readonly issue: number;
  readonly note: string;
}

/** The pure evaluation result — the gate's sole oracle. */
export interface Evaluation {
  violations: MatrixRow[];
  baselined: MatrixRow[];
  staleBaseline: ContrastBaselineEntry[];
}

/**
 * Evaluate the matrix against the committed baseline.
 *
 * @throws if a baseline entry lacks a live issue number, or the baseline grew
 *         past `max` (the frozen day-one cap).
 */
export function evaluateContrast(
  rows: MatrixRow[],
  baseline: readonly ContrastBaselineEntry[],
  max: number,
): Evaluation {
  for (const entry of baseline) {
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
      throw new Error(
        `contrast baseline entry "${entry.key}" must reference a live issue number, got ${String(entry.issue)}`,
      );
    }
  }
  if (baseline.length > max) {
    throw new Error(
      `contrast baseline grew to ${baseline.length} entries, over the frozen cap BASELINE_MAX=${max}`,
    );
  }

  const baselineKeys = new Set(baseline.map((entry) => entry.key));
  const violations = rows.filter((row) => row.ratio < row.floor);
  const violatingKeys = new Set(violations.map((row) => row.key));
  return {
    violations,
    baselined: rows.filter((row) => baselineKeys.has(row.key)),
    staleBaseline: baseline.filter((entry) => !violatingKeys.has(entry.key)),
  };
}
