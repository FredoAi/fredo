/**
 * Spec #3033 ST-3 — the committed, reviewed day-one contrast baseline.
 *
 * Generated ONCE at authoring time from `buildContrastMatrix()` (never at test
 * time) and reviewed as a PR diff. It excuses ONLY known pre-existing
 * violations of the absolute WCAG floor, every entry keyed to the sibling
 * defect sweep #3035 that owns the token/state fix.
 *
 * The gate is read-only: `evaluateContrast` fails on a NEW unbaselined
 * violation and on a STALE entry (a pair that no longer violates must leave the
 * baseline), and `BASELINE_MAX` is the frozen cap so the baseline can only
 * shrink. #3035 empties this file and sets BASELINE_MAX to 0.
 *
 * #3035 ST-2 — DRAINED. The ledger is EMPTY: groups A/B/C drained by ST-1's
 * contract chrome re-derivation (propagated into the matrix by ST-2), group D by
 * the authored short-preset tightening, group E by the lowered radio-card
 * selected tint, and group F by the WCAG inactive-component exemption
 * (`ContractPair.exempt`). `BASELINE_MAX = 0`; a NEW below-floor pair is now an
 * immediate violation.
 */
import type { ContrastBaselineEntry } from './evaluate';

/**
 * The frozen day-one cap. `CONTRAST_BASELINE.length` may never EXCEED this; the
 * ledger only shrinks (ratchet-down). #3035 ST-2 drained the ledger, so the cap
 * is now 0 — any new violation fails the gate immediately.
 */
export const BASELINE_MAX = 0;

/** Every pre-existing absolute-floor violation that remains on the tip. */
export const CONTRAST_BASELINE: readonly ContrastBaselineEntry[] = [];
