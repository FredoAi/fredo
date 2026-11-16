/**
 * useDoomMode — the shared frontend Doom Mode client (Spec #2970, ST-5).
 *
 * The ONE frontend reader of the ST-2 contract: a mount seed
 * (`get_doom_mode_status`), a live `doom-mode-changed` subscription, and the
 * `enter`/`exit` invokers. It is ALSO the single driver of the module-scoped
 * `performanceGate` store (seed + every broadcast), so the launcher's voice
 * affordance follows the mode without a React context, AND the single driver of
 * the module-scoped `doomVisual` store (ST-3), so the theme layer and the armor
 * overlay can never diverge from the phase.
 *
 * The mode is NEVER persisted: a fresh boot is always `inactive` until the seed
 * resolves.
 */
import { useCallback, useEffect, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';
import { setDoomVisualEngaged } from './doomVisual';
import { setPerformanceGateActive } from './performanceGate';
import {
  DOOM_MODE_EVENT,
  DOOM_MODE_INACTIVE_STATUS,
  isDoomModeEngaged,
  type DoomModeOrigin,
  type DoomModeResult,
  type DoomModeStatus,
} from './types';

export interface UseDoomModeResult {
  /** The latest mode snapshot (the resting `inactive` status before the seed). */
  status: DoomModeStatus;
  /** Convenience mirror of `status.active`. */
  active: boolean;
  /** Convenience mirror of `status.voiceSuppressed`. */
  voiceSuppressed: boolean;
  /** Invoke `enter_doom_mode` (idempotent). Resolves to the typed result. */
  enter: (origin?: DoomModeOrigin) => Promise<DoomModeResult | undefined>;
  /** Invoke `exit_doom_mode` (idempotent). Resolves to the typed result. */
  exit: (reason?: string) => Promise<DoomModeResult | undefined>;
}

export function useDoomMode(): UseDoomModeResult {
  const [status, setStatus] = useState<DoomModeStatus>(DOOM_MODE_INACTIVE_STATUS);

  const applyStatus = useCallback((next: DoomModeStatus) => {
    setStatus(next);
    setPerformanceGateActive(next.voiceSuppressed);
    setDoomVisualEngaged(isDoomModeEngaged(next.phase));
  }, []);

  // Mount seed + live subscription. Registered exactly once per mount (the
  // shipped #523 loop guard: the callback identity is stable).
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const seed = await adapterBridge.invoke<DoomModeStatus>('get_doom_mode_status');
      if (disposed) return;
      if (seed) applyStatus(seed);

      const off = await adapterBridge.listen<DoomModeStatus>(DOOM_MODE_EVENT, (payload) => {
        if (payload) applyStatus(payload);
      });
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyStatus]);

  const enter = useCallback(
    (origin?: DoomModeOrigin) =>
      adapterBridge.invoke<DoomModeResult>('enter_doom_mode', { origin: origin ?? null }),
    [],
  );

  const exit = useCallback(
    (reason?: string) =>
      adapterBridge.invoke<DoomModeResult>('exit_doom_mode', { reason: reason ?? null }),
    [],
  );

  return { status, active: status.active, voiceSuppressed: status.voiceSuppressed, enter, exit };
}
