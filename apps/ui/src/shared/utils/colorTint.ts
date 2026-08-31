/**
 * Alpha-tint a CSS custom-property reference.
 *
 * `var(--x)NN` is INVALID CSS: var() substitution splices tokens without
 * re-lexing, so appended digits remain a separate token and the browser drops
 * the whole declaration at computed-value time (#2770 round 5). color-mix()
 * computes live from the var at paint time — theme-switch and user-override
 * safe. Chromium 111+ (WebView2 evergreen).
 *
 * Alpha-append is valid ONLY on literal hex strings (e.g. `${'#a855f7'}28` —
 * JS concatenation yields a valid 8-digit hex before CSS parsing). For any
 * `var()` reference, use this helper:
 *
 *   tint('var(--accent-primary)', 22)  // → color-mix(in srgb, … 22%, transparent)
 */
export const tint = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;
