/**
 * useModelAudioCapability — the Companion readiness row's backend capability
 * probe (Spec #2897 ST-6; REQ-7).
 *
 * The UI NEVER infers audio capability from a model name: this hook invokes the
 * backend-owned `stt_audio_capability` command (which performs the sanctioned
 * read-only probe against the managed loopback `llama-server`) and exposes the
 * typed result. The probe is:
 *
 * - ENABLED-SCOPED: it runs only while the caller says capability matters — since
 *   Spec #2914 ST-3 there is a single model-audio path, so the caller gates on
 *   `voiceEnabled` (never on a speech-handling mode, which no longer exists). A
 *   disabled hook invokes nothing and drops the result.
 * - SINGLE-FLIGHT: concurrent probes coalesce, so a burst of re-renders can
 *   never stack requests.
 * - FAIL-CLOSED: a rejected invoke / absent command leaves `capability` null,
 *   which the row derives as `unknown` ("can't check") — never a fabricated
 *   `ready`.
 *
 * The probe goes through the shared `adapterBridge` (the one sanctioned wrapper;
 * never a static `@tauri-apps/api` import).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';
import type { SttAudioCapability } from '../components/companion/companionReadiness';

export interface ModelAudioCapabilityProbe {
  /** The latest backend verdict, or null while unknown / before the first probe. */
  capability: SttAudioCapability | null;
  /** A probe is in flight (the UI-side `checking` value). */
  checking: boolean;
  /** Re-probe now (the row's `Try again`). A no-op while disabled. */
  refresh: () => void;
}

const isCapability = (value: unknown): value is SttAudioCapability => {
  if (!value || typeof value !== 'object') return false;
  const state = (value as Record<string, unknown>).state;
  return (
    state === 'checking' ||
    state === 'ready' ||
    state === 'unsupported' ||
    state === 'serverUnavailable' ||
    state === 'unknown'
  );
};

export function useModelAudioCapability(enabled: boolean): ModelAudioCapabilityProbe {
  const [capability, setCapability] = useState<SttAudioCapability | null>(null);
  const [checking, setChecking] = useState(false);

  // Cleared on unmount; every async continuation checks it before touching state
  // so a probe that settles late is a no-op.
  const mountedRef = useRef(true);
  // Read synchronously by the probe guards — a probe that resolves after the
  // mode changed must not publish a stale verdict.
  const enabledRef = useRef(enabled);
  // Monotonic probe id: only the newest probe may report.
  const probeIdRef = useRef(0);
  // Single-flight: at most one `stt_audio_capability` invocation at a time.
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
    if (mountedRef.current && enabledRef.current) setChecking(true);

    const task = (async () => {
      try {
        const result = await adapterBridge.invoke<SttAudioCapability>('stt_audio_capability');
        if (!mountedRef.current || !enabledRef.current || id !== probeIdRef.current) return;
        // Fail closed: a malformed/absent result is "can't check", never ready.
        setCapability(isCapability(result) ? result : null);
      } catch {
        if (!mountedRef.current || !enabledRef.current || id !== probeIdRef.current) return;
        setCapability(null);
      } finally {
        if (mountedRef.current && enabledRef.current && id === probeIdRef.current) {
          setChecking(false);
        }
      }
    })();

    inFlightRef.current = task;
    try {
      await task;
    } finally {
      if (inFlightRef.current === task) inFlightRef.current = null;
    }
  }, []);

  // Probe on the enable 0 -> 1 edge; drop the verdict (and invalidate an in-flight
  // probe) when the capability stops mattering (voice disabled), so a stale
  // model-audio verdict is never shown for a later session.
  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) {
      void probe();
    } else {
      probeIdRef.current += 1;
      setCapability(null);
      setChecking(false);
    }
  }, [enabled, probe]);

  const refresh = useCallback(() => {
    if (!enabledRef.current) return;
    void probe();
  }, [probe]);

  return useMemo(() => ({ capability, checking, refresh }), [capability, checking, refresh]);
}
