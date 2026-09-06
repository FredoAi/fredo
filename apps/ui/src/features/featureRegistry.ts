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

/**
 * Deduplicate a feature list by feature `id` (first-wins, stable order).
 *
 * Pure helper — NEVER mutates the input and NEVER mutates `_registry`. A single
 * O(n) pass keeps the FIRST occurrence of each distinct `feature.id` and drops
 * every later duplicate, preserving input order. Keyed by `feature.id` — NEVER
 * by `name`/label, so two distinct ids that happen to share a label BOTH render.
 *
 * #2826: `registerFeature()` (lines 24-26) performs a plain `_registry.push`
 * with NO by-id de-dup, so `getFeatures()` can carry the same feature more than
 * once (double-registration). The launcher wraps
 * `ALL_FEATURES.filter((f) => f.showable)` in this helper so the app grid and
 * its keyboard-nav indices are index-aligned BY CONSTRUCTION — one tile per
 * distinct id, no ghost tiles, no nav-sequence gaps.
 */
export function dedupeByFeatureId(features: FredoFeatureClass[]): FredoFeatureClass[] {
  const seen = new Set<string>();
  const out: FredoFeatureClass[] = [];
  for (const feature of features) {
    if (seen.has(feature.id)) continue;
    seen.add(feature.id);
    out.push(feature);
  }
  return out;
}
