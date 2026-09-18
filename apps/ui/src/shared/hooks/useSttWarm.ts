/**
 * useSttWarm — the launcher's warm (engine-residency) retry and re-arm path
 * (Spec #2887 ST-6; serves R-1, R-4, R-6, R-7).
 *
 * The PRIMARY warm is backend-side at setup — `ResidentEngine::warm_at_setup`
 * (ST-1) runs off the critical path the moment the app is composed. This hook is
 * deliberately NOT the trigger; it is the REDUNDANCY. It re-attempts the
 * idempotent, engine-only `stt_warm` when the setup warm could have been missed
 * or the residency lost:
 *   - on the voice-enabled 0 -> 1 edge,
 *   - when the model probe first reports ready (ST-3's `useSttModelReady`),
 *   - on the summon path (ST-7 calls `warmNow()` alongside `sttModel.refresh()`).
 *
 * **R-6 release (Spec #2887 follow-up).** This hook is also the OBSERVATION SITE
 * for the release edge: it is the one frontend module that receives BOTH the
 * app-global voice-enabled flag (the persisted opt-in, `CompanionContext`) and
 * the fail-closed STT model-ready probe, and it is mounted for the whole main
 * window's life (the launcher surface is never unmounted — `LauncherShell.tsx`).
 * On either 1 -> 0 edge — voice input switched OFF, or the model becoming
 * unavailable/removed — it invokes the idempotent, engine-only `stt_release`
 * through the sanctioned `adapterBridge`, so the process-resident recognizer is
 * dropped and its memory reclaimed. The falling-edge guard means it can NEVER
 * fire while voice is enabled AND the model is ready (residency is retained for
 * the process lifetime by design, R-7), and re-enabling simply warms again at
 * the new resident generation — the release does not poison residency.
 *
 * Design:
 * - DISABLED / NOT-READY = NO INVOKE. While voice input is off, or while the
 *   model probe has not affirmatively reported ready, nothing is invoked — not
 *   even on `warmNow()`.
 * - IDEMPOTENT BY CONTRACT. Every call goes to the backend's single-flight
 *   `stt_warm` (ST-1/ST-2). A retry can therefore never race the setup warm into
 *   a second model load: the backend JOINS an in-flight load and reports
 *   `warmMs: None`, and an already-resident engine short-circuits. This hook
 *   loads nothing itself and owns no engine/session state.
 * - BOUNDED + COALESCED. At most one invoke per trigger edge; a trigger that
 *   lands while a call is in flight is coalesced into that call. There is no
 *   timer, no polling, and no retry loop.
 * - SILENT FAILURE. `stt_warm` is engine-only and its failure is not
 *   user-facing (ST-1). Neither a rejection nor a non-warmed result ever throws
 *   to the caller, surfaces an error, or blocks a gesture. A rejection carries
 *   no residency information (the call may not even have reached the backend in
 *   dev/no-Tauri), so the last affirmatively reported state stands.
 * - NO STATE AFTER UNMOUNT / NO STALE REPORT. Every async continuation checks
 *   the mount flag and a monotonic call id before touching state, so a call
 *   that settles after unmount — or after voice input was disabled — is a no-op.
 * - TRANSPORT. The call goes through the shared `adapterBridge` (the one
 *   sanctioned wrapper; the dynamic `@tauri-apps/api` import lives only in
 *   `TauriAdapter.ts`) — never a static `@tauri-apps/api` import.
 *
 * `warm` is DIAGNOSTICS ONLY (the B11 observable): it is `true` only after a
 * `stt_warm` result affirmatively reported the engine resident, and it is never
 * optimistic. The shell must NOT use it to decide whether a hold may capture —
 * that gate is the model-ready probe (`useSttModelReady`), and `stt_start` has
 * its own identical cold-load fallback if the engine is not resident.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';

/**
 * Minimal `stt_warm` result shape (camelCase IPC). Only the residency field is
 * consumed here; the typed failure fields are part of the wire contract but are
 * deliberately NOT surfaced (a warm failure is silent).
 */
interface SttWarmResult {
  /** True iff the engine is genuinely resident and ready (never optimistic). */
  warmed: boolean;
  code?: string | null;
  detail?: string | null;
  warmMs?: number | null;
}

