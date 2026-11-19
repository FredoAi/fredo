/**
 * Reduced-motion preference hook (Spec #3151 ST-1) — the re-homed home of the
 * surviving reduced-motion read (NFR-2).
 *
 * `useReducedMotion()` answers one question — does the host prefer reduced
 * motion? — and re-answers it on every render plus whenever the media query
 * flips. It FAILS SAFE to `false` when `matchMedia` is absent (jsdom, SSR),
 * because "unknown" must never silently disable motion the user did not ask to
 * disable.
 *
 * `useSyncExternalStore` is the subscription: the snapshot is a PRIMITIVE
 * boolean re-read from the CURRENT `window.matchMedia` on each render (so a
 * `matchMedia` replaced after mount is honoured on the next render), and
 * `subscribe` attaches the `change` listener to that same current list so
 * OS/app-level flips stay live. A primitive snapshot cannot re-render in a loop
 * (the #523 rule).
 *
 * Relocated from `shared/navigation/ui/useReducedMotion.ts` with the query
 * constant folded in — this module imports nothing from the retired engine.
 */

import { useSyncExternalStore } from 'react';

/** The media query the host answers for reduced motion. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Fail-safe read of the media query: `false` whenever the host cannot answer. */
function readPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches === true;
}

/** Subscribe to the query's `change` event on the CURRENT list; no listener when absent. */
function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener?.('change', onChange);
  return () => {
    query.removeEventListener?.('change', onChange);
  };
}

/** Server snapshot — always the fail-safe `false`. */
function getServerSnapshot(): boolean {
  return false;
}

/** True while the host prefers reduced motion; `false` when the query is unavailable. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, readPreference, getServerSnapshot);
}
