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
import { CompanionEntity, WORKING_BEAT_MS } from '@/shared/components/companion/CompanionEntity';
import type { CompanionEntityHandle } from '@/shared/components/companion/CompanionEntity';
import { pushAppOpenReply, registerAppOpenReplyPusher } from '@/shared/components/companion/skillBridge';
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
  // #2918 ST-5 — the structured-status transport is now the ONE generation route
  // (joke / typed ask / dictation). The skill-aware generation's callbacks are
  // captured here verbatim; every shipped per-generation assertion is unchanged.
  adapterBridge.setLlmChatWithStatus(async (_messages, _options, onToken, onDone, _onStatus, onSkillCall, onError) => {
    skills = { onToken, onDone, onSkillCall: (c: LlmSkillCall) => onSkillCall?.(c), onError: (message: string) => onError?.(message) };
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
    // FIX-1 (r2): the pushed settle completes the bounded `working` beat BEFORE
    // the shipped `happy` expression (the round-1 immediate-happy sequencing was
    // exactly the RC-1 defect the fix removes). Refreshed, not weakened. G-125.
    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Mission Monitor' }); });
    expect(surfaceText()).toBe('Opening Mission Monitor');
    expect(avatarState(view.container)).toBe('working');
    expect(liveRegionText()).toBe('Opening Mission Monitor');

    // Completing the beat renders the shipped `happy` settle.
    act(() => { vi.advanceTimersByTime(WORKING_BEAT_MS); });
    expect(avatarState(view.container)).toBe('happy');

    // Shipped HAPPY_HOLD_MS clears it (measured from the settle).
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
      // FIX-1 (r2): the pushed settle renders the bounded `working` beat first…
      expect(avatarState(view.container)).toBe('working');

      // …then the shipped `error` expression for ERROR_HOLD_MS, measured from the
      // settle (8 s > the 5 s happy hold). Refreshed, not weakened. G-125.
      act(() => { vi.advanceTimersByTime(WORKING_BEAT_MS); });
      expect(avatarState(view.container)).not.toBe('happy');
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

/**
 * Spec #2893 ST-9 — the continuous invariant: ALWAYS settle / never stuck
 * (`R-1.4`, AC-1). These pins drive every failure branch of a skill-aware
 * generation and assert the Companion returns to rest: `isStreaming` off (the
 * avatar's `data-streaming` mark), the context's `isInUse` cleared (which holds
 * the launcher bar's `aria-busy`), and the single-in-flight guard released so a
 * later `ask` can start a NEW generation.
 */
describe('#2893 ST-9 — always settle / never stuck (R-1.4)', () => {
  const streamingMark = (container: HTMLElement): boolean =>
    container.querySelector('.fredo-companion-avatar')?.hasAttribute('data-streaming') ?? false;

  it('re-arms the watchdog backstop when a content token preceded the skill selection', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    act(() => { view.ref.current?.ask('open Mission Monitor'); });
    // A preamble / reasoning token clears the shipped first-token watchdog …
    act(() => { (skills as unknown as SkillDriver).onToken('Sure, let me '); });
    // … then the model selects open_app and the backend settles with llm-done.
    act(() => { (skills as unknown as SkillDriver).onSkillCall(OPEN_APP_CALL); });
    act(() => { (skills as unknown as SkillDriver).onDone(); });

    expect(surfaceText()).toContain('Sure, let me');
    expect(api.state.isInUse).toBe(true);

    // No pushed reply ever lands: the RE-ARMED shipped watchdog still settles.
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(surfaceText()).not.toContain('Sure, let me');
    expect(api.state.isInUse).toBe(false);
    expect(streamingMark(view.container)).toBe(false);
  });

  it('releases isInFlight/busy after a pushed success reply and accepts a later ask', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startSkillGeneration(view.ref);
    act(() => { (skills as unknown as SkillDriver).onDone(); });
    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Mission Monitor' }); });

    expect(api.state.isInUse).toBe(false);
    expect(streamingMark(view.container)).toBe(false);
    // FIX-1 (r2): the bounded `working` beat precedes the shipped `happy` settle.
    expect(avatarState(view.container)).toBe('working');
    act(() => { vi.advanceTimersByTime(WORKING_BEAT_MS); });
    expect(avatarState(view.container)).toBe('happy');

    // The single-in-flight guard is released: a later ask runs a NEW generation.
    skills = null;
    act(() => { view.ref.current?.ask('hello again'); });
    expect(skills).not.toBeNull();
    expect(surfaceText()).toContain('Thinking');
  });

  it('releases isInFlight/busy after a non-success reply and accepts a later ask', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startSkillGeneration(view.ref);
    act(() => { (skills as unknown as SkillDriver).onDone(); });
    act(() => {
      pushAppOpenReply({
        kind: 'failed',
        text: `I couldn't open Mission Monitor. Try again from the launcher grid.`,
      });
    });

    expect(api.state.isInUse).toBe(false);
    expect(streamingMark(view.container)).toBe(false);
    expect(avatarState(view.container)).not.toBe('happy');

    skills = null;
    act(() => { view.ref.current?.ask('hello again'); });
    expect(skills).not.toBeNull();
  });

  it('settles and clears busy on the backend failure path (llm-error then llm-done)', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    act(() => { view.ref.current?.ask('open Mission Monitor'); });
    act(() => {
      (skills as unknown as SkillDriver).onError('the companion server returned HTTP 500');
    });
    // The transport's follow-up llm-done must not re-settle or re-play a beat.
    act(() => { (skills as unknown as SkillDriver).onDone(); });

    expect(api.state.isInUse).toBe(false);
    expect(streamingMark(view.container)).toBe(false);
    expect(avatarState(view.container)).not.toBe('happy');

    skills = null;
    act(() => { view.ref.current?.ask('hello again'); });
    expect(skills).not.toBeNull();
  });

  it('a throwing pusher leaves the generation to the watchdog backstop (never stuck)', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startSkillGeneration(view.ref);
    act(() => { (skills as unknown as SkillDriver).onDone(); });

    // A pusher whose resolve throws: the bridge contains it, so nothing applies.
    const off = registerAppOpenReplyPusher(() => {
      throw new Error('the resolve threw');
    });
    expect(() =>
      pushAppOpenReply({ kind: 'success', text: 'Opening Mission Monitor' }),
    ).not.toThrow();
    off();
    expect(surfaceText()).toContain('Thinking');

    // The shipped watchdog is still the backstop: the Companion returns to rest.
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(surfaceText()).not.toContain('Thinking');
    expect(api.state.isInUse).toBe(false);
    expect(streamingMark(view.container)).toBe(false);
  });

  it('reports a clean console across the ST-9 termination paths', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    act(() => { view.ref.current?.ask('open Mission Monitor'); });
    act(() => { (skills as unknown as SkillDriver).onToken('preamble '); });
    act(() => { (skills as unknown as SkillDriver).onSkillCall(OPEN_APP_CALL); });
    act(() => { (skills as unknown as SkillDriver).onDone(); });
    act(() => { vi.advanceTimersByTime(15_000); });

    expect(consoleError).not.toHaveBeenCalled();
  });
});
