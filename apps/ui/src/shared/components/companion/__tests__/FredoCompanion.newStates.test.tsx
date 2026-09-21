/**
 * #2917 ST-4 / ST-5 — the four NEW status states at the CONSUMER seam.
 *
 * Drives the REAL `CompanionEntity` through each new state's product trigger and
 * pins the consumer wrapper's `data-state` + the shared overlay's rendered
 * `#fredo-expression[data-state]`:
 *   - `listening` ← the live voice-capture signal (`stt:state { listening: true }`)
 *   - `working`   ← a validated skill selection (`onSkillCall`) OR the deterministic
 *                   push itself (FIX-1 `WORKING_BEAT_MS`), then superseded by the
 *                   pushed settle (`happy`)
 *   - `error`     ← the typed `onError` channel AND the non-success app-open
 *                   reply, held for the UNCHANGED `ERROR_HOLD_MS` (from the settle)
 *   - `greeting`  ← an ambient context message with no generation in flight,
 *                   while the context `animState` STAYS `talk`
 *
 * Round-2 FIX-1 refreshed this file's `working`/non-success sequencing and added
 * the RC-1 same-dispatch race pin, the beat-vs-holds invariant and the timer-leak
 * pins. Every refreshed assertion is NAMED with the reason (G-125) — none deleted
 * or weakened. The existing per-state `data-state` pins (devMode / seatTeleport /
 * crossWindow) are NOT modified by this file.
 */

import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider, useCompanion, WELCOME_TEXT } from '@/shared/contexts/CompanionContext';
import { CompanionEntity, GREETING_BEAT_MS, WORKING_BEAT_MS } from '@/shared/components/companion/CompanionEntity';
import type { CompanionEntityHandle } from '@/shared/components/companion/CompanionEntity';
import { pushAppOpenReply } from '@/shared/components/companion/skillBridge';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { LlmSkillCall } from '@/app/adapters/HostAdapter';

// ── Module mocks (same shape as skillSettle.test.tsx) ───────────────────────────
const motionMock = vi.hoisted(() => {
  let react: { createElement: (tag: string, props: unknown, ...children: unknown[]) => unknown } | null = null;
  const cache = new Map<string, (props: Record<string, unknown>) => unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        let comp = cache.get(tag);
        if (!comp) {
          comp = (props: Record<string, unknown>) => {
            if (!react) throw new Error('framer-motion mock: React not set yet');
            const { initial: _i, animate: _a, exit: _e, transition: _t, ...rest } = props ?? {};
            void _i; void _a; void _e; void _t;
            const children = (props as { children?: unknown }).children;
            if (children !== undefined) return react.createElement(tag, { ...rest }, children);
            return react.createElement(tag, { ...rest });
          };
          cache.set(tag, comp);
        }
        return comp;
      },
    },
  );
  return {
    setReact(r: typeof react) { react = r; },
    motion,
    AnimatePresence: ({ children }: { children?: unknown }) => children ?? null,
  };
});

vi.mock('framer-motion', () => ({
  AnimatePresence: motionMock.AnimatePresence,
  motion: motionMock.motion,
  useReducedMotion: () => false,
}));

motionMock.setReact(React);

// ── Harness ────────────────────────────────────────────────────────────────────
type CompanionApi = ReturnType<typeof useCompanion>;
let api: CompanionApi;

function ApiProbe() {
  api = useCompanion();
  return null;
}

type SkillDriver = {
  onToken: (token: string) => void;
  onDone: () => void;
  onSkillCall: (call: LlmSkillCall) => void;
  onError: (message: string) => void;
};
let skills: SkillDriver | null = null;
/** The `stt:state` handler the entity's `useVoiceDictation` registered. */
let sttHandler: ((payload: unknown) => void) | null = null;

const OPEN_APP_CALL: LlmSkillCall = { skill: 'open_app', arguments: { app: 'Notepad' } };

const avatarState = (container: HTMLElement): string | null =>
  container.querySelector('.fredo-companion-avatar')?.getAttribute('data-state') ?? null;
const overlayState = (container: HTMLElement): string | null =>
  container.querySelector('#fredo-expression')?.getAttribute('data-state') ?? null;

