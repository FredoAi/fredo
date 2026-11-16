/**
 * Theme contract — the single machine-readable home for every semantic token,
 * every (surface × interactive state) pair, the derivation weights, the WCAG
 * floors and the named data/art allowlist (Spec #3034 ST-1).
 *
 * Consumers: `app/theme/system.ts` and `app/providers/ThemeProvider.tsx` (ST-2),
 * and `app/theme/contrast/**` (ST-3). The contract imports nothing from them, so
 * there is no cycle.
 */
export * from './tokens';
export * from './surfaces';
export * from './allowlist';
