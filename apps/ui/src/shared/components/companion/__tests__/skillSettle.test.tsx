/**
 * Spec #2893 ST-7 — the Companion's skill-call handling + settle routing.
 *
 * PRODUCT-UNIT PINS for the skill-aware `ask` path in `CompanionEntity.tsx`:
 *
 *   R-1.1/R-1.3 — a validated `open_app` selection is marked skill-pending and its
 *                 deterministic reply (pushed by ST-6's `useAppOpenRequests` hook
 *                 through the module-scoped `skillBridge`) is applied to the SAME
 *                 `streamingMessage` / `streamingTextRef` / live-region channel the
 *                 streamed reply uses; success settles with the shipped `happy`
 *                 beat (`HAPPY_HOLD_MS`).
 *   R-1.4      — the settle is DEFERRED until the pushed reply lands; when it never
 *                 lands the shipped `SAFETY_TIMEOUT_MS` watchdog backstop still
 *                 returns the Companion to rest (never stuck).
 *   R-4.3      — a non-success reply (unknown/ambiguous/failed) settles `idle`
 *                 with the shipped `ERROR_HOLD_MS` hold — never a `happy` beat.
 *   R-3.6      — a plain content stream (no selection) settles exactly as today and
 *                 never renders raw tool-call JSON.
 */

import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider, useCompanion } from '@/shared/contexts/CompanionContext';
import { CompanionEntity } from '@/shared/components/companion/CompanionEntity';
import type { CompanionEntityHandle } from '@/shared/components/companion/CompanionEntity';
import { pushAppOpenReply } from '@/shared/components/companion/skillBridge';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { LlmSkillCall } from '@/app/adapters/HostAdapter';

// ── Module mocks (same shape as replyProtection.test.ts) ───────────────────────
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

/** The captured callbacks of the ONE in-flight skill-aware generation. */
type SkillDriver = {
  onToken: (token: string) => void;
  onDone: () => void;
  onSkillCall: (call: LlmSkillCall) => void;
  onError: (message: string) => void;
};
let skills: SkillDriver | null = null;

const OPEN_APP_CALL: LlmSkillCall = { skill: 'open_app', arguments: { app: 'Mission Monitor' } };

const surfaceEl = (): HTMLElement => screen.getByTestId('fredo-companion-surface');
const surfaceText = (): string => surfaceEl().textContent ?? '';
const liveRegionText = (): string => screen.getByTestId('fredo-companion-live-region').textContent ?? '';
const avatarState = (container: HTMLElement): string | null =>
  container.querySelector('.fredo-companion-avatar')?.getAttribute('data-state') ?? null;

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

/** Start a skill-aware generation and mark it skill-pending. */
function startSkillGeneration(ref: React.RefObject<CompanionEntityHandle>) {
  act(() => { ref.current?.ask('open Mission Monitor'); });
  expect(skills).not.toBeNull();
  act(() => { (skills as unknown as SkillDriver).onSkillCall(OPEN_APP_CALL); });
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  skills = null;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  adapterBridge.setInvoke(async () => undefined);
  adapterBridge.setListen(() => Promise.resolve(() => {}));
  adapterBridge.setLlmChat(async (_messages, onToken, onDone, onError) => {
    // The joke path stays on llmChat; only its callbacks are captured.
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

describe('#2893 ST-7 — companion skill-call settle routing', () => {
  it('defers the settle on llm-skill-call, then applies the pushed success reply on the happy beat', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startSkillGeneration(view.ref);

    // Raw tool-call JSON is NEVER rendered — the thinking placeholder stays.
    expect(surfaceText()).toContain('Thinking');
    expect(surfaceText()).not.toContain('open_app');
    expect(surfaceText()).not.toContain('"app"');

    // The backend follows with llm-done: the settle is DEFERRED (skill-pending).
    act(() => { (skills as unknown as SkillDriver).onDone(); });
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(surfaceText()).toContain('Thinking');
    expect(surfaceText()).not.toContain('Opening Mission Monitor');
    expect(avatarState(view.container)).not.toBe('happy');

    // The deterministic reply lands → applied to the existing reply channel.
    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Mission Monitor' }); });
    expect(surfaceText()).toBe('Opening Mission Monitor');
    expect(avatarState(view.container)).toBe('happy');
    expect(liveRegionText()).toBe('Opening Mission Monitor');

    // Shipped HAPPY_HOLD_MS clears it.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(surfaceText()).not.toContain('Opening Mission Monitor');
  });

  it('the watchdog backstop settles a skill-pending generation when no reply ever arrives (R-1.4)', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startSkillGeneration(view.ref);
    act(() => { (skills as unknown as SkillDriver).onDone(); });

    // Nothing arrives: still thinking just before the bound…
    act(() => { vi.advanceTimersByTime(14_999); });
    expect(surfaceText()).toContain('Thinking');

    // …and the shipped 15 s watchdog returns the Companion to rest.
    act(() => { vi.advanceTimersByTime(1); });
    expect(surfaceText()).not.toContain('Thinking');
    expect(avatarState(view.container)).not.toBe('happy');
    const avatar = view.container.querySelector('.fredo-companion-avatar');
    expect(avatar?.hasAttribute('data-streaming')).toBe(false);
  });

  it('a stale push after the watchdog is a safe no-op', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startSkillGeneration(view.ref);
    act(() => { (skills as unknown as SkillDriver).onDone(); });
    act(() => { vi.advanceTimersByTime(15_000); });

    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Mission Monitor' }); });
    expect(surfaceText()).not.toContain('Opening Mission Monitor');
  });

  it.each([
    ['unknown', `I couldn't find "Narnia"`],
    [
      'ambiguous',
      'I found more than one app matching "monitor". Which one did you mean: Mission Monitor or Monitor Two?',
    ],
    ['failed', `I couldn't open Mission Monitor. Try again from the launcher grid.`],
  ] as const)(
    'a %s reply settles on idle (no happy beat) with the error hold',
    async (kind, text) => {
      const view = await mountEntity();
      vi.useFakeTimers();

      startSkillGeneration(view.ref);
      act(() => { (skills as unknown as SkillDriver).onDone(); });
      act(() => { pushAppOpenReply({ kind, text }); });

      expect(surfaceText()).toBe(text);
      expect(avatarState(view.container)).not.toBe('happy');

      // Shipped ERROR_HOLD_MS clears it (8 s > the 5 s happy hold).
      act(() => { vi.advanceTimersByTime(7999); });
      expect(surfaceText()).toBe(text);
      act(() => { vi.advanceTimersByTime(1); });
      expect(surfaceText()).toBe('');
    },
  );

  it('a plain content stream never shows tool-call JSON and settles happy as today (R-3.6)', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    act(() => { view.ref.current?.ask('what is the weather'); });
    expect(skills).not.toBeNull();

    act(() => { (skills as unknown as SkillDriver).onToken('Hello there'); });
    act(() => { (skills as unknown as SkillDriver).onDone(); });

    expect(surfaceText()).toBe('Hello there');
    expect(surfaceText()).not.toContain('open_app');
    expect(surfaceText()).not.toContain('{');
    expect(avatarState(view.container)).toBe('happy');
    expect(liveRegionText()).toBe('Hello there');
  });

  it('reports a clean console across the skill settle lifecycle', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startSkillGeneration(view.ref);
    act(() => { (skills as unknown as SkillDriver).onDone(); });
    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Mission Monitor' }); });
    act(() => { vi.advanceTimersByTime(5000); });

    expect(consoleError).not.toHaveBeenCalled();
  });
});
