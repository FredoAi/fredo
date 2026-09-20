/**
 * #2883 ST-6 (AC4) — "a reply being read stays put".
 *
 * PRODUCT-UNIT PINS for the ONE hide gate (`replyProtection.ts` + the entity
 * wiring in `CompanionEntity.tsx`). The live legs (real pointer hover / real
 * focus mid-countdown on the served tip) are the tester's; these pin the
 * contract:
 *
 *   R-4.1 — a dismissal countdown that had ALREADY started is suspended when the
 *           pointer arrives, and never completes while the reply is held.
 *   R-4.2 — the clear is RE-ARMED on leave (a FRESH full 2000 ms; never resumed)
 *           and runs exactly then: present immediately after the leave, gone at
 *           `REPLY_LEAVE_GRACE_MS`.
 *   R-4.3 — keyboard focus protects INDEPENDENTLY of the pointer, and the grace
 *           starts only after the focus leaves.
 *   R-4.4 — while protected the entity reports `isInUse`, so the context's idle
 *           auto-return cannot unmount the seat mid-read; the gate re-arms after
 *           protection ends.
 *   a11y  — the wrapper's `aria-hidden` is dropped and it becomes a named
 *           `role="region"` + `tabIndex={0}` for the REPLY case only; the
 *           context-owned welcome bubble and the TicTacToe card are unaffected.
 *   a11y  — ONE polite announcement on the FIRST protection entry per
 *           generation (never per token, never on re-entry).
 */

import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  IDLE_TIMEOUT_SETTING_KEY,
  WELCOME_TEXT,
  useCompanion,
} from '@/shared/contexts/CompanionContext';
import { CompanionEntity } from '@/shared/components/companion/CompanionEntity';
import type { CompanionEntityHandle } from '@/shared/components/companion/CompanionEntity';
import {
  REPLY_LEAVE_GRACE_MS,
  REPLY_PROTECTION_ANNOUNCEMENT,
  protectionSurvivesLeave,
  shouldAnnounceProtection,
  useReplyProtection,
} from '@/shared/components/companion/replyProtection';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { LlmSkillCall } from '@/app/adapters/HostAdapter';

// ── Module mocks ───────────────────────────────────────────────────────────────
// framer-motion is replaced with plain elements (the bubble's spring is not under
// test here); the motion key/timing pins live in SpeechBubble.reducedMotion.test.
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

// ── Shared entity harness ──────────────────────────────────────────────────────

type CompanionApi = ReturnType<typeof useCompanion>;
let api: CompanionApi;

function ApiProbe() {
  api = useCompanion();
  return null;
}

/** The captured streaming callbacks of the ONE in-flight test generation. */
type LlmDriver = {
  onToken: (token: string) => void;
  onDone: () => void;
  onSkillCall: (call: LlmSkillCall) => void;
  onError: (message: string) => void;
};
let llm: LlmDriver | null = null;

const surfaceEl = (): HTMLElement => screen.getByTestId('fredo-companion-surface');
const surfaceText = (): string => surfaceEl().textContent ?? '';
const liveRegionText = (): string => screen.getByTestId('fredo-companion-live-region').textContent ?? '';

/**
 * Mount the real provider + the seat entity + an API probe. `waitFor` runs under
 * REAL timers (the persisted-setting load is async), so tests switch to fake
 * timers only after this resolves.
 */
async function mountEntity(seed: { visible?: boolean; timeoutS?: number } = {}) {
  localStorage.clear();
  if (seed.visible) localStorage.setItem('Fredo_companion_visible', 'true');
  if (seed.timeoutS) localStorage.setItem(IDLE_TIMEOUT_SETTING_KEY, String(seed.timeoutS));

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
    expect(api.idleTimeoutSeconds).toBe(seed.timeoutS ?? 60);
    if (seed.visible) expect(api.state.isVisible).toBe(true);
  });
  await act(async () => {});
  return { ref, container: view.container };
}

