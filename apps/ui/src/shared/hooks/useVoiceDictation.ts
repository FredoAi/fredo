/**
 * useVoiceDictation — STT control-plane state client (Spec #2877 ST-3; one path
 * since Spec #2914 ST-5).
 *
 * The single shared client for the control-plane `stt:state` event. It exposes
 * the session lifecycle (`start` / `stop` / `cancel`) and the state contract
 * every consumer shares. There is NO per-consumer re-subscription.
 *
 * Spec #2914 ST-5 — the `stt:transcript` producer/consumer/merge is GONE: voice
 * input has exactly ONE path (the captured model-audio clip delivered to the
 * local multimodal server), so this hook no longer carries transcript text
 * (`committed` / `partial` / `liveText`) and no longer registers
 * `stt:transcript`. The one transcript projection (`transcriptCase`) and its
 * wiring were removed with the deleted on-device engine.
 *
 * The subscription goes through the shared `adapterBridge.listen`, which
 * performs the guarded DYNAMIC `@tauri-apps/api/event` import internally and is
 * a no-op outside Tauri (AGENTS.md: never a static `@tauri-apps/api` import; the
 * bridge is the one sanctioned wrapper — the same path `useCompanionReadiness`
 * uses).
 *
 * These events are CONTROL PLANE — they never go through `EventBus`/RTDB rows
 * (only `RowDeliveryBatch` envelopes do), so this hook never uses
 * `useEventRows`. Contract: every method resolves and never throws to the
 * caller, and no state is updated after unmount.
 *
 * Spec #2897 ST-2 — the state contract carries the model-audio phase
 * (`capturing` / `processing`) and the at-ceiling signal the launcher's
 * model-audio indicator derives from; Spec #2897 ST-5 adds the pinned per-input
 * ceiling (`limitMs`) so the UI copy and the backend constant can never
 * disagree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';

/** STT session origin — the context-dependent Ctrl+Space cascade picks one. */
export type VoiceOrigin = 'launcher' | 'companion';

/** Rust `SttErrorCode` (camelCase wire) — the closed STT failure vocabulary. */
export type VoiceErrorCode =
  | 'noDevice'
  | 'permissionDenied'
  | 'modelMissing'
  | 'modelCorrupt'
  | 'engineStartFailed'
  | 'alreadyListening'
  | 'disabled'
  | 'internal'
  | 'modelAudioUnsupported'
  | 'modelAudioUnavailable';

/**
 * Spec #2897 ST-2 — Rust `SttPhaseWire` (camelCase wire): the model-audio
 * capture phase. `stopped` / `error` are deliberately NOT wire values — the
 * indicator derives them from `listening:false` + `code`.
 */
export type VoiceModelAudioPhase = 'capturing' | 'processing';

/** Rust `SttStateEvent` (camelCase wire). */
export interface SttStateEvent {
  listening: boolean;
  /** One of the `VoiceErrorCode` strings, or null. */
  code: VoiceErrorCode | null;
  detail: string | null;
  origin: string | null;
  /**
   * Spec #2887 ST-1 — start receipt → capture-live elapsed ms. `null` on every
   * path that did not start a session (idle, error, a status re-emit).
   */
  readyMs?: number | null;
  /**
   * Spec #2897 ST-2 — the model-audio phase (`capturing` while accumulating,
   * `processing` once a stop committed the clip). `null` on every path that is
   * not a model-audio session.
   */
  phase?: VoiceModelAudioPhase | null;
  /**
   * Spec #2897 ST-2 (REQ-6) — `true` iff the stop auto-stopped at the pinned
   * clip ceiling; `false` on a manual model-audio stop; `null` on every other
   * path. Not an error state.
   */
  limitReached?: boolean | null;
  /**
   * Spec #2897 ST-5 (REQ-6) — the pinned per-input ceiling, in milliseconds, the
   * model-audio capture is bounded by. `null` outside a model-audio session.
   * The launcher's "last N seconds" countdown and its limit notice derive from
   * THIS value, so the backend constant and the UI copy can never disagree.
   */
  limitMs?: number | null;
}

/** Rust `SttStartResult` (camelCase wire). */
export interface SttStartResult {
  started: boolean;
  code: VoiceErrorCode | null;
  detail: string | null;
  deviceName: string | null;
  sampleRate: number | null;
}

export interface VoiceDictation {
  /** True while the backend reports an active capture session. */
  listening: boolean;
  /** Typed failure code for the last failed start / current error state. */
  errorCode: VoiceErrorCode | null;
  /** Actionable detail paired with `errorCode` (null when there is no error). */
  detail: string | null;
  /** Device name reported by the last successful start. */
  deviceName: string | null;
  /** Session origin of the active (or last) session. */
  origin: VoiceOrigin | null;
  /**
   * Spec #2897 ST-2 — the model-audio phase the launcher indicator derives from:
   * `'capturing'` while the clip accumulates, `'processing'` once a stop
   * committed it, `null` outside a model-audio session.
   */
  modelAudioPhase: VoiceModelAudioPhase | null;
  /**
   * Spec #2897 ST-2 (REQ-6) — the most recent stop auto-stopped at the pinned
   * clip ceiling. A warning treatment, never an error.
   */
  limitReached: boolean;
  /**
   * Spec #2897 ST-5 (REQ-6) — the pinned per-input ceiling in ms, or `null`
   * outside a model-audio session. The launcher derives its countdown and its
   * limit notice from this ONE value (never a hardcoded duration).
   */
  modelAudioLimitMs: number | null;
  start(origin: VoiceOrigin): Promise<void>;
  /** Commit the final partial (the backend emits the final first). */
  stop(): Promise<void>;
  /** Discard the current partial (no final transcript). */
  cancel(): Promise<void>;
}

