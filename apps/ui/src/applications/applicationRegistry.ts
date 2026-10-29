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

/**
 * Spec #3099 ST-2 — additive registration subscription.
 *
 * Registration stays a plain PUSH (the #2826 double-registration contract is
 * unchanged); the listeners fire AFTER the push, so a listener that reads
 * `getApplications()` sees the new application. The publisher uses this to
 * republish the companion manifest whenever a feature registers.
 */
const _listeners = new Set<() => void>();

export function registerApplication(feature: FredoApplicationClass): void {
  _registry.push(feature);
  // Copy before iterating so an unsubscribe during notification is safe.
  for (const listener of [..._listeners]) listener();
}

export function getApplications(): FredoApplicationClass[] {
  return _registry;
}

/**
 * Subscribe to application registration. Returns an unsubscribe function.
 * Notification fires AFTER the feature has been pushed into the registry.
 */
export function subscribeApplications(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/**
 * Test-only reset: empties the registry AND the subscription set so one test
 * file's registrations/publisher installations cannot leak into the next.
 * The registry array is mutated in place because `getApplications()` hands out
 * the live reference.
 */
export function resetApplicationRegistryForTests(): void {
  _registry.length = 0;
  _listeners.clear();
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
