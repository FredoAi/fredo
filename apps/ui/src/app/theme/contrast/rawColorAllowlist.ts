/**
 * Spec #3033 ST-4 / #3034 ST-3 — the raw-colour allowlist, re-exported from the
 * theme contract (the single home).
 *
 * #3034 ST-3: the literal-pinned data/art permit now lives in
 * `app/theme/contract/allowlist.ts` (`ART_PALETTE_ALLOWLIST`); this module is a
 * back-compat re-export so the evaluator (`rawColorEvaluate.ts`) and every test
 * keep their existing imports unchanged — there is exactly ONE allowlist.
 *
 * The allowlist is for **non-UI data/art palettes only** (UI/UX policy): colours
 * painted into a canvas/WebGL context, a terminal renderer's ANSI palette, node
 * identity hues explicitly declared token-equivalent, or test fixtures that
 * assert parser/scanner behaviour.
 *
 * Anti-widening (binding): an entry is **literal-pinned, not file-scoped**. A hit
 * is allowed IFF an entry has `entry.file === hit.file` (exact POSIX relative
 * path, NO glob/regex matching) AND `entry.literals.includes(hit.literal)` (the
 * `normalizeRawLiteral`-normalised token). Listing a file therefore does NOT
 * license a literal added to that file later.
 *
 * UI-chrome files are NEVER allowlistable — e.g. `dev-mode/components/DevMode.tsx`,
 * `optimizely/components/OptimizelyFlagsPanel.tsx`,
 * `diagram/components/NodeContextMenu.tsx`, `mission-monitor/components/FocusWindow.tsx`.
 * Their literals are reported and owned by the token/defect sweep (#3034/#3035).
 */
import {
  ART_PALETTE_ALLOWLIST,
  type ArtPaletteAllowlistEntry,
} from '../contract';

/** Back-compat alias — the contract's entry shape. */
export type RawColorAllowlistEntry = ArtPaletteAllowlistEntry;

/** The named data/art allowlist (the contract's copy) — the ONLY permanent raw-color permit. */
export const RAW_COLOR_ALLOWLIST: readonly RawColorAllowlistEntry[] = ART_PALETTE_ALLOWLIST;
