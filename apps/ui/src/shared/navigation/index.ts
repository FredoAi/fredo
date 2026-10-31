/**
 * Spec #3117 (P3) — the NavigationEngine public surface.
 *
 * The barrel is the ONLY module with no inbound edge (`docs/NAVIGATION_ENGINE.md` §1–§10):
 * it re-exports every public name of the ten sibling modules and declares nothing of its
 * own. Consumers (P4 and later) import from here — or from the one additive line in
 * `apps/ui/src/index.ts` — and never reach into an internal module.
 *
 * No logic, no constants, no types: additions belong in the module that owns the concept.
 */

export * from './types';
export * from './keys';
export * from './focusContext';
export * from './registry';
export * from './resolver';
export * from './keyResolver';
export * from './dispatch';
export * from './journal';
export * from './context';
export * from './discover';
export * from './manifest';
export * from './validation';
