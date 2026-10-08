/**
 * Feature Registry — the single source of truth for all registered features.
 *
 * This is the UI equivalent of the SAD's explicit feature composition root.
 * Each feature's index.ts calls `registerApplication(instance)` at module load time.
 * `allApplications.ts` is the side-effect barrel that triggers all registrations.
 * `Home.tsx` imports `allApplications` once, then reads the list via `getApplications()`.
 *
 * This pattern mirrors the Rust `AppRuntime` feature registration in lib.rs:
 *   - `registerApplication()` ≡ `AppRuntime::register_feature()`
 *   - `getApplications()`     ≡ `AppRuntime::build()` → collected handlers
 *   - `allApplications.ts`   ≡ the explicit composition list in lib.rs
 *
 * Adding a new feature:
 *   1. Create the feature and export a singleton instance.
 *   2. Call `registerApplication(instance)` in the feature's index.ts.
 *   3. Add one import line to `src/applications/allApplications.ts`.
 *   Home.tsx never needs to change.
 */
import type { FredoApplicationClass } from '../shared/classes';

const _registry: FredoApplicationClass[] = [];

export function registerApplication(feature: FredoApplicationClass): void {
  _registry.push(feature);
}

export function getApplications(): FredoApplicationClass[] {
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
 * #2826: `registerApplication()` (lines 24-26) performs a plain `_registry.push`
 * with NO by-id de-dup, so `getApplications()` can carry the same feature more than
 * once (double-registration). The launcher wraps
 * `ALL_FEATURES.filter((f) => f.showable)` in this helper so the app grid and
 * its keyboard-nav indices are index-aligned BY CONSTRUCTION — one tile per
 * distinct id, no ghost tiles, no nav-sequence gaps.
 */
export function dedupeByApplicationId(features: FredoApplicationClass[]): FredoApplicationClass[] {
  const seen = new Set<string>();
  const out: FredoApplicationClass[] = [];
  for (const feature of features) {
    if (seen.has(feature.id)) continue;
    seen.add(feature.id);
    out.push(feature);
  }
  return out;
}
