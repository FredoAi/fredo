/**
 * Spec #3034 ST-4 — the raw-colour baseline, EMPTIED.
 *
 * The sibling defect sweep #3035 that previously owned these entries is
 * superseded on this dimension: ST-4 migrated every non-allowlisted UI-chrome
 * hex/rgba literal under `apps/ui/src/applications/**` to theme-contract tokens
 * or the shared `tint()` helper. The only remaining raw-colour permits are the
 * named data/art palettes in `rawColorAllowlist.ts` (`ART_PALETTE_ALLOWLIST`).
 *
 * Matched on `{file, literal}` (via `normalizeRawLiteral`). The gate is
 * read-only: `evaluateRawColors` fails on a NEW unbaselined hit and on a STALE
 * entry; `RAW_COLOR_BASELINE_MAX` is frozen at this file's entry count (0) so
 * the baseline can never grow. Day-one absolute zero.
 */
import type { RawColorBaselineEntry } from './rawColorEvaluate';

/**
 * The frozen unallowlisted hit count. `RAW_COLOR_BASELINE.length` must equal
 * this constant; the ledger may never grow past it (ratchet-down only — 0).
 */
export const RAW_COLOR_BASELINE_MAX = 0;

/** No pre-existing unallowlisted raw-colour hits remain (ST-4 emptied the ledger). */
export const RAW_COLOR_BASELINE: readonly RawColorBaselineEntry[] = [];
