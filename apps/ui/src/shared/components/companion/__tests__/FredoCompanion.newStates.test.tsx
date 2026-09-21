/**
 * #2917 ST-4 / ST-5 — the four NEW status states at the CONSUMER seam.
 *
 * Drives the REAL `CompanionEntity` through each new state's product trigger and
 * pins the consumer wrapper's `data-state` + the shared overlay's rendered
 * `#fredo-expression[data-state]`:
 *   - `listening` ← the live voice-capture signal (`stt:state { listening: true }`)
 *   - `working`   ← a validated skill selection (`onSkillCall`), then superseded
 *                   by the pushed settle (`happy`)
 *   - `error`     ← the typed `onError` channel AND the non-success app-open
 *                   reply, held for the UNCHANGED `ERROR_HOLD_MS`
 *   - `greeting`  ← an ambient context message with no generation in flight,
 *                   while the context `animState` STAYS `talk`
 *
 * The existing per-state `data-state` pins (devMode / seatTeleport / crossWindow /
 * skillSettle) are NOT modified by this file.
 */

import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider, useCompanion, WELCOME_TEXT } from '@/shared/contexts/CompanionContext';
import { CompanionEntity } from '@/shared/components/companion/CompanionEntity';
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

    // The settle path supersedes the pending-skill expression.
    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Notepad' }); });
    expect(avatarState(container)).toBe('happy');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders `error` on the typed error channel, held for the UNCHANGED ERROR_HOLD_MS', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.ask('open notepad'); });
    act(() => { (skills as unknown as SkillDriver).onError('the companion server returned HTTP 500'); });

    expect(avatarState(container)).toBe('error');
    expect(overlayState(container)).toBe('error');

    // The shipped 8 s hold is unchanged: still `error` at 7999 ms, idle at 8000.
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

    expect(avatarState(container)).toBe('error');
    expect(overlayState(container)).toBe('error');

    act(() => { vi.advanceTimersByTime(8000); });
    expect(avatarState(container)).toBe('idle');
  });

  it('renders `greeting` for an ambient message while the context animState STAYS talk', async () => {
    const { container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { api.showMessage(WELCOME_TEXT, 4000); });

    expect(avatarState(container)).toBe('greeting');
    expect(overlayState(container)).toBe('greeting');
    // The #2853 busy/presence marker is untouched.
    expect(api.state.animState).toBe('talk');
    expect(screen.getByText(WELCOME_TEXT)).toBeInTheDocument();

    // The existing 4000 ms welcome window returns to idle.
    act(() => { vi.advanceTimersByTime(4000); });
    expect(avatarState(container)).toBe('idle');
    expect(consoleError).not.toHaveBeenCalled();
  });
});