/** Start ONE bar generation and land its first token. */
function startGeneration(ref: React.RefObject<CompanionEntityHandle>, reply = 'Hi there!') {
  act(() => { ref.current?.ask('hello'); });
  expect(llm).not.toBeNull();
  act(() => { (llm as unknown as LlmDriver).onToken(reply); });
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  llm = null;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  adapterBridge.setInvoke(async () => undefined);
  adapterBridge.setListen(() => Promise.resolve(() => {}));
  adapterBridge.setLlmChat(async (_messages, onToken, onDone, onError) => {
    llm = {
      onToken,
      onDone,
      onSkillCall: () => {},
      onError: (message: string) => onError?.(message),
    };
  });
  // #2893 ST-7 — the bar's `ask` path is now skill-aware; the harness must
  // capture that driver too (the joke path above stays on `llmChat`).
  adapterBridge.setLlmChatWithSkills(async (_messages, onToken, onDone, onSkillCall, onError) => {
    llm = { onToken, onDone, onSkillCall, onError: (message: string) => onError?.(message) };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

// ── 1. The bound + the pure decisions ──────────────────────────────────────────

describe('#2883 ST-6 — replyProtection contract (AC4)', () => {
  it('binds REPLY_LEAVE_GRACE_MS = 2000 and the pure decisions', () => {
    expect(REPLY_LEAVE_GRACE_MS).toBe(2000);

    // R-4.3 — focus survives a pointer leave; the last live source ends it.
    expect(protectionSurvivesLeave(new Set(['pointer']), 'pointer')).toBe(false);
    expect(protectionSurvivesLeave(new Set(['focus']), 'focus')).toBe(false);
    expect(protectionSurvivesLeave(new Set(['pointer', 'focus']), 'pointer')).toBe(true);
    expect(protectionSurvivesLeave(new Set(['pointer', 'focus']), 'focus')).toBe(true);

    // ONE announcement on the FIRST entry per generation.
    expect(shouldAnnounceProtection(-1, 1)).toBe(true);
    expect(shouldAnnounceProtection(1, 1)).toBe(false);
    expect(shouldAnnounceProtection(1, 2)).toBe(true);
  });

  it('suspends a dismissal countdown that had already started (R-4.1)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection());
    const clear = vi.fn();

    act(() => { result.current.enter('pointer'); });
    expect(result.current.protected).toBe(true);
    expect(result.current.protectedRef.current).toBe(true);

    // The countdown comes due WHILE the pointer is over the reply.
    act(() => { result.current.clearOrDefer(clear); });
    expect(clear).not.toHaveBeenCalled();

    // …and it never completes for as long as the pointer stays.
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(clear).not.toHaveBeenCalled();
    expect(result.current.protected).toBe(true);
  });

  it('re-arms the clear on leave and dismisses exactly after the bound grace (R-4.2)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection());
    const clear = vi.fn();

    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { result.current.leave('pointer'); });

    // Present immediately after the leave; the grace protects a brief slip.
    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS - 1); });
    expect(clear).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result.current.protected).toBe(false);
    expect(result.current.protectedRef.current).toBe(false);
  });

  it('keeps protection alive when the pointer re-enters inside the grace', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection());
    const clear = vi.fn();

    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { result.current.leave('pointer'); });
    act(() => { vi.advanceTimersByTime(1500); });
    act(() => { result.current.enter('pointer'); });

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(clear).not.toHaveBeenCalled();
    expect(result.current.protected).toBe(true);

    act(() => { result.current.leave('pointer'); });
    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS); });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('a second leave restarts a FRESH grace — never resumes the suspended window', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection());
    const clear = vi.fn();

    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { result.current.leave('pointer'); });
    act(() => { vi.advanceTimersByTime(1500); });
    // Re-arm from NOW: the earlier 1500 ms must not count towards the new window.
    act(() => { result.current.leave('pointer'); });

    act(() => { vi.advanceTimersByTime(1500); });
    expect(clear).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS - 1500); });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('keyboard focus protects independently of the pointer (R-4.3)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection());
    const clear = vi.fn();

    // Focus alone — no pointer event anywhere.
    act(() => { result.current.enter('focus'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(clear).not.toHaveBeenCalled();
    expect(result.current.protected).toBe(true);

    // The pointer leaves while focus is still inside: the grace must NOT start.
    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.leave('pointer'); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(clear).not.toHaveBeenCalled();

    // Focus leaves → the fresh grace → clears.
    act(() => { result.current.leave('focus'); });
    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS); });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('reset() (a new generation) drops the suspended clear and ends protection', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection());
    const stale = vi.fn();

    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(stale); });
    act(() => { result.current.reset(); });

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(stale).not.toHaveBeenCalled();
    expect(result.current.protected).toBe(false);
    expect(result.current.protectedRef.current).toBe(false);
  });

  it('runs a clear immediately when the reply is not protected', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection());
    const clear = vi.fn();
    act(() => { result.current.clearOrDefer(clear); });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

// ── 1b. Configurable leave grace (#2892 ST-2) ─────────────────────────────────

