/**
 * useSttModelReady — the launcher's cheap, fail-closed STT-model readiness gate
 * (Spec #2882 ST-3; REQ R-3.3, and the arming gate for R-2.1).
 *
 * AC3 requires that when the voice model is not installed, holding Space
 * records nothing AND surfaces no error. A post-hoc `stt_start` failure cannot
 * satisfy that: by the time it resolves the Space keydown default action has
 * already run, so the space the user meant to type is lost. The shell therefore
 * needs a SYNCHRONOUS flag it can read while deciding whether to consume the
 * keydown — this hook is that flag.
 *
 * Design:
 * - FAIL-CLOSED: `ready` is `false` while unknown or unavailable. Readiness
 *   that has not been affirmatively observed means NOT armed, so Space stays
 *   natively ordinary and nothing is promised. It flips to `true` only after a
 *   well-formed probe result reports a complete model.
 * - COST-BOUNDED: `stt_check_model` is a cheap local file-stat, but it is still
 *   probed at most once per ENABLED session plus one re-probe per `refresh()`
 *   (the summon path). Re-renders and keydowns never trigger a probe, and
 *   concurrent probes are coalesced (single-flight).
 * - DISABLED = NO PROBE: while voice input is off nothing is invoked and the
 *   readiness is dropped back to the fail-closed `false`.
 *
 * It deliberately does NOT mount `useCompanionReadiness`: that hook runs five
 * probes and can auto-launch the managed server — far too much work, and a side
 * effect, for a Space keydown precondition. The probe goes through the shared
 * `adapterBridge` (the one sanctioned wrapper; never a static `@tauri-apps/api`
 * import) and the backend command already exists (`stt_check_model`,
 * `lib.rs:353`) — no Rust/IPC-surface change is needed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';

/**
 * Minimal `stt_check_model` probe shape (camelCase IPC). Only the gate field is
 * consumed here; the hook stays independent of the companion readiness module.
 */
interface SttModelProbeResult {
  /** true iff EVERY pinned STT file is present-and-complete. */
  ready: boolean;
}

export interface SttModelReady {
  /** true only after a well-formed probe affirmed a complete model. */
  ready: boolean;
  /**
   * Re-probe now (the summon path). A no-op while voice input is disabled and
   * coalesced while a probe is already in flight.
   */
  refresh: () => void;
}

export function useSttModelReady(enabled: boolean): SttModelReady {
  const [ready, setReady] = useState(false);

  // Cleared on unmount; every async continuation checks it before touching
  // state so a probe that settles late is a no-op.
  const mountedRef = useRef(true);
  // Read synchronously by the probe/report guards — a probe that resolves after
  // voice input was disabled must not arm the gesture.
  const enabledRef = useRef(enabled);
  // Monotonic probe id: only the newest probe may report (a stale result can
  // never overwrite a newer one, and disabling invalidates any in-flight probe).
  const probeIdRef = useRef(0);
  // Single-flight: at most one `stt_check_model` invocation at a time.
  const inFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const probe = useCallback(async (): Promise<void> => {
    const inFlight = inFlightRef.current;
    if (inFlight) return inFlight;

    const id = ++probeIdRef.current;
    const task = (async () => {
      try {
        const status = await adapterBridge.invoke<SttModelProbeResult>('stt_check_model');
        if (!mountedRef.current || !enabledRef.current || id !== probeIdRef.current) return;
        // Fail closed: only a well-formed affirmative result arms the gesture.
        setReady(status != null && status.ready === true);
      } catch {
        // Missing command / rejected invoke / no adapter — never ready, never throws.
        if (!mountedRef.current || !enabledRef.current || id !== probeIdRef.current) return;
        setReady(false);
      }
    })();

    inFlightRef.current = task;
    try {
      await task;
    } finally {
      if (inFlightRef.current === task) inFlightRef.current = null;
    }
  }, []);

  // Probe on the enable 0 -> 1 edge; drop readiness (and invalidate an in-flight
  // probe) when voice input goes away. No probe ever runs while disabled.
  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) {
      void probe();
    } else {
      probeIdRef.current += 1;
      setReady(false);
    }
  }, [enabled, probe]);

  const refresh = useCallback(() => {
    if (!enabledRef.current) return;
    void probe();
  }, [probe]);

  return useMemo(() => ({ ready, refresh }), [ready, refresh]);
}
