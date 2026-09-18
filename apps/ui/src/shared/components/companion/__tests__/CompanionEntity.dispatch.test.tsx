/**
 * Spec #2892 ST-4 — CompanionEntity: truth split, grace wiring, acceptance,
 * queue, interrupt.
 *
 * PRODUCT-UNIT PINS for the core fix (the live legs are the tester's):
 *
 *   REQ-3  — `replyInFlight` is true iff a generation is genuinely in flight and
 *            clears at EVERY terminal path (onDone / onError / watchdog /
 *            pushed-skill settle), even with the pointer resting on the bubble.
 *   AC4    — a completed reply held by the pointer keeps `isInUse` true while
 *            `replyInFlight` stays false (the read-hold never enters the flag).
 *   REQ-5  — a send while generating under the persisted `queue` disposition is
 *            accepted with `{ outcome: 'queued', queuePosition, queueId }`, is
 *            mirrored to `queuedSendCount`, and is auto-dispatched FIFO on the
 *            next settle, exactly once.
 *   REQ-6  — the FIFO dequeues synchronously before its generation starts; each
 *            queued message produces exactly one generation.
 *   REQ-7  — `interrupt` supersedes the in-flight generation logically (its late
 *            callbacks and pending hold timer are invalidated) and dispatches
 *            the new message as the current generation.
 *   REQ-8  — `ask`/`askActiveCompanion` return the typed `CompanionSendResult`;
 *            `rejected` (teleport owns the entity) and no-entity are non-accepting.
 *   Defect — a superseded generation's 5 s happy-hold timer can never clear a
 *            newer generation (generation guard + `clearTimer()`).
 */

import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  COMPANION_SEND_DURING_REPLY_KEY,
  useCompanion,
} from '@/shared/contexts/CompanionContext';
import { askActiveCompanion, CompanionEntity } from '@/shared/components/companion/CompanionEntity';
import type { CompanionEntityHandle } from '@/shared/components/companion/CompanionEntity';
import type { CompanionSendResult } from '@/shared/components/companion/companionDispatch';
import { pushAppOpenReply } from '@/shared/components/companion/skillBridge';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { LlmSkillCall } from '@/app/adapters/HostAdapter';

// ── Module mocks (same shape as skillSettle.test.tsx) ─────────────────────────
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

type LlmDriver = {
  onToken: (token: string) => void;
  onDone: () => void;
  onSkillCall: (call: LlmSkillCall) => void;
  onError: (message: string) => void;
};

type Generation = { text: string; driver: LlmDriver };
let generations: Generation[] = [];

const lastGen = (): Generation => generations[generations.length - 1];

const surfaceEl = (): HTMLElement => screen.getByTestId('fredo-companion-surface');
const surfaceText = (): string => surfaceEl().textContent ?? '';

const OPEN_APP_CALL: LlmSkillCall = { skill: 'open_app', arguments: { app: 'Mission Monitor' } };

async function mountEntity(seed: { sendDuringReply?: 'queue' | 'interrupt' } = {}) {
  localStorage.clear();
  if (seed.sendDuringReply) {
    localStorage.setItem(COMPANION_SEND_DURING_REPLY_KEY, seed.sendDuringReply);
  }
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
    if (seed.sendDuringReply) expect(api.sendDuringReply).toBe(seed.sendDuringReply);
  });
  await act(async () => {});
  return { ref, view };
}

