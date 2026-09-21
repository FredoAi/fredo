/**
 * useVoiceDictation — Spec #2877 ST-3 unit pins; one path since Spec #2914 ST-5.
 *
 * Covers: the guarded dynamic listener registration through `adapterBridge`
 * (never a static `@tauri-apps/api` import, never RTDB/`useEventRows`), the state
 * contract (`listening` / `origin` / `errorCode` / `detail` / `deviceName`), the
 * lifecycle methods never throwing to the caller, and the unmount contract
 * (unlisten + no state update / no throw after unmount).
 *
 * Spec #2914 ST-9 — the resident-engine observable (`engineResident`) is GONE
 * with the deleted engine (SA-11): the hook no longer exposes or mirrors it, and
 * the launch-window hold cue derives from `holdPending` alone.
 *
 * Spec #2897 ST-2/ST-5 adds the model-audio phase + at-ceiling signal and the
 * pinned per-input ceiling (`limitMs`) the launcher indicator/countdown derive
 * from.
 *
 * Spec #2914 ST-5 — the `stt:transcript` producer/consumer and the whole
 * transcript merge are GONE (voice has exactly ONE model-audio path), so this
 * file no longer pins transcript merge/normalize/casing and the hook must NOT
 * register `stt:transcript` at all. The `stt:state` lifecycle, phase, ceiling
 * and cancel assertions are kept.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('../../utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: invokeMock,
    listen: listenMock,
    llmChat: vi.fn(),
    llmChatWithImage: vi.fn(),
  },
}));

import { useVoiceDictation } from '../useVoiceDictation';
import type { SttStartResult } from '../useVoiceDictation';

type Handler = (payload: unknown) => void;

let handlers: Record<string, Handler[]>;
let unlisteners: Array<ReturnType<typeof vi.fn>>;
let consoleError: ReturnType<typeof vi.spyOn>;

const okStart = (): SttStartResult => ({
  started: true,
  code: null,
  detail: null,
  deviceName: 'Test Mic',
  sampleRate: 48000,
});

const emit = (event: string, payload: unknown) => {
  act(() => {
    (handlers[event] ?? []).forEach((handler) => handler(payload));
  });
};

beforeEach(() => {
  handlers = {};
  unlisteners = [];
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockImplementation(async (event: string, handler: Handler) => {
    (handlers[event] ??= []).push(handler);
    const unlisten = vi.fn();
    unlisteners.push(unlisten);
    return unlisten;
  });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleError.mockRestore();
  vi.clearAllMocks();
});

// ── 1. Subscription + regression invariants ─────────────────────────────────

describe('useVoiceDictation — control-plane subscription', () => {
  it('registers stt:state through adapterBridge.listen — and NEVER stt:transcript', () => {
    renderHook(() => useVoiceDictation());

    const events = listenMock.mock.calls.map((call) => call[0]);
    expect(events).toContain('stt:state');
    // Spec #2914 ST-5 (G-183 #16) — the transcript event is never consumed:
    // there is exactly one model-audio path and no local recogniser.
    expect(events).not.toContain('stt:transcript');
  });

  it('exposes the initial idle contract', () => {
    const { result } = renderHook(() => useVoiceDictation());

    expect(result.current.listening).toBe(false);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.detail).toBeNull();
    expect(result.current.deviceName).toBeNull();
    expect(result.current.origin).toBeNull();
    // Spec #2914 ST-9 (SA-11) — the removed residency observable never reappears
    // in the state contract (its only source was the deleted wire field).
    expect('engineResident' in result.current).toBe(false);
    // #2897 ST-2 — no model-audio phase and no ceiling signal while idle.
    expect(result.current.modelAudioPhase).toBeNull();
    expect(result.current.limitReached).toBe(false);
    // #2897 ST-5 — no bound is advertised outside a model-audio session.
    expect(result.current.modelAudioLimitMs).toBeNull();
  });

  it('never statically imports @tauri-apps/api, never uses useEventRows, no transcript consumer, no POC residue', () => {
    // vitest runs with cwd = apps/ui; resolve the hook source relative to it.
    const rawSource = readFileSync(
      resolve(process.cwd(), 'src/shared/hooks/useVoiceDictation.ts'),
      'utf8',
    );
    // Strip comments so doc prose about the sanctioned dynamic import /
    // control-plane rule cannot false-positive the literal grep.
    const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/@tauri-apps\/api/);
    expect(source).not.toMatch(/useEventRows/);
    // Spec #2914 ST-5 (G-183 #16) — the transcript path is gone at the source:
    // no `stt:transcript` registration and no transcript-case projection.
    expect(source).not.toMatch(/stt:transcript/);
    expect(source).not.toMatch(/normalizeTranscriptSegment|transcriptCase/);
    // No auto-submit / autosend dispatch in this stream client.
    expect(source).not.toMatch(/auto[-_]?submit|autosend|handleQueryChange/i);
    // Production source — the spike header is gone (REQ-NF3).
    expect(rawSource).not.toContain('SPIKE #2876');
    expect(rawSource).not.toContain('THROWAWAY POC');
    // Spec #2914 ST-9 (SA-11) — no resident-engine remnant survives in the hook.
    expect(source).not.toMatch(/engineResident|ResidentEngine/);
  });
});

// ── 2. stt:state contract ───────────────────────────────────────────────────

describe('useVoiceDictation — stt:state', () => {
  it('applies listening / origin / errorCode / detail', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: false,
      code: 'modelMissing',
      detail: 'The voice input model is not installed.',
      origin: 'launcher',
    });

    expect(result.current.listening).toBe(false);
    expect(result.current.errorCode).toBe('modelMissing');
    expect(result.current.detail).toBe('The voice input model is not installed.');
    expect(result.current.origin).toBe('launcher');
  });

  it('clears a stale error when a session starts', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: false, code: 'noDevice', detail: 'no mic', origin: 'launcher' });
    expect(result.current.errorCode).toBe('noDevice');

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'companion' });
    expect(result.current.listening).toBe(true);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.detail).toBeNull();
    expect(result.current.origin).toBe('companion');
  });

  it('ignores an unknown origin and keeps the last valid one', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: null });
    expect(result.current.origin).toBeNull();

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    expect(result.current.origin).toBe('launcher');

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'bogus' });
    expect(result.current.origin).toBe('launcher');
  });
});

// ── 3. Idle sweep / `disabled` lifecycle (#2887 ST-7; #2914 ST-9 re-point) ───
//
// Spec #2914 ST-9 — the resident-engine observable (`engineResident`) is GONE
// with the deleted engine: the hook no longer exposes or mirrors it, and the
// launch-window hold cue derives from `holdPending` alone (pinned in
// `launcherVoiceDictation.test.tsx`). The lifecycle assertions that surrounded
// it are kept here (G-125 re-point): an idle sweep ends the capture without
// fabricating an error, and the typed `disabled` voice-off signal surfaces its
// error code.

describe('useVoiceDictation — idle / `disabled` lifecycle (#2887 ST-7; #2914 ST-9)', () => {
  it('an idle sweep ends the capture without fabricating an error', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      readyMs: 90,
    });
    expect(result.current.listening).toBe(true);

    // The session ended: the SWEEPING event clears `listening`/errors.
    emit('stt:state', {
      listening: false,
      code: null,
      detail: null,
      origin: 'launcher',
      readyMs: null,
    });
    expect(result.current.listening).toBe(false);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.detail).toBeNull();
  });

  it('the typed `disabled` voice-off signal surfaces its error code', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: false,
      code: 'disabled',
      detail: 'Voice input is disabled in Companion settings.',
      origin: 'launcher',
    });
    expect(result.current.errorCode).toBe('disabled');
    expect(result.current.detail).toBe('Voice input is disabled in Companion settings.');
  });
});

// ── 4. The model-audio phase + ceiling signal (#2897 ST-2) ──────────────────
//
// The backend stamps `phase` on `stt:state` (`capturing` on the start,
// `processing` on a model-audio stop) and `limitReached` on the at-ceiling stop.
// The launcher's model-audio indicator derives its `processing` state from
// `modelAudioPhase` even though `listening` is already false; `stopped`/`error`
// remain client-derived from `listening` + `code`.

describe('useVoiceDictation — the model-audio phase + ceiling signal (#2897 ST-2)', () => {
  it('mirrors capturing → processing across a model-audio session', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'capturing',
    });
    expect(result.current.modelAudioPhase).toBe('capturing');
    expect(result.current.listening).toBe(true);

    // The stop committed the clip: `listening` is false but the turn is still
    // being processed — the phase (not `listening`) carries the indicator.
    emit('stt:state', {
      listening: false,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'processing',
    });
    expect(result.current.listening).toBe(false);
    expect(result.current.modelAudioPhase).toBe('processing');
  });

  it('leaves the phase null on a state without a model-audio phase', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    expect(result.current.modelAudioPhase).toBeNull();

    emit('stt:state', {
      listening: false,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: null,
      limitReached: null,
    });
    expect(result.current.modelAudioPhase).toBeNull();
  });

  it('surfaces limitReached only on the at-ceiling stop, and resets on the next listen', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'capturing',
      limitReached: null,
    });
    expect(result.current.limitReached).toBe(false);

    // The bound auto-stopped capture: a warning treatment, never an error.
    emit('stt:state', {
      listening: false,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'processing',
      limitReached: true,
    });
    expect(result.current.limitReached).toBe(true);
    expect(result.current.errorCode).toBeNull();

    // The next session starts from a clean slate.
    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'capturing',
      limitReached: null,
    });
    expect(result.current.limitReached).toBe(false);
  });

  it('clears the phase when a typed error ends the session', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'capturing',
    });
    expect(result.current.modelAudioPhase).toBe('capturing');

    emit('stt:state', {
      listening: false,
      code: 'modelAudioUnavailable',
      detail: 'the model server is not running',
      origin: 'launcher',
    });
    expect(result.current.modelAudioPhase).toBeNull();
    expect(result.current.errorCode).toBe('modelAudioUnavailable');
  });

  it('resets the ceiling signal optimistically on a new start()', async () => {
    invokeMock.mockResolvedValue(okStart());
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: false,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'processing',
      limitReached: true,
    });
    expect(result.current.limitReached).toBe(true);

    await act(async () => {
      await result.current.start('launcher');
    });
    expect(result.current.limitReached).toBe(false);
  });

  it('surfaces the backend ceiling from `stt:state.limitMs` and clears it on a state without a bound (#2897 ST-5)', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'capturing',
      limitMs: 30_000,
    });
    expect(result.current.modelAudioLimitMs).toBe(30_000);

    // The at-ceiling auto-stop keeps advertising the same pinned bound.
    emit('stt:state', {
      listening: false,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'processing',
      limitReached: true,
      limitMs: 30_000,
    });
    expect(result.current.modelAudioLimitMs).toBe(30_000);

    // An event without a bound clears the display value.
    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    expect(result.current.modelAudioLimitMs).toBeNull();
  });
});

// ── 5. start() ──────────────────────────────────────────────────────────────

describe('useVoiceDictation — start()', () => {
  it('invokes stt_start with the origin and reflects the reported device', async () => {
    invokeMock.mockResolvedValue(okStart());
    const { result } = renderHook(() => useVoiceDictation());

    await act(async () => {
      await result.current.start('companion');
    });

    expect(invokeMock).toHaveBeenCalledWith('stt_start', { origin: 'companion' });
    expect(result.current.listening).toBe(true);
    expect(result.current.origin).toBe('companion');
    expect(result.current.deviceName).toBe('Test Mic');
    expect(result.current.errorCode).toBeNull();
    expect(result.current.detail).toBeNull();
  });

  it('surfaces a typed failure code + detail without throwing (R-4.5 client side)', async () => {
    invokeMock.mockResolvedValue({
      started: false,
      code: 'noDevice',
      detail: 'The selected microphone is not available.',
      deviceName: null,
      sampleRate: null,
    });
    const { result } = renderHook(() => useVoiceDictation());

    await act(async () => {
      await result.current.start('launcher');
    });

    expect(result.current.listening).toBe(false);
    expect(result.current.errorCode).toBe('noDevice');
    expect(result.current.detail).toBe('The selected microphone is not available.');
  });

  it('clears a previous failure on the next start attempt', async () => {
    invokeMock.mockResolvedValueOnce({
      started: false,
      code: 'modelMissing',
      detail: 'missing',
      deviceName: null,
      sampleRate: null,
    });
    const { result } = renderHook(() => useVoiceDictation());

    await act(async () => {
      await result.current.start('launcher');
    });
    expect(result.current.errorCode).toBe('modelMissing');

    invokeMock.mockResolvedValueOnce(okStart());
    await act(async () => {
      await result.current.start('launcher');
    });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.detail).toBeNull();
    expect(result.current.listening).toBe(true);
  });

  it('F-38: a duplicate start is an idempotent no-op — listening stays true with no error', async () => {
    // A live companion-origin session is already observable via the app-global
    // `stt:state` (the backend owns the session).
    invokeMock.mockResolvedValue({
      started: false,
      code: 'alreadyListening',
      detail: 'A listening session is already active.',
      deviceName: null,
      sampleRate: null,
    });
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'companion' });
    expect(result.current.listening).toBe(true);
    expect(result.current.origin).toBe('companion');

    await act(async () => {
      await result.current.start('companion');
    });

    // R-4.1: the reject is idempotent — the live indicator and session origin
    // survive, and no failure state is synthesised.
    expect(result.current.listening).toBe(true);
    expect(result.current.origin).toBe('companion');
    expect(result.current.errorCode).toBeNull();
    expect(result.current.detail).toBeNull();
  });

  it('F-38: a duplicate start never adopts the REQUESTED origin (R-5.3 routing)', async () => {
    // The active session is launcher-origin; a duplicate start requesting
    // `companion` must not steal the origin (that would re-route the single
    // visible indicator to the wrong surface).
    invokeMock.mockResolvedValue({
      started: false,
      code: 'alreadyListening',
      detail: 'A listening session is already active.',
      deviceName: null,
      sampleRate: null,
    });
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });

    await act(async () => {
      await result.current.start('companion');
    });

    expect(result.current.listening).toBe(true);
    expect(result.current.origin).toBe('launcher');
    expect(result.current.errorCode).toBeNull();
  });

  it('is a no-op without an adapter (invoke resolves undefined)', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useVoiceDictation());

    await act(async () => {
      await result.current.start('launcher');
    });

    expect(result.current.listening).toBe(false);
    expect(result.current.errorCode).toBeNull();
  });

  it('resolves with an internal code when the invoke rejects — never throws', async () => {
    invokeMock.mockRejectedValue(new Error('ipc unavailable'));
    const { result } = renderHook(() => useVoiceDictation());

    await act(async () => {
      await result.current.start('launcher');
    });

    expect(result.current.listening).toBe(false);
    expect(result.current.errorCode).toBe('internal');
    expect(result.current.detail).toBe('ipc unavailable');
  });
});

// ── 6. stop() ───────────────────────────────────────────────────────────────

describe('useVoiceDictation — stop()', () => {
  it('invokes stt_stop and reflects idle', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    await act(async () => {
      await result.current.stop();
    });

    expect(invokeMock).toHaveBeenCalledWith('stt_stop');
    expect(result.current.listening).toBe(false);
  });

  it('still resolves and reflects idle when the invoke rejects', async () => {
    invokeMock.mockRejectedValue(new Error('ipc unavailable'));
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.listening).toBe(false);
  });
});

// ── 7. cancel() ─────────────────────────────────────────────────────────────

describe('useVoiceDictation — cancel()', () => {
  it('invokes stt_cancel and reflects idle (R-4.4)', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      phase: 'capturing',
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(invokeMock).toHaveBeenCalledWith('stt_cancel');
    expect(result.current.listening).toBe(false);
  });

  it('still resolves and reflects idle when the invoke rejects', async () => {
    invokeMock.mockRejectedValue(new Error('ipc unavailable'));
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.listening).toBe(false);
  });
});

// ── 8. Lifecycle after unmount ──────────────────────────────────────────────

describe('useVoiceDictation — unmount contract', () => {
  it('unlistens the control-plane event on unmount', async () => {
    const { unmount } = renderHook(() => useVoiceDictation());
    await act(async () => {});

    unmount();

    expect(unlisteners).toHaveLength(1);
    unlisteners.forEach((unlisten) => expect(unlisten).toHaveBeenCalled());
  });

  it('unlistens a registration that settles AFTER unmount', async () => {
    const { unmount } = renderHook(() => useVoiceDictation());
    // No microtask flush: the register promise has not settled yet.
    unmount();
    await act(async () => {});

    expect(unlisteners).toHaveLength(1);
    unlisteners.forEach((unlisten) => expect(unlisten).toHaveBeenCalled());
  });

  it('does not invoke stt_start after unmount (no post-unmount activity)', async () => {
    const { result, unmount } = renderHook(() => useVoiceDictation());
    unmount();

    await act(async () => {
      await result.current.start('launcher');
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('resolves a start that settles after unmount without throwing', async () => {
    let resolveStart: (result: SttStartResult) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise<SttStartResult>((res) => (resolveStart = res)),
    );
    const { result, unmount } = renderHook(() => useVoiceDictation());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.start('launcher');
    });
    unmount();

    await act(async () => {
      resolveStart(okStart());
      await pending;
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('ignores a late state event that arrives after unmount (hostile unlisten)', async () => {
    // Simulate an adapter that fails to actually detach the handler.
    listenMock.mockImplementation(async (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
      return () => {};
    });
    const { result, unmount } = renderHook(() => useVoiceDictation());
    await act(async () => {});

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    expect(result.current.listening).toBe(true);

    const snapshot = result.current;
    unmount();

    act(() => {
      (handlers['stt:state'] ?? []).forEach((handler) =>
        handler({ listening: false, code: null, detail: null, origin: 'launcher' }),
      );
    });

    // The mounted guard makes the late event a no-op: no re-render, no throw.
    expect(result.current).toBe(snapshot);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('stays functional when a listener registration rejects (guarded dynamic listen)', async () => {
    listenMock.mockRejectedValue(new Error('no listener available'));
    invokeMock.mockResolvedValue(okStart());
    const { result } = renderHook(() => useVoiceDictation());
    await act(async () => {});

    await act(async () => {
      await result.current.start('launcher');
    });

    expect(result.current.listening).toBe(true);
  });
});
