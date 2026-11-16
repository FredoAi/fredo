/**
 * Spec #3118 (P4), ST-1 — the reduced-motion hook the three surfaces read.
 *
 * `useNavReducedMotion()` answers one question — does the host prefer reduced motion? — and
 * re-answers it on every render plus whenever the media query flips. It FAILS SAFE to `false`
 * when `matchMedia` is absent (jsdom, SSR), because "unknown" must never silently disable
 * motion the user did not ask to disable (QA Q5-01 / GAP 7).
 *
 * `useSyncExternalStore` is the subscription: the snapshot is a primitive boolean re-read from
 * the CURRENT `window.matchMedia` on each render (so a `matchMedia` replaced after mount — the
 * plan's live R-9.2 lever — is honoured on the next render), and `subscribe` attaches the
 * `change` listener to that same current list so OS/app-level flips stay live. A primitive
 * snapshot cannot re-render in a loop (the #523 rule).
 */

import { useSyncExternalStore } from 'react';

import { NAV_REDUCED_MOTION_QUERY } from './constants';

/** Fail-safe read of the media query: `false` whenever the host cannot answer. */
function readPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NAV_REDUCED_MOTION_QUERY).matches === true;
}

/** Subscribe to the query's `change` event on the CURRENT list; no listener when absent. */
function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia(NAV_REDUCED_MOTION_QUERY);
  query.addEventListener?.('change', onChange);
  return () => {
    query.removeEventListener?.('change', onChange);
  };
}

/** True while the host prefers reduced motion; `false` when the query is unavailable. */
export function useNavReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, readPreference, () => false);
}
