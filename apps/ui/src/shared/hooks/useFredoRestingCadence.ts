import { useEffect, useRef, useState } from 'react';

export interface FredoRestingCadenceOptions {
  /** Sustained rest required before the playful beat fires. */
  delayMs?: number;
  /** Length of the playful beat before returning to idle. */
  holdMs?: number;
}

/**
 * #2854 — the shared resting `playful` cadence for the Fredo avatar.
 *
 * While `active === false` (truly resting — no message / stream / game / engaged
 * surface) the hook emits `'playful'` after `delayMs` of sustained rest, holds it
 * for `holdMs`, returns to `'idle'`, and repeats on the cadence. `active === true`
 * cancels the cadence and forces `'idle'` (it restarts when rest resumes).
 *
 * Implemented with a SINGLE `setTimeout` ref (never `setInterval`): the ref is
 * cleared before every re-arm and on unmount / when `active` flips, so no timer
 * can leak. The effect deps are primitives only (no `.length` / fresh object
 * identity) — AGENTS.md #523.
 *
 * @returns the resting phase — `'idle'` or `'playful'`.
 */
export function useFredoRestingCadence(
  active: boolean,
  { delayMs = 12000, holdMs = 1800 }: FredoRestingCadenceOptions = {},
): 'idle' | 'playful' {
  const [resting, setResting] = useState<'idle' | 'playful'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    clear();

    if (active) {
      // Not resting: cancel the beat and reset the cadence.
      setResting('idle');
      return clear;
    }

    // Resting: wait out the delay, emit the bounded beat, then re-arm the cadence.
    const scheduleBeat = () => {
      timerRef.current = setTimeout(() => {
        setResting('playful');
        timerRef.current = setTimeout(() => {
          setResting('idle');
          scheduleBeat();
        }, holdMs);
      }, delayMs);
    };
    scheduleBeat();

    return clear;
  }, [active, delayMs, holdMs]);

  return resting;
}