/** Call `ask` synchronously inside `act` and return its typed result. */
function askNow(ref: React.RefObject<CompanionEntityHandle>, text: string): CompanionSendResult {
  let result: CompanionSendResult | undefined;
  act(() => { result = ref.current?.ask(text); });
  return result as CompanionSendResult;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  generations = [];
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  adapterBridge.setInvoke(async () => undefined);
  adapterBridge.setListen(() => Promise.resolve(() => {}));
  adapterBridge.setLlmChat(async (_messages, onToken, onDone, onError) => {
    generations.push({
      text: 'joke',
      driver: { onToken, onDone, onSkillCall: () => {}, onError: (m: string) => onError?.(m) },
    });
  });
  adapterBridge.setLlmChatWithSkills(async (messages, onToken, onDone, onSkillCall, onError) => {
    const last = messages[messages.length - 1] as { content: string };
    generations.push({
      text: last.content,
      driver: { onToken, onDone, onSkillCall, onError: (m: string) => onError?.(m) },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

// ── REQ-3 / AC4 — the truth split ──────────────────────────────────────────────

describe('#2892 ST-4 — replyInFlight truth vs isInUse read-hold', () => {
  it('reports replyInFlight true while streaming, false at onDone, while a held reply keeps isInUse true', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();
    expect(api.replyInFlight).toBe(false);

    const result = askNow(ref, 'hello');
    expect(result).toEqual({ outcome: 'dispatched' });
    expect(api.replyInFlight).toBe(true);

    act(() => { lastGen().driver.onToken('Hi there!'); });
    expect(api.replyInFlight).toBe(true);

    act(() => { lastGen().driver.onDone(); });
    expect(api.replyInFlight).toBe(false);
    expect(surfaceText()).toContain('Hi there!');

    // AC2/AC4 — hovering the completed reply never enters replyInFlight, and the
    // read-hold keeps `isInUse` true (idle auto-return stays suppressed).
    act(() => { fireEvent.pointerOver(surfaceEl()); });
    expect(api.replyInFlight).toBe(false);
    expect(api.state.isInUse).toBe(true);
  });

  it('clears replyInFlight on the error settle (llm-error + follow-up llm-done)', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();

    askNow(ref, 'boom');
    expect(api.replyInFlight).toBe(true);

    act(() => { lastGen().driver.onError('the companion server returned HTTP 500'); });
    expect(api.replyInFlight).toBe(false);

    // The transport's follow-up llm-done must not re-open the flag.
    act(() => { lastGen().driver.onDone(); });
    expect(api.replyInFlight).toBe(false);
  });

  it('clears replyInFlight on the watchdog backstop', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();

    askNow(ref, 'stuck');
    expect(api.replyInFlight).toBe(true);

    act(() => { vi.advanceTimersByTime(15_000); });
    expect(api.replyInFlight).toBe(false);
  });

  it('clears replyInFlight on the pushed-skill settle path', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();

    askNow(ref, 'open Mission Monitor');
    act(() => { lastGen().driver.onSkillCall(OPEN_APP_CALL); });
    expect(api.replyInFlight).toBe(true);

    // The settle is DEFERRED while the skill reply is pending.
    act(() => { lastGen().driver.onDone(); });
    expect(api.replyInFlight).toBe(true);

    act(() => { pushAppOpenReply({ kind: 'success', text: 'Opening Mission Monitor' }); });
    expect(api.replyInFlight).toBe(false);
  });
});

// ── REQ-5/REQ-6 — acceptance + FIFO queue ──────────────────────────────────────

describe('#2892 ST-4 — send acceptance + FIFO queue', () => {
  it('returns dispatched when idle and starts the generation', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();

    const result = askNow(ref, 'alpha');
    expect(result).toEqual({ outcome: 'dispatched' });
    expect(generations.map((g) => g.text)).toEqual(['alpha']);
    expect(api.queuedSendCount).toBe(0);
  });

  it('queues while generating under the default disposition and mirrors queuedSendCount', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();

    expect(askNow(ref, 'alpha')).toEqual({ outcome: 'dispatched' });
    expect(api.replyInFlight).toBe(true);
    expect(api.queuedSendCount).toBe(0);

    const second = askNow(ref, 'beta');
    expect(second.outcome).toBe('queued');
    expect(second.queuePosition).toBe(1);
    expect(typeof second.queueId).toBe('string');
    expect((second.queueId as string).length).toBeGreaterThan(0);
    expect(api.queuedSendCount).toBe(1);

    const third = askNow(ref, 'gamma');
    expect(third.outcome).toBe('queued');
    expect(third.queuePosition).toBe(2);
    expect(third.queueId).not.toBe(second.queueId);
    expect(api.queuedSendCount).toBe(2);

    // No extra generation started while queueing.
    expect(generations.map((g) => g.text)).toEqual(['alpha']);
  });

  it('drains the FIFO on settle, dispatching each queued message exactly once', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();

    askNow(ref, 'alpha');
    askNow(ref, 'beta');
    askNow(ref, 'gamma');
    expect(generations.map((g) => g.text)).toEqual(['alpha']);
    expect(api.queuedSendCount).toBe(2);

    act(() => { lastGen().driver.onToken('reply alpha'); });
    act(() => { lastGen().driver.onDone(); });

    // beta dispatched exactly once, count decremented.
    expect(generations.map((g) => g.text)).toEqual(['alpha', 'beta']);
    expect(api.queuedSendCount).toBe(1);

    act(() => { lastGen().driver.onToken('reply beta'); });
    act(() => { lastGen().driver.onDone(); });

    expect(generations.map((g) => g.text)).toEqual(['alpha', 'beta', 'gamma']);
    expect(api.queuedSendCount).toBe(0);

    act(() => { lastGen().driver.onToken('reply gamma'); });
    act(() => { lastGen().driver.onDone(); });

    // The final settle does not dispatch anything twice.
    expect(generations.map((g) => g.text)).toEqual(['alpha', 'beta', 'gamma']);
    expect(api.queuedSendCount).toBe(0);
  });
});

// ── REQ-7 — interrupt + the declared defect fix ───────────────────────────────