export interface SttWarm {
  /** true once `stt_warm` reported the engine resident (diagnostics only). */
  warm: boolean;
  /** Idempotent; no-op while disabled or while the model probe is not ready. */
  warmNow: () => void;
}

export function useSttWarm(enabled: boolean, modelReady: boolean): SttWarm {
  const [warm, setWarm] = useState(false);

  // Cleared on unmount; every async continuation checks it before touching
  // state so a call that settles late is a no-op.
  const mountedRef = useRef(true);
  // Read synchronously by the call guard — a call resolving after voice input
  // was disabled (or before the model probe affirmed readiness) must not arm
  // anything.
  const enabledRef = useRef(enabled);
  const modelReadyRef = useRef(modelReady);
  // Monotonic call id: only the newest call may report, and disabling
  // invalidates any in-flight call.
  const callIdRef = useRef(0);
  // Single-flight: at most one `stt_warm` invocation at a time.
  const inFlightRef = useRef<Promise<void> | null>(null);
  // The previous render's "voice enabled AND model ready" state. The R-6 release
  // fires ONLY on a 1 -> 0 edge of this composite, so it can never fire while
  // residency is wanted (R-7) and never on a mount that starts already disabled.
  const prevArmedRef = useRef(enabled && modelReady);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const warmUp = useCallback(async (): Promise<void> => {
    // No-op while disabled or while the model probe is not ready.
    if (!enabledRef.current || !modelReadyRef.current) return;

    // Coalesce: a trigger landing while a call is in flight joins that call.
    const inFlight = inFlightRef.current;
    if (inFlight) return inFlight;

    const id = ++callIdRef.current;
    const task = (async () => {
      try {
        const result = await adapterBridge.invoke<SttWarmResult>('stt_warm');
        if (!mountedRef.current || !enabledRef.current || id !== callIdRef.current) return;
        // Fail-honest: only a well-formed affirmative result reports residency.
        // `warmed:false` is the backend saying the engine is NOT resident.
        setWarm(result != null && result.warmed === true);
      } catch {
        // Silent by contract: never throws, never surfaces an error. The last
        // affirmatively reported state stands (a rejection says nothing about
        // residency — the call may never have reached the backend).
      }
    })();

    inFlightRef.current = task;
    try {
      await task;
    } finally {
      if (inFlightRef.current === task) inFlightRef.current = null;
    }
  }, []);

  /**
   * R-6 — release the process-resident engine and reclaim its memory. Invoked
   * ONLY on the falling edge of "voice enabled AND model ready" (see the effect
   * below), never while residency is wanted. Idempotent and engine-only on the
   * backend (`stt_release`), and silent on failure: a failed release carries no
   * residency information and must never throw to the caller or surface an
   * error. The call goes through the sanctioned `adapterBridge` (never a static
   * `@tauri-apps/api` import).
   */
  const release = useCallback(async (): Promise<void> => {
    try {
      await adapterBridge.invoke('stt_release');
    } catch {
      // Silent by contract: the next `stt_start` cold-loads normally, and a
      // later warm re-attempts residency. Never throws.
    }
  }, []);

  // Trigger on the enable 0 -> 1 edge and on the model-ready edge. Disabling
  // drops the observable back to fail-closed and invalidates any in-flight call,
  // so a disabled session can never be re-armed by a late resolution. There is
  // no invoke while disabled and none while the probe is not ready.
  //
  // R-6: the SAME composite ("voice enabled AND model ready") drives the release
  // on its 1 -> 0 edge — voice switched off, or the model removed/unavailable.
  // The release is issued off the transition, never on a mount that begins
  // already-unarmed, so an app launched with voice disabled never fires it.
  useEffect(() => {
    enabledRef.current = enabled;
    modelReadyRef.current = modelReady;
    const armed = enabled && modelReady;
    const wasArmed = prevArmedRef.current;
    prevArmedRef.current = armed;
    if (!enabled) {
      callIdRef.current += 1;
      setWarm(false);
    } else if (modelReady) {
      void warmUp();
    }
    if (wasArmed && !armed) void release();
  }, [enabled, modelReady, warmUp, release]);

  const warmNow = useCallback(() => {
    if (!enabledRef.current || !modelReadyRef.current) return;
    void warmUp();
  }, [warmUp]);

  return useMemo(() => ({ warm, warmNow }), [warm, warmNow]);
}
