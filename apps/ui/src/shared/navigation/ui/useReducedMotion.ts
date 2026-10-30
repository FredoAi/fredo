/**
 * Spec #3118 (P4), ST-1 — the reduced-motion hook the three surfaces read.
 *
 * `useNavReducedMotion()` answers one question — does the host prefer reduced motion? — and
 * re-answers it when the media query flips. It FAILS SAFE to `false` when `matchMedia` is
 * absent (jsdom, SSR), because "unknown" must never silently disable motion the user did not
 * ask to disable (QA Q5-01 / GAP 7).
 *
 * The subscription lives in ONE `useEffect` with an EMPTY dependency array: no `.length`
 * dependency, no freshly-created array, no state write keyed on a re-created value — the
 * #523 re-render-loop rule.
 */

import { useEffect, useState } from 'react';

import { NAV_REDUCED_MOTION_QUERY } from './constants';

/** Fail-safe read of the media query: `false` whenever the host cannot answer. */
function readPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NAV_REDUCED_MOTION_QUERY).matches === true;
}

/** True while the host prefers reduced motion; `false` when the query is unavailable. */
export function useNavReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readPreference);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(NAV_REDUCED_MOTION_QUERY);
    setReduced(query.matches === true);
    const onChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches === true);
    };
    query.addEventListener?.('change', onChange);
    return () => {
      query.removeEventListener?.('change', onChange);
    };
  }, []);

  return reduced;
}
