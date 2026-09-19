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
 *
 * Spec #2887 ST-7 — the state contract also carries the resident-engine
 * observable (`engineResident`, ST-3's `stt:state` stamp) that the launcher's
 * honest hold cue derives from; see the field docs below.
 *
 * Spec #2888 ST-2 — this hook is ALSO the single transcript-case seam: every
 * `stt:transcript` segment is projected through
 * `normalizeTranscriptSegment` (sentence case, the product name, the declared
 * intentional capitals) BEFORE it is committed/rendered, so every consumer of
 * transcript text sees the same normal form and the app's own transport is the
 * only place the transform lives. The projection is upstream of the bar write,
 * so `LauncherShell`'s live-write/finalize/provenance logic is untouched.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';
import { normalizeTranscriptSegment } from '../utils/transcriptCase';

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
  /**
   * Spec #2887 ST-1 — start receipt → capture-live elapsed ms. `null` on every
   * path that did not start a session (idle, error, a status re-emit).
   */
  readyMs?: number | null;
  /**
   * Spec #2887 ST-3 — did the session's engine come from the resident slot.
   * `true` only for a genuine take (never optimistic): a launch-window hold that
   * JOINED the in-flight warm reports `false`, as does every idle/error event.
   */
  engineResident?: boolean;
  /**
   * Spec #2897 ST-2 — the model-audio phase (`capturing` while accumulating,
   * `processing` once a stop committed the clip). `null` on every legacy /
   * `'local'` path.
   */
  phase?: VoiceModelAudioPhase | null;
  /**
   * Spec #2897 ST-2 (REQ-6) — `true` iff the stop auto-stopped at the pinned
   * clip ceiling; `false` on a manual model-audio stop; `null` on every other
   * path. Not an error state.
   */
  limitReached?: boolean | null;
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
  /**
   * Spec #2887 ST-7 (R-1/R-4) — the resident-engine observable the honest hold
   * cue derives from. It mirrors the residency stamp of the most recent session
   * START (`stt:state{listening:true}`), which is the truthful answer to "will
   * the next hold pay a model load?". An idle event NEVER rewrites it (its
   * `engineResident:false` means "no start happened", not "the resident is
   * gone"); the typed `disabled` voice-off signal clears it. `false` while no
   * session has started — the launch window, when the engine is not resident yet.
   */
  engineResident: boolean;
  /**
   * Spec #2897 ST-2 — the model-audio phase the launcher indicator derives from:
   * `'capturing'` while the clip accumulates, `'processing'` once a stop
   * committed it, `null` on every legacy / local-transcription path.
   */
  modelAudioPhase: VoiceModelAudioPhase | null;
  /**
   * Spec #2897 ST-2 (REQ-6) — the most recent stop auto-stopped at the pinned
   * clip ceiling. A warning treatment, never an error.
   */
  limitReached: boolean;
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
  // Spec #2887 ST-7 — fail-closed: unknown residency is NOT resident (the cue
  // therefore says `warming` rather than claiming a warm engine it cannot see).
  const [engineResident, setEngineResident] = useState(false);
  // Spec #2897 ST-2 — the model-audio phase + the at-ceiling signal the
  // launcher's model-audio indicator derives from. Both are `stt:state`-driven.
  const [modelAudioPhase, setModelAudioPhase] = useState<VoiceModelAudioPhase | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  // Cleared on unmount; every async continuation checks it before touching
  // state so a late `stt_start`/`stop`/`cancel` resolution is a no-op.
  const mountedRef = useRef(true);

  // Spec #2888 ST-2 — has a FINAL segment already been emitted in this session?
  // The utterance opening is capitalised ONCE per session: until the first final
  // arrives every segment is the opening (`atUtteranceStart = true`), and any
  // continuation segment must not manufacture a mid-sentence capital. A ref (not
  // state) is correct here — it carries no render output and MUST reset per
  // mount; a new `listening` session re-opens the utterance.
  const segmentSeenRef = useRef(false);

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
      // Spec #2888 ST-2 — the ONE projection point for transcript text.
      const text = normalizeTranscriptSegment(event.text, !segmentSeenRef.current);
      if (event.isFinal) {
        setCommitted((prev) => joinSegments(prev, text));
        setPartial('');
        // The utterance opening has been emitted: a later segment is a
        // continuation and stays lowercase-initial.
        segmentSeenRef.current = true;
      } else {
        setPartial(text);
      }
    });

    register('stt:state', (payload) => {
      if (disposed || !mountedRef.current) return;
      const event = payload as SttStateEvent;
      // Spec #2888 ST-2 — a new session re-opens the utterance.
      if (event.listening) segmentSeenRef.current = false;
      setListening(event.listening);
      if (isVoiceOrigin(event.origin)) setOrigin(event.origin);
      // An error state clears as soon as a session is (re)started.
      setErrorCode(event.listening ? null : event.code ?? null);
      setDetail(event.listening ? null : event.detail ?? null);
      // Spec #2887 ST-7 (R-1/R-4) — the residency stamp travels ONLY on a START.
      // An idle event's `engineResident:false` means "no start happened", never
      // "the resident engine is gone", so it must not clear the last stamp (that
      // would mislabel every later hold as a launch-window `warming`). The typed
      // `disabled` signal IS the voice-off/release edge, so it clears it.
      if (event.listening) {
        setEngineResident(event.engineResident === true);
      } else if (event.code === 'disabled') {
        setEngineResident(false);
      }
      // Spec #2897 ST-2 — the model-audio phase travels on the event itself:
      // `capturing` on the start stamp, `processing` on a model-audio stop, and
      // `null` (cleared) on every legacy / local / error path. `limitReached`
      // is a one-shot signal — `true` only on the at-ceiling stop event.
      setModelAudioPhase(event.phase ?? null);
      setLimitReached(event.limitReached === true);
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
      engineResident,
      modelAudioPhase,
      limitReached,
      start,
      stop,
      cancel,
    }),
    [
      listening,
      committed,
      partial,
      errorCode,
      detail,
      deviceName,
      origin,
      engineResident,
      modelAudioPhase,
      limitReached,
      start,
      stop,
      cancel,
    ],
  );
}
