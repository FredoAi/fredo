/**
 * useVoiceDictation — Spec #2877 ST-3 unit pins.
 *
 * Covers: the guarded dynamic listener registration through `adapterBridge`
 * (never a static `@tauri-apps/api` import, never RTDB/`useEventRows`), the
 * committed/partial/liveText merge semantics (R-3.1), the state contract
 * (`listening` / `origin` / `errorCode` / `detail` / `deviceName`), the
 * lifecycle methods never throwing to the caller, the final-before-idle
 * ordering (R-4.3), cancel discarding the in-flight partial (R-4.4), and the
 * unmount contract (unlisten + no state update / no throw after unmount).
 *
 * Spec #2887 ST-7 adds the resident-engine observable (`engineResident`, ST-3's
 * `stt:state` start stamp) the launcher's honest hold cue derives from.
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

const transcript = (over: Partial<Record<string, unknown>>) => ({
  sessionId: 's1',
  revision: 1,
  segmentId: 0,
  text: '',
  isFinal: false,
  latencyMs: 5,
  ...over,
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
  it('registers stt:transcript + stt:state through adapterBridge.listen', () => {
    renderHook(() => useVoiceDictation());

    const events = listenMock.mock.calls.map((call) => call[0]);
    expect(events).toContain('stt:transcript');
    expect(events).toContain('stt:state');
  });

  it('exposes the initial idle contract', () => {
    const { result } = renderHook(() => useVoiceDictation());

    expect(result.current.listening).toBe(false);
    expect(result.current.committed).toBe('');
    expect(result.current.partial).toBe('');
    expect(result.current.liveText).toBe('');
    expect(result.current.errorCode).toBeNull();
    expect(result.current.detail).toBeNull();
    expect(result.current.deviceName).toBeNull();
    expect(result.current.origin).toBeNull();
    // #2887 ST-7 — fail-closed: unknown residency is NOT resident.
    expect(result.current.engineResident).toBe(false);
  });

  it('never statically imports @tauri-apps/api, never uses useEventRows, no auto-submit, no POC residue', () => {
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
    // No auto-submit / autosend dispatch in this stream client (ST-5 / #2878 own those).
    expect(source).not.toMatch(/auto[-_]?submit|autosend|handleQueryChange/i);
    // Production source — the spike header is gone (REQ-NF3).
    expect(rawSource).not.toContain('SPIKE #2876');
    expect(rawSource).not.toContain('THROWAWAY POC');
  });
});

// ── 2. Transcript merge semantics (R-3.1) ───────────────────────────────────

describe('useVoiceDictation — transcript merge (R-3.1)', () => {
  it('a partial REPLACES the current segment; the final commits it and clears the partial', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:transcript', transcript({ revision: 1, text: 'hello' }));
    expect(result.current.partial).toBe('hello');
    expect(result.current.liveText).toBe('hello');

    // Cumulative segment text: the newer partial REPLACES, never appends.
    emit('stt:transcript', transcript({ revision: 2, text: 'hello world' }));
    expect(result.current.partial).toBe('hello world');
    expect(result.current.liveText).toBe('hello world');

    emit('stt:transcript', transcript({ revision: 3, text: 'hello world', isFinal: true }));
    expect(result.current.committed).toBe('hello world');
    expect(result.current.partial).toBe('');
    expect(result.current.liveText).toBe('hello world');
  });

  it('joins successive finalized segments with a single space', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:transcript', transcript({ revision: 1, text: 'first', isFinal: true }));
    emit('stt:transcript', transcript({ revision: 2, text: 'second', isFinal: false }));
    expect(result.current.liveText).toBe('first second');

    emit('stt:transcript', transcript({ revision: 3, text: 'second', isFinal: true }));
    expect(result.current.committed).toBe('first second');
    expect(result.current.partial).toBe('');
  });
});

// ── 3. stt:state contract ───────────────────────────────────────────────────

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

// ── 3b. The resident-engine observable (Spec #2887 ST-7) ─────────────────────
//
// ST-3 stamps `engineResident` (and `readyMs`) on the START-success
// `stt:state`. The launcher's honest hold cue derives from it: `false` = the
// engine was NOT resident at the start (the launch window) ⇒ `warming`; `true`
// ⇒ `starting`. These pins fix the mirror rule (a START writes it, an IDLE
// event must not clear it, the typed voice-off signal does).

describe('useVoiceDictation — the resident-engine observable (#2887 ST-7)', () => {
  it('mirrors the START stamp and is fail-closed while unknown', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      readyMs: 118,
      engineResident: true,
    });
    expect(result.current.engineResident).toBe(true);

    // A launch-window start JOINED the in-flight warm: never an optimistic stamp.
    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      readyMs: 2_940,
      engineResident: false,
    });
    expect(result.current.engineResident).toBe(false);
  });

  it('an idle state event never clears the last START stamp (its false means "no start happened")', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      readyMs: 90,
      engineResident: true,
    });
    expect(result.current.engineResident).toBe(true);

    // The session ended: the SWEEPING event clears `listening`/errors, but the
    // engine stays parked — clearing residency here would mislabel every later
    // hold as a launch-window `warming`.
    emit('stt:state', {
      listening: false,
      code: null,
      detail: null,
      origin: 'launcher',
      readyMs: null,
      engineResident: false,
    });
    expect(result.current.listening).toBe(false);
    expect(result.current.engineResident).toBe(true);
  });

  it('the typed `disabled` voice-off signal clears it (the voice-disabled edge)', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', {
      listening: true,
      code: null,
      detail: null,
      origin: 'launcher',
      readyMs: 90,
      engineResident: true,
    });
    expect(result.current.engineResident).toBe(true);

    emit('stt:state', {
      listening: false,
      code: 'disabled',
      detail: 'Voice input is disabled in Companion settings.',
      origin: 'launcher',
    });
    expect(result.current.errorCode).toBe('disabled');
    expect(result.current.engineResident).toBe(false);
  });
});

// ── 4. start() ──────────────────────────────────────────────────────────────

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

// ── 5. stop() — final before idle (R-4.3) ───────────────────────────────────

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

  it('keeps the committed final emitted before listening:false (R-4.3 ordering)', () => {
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    emit('stt:transcript', transcript({ revision: 1, text: 'good morning' }));
    expect(result.current.partial).toBe('good morning');

    // The backend commits the final BEFORE the idle state event.
    emit('stt:transcript', transcript({ revision: 2, text: 'good morning', isFinal: true }));
    emit('stt:state', { listening: false, code: null, detail: null, origin: 'launcher' });

    expect(result.current.committed).toBe('good morning');
    expect(result.current.partial).toBe('');
    expect(result.current.liveText).toBe('good morning');
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

// ── 6. cancel() — discard the partial (R-4.4) ───────────────────────────────

describe('useVoiceDictation — cancel()', () => {
  it('invokes stt_cancel, discards the in-flight partial, and commits nothing (R-4.4)', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    emit('stt:transcript', transcript({ revision: 1, text: 'half a sentence' }));
    expect(result.current.partial).toBe('half a sentence');

    await act(async () => {
      await result.current.cancel();
    });

    expect(invokeMock).toHaveBeenCalledWith('stt_cancel');
    expect(result.current.partial).toBe('');
    expect(result.current.committed).toBe('');
    expect(result.current.liveText).toBe('');
    expect(result.current.listening).toBe(false);
  });

  it('still resolves and discards the partial when the invoke rejects', async () => {
    invokeMock.mockRejectedValue(new Error('ipc unavailable'));
    const { result } = renderHook(() => useVoiceDictation());

    emit('stt:transcript', transcript({ revision: 1, text: 'draft' }));
    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.partial).toBe('');
  });
});

// ── 7. Lifecycle after unmount ──────────────────────────────────────────────

describe('useVoiceDictation — unmount contract', () => {
  it('unlistens both control-plane events on unmount', async () => {
    const { unmount } = renderHook(() => useVoiceDictation());
    await act(async () => {});

    unmount();

    expect(unlisteners).toHaveLength(2);
    unlisteners.forEach((unlisten) => expect(unlisten).toHaveBeenCalled());
  });

  it('unlistens a registration that settles AFTER unmount', async () => {
    const { unmount } = renderHook(() => useVoiceDictation());
    // No microtask flush: the register promise has not settled yet.
    unmount();
    await act(async () => {});

    expect(unlisteners).toHaveLength(2);
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

  it('ignores a late transcript that arrives after unmount (hostile unlisten)', async () => {
    // Simulate an adapter that fails to actually detach the handler.
    listenMock.mockImplementation(async (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
      return () => {};
    });
    const { result, unmount } = renderHook(() => useVoiceDictation());
    await act(async () => {});

    emit('stt:transcript', transcript({ revision: 1, text: 'before unmount' }));
    expect(result.current.partial).toBe('before unmount');

    const snapshot = result.current;
    unmount();

    act(() => {
      (handlers['stt:transcript'] ?? []).forEach((handler) =>
        handler(transcript({ revision: 2, text: 'after unmount' })),
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
