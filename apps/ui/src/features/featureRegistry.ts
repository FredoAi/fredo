/**
 * Feature Registry — the single source of truth for all registered features.
 *
 * This is the UI equivalent of the SAD's explicit feature composition root.
 * Each feature's index.ts calls `registerFeature(instance)` at module load time.
 * `allFeatures.ts` is the side-effect barrel that triggers all registrations.
 * `Home.tsx` imports `allFeatures` once, then reads the list via `getFeatures()`.
 *
 * This pattern mirrors the Rust `AppRuntime` feature registration in lib.rs:
 *   - `registerFeature()` ≡ `AppRuntime::register_feature()`
 *   - `getFeatures()`     ≡ `AppRuntime::build()` → collected handlers
 *   - `allFeatures.ts`   ≡ the explicit composition list in lib.rs
 *
 * Adding a new feature:
 *   1. Create the feature and export a singleton instance.
 *   2. Call `registerFeature(instance)` in the feature's index.ts.
 *   3. Add one import line to `src/features/allFeatures.ts`.
 *   Home.tsx never needs to change.
 */
import type { FredoFeatureClass } from '../shared/classes';

const _registry: FredoFeatureClass[] = [];

export function registerFeature(feature: FredoFeatureClass): void {
  _registry.push(feature);
}

export function getFeatures(): FredoFeatureClass[] {
  return _registry;
}