async function mountEntity() {
  localStorage.clear();
  const ref = createRef<CompanionEntityHandle>();
  const view = renderWithChakra(
    React.createElement(
      CompanionProvider,
      null,
      React.createElement(CompanionEntity, { ref, surface: 'seat' }),
      React.createElement(ApiProbe, null),
    ),
  );
  await waitFor(() => {
    expect(api.idleTimeoutSeconds).toBe(60);
  });
  await act(async () => {});
  return { ref, container: view.container };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  skills = null;
  sttHandler = null;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  adapterBridge.setInvoke(async () => undefined);
  adapterBridge.setListen(async (event, handler) => {
    if (event === 'stt:state') sttHandler = handler as (payload: unknown) => void;
    return () => {};
  });
  adapterBridge.setLlmChat(async (_messages, onToken, onDone, onError) => {
    void onToken; void onDone; void onError;
  });
  adapterBridge.setLlmChatWithSkills(async (_messages, onToken, onDone, onSkillCall, onError) => {
    skills = { onToken, onDone, onSkillCall, onError: (message: string) => onError?.(message) };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe('#2917 ST-4 — new states at the consumer seam', () => {
  it('renders `listening` from the live voice-capture signal, with the overlay frame', async () => {
    const { container } = await mountEntity();
    vi.useFakeTimers();

    expect(sttHandler).not.toBeNull();
    act(() => {
      sttHandler?.({ listening: true, code: null, detail: null, origin: 'companion' });
    });

    expect(avatarState(container)).toBe('listening');
    expect(overlayState(container)).toBe('listening');
    expect(container.querySelectorAll('.fredo-listening-bar')).toHaveLength(3);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders `working` on a validated skill selection, then `happy` on the pushed settle', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.ask('open notepad'); });
    act(() => { (skills as unknown as SkillDriver).onSkillCall(OPEN_APP_CALL); });

    expect(avatarState(container)).toBe('working');
    expect(overlayState(container)).toBe('working');

    // FIX-1 (r2): the pushed settle first completes the bounded `working` beat,
    // THEN runs the shipped `happy` settle. (Refreshed from the round-1 assertion
    // that `happy` appeared in the same commit as the push — that sequencing is
    // exactly the RC-1 defect this fix removes. G-125.)
    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Notepad' }); });
    expect(avatarState(container)).toBe('working');
    act(() => { vi.advanceTimersByTime(WORKING_BEAT_MS); });
    expect(avatarState(container)).toBe('happy');
    expect(overlayState(container)).toBe('happy');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders `working` when the pushed reply arrives in the SAME dispatch as the selection (RC-1 race)', async () => {
    // Production ordering (RC-1): the app-open reply listener runs BEFORE the
    // per-generation `onSkillCall` listener, so the deterministic push can land
    // with NO prior `onSkillCall`. The push itself is the evidence a skill ran.
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => {
      ref.current?.ask('open notepad');
      // Same act()/dispatch as the selection — no onSkillCall call at all.
      pushAppOpenReply({ kind: 'success', text: 'Opening Notepad' });
    });

    expect(skills).not.toBeNull();
    // The zero-length window is gone: `working` commits before the settle.
    expect(avatarState(container)).toBe('working');
    expect(overlayState(container)).toBe('working');

    act(() => { vi.advanceTimersByTime(WORKING_BEAT_MS); });
    expect(avatarState(container)).toBe('happy');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps WORKING_BEAT_MS strictly below both settle holds (FIX-1 invariant)', () => {
    // HAPPY_HOLD_MS (5000) and ERROR_HOLD_MS (8000) are the shipped
    // module-private holds (CompanionEntity.tsx:49/:53); the display-only beat
    // must never outlast them, and it must exceed the app-open reply beat (800).
    expect(WORKING_BEAT_MS).toBe(900);
    expect(WORKING_BEAT_MS).toBeLessThan(5000);
    expect(WORKING_BEAT_MS).toBeLessThan(8000);
    expect(WORKING_BEAT_MS).toBeGreaterThan(800);
  });

  it('renders `error` on the typed error channel, held for the UNCHANGED ERROR_HOLD_MS', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.ask('open notepad'); });
    act(() => { (skills as unknown as SkillDriver).onError('the companion server returned HTTP 500'); });

    expect(avatarState(container)).toBe('error');
    expect(overlayState(container)).toBe('error');

    // The typed error leg is UNCHANGED by FIX-1 (no beat): the shipped 8 s hold
    // is still measured from the error event — 7999 ms error, 8000 ms idle.
    act(() => { vi.advanceTimersByTime(7999); });
    expect(avatarState(container)).toBe('error');
    act(() => { vi.advanceTimersByTime(1); });
    expect(avatarState(container)).toBe('idle');
    expect(overlayState(container)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders `error` on a non-success pushed app-open reply (never a bare idle)', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.ask('open narnia'); });
    act(() => { (skills as unknown as SkillDriver).onSkillCall(OPEN_APP_CALL); });
    act(() => { (skills as unknown as SkillDriver).onDone(); });
    act(() => {
      pushAppOpenReply({ kind: 'unknown', text: `I couldn't find "Narnia"` });
    });

    // FIX-1 (r2): the bounded `working` beat precedes the settle expression…
    expect(avatarState(container)).toBe('working');
    act(() => { vi.advanceTimersByTime(WORKING_BEAT_MS); });
    expect(avatarState(container)).toBe('error');
    expect(overlayState(container)).toBe('error');

    // …and the shipped ERROR_HOLD_MS is measured FROM THE SETTLE.
    act(() => { vi.advanceTimersByTime(7999); });
    expect(avatarState(container)).toBe('error');
    act(() => { vi.advanceTimersByTime(1); });
    expect(avatarState(container)).toBe('idle');
  });

  it('leaks no working-beat timer: a superseding generation clears it', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();
    act(() => { ref.current?.ask('open notepad'); });
    act(() => { (skills as unknown as SkillDriver).onSkillCall(OPEN_APP_CALL); });
    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Notepad' }); });
    expect(avatarState(container)).toBe('working');

    // A new generation supersedes the beat (clearTimer)…
    skills = null;
    act(() => { ref.current?.ask('hello again'); });
    expect(skills).not.toBeNull();
    // …so advancing past the beat + hold never plays the stale `happy` settle.
    act(() => { vi.advanceTimersByTime(WORKING_BEAT_MS + 5000); });
    expect(avatarState(container)).not.toBe('happy');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('leaks no working-beat timer: unmount clears it (no callback after cleanup)', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();
    act(() => { ref.current?.ask('open notepad'); });
    act(() => { (skills as unknown as SkillDriver).onSkillCall(OPEN_APP_CALL); });
    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Notepad' }); });
    expect(avatarState(container)).toBe('working');

    // The unmount cleanup calls `clearTimer`, which owns the beat timer.
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders `greeting` as a BOUNDED welcome beat, then the base `talk`, for an ambient message (FIX-4r3)', async () => {
    const { container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { api.showMessage(WELCOME_TEXT, 4000); });

    // t=0 — the bounded greeting beat (the round-1 expectation, unchanged).
    expect(avatarState(container)).toBe('greeting');
    expect(overlayState(container)).toBe('greeting');
    // The #2853 busy/presence marker is untouched; it now doubles as the
    // invariant across the beat (greeting → talk → idle all keep `animState` talk).
    expect(api.state.animState).toBe('talk');
    expect(screen.getByText(WELCOME_TEXT)).toBeInTheDocument();

    // FIX-4r3 NAMED REFRESH: at GREETING_BEAT_MS the SAME ambient message yields
    // to the base `talk` expression (the pre-#2917 reachability restored — the
    // round-1 pin asserted `greeting` for the whole window, which masked `talk`).
    act(() => { vi.advanceTimersByTime(GREETING_BEAT_MS); });
    expect(avatarState(container)).toBe('talk');
    expect(overlayState(container)).toBe('talk');
    expect(api.state.animState).toBe('talk');

    // AC2 static-frame expectation for the `talk` leg: the overlay group is
    // present and painted LAST; the persistent closed-mouth rect renders; the
    // streaming mark is ABSENT (so the open-mouth rect rests at opacity 0).
    const expression = container.querySelector("#fredo-expression[data-state='talk']");
    expect(expression).not.toBeNull();
    expect(expression!.querySelector('.fredo-talk-mouth-closed')).not.toBeNull();
    const wrapper = container.querySelector('.fredo-companion-avatar');
    expect(wrapper?.hasAttribute('data-streaming')).toBe(false);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.lastElementChild?.id).toBe('fredo-expression');

    // Still `talk` immediately before the message clears…
    act(() => { vi.advanceTimersByTime(3999 - GREETING_BEAT_MS); });
    expect(avatarState(container)).toBe('talk');

    // …and `idle` at the existing 4000 ms welcome window (message clear).
    act(() => { vi.advanceTimersByTime(1); });
    expect(avatarState(container)).toBe('idle');
    expect(overlayState(container)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps GREETING_BEAT_MS below the shortest shipped ambient window (FIX-4r3 invariant)', () => {
    // The 4000 ms welcome / dev-mode message is the shortest ambient window
    // (CompanionContext WELCOME_TEXT, Home.tsx dev-mode message); the bounded
    // welcome beat must complete well inside it.
    expect(GREETING_BEAT_MS).toBe(1500);
    expect(GREETING_BEAT_MS).toBeLessThan(4000);
  });

  it('re-arms the greeting beat on a replaced ambient message (FIX-4r3)', async () => {
    const { container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { api.showMessage(WELCOME_TEXT, 4000); });
    expect(avatarState(container)).toBe('greeting');
    act(() => { vi.advanceTimersByTime(GREETING_BEAT_MS); });
    expect(avatarState(container)).toBe('talk');

    // A REPLACE message (different text) re-arms the beat: greeting → talk again.
    act(() => { api.showMessage('Guide hello', 5000); });
    expect(avatarState(container)).toBe('greeting');
    act(() => { vi.advanceTimersByTime(GREETING_BEAT_MS); });
    expect(avatarState(container)).toBe('talk');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('leaks no greeting-beat timer: unmount during the active beat clears it (FIX-4r3)', async () => {
    const { container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { api.showMessage(WELCOME_TEXT, 4000); });
    expect(avatarState(container)).toBe('greeting');

    // The entity's unmount cleanup owns the greeting beat (`clearGreetingBeat`).
    // The context-owned `showMessage` dismiss timer is a SEPARATE, pre-existing
    // timer that is not part of the entity's cleanup contract, so pin the exact
    // delta rather than a bare 0: exactly one pending timer (the greeting beat)
    // is cleared on unmount.
    const pendingBeforeUnmount = vi.getTimerCount();
    expect(pendingBeforeUnmount).toBeGreaterThanOrEqual(1);
    cleanup();
    expect(vi.getTimerCount()).toBe(pendingBeforeUnmount - 1);
  });
});