describe('#2892 ST-2 — configurable reply hold-open grace (REQ-10/REQ-11)', () => {
  it('defaults the leave grace to REPLY_LEAVE_GRACE_MS when the parameter is omitted', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection());
    const clear = vi.fn();

    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { result.current.leave('pointer'); });

    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS - 1); });
    expect(clear).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit graceMs when arming the leave window', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection(5000));
    const clear = vi.fn();

    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { result.current.leave('pointer'); });

    act(() => { vi.advanceTimersByTime(4999); });
    expect(clear).not.toHaveBeenCalled();
    expect(result.current.protected).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result.current.protected).toBe(false);
  });

  it('does not retroactively re-time an armed window when graceMs changes mid-grace', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ graceMs }: { graceMs: number }) => useReplyProtection(graceMs),
      { initialProps: { graceMs: 2000 } },
    );
    const clear = vi.fn();

    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { result.current.leave('pointer'); });
    act(() => { vi.advanceTimersByTime(500); });

    // The setting drops to 100 ms WHILE the 2000 ms window is armed.
    act(() => { rerender({ graceMs: 100 }); });
    act(() => { vi.advanceTimersByTime(100); });
    // The armed window keeps its original delay: a mid-grace change cannot
    // shorten (or resurrect) it — only a NEW leave() may arm the new value.
    expect(clear).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2000 - 500 - 100); });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('arms a NEW leave with the current graceMs after a setting change', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ graceMs }: { graceMs: number }) => useReplyProtection(graceMs),
      { initialProps: { graceMs: 2000 } },
    );
    const clear = vi.fn();

    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { result.current.leave('pointer'); });
    act(() => { vi.advanceTimersByTime(500); });

    // Setting changes, then a fresh protection cycle: the NEXT leave arms 3000.
    act(() => { rerender({ graceMs: 3000 }); });
    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.leave('pointer'); });

    act(() => { vi.advanceTimersByTime(2999); });
    expect(clear).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('keeps the suspend/reset semantics under an explicit graceMs (REQ-11)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReplyProtection(4000));
    const clear = vi.fn();

    // R-4.1 — a due clear is suspended while protected, for any grace value.
    act(() => { result.current.enter('pointer'); });
    act(() => { result.current.clearOrDefer(clear); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(clear).not.toHaveBeenCalled();
    expect(result.current.protected).toBe(true);

    // reset() (a new generation) still drops the stashed clear and ends protection.
    act(() => { result.current.reset(); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(clear).not.toHaveBeenCalled();
    expect(result.current.protected).toBe(false);
    expect(result.current.protectedRef.current).toBe(false);
  });
});

// ── 2. Entity integration: the ONE gate, end to end ───────────────────────────

describe('#2883 ST-6 — CompanionEntity hide gate (AC4)', () => {
  it('the pointer over the reply suspends the due happy hold and releases after the grace (R-4.1/R-4.2)', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startGeneration(view.ref);
    act(() => { (llm as unknown as LlmDriver).onDone(); });
    expect(surfaceText()).toContain('Hi there!');

    // The pointer arrives mid-countdown, then the 5 s happy hold comes due.
    act(() => { fireEvent.pointerOver(surfaceEl()); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(surfaceText()).toContain('Hi there!');

    // Pointer leaves: present immediately, gone exactly at the bound grace.
    act(() => { fireEvent.pointerOut(surfaceEl()); });
    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS - 1); });
    expect(surfaceText()).toContain('Hi there!');
    act(() => { vi.advanceTimersByTime(1); });
    expect(surfaceText()).not.toContain('Hi there!');
  });

  it('keyboard focus alone protects the reply, and the grace starts only after focus leaves (R-4.3)', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    startGeneration(view.ref);
    act(() => { (llm as unknown as LlmDriver).onDone(); });

    // Focus — NO pointer event at all — holds the reply past the happy hold.
    act(() => { fireEvent.focusIn(surfaceEl()); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(surfaceText()).toContain('Hi there!');

    // A pointer that arrives and leaves does not release keyboard protection.
    act(() => { fireEvent.pointerOver(surfaceEl()); });
    act(() => { fireEvent.pointerOut(surfaceEl()); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(surfaceText()).toContain('Hi there!');

    // Focus leaves → the fresh grace → the reply dismisses.
    act(() => { fireEvent.focusOut(surfaceEl()); });
    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS); });
    expect(surfaceText()).not.toContain('Hi there!');
  });

  it('never reports isInUse=false mid-read: the idle auto-return cannot fire while protected (R-4.4)', async () => {
    const view = await mountEntity({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    startGeneration(view.ref);
    act(() => { (llm as unknown as LlmDriver).onDone(); });

    act(() => { fireEvent.pointerOver(surfaceEl()); });
    expect(api.state.isInUse).toBe(true);

    // Well past the 5 s idle deadline: suppressed, and the reply is still up.
    act(() => { vi.advanceTimersByTime(6000); });
    expect(api.state.isAutoReturning).toBe(false);
    expect(surfaceText()).toContain('Hi there!');

    // Release: the seat is no longer held, the reply clears, and the idle gate
    // re-arms for a full quiet period after protection ends.
    act(() => { fireEvent.pointerOut(surfaceEl()); });
    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS); });
    expect(api.state.isInUse).toBe(false);
    expect(surfaceText()).not.toContain('Hi there!');

    act(() => { vi.advanceTimersByTime(5000); });
    expect(api.state.isAutoReturning).toBe(true);
  });

  it('exposes the reply through AT: aria-hidden dropped, named region, focusable (a11y)', async () => {
    const view = await mountEntity();

    // Before any reply the wrapper stays decorative (today's handling).
    expect(surfaceEl().getAttribute('aria-hidden')).toBe('true');
    expect(surfaceEl().getAttribute('role')).toBeNull();
    expect(surfaceEl().getAttribute('tabindex')).toBeNull();

    startGeneration(view.ref);
    expect(surfaceEl().getAttribute('aria-hidden')).toBeNull();
    expect(surfaceEl().getAttribute('role')).toBe('region');
    expect(surfaceEl().getAttribute('aria-label')).toBe("Fredo's reply");
    expect(surfaceEl().getAttribute('tabindex')).toBe('0');
  });

  it('announces protection ONCE per generation — never per token, never on re-entry (a11y)', async () => {
    const view = await mountEntity();

    act(() => { view.ref.current?.ask('hello'); });
    act(() => { fireEvent.focusIn(surfaceEl()); });
    expect(liveRegionText()).toBe(REPLY_PROTECTION_ANNOUNCEMENT);

    // Tokens never announce.
    act(() => { (llm as unknown as LlmDriver).onToken('Hi there!'); });
    expect(liveRegionText()).toBe(REPLY_PROTECTION_ANNOUNCEMENT);

    // The settle announcement replaces it (the existing discrete announcement).
    act(() => { (llm as unknown as LlmDriver).onDone(); });
    expect(liveRegionText()).toBe('Hi there!');

    // Re-entry inside the SAME generation must not re-announce protection.
    act(() => { fireEvent.focusOut(surfaceEl()); });
    act(() => { fireEvent.focusIn(surfaceEl()); });
    expect(liveRegionText()).toBe('Hi there!');

    // A NEW generation announces again on its first protection entry.
    act(() => { view.ref.current?.ask('again'); });
    act(() => { fireEvent.focusOut(surfaceEl()); });
    act(() => { fireEvent.focusIn(surfaceEl()); });
    expect(liveRegionText()).toBe(REPLY_PROTECTION_ANNOUNCEMENT);
  });

  it('leaves the context-owned welcome bubble untouched (no region, ~4 s auto-hide as shipped)', async () => {
    await mountEntity();
    vi.useFakeTimers();

    act(() => { api.showMessage(WELCOME_TEXT, 4000); });
    expect(surfaceText()).toContain(WELCOME_TEXT);
    // The welcome is NOT AC4's reply: today's aria-hidden handling is kept…
    expect(surfaceEl().getAttribute('aria-hidden')).toBe('true');
    expect(surfaceEl().getAttribute('role')).toBeNull();
    expect(surfaceEl().getAttribute('tabindex')).toBeNull();

    // …and its context-owned ~4 s auto-hide is unchanged (protection never gates it).
    act(() => { vi.advanceTimersByTime(4000); });
    expect(surfaceText()).not.toContain(WELCOME_TEXT);
  });

  it('leaves the TicTacToe card handling unchanged (no reply region, board reachable)', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();

    const avatar = view.container.querySelector('.fredo-companion-avatar');
    expect(avatar).not.toBeNull();
    act(() => { fireEvent.click(avatar as HTMLElement); });
    act(() => { fireEvent.click(avatar as HTMLElement); });

    // The game case keeps today's handling: aria-hidden dropped for the board,
    // and NO reply region/focus target is invented.
    expect(surfaceEl().getAttribute('aria-hidden')).toBeNull();
    expect(surfaceEl().getAttribute('role')).toBeNull();
    expect(surfaceEl().getAttribute('tabindex')).toBeNull();
  });
});

describe('#2883 ST-6 — no console errors', () => {
  it('reports a clean console across the protection lifecycle', async () => {
    const view = await mountEntity();
    vi.useFakeTimers();
    startGeneration(view.ref);
    act(() => { (llm as unknown as LlmDriver).onDone(); });
    act(() => { fireEvent.pointerOver(surfaceEl()); });
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { fireEvent.pointerOut(surfaceEl()); });
    act(() => { vi.advanceTimersByTime(REPLY_LEAVE_GRACE_MS); });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