const isVoiceOrigin = (value: string | null): value is VoiceOrigin =>
  value === 'launcher' || value === 'companion';

export function useVoiceDictation(): VoiceDictation {
  const [listening, setListening] = useState(false);
  const [errorCode, setErrorCode] = useState<VoiceErrorCode | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [origin, setOrigin] = useState<VoiceOrigin | null>(null);
  // Spec #2897 ST-2 — the model-audio phase + the at-ceiling signal the
  // launcher's model-audio indicator derives from. Both are `stt:state`-driven.
  const [modelAudioPhase, setModelAudioPhase] = useState<VoiceModelAudioPhase | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  // Spec #2897 ST-5 — the pinned ceiling the model-audio capture is bounded by
  // (from `stt:state.limitMs`), surfaced so the launcher never hardcodes it.
  const [modelAudioLimitMs, setModelAudioLimitMs] = useState<number | null>(null);

  // Cleared on unmount; every async continuation checks it before touching
  // state so a late `stt_start`/`stop`/`cancel` resolution is a no-op.
  const mountedRef = useRef(true);

  // ── Event subscription (register-once; unlisten on unmount) ────────────────
  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const register = (event: string, handler: (payload: unknown) => void) => {
      void adapterBridge
        .listen<unknown>(event, handler)
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlisteners.push(unlisten);
        })
        .catch(() => {
          // A registration failure must never escape the hook (dev/no-Tauri).
        });
    };

    register('stt:state', (payload) => {
      if (disposed || !mountedRef.current) return;
      const event = payload as SttStateEvent;
      setListening(event.listening);
      if (isVoiceOrigin(event.origin)) setOrigin(event.origin);
      // An error state clears as soon as a session is (re)started.
      setErrorCode(event.listening ? null : event.code ?? null);
      setDetail(event.listening ? null : event.detail ?? null);
      // Spec #2897 ST-2 — the model-audio phase travels on the event itself:
      // `capturing` on the start stamp, `processing` on a model-audio stop, and
      // `null` (cleared) on every other path. `limitReached` is a one-shot
      // signal — `true` only on the at-ceiling stop event.
      setModelAudioPhase(event.phase ?? null);
      setLimitReached(event.limitReached === true);
      // Spec #2897 ST-5 (REQ-6) — the pinned ceiling travels on every
      // model-audio state; an event without a bound clears it.
      setModelAudioLimitMs(typeof event.limitMs === 'number' ? event.limitMs : null);
    });

    return () => {
      mountedRef.current = false;
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const start = useCallback(async (nextOrigin: VoiceOrigin) => {
    if (!mountedRef.current) return;
    // Optimistically clear the previous failure; the result re-sets it.
    setErrorCode(null);
    setDetail(null);
    // Spec #2897 ST-2 — a new listen invalidates the previous stop's ceiling
    // signal; the phase is re-stamped by the backend's `stt:state`.
    setLimitReached(false);
    try {
      const result = await adapterBridge.invoke<SttStartResult>('stt_start', {
        origin: nextOrigin,
      });
      if (!mountedRef.current) return;
      // No adapter (dev/test without Tauri): nothing to start, no crash.
      if (!result) return;
      if (result.started) {
        setOrigin(nextOrigin);
        setListening(true);
        setDeviceName(result.deviceName ?? null);
      } else if (result.code === 'alreadyListening') {
        // F-38 (R-4.1 / R-5.3) — a duplicate start is an IDEMPOTENCE signal, not
        // a failure: the backend already owns a live app-global session, so the
        // request is a no-op. Keep the live indicator, and do NOT adopt the
        // requested origin (the ACTIVE session's origin is authoritative and
        // comes from the app-global `stt:state` — R-5.3's one-indicator routing),
        // do NOT touch `deviceName`, and do NOT set an error. The optimistic
        // clear above is the whole effect.
        setListening(true);
      } else {
        setListening(false);
        setErrorCode(result.code ?? 'internal');
        setDetail(result.detail ?? null);
      }
    } catch (error) {
      // Every failure surfaces as a typed code; never throws to the caller.
      if (!mountedRef.current) return;
      setListening(false);
      setErrorCode('internal');
      setDetail(error instanceof Error ? error.message : null);
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await adapterBridge.invoke('stt_stop');
    } catch {
      // The backend still emits `stt:state listening:false`; local state is set below.
    }
    if (!mountedRef.current) return;
    setListening(false);
  }, []);

  const cancel = useCallback(async () => {
    try {
      await adapterBridge.invoke('stt_cancel');
    } catch {
      // Cancel is best-effort; local state is set regardless.
    }
    if (!mountedRef.current) return;
    setListening(false);
  }, []);

  return useMemo(
    () => ({
      listening,
      errorCode,
      detail,
      deviceName,
      origin,
      modelAudioPhase,
      limitReached,
      modelAudioLimitMs,
      start,
      stop,
      cancel,
    }),
    [
      listening,
      errorCode,
      detail,
      deviceName,
      origin,
      modelAudioPhase,
      limitReached,
      modelAudioLimitMs,
      start,
      stop,
      cancel,
    ],
  );
}
