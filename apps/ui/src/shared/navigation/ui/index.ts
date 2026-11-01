/**
 * Spec #3118 (P4), ST-7 — the navigation UI public surface.
 *
 * This is the SECOND, additive barrel of the NavigationEngine: the headless barrel
 * (`shared/navigation/index.ts`) owns the pure engine and is deliberately NOT widened by
 * the React surfaces (purity boundary, QA Q9-02). This barrel re-exports every public
 * symbol of the eleven UI modules and declares nothing of its own — no logic, no
 * constants, no types. Additions belong in the module that owns the concept.
 *
 * Reachability: `apps/ui/src/index.ts` re-exports this module through ONE additive line
 * (`export * from './shared/navigation/ui';`), so a P5 consumer can write
 * `import { CommandRail } from '@fredo/ui'`.
 *
 * Bound rules (ST-7 scope):
 *   - `Keycap.tsx` exports `NavKeycap` (never `Keycap`) — the legacy shared primitive is
 *     already root-exported as `Keycap` (`apps/ui/src/index.ts:32`) and the two names must
 *     never collide;
 *   - nothing under `app/dev/` is exported here (or anywhere in the root surface), so the
 *     DEV prototype stays out of the production bundle (R-8.2 / QA Q8-02);
 *   - `__tests__/` is never re-exported (test fixtures stay test-only).
 */

export * from './constants';
export * from './types';
export * from './format';
export * from './models';
export * from './useReducedMotion';
export * from './Keycap';
export * from './CommandRail';
export * from './NavigationMap';
export * from './ActivityTrail';
export * from './announce';
export * from './host';
export * from './hostRegistry';
export * from './confirmation';
export * from './globalKeys';
export * from './terminalPassthrough';
export * from './NavigationProvider';
