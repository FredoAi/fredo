/**
 * useVoiceDictation — STT transcript stream client (Spec #2877 ST-3).
 *
 * The single shared client for the control-plane `stt:transcript` /
 * `stt:state` events. It exposes the committed + current-partial transcript
 * merge plus the session lifecycle (`start` / `stop` / `cancel`) every consumer
 * shares — the launcher bar cue (ST-5), the companion listening bubble (ST-6),
 * and #2878's chat binding. There is NO per-consumer re-subscription.
 *
 * The subscription goes through the shared `adapterBridge.listen`, which
 * performs the guarded DYNAMIC `@tauri-apps/api/event` import internally and is
 * a no-op outside Tauri (AGENTS.md: never a static `@tauri-apps/api` import; the
 * bridge is the one sanctioned wrapper — the same path `useCompanionReadiness`
 * uses).
 *
 * These events are CONTROL PLANE — they never go through `EventBus`/RTDB rows
 * (only `RowDeliveryBatch` envelopes do), so this hook never uses
 * `useEventRows`. It also never auto-submits: writing a finished transcript
 * into the launcher bar and the autosend dispatch belong to ST-5 / #2878.
 *
 * Merge semantics (R-3.1): a non-final transcript REPLACES the current
 * segment's partial (the backend sends CUMULATIVE segment text); a final
 * transcript commits the segment and clears the partial. `cancel` discards the
 * current partial; `stop` commits it (the backend emits the final first —
 * R-4.3). Contract: every method resolves and never throws to the caller, and
 * no state is updated after unmount.
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
  | 'internal';

/** Rust `SttTranscriptEvent` (camelCase wire). */
export interface SttTranscriptEvent {
  sessionId: string;
  revision: number;
  segmentId: number;
  /** CUMULATIVE text of the CURRENT segment. */
  text: string;
  isFinal: boolean;
  latencyMs: number;
}

/** Rust `SttStateEvent` (camelCase wire). */
export interface SttStateEvent {
  listening: boolean;
  /** One of the `VoiceErrorCode` strings, or null. */
  code: VoiceErrorCode | null;
  detail: string | null;
  origin: string | null;
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
  /** Finalized segments of this session, space-joined. */
  committed: string;
  /** Current segment, cumulative. */
  partial: string;
  /** `committed + (committed && partial ? ' ' : '') + partial`. */
  liveText: string;
  /** Typed failure code for the last failed start / current error state. */
  errorCode: VoiceErrorCode | null;
  /** Actionable detail paired with `errorCode` (null when there is no error). */
  detail: string | null;
  /** Device name reported by the last successful start. */
  deviceName: string | null;
  /** Session origin of the active (or last) session. */
  origin: VoiceOrigin | null;
  start(origin: VoiceOrigin): Promise<void>;
  /** Commit the final partial (the backend emits the final first). */
  stop(): Promise<void>;
  /** Discard the current partial (no final transcript). */
  cancel(): Promise<void>;
}

/** Space-join two segment strings without a trailing/duplicate space. */
const joinSegments = (lead: string, tail: string): string => {
  if (!lead) return tail;
  if (!tail) return lead;
  return `${lead} ${tail}`;
};

const isVoiceOrigin = (value: string | null): value is VoiceOrigin =>
  value === 'launcher' || value === 'companion';

export function useVoiceDictation(): VoiceDictation {
  const [listening, setListening] = useState(false);
  const [committed, setCommitted] = useState('');
  const [partial, setPartial] = useState('');
  const [errorCode, setErrorCode] = useState<VoiceErrorCode | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [origin, setOrigin] = useState<VoiceOrigin | null>(null);

  // Cleared on unmount; every async continuation checks it before touching
  // state so a late `stt_start`/`stop`/`cancel` resolution is a no-op.
  const mountedRef = useRef(true);

  // ── Event subscriptions (register-once; unlisten on unmount) ───────────────
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

    register('stt:transcript', (payload) => {
      if (disposed || !mountedRef.current) return;
      const event = payload as SttTranscriptEvent;
      if (event.isFinal) {
        setCommitted((prev) => joinSegments(prev, event.text));
        setPartial('');
      } else {
        setPartial(event.text);
      }
    });

    register('stt:state', (payload) => {
      if (disposed || !mountedRef.current) return;
      const event = payload as SttStateEvent;
      setListening(event.listening);
      if (isVoiceOrigin(event.origin)) setOrigin(event.origin);
      // An error state clears as soon as a session is (re)started.
      setErrorCode(event.listening ? null : event.code ?? null);
      setDetail(event.listening ? null : event.detail ?? null);
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
      // Cancel is best-effort; the partial is discarded locally regardless.
    }
    if (!mountedRef.current) return;
    setPartial('');
    setListening(false);
  }, []);

  return useMemo(
    () => ({
      listening,
      committed,
      partial,
      liveText: joinSegments(committed, partial),
      errorCode,
      detail,
      deviceName,
      origin,
      start,
      stop,
      cancel,
    }),
    [listening, committed, partial, errorCode, detail, deviceName, origin, start, stop, cancel],
  );
}
