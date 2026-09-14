// SPIKE #2876 — THROWAWAY POC — replaced by #2877/#2878
/**
 * useVoiceDictation — live STT transcript for the launcher bar (Spec #2876 ST-4).
 *
 * Subscribes to the control-plane `stt:transcript` / `stt:state` events and
 * exposes the committed + current-partial text plus the session lifecycle
 * (`start` / `stop` / `cancel`). The subscription goes through the shared
 * `adapterBridge.listen`, which performs the guarded DYNAMIC
 * `@tauri-apps/api/event` import internally and is a no-op outside Tauri
 * (AGENTS.md: never a static `@tauri-apps/api` import; the bridge is the one
 * sanctioned wrapper — the same path `useCompanionReadiness` uses).
 *
 * Merge semantics (R-3.1/R-3.3): a non-final transcript REPLACES the current
 * segment's partial (the backend sends CUMULATIVE segment text); a final
 * transcript commits the segment and clears the partial. `cancel` discards the
 * current partial; `stop` commits it (the backend emits the final first).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';

/** STT session origin — the context-dependent Ctrl+Space cascade picks one. */
export type VoiceOrigin = 'launcher' | 'companion';

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
  /** One of the SttErrorCode strings, or null. */
  code: string | null;
  detail: string | null;
  origin: string | null;
}

/** Rust `SttStartResult` (camelCase wire). */
export interface SttStartResult {
  started: boolean;
  code: string | null;
  detail: string | null;
  deviceName: string | null;
  sampleRate: number | null;
}

export interface VoiceDictation {
  listening: boolean;
  /** Finalized segments of THIS session, space-joined. */
  committed: string;
  /** Current segment, cumulative. */
  partial: string;
  /** `committed + (committed && partial ? ' ' : '') + partial`. */
  liveText: string;
  /** Typed SttErrorCode string, or null. */
  errorCode: string | null;
  origin: VoiceOrigin | null;
  start(origin: VoiceOrigin): Promise<void>;
  /** Commit the final partial. */
  stop(): Promise<void>;
  /** Discard the current partial. */
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
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [origin, setOrigin] = useState<VoiceOrigin | null>(null);

  // ── Event subscriptions (register-once; unlisten on unmount) ───────────────
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const register = (event: string, handler: (payload: unknown) => void) => {
      void adapterBridge.listen<unknown>(event, handler).then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      });
    };

    register('stt:transcript', (payload) => {
      const event = payload as SttTranscriptEvent;
      if (event.isFinal) {
        setCommitted((prev) => joinSegments(prev, event.text));
        setPartial('');
      } else {
        setPartial(event.text);
      }
    });

    register('stt:state', (payload) => {
      const event = payload as SttStateEvent;
      setListening(event.listening);
      if (isVoiceOrigin(event.origin)) setOrigin(event.origin);
      setErrorCode(event.listening ? null : event.code ?? null);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const start = useCallback(async (nextOrigin: VoiceOrigin) => {
    setErrorCode(null);
    try {
      const result = await adapterBridge.invoke<SttStartResult>('stt_start', {
        origin: nextOrigin,
      });
      // No adapter (dev/test without Tauri): nothing to start, no crash.
      if (!result) return;
      if (result.started) {
        setOrigin(nextOrigin);
        setListening(true);
      } else {
        setListening(false);
        setErrorCode(result.code ?? 'internal');
      }
    } catch {
      // Every failure surfaces as a typed code; never throws to the caller.
      setListening(false);
      setErrorCode('internal');
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await adapterBridge.invoke('stt_stop');
    } catch {
      // The backend still emits `stt:state listening:false`; local state is set below.
    }
    setListening(false);
  }, []);

  const cancel = useCallback(async () => {
    try {
      await adapterBridge.invoke('stt_cancel');
    } catch {
      // Cancel is best-effort; the partial is discarded locally regardless.
    }
    setPartial('');
    setListening(false);
  }, []);

  return {
    listening,
    committed,
    partial,
    liveText: joinSegments(committed, partial),
    errorCode,
    origin,
    start,
    stop,
    cancel,
  };
}