describe('#2892 ST-4 — interrupt supersession + stale-timer guard', () => {
  it('interrupt disposition supersedes the in-flight generation and returns dispatched', async () => {
    const { ref } = await mountEntity({ sendDuringReply: 'interrupt' });
    vi.useFakeTimers();

    askNow(ref, 'first');
    expect(generations).toHaveLength(1);
    const firstDriver = lastGen().driver;
    act(() => { firstDriver.onToken('partial first'); });
    expect(surfaceText()).toContain('partial first');

    const result = askNow(ref, 'INTERRUPTED');
    expect(result).toEqual({ outcome: 'dispatched' });
    expect(generations).toHaveLength(2);
    expect(lastGen().text).toBe('INTERRUPTED');
    expect(api.queuedSendCount).toBe(0);

    // The superseded generation's late callbacks are invalidated.
    act(() => { firstDriver.onToken(' stale'); });
    expect(surfaceText()).not.toContain('stale');
    act(() => { firstDriver.onDone(); });
    expect(api.replyInFlight).toBe(true);

    act(() => { lastGen().driver.onToken('INTERRUPTED'); });
    act(() => { lastGen().driver.onDone(); });
    expect(surfaceText()).toContain('INTERRUPTED');
    expect(api.replyInFlight).toBe(false);
  });

  it('a superseded happy-hold timer cannot clear a newer generation (declared defect fix)', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();

    askNow(ref, 'first');
    act(() => { lastGen().driver.onToken('first reply'); });
    act(() => { lastGen().driver.onDone(); });
    expect(surfaceText()).toContain('first reply');

    // A new send inside the first generation's 5 s happy hold owns the bubble.
    askNow(ref, 'second');
    act(() => { lastGen().driver.onToken('second reply'); });
    expect(surfaceText()).toContain('second reply');

    // Past the FIRST generation's deadline: the stale 5 s hold must not clear it.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(surfaceText()).toContain('second reply');
    expect(api.replyInFlight).toBe(true);

    // Its OWN settle + hold clears it exactly as shipped.
    act(() => { lastGen().driver.onDone(); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(surfaceText()).not.toContain('second reply');
  });

  it('completes an interrupt cleanly while a superseded hold timer is pending', async () => {
    const { ref } = await mountEntity({ sendDuringReply: 'interrupt' });
    vi.useFakeTimers();

    askNow(ref, 'first');
    act(() => { lastGen().driver.onToken('first reply'); });
    act(() => { lastGen().driver.onDone(); }); // arms a happy hold, then…
    askNow(ref, 'second'); // …a fresh send supersedes it (clearTimer + guard)

    act(() => { lastGen().driver.onToken('second reply'); });
    act(() => { lastGen().driver.onDone(); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(surfaceText()).not.toContain('second reply');
    expect(consoleError).not.toHaveBeenCalled();
  });
});

// ── REQ-8 — result shape + no-entity + unmount ────────────────────────────────

describe('#2892 ST-4 — result shape, no-entity, unmount drop', () => {
  it('askActiveCompanion returns null with no entity and the typed result with one', async () => {
    expect(askActiveCompanion('x')).toBeNull();

    const { ref } = await mountEntity();
    vi.useFakeTimers();

    let result: CompanionSendResult | null = null;
    act(() => { result = askActiveCompanion('hello'); });
    expect(result).toEqual({ outcome: 'dispatched' });
    expect(ref.current).not.toBeNull();
  });

  it('returns rejected while a teleport owns the entity (never a silent drop)', async () => {
    const { ref } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.teleportTo({ x: 10, y: 10 }); });
    const result = askNow(ref, 'hello');
    expect(result).toEqual({ outcome: 'rejected' });
    expect(generations).toHaveLength(0);
    expect(api.queuedSendCount).toBe(0);
  });

  it('drops the FIFO and clears the mirrored signals on unmount (cross-seat durability out of scope)', async () => {
    localStorage.clear();
    const ref = createRef<CompanionEntityHandle>();

    function Harness({ show }: { show: boolean }) {
      return React.createElement(
        CompanionProvider,
        null,
        show ? React.createElement(CompanionEntity, { ref, surface: 'seat' }) : null,
        React.createElement(ApiProbe, null),
      );
    }

    const view = renderWithChakra(React.createElement(Harness, { show: true }));
    await waitFor(() => { expect(api.idleTimeoutSeconds).toBe(60); });
    await act(async () => {});
    vi.useFakeTimers();

    askNow(ref, 'alpha');
    askNow(ref, 'beta');
    expect(api.queuedSendCount).toBe(1);
    expect(api.replyInFlight).toBe(true);

    act(() => { view.rerender(React.createElement(Harness, { show: false })); });
    expect(api.queuedSendCount).toBe(0);
    expect(api.replyInFlight).toBe(false);
    expect(askActiveCompanion('later')).toBeNull();
  });
});
