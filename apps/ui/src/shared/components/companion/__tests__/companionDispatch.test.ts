/**
 * Spec #2892 ST-3 — product-unit pins for the ONE pure dispatch contract.
 *
 * Deterministic, no React harness: `companionDispatch.ts` is pure, so every
 * guarantee REQ-5/REQ-6/REQ-7 relies on is asserted directly:
 *
 *   REQ-5 — accepted sends are FIFO; the bar's waiting copy/count derivation.
 *   REQ-6 — `resolveSendOutcome` is the ONE decision table (queue vs interrupt
 *           while generating; dispatch otherwise).
 *   REQ-7 — exactly-once: `dequeue()` removes synchronously and returns the
 *           exact item, so it can never be dispatched twice; `enqueue` always
 *           accepts (never throws / never returns `rejected`).
 *   REQ-12 — the bound copy + testid constants.
 *
 * The live legs (real rapid sends against a served app) are the tester's; these
 * pin the contract the entity/launcher consume.
 */
import { describe, it, expect } from 'vitest';

import {
  QUEUED_WAITING_COPY,
  QUEUED_WAITING_TESTID,
  buildCompanionTurnMessages,
  companionGroundingContent,
  createCompanionSendQueue,
  queuedWaitingCopy,
  resolveSendOutcome,
} from '../companionDispatch';
import { CAPABILITY_LIMITS } from '../../../navigation/types';
import type { ContextEnvelope } from '../../../navigation/types';

const PERSONA = 'You are Fredo, a friendly, concise desktop assistant.';

/** #3120 ST-3 — a minimal envelope used as the exact grounding payload. */
function makeContext(overrides: Partial<ContextEnvelope> = {}): ContextEnvelope {
  return {
    version: 1,
    appId: 'wireframe',
    placePath: [{ id: 'root', label: 'Wireframe', transient: false, sticky: true }],
    selection: { count: 0, kinds: [], label: null, ids: [] },
    verbs: [],
    journal: { last: [], undoableCount: 0 },
    dirty: false,
    limits: CAPABILITY_LIMITS,
    ...overrides,
  };
}

// ── createCompanionSendQueue — FIFO + exactly-once (REQ-5/REQ-7) ──────────────

describe('createCompanionSendQueue — FIFO append + exactly-once dequeue', () => {
  it('reports a 1-based position and a fresh id for every enqueue', () => {
    const queue = createCompanionSendQueue();

    const first = queue.enqueue('alpha');
    const second = queue.enqueue('beta');
    const third = queue.enqueue('gamma');

    expect(first.outcome).toBe('queued');
    expect(first.queuePosition).toBe(1);
    expect(second.queuePosition).toBe(2);
    expect(third.queuePosition).toBe(3);

    expect(typeof first.queueId).toBe('string');
    expect(first.queueId).not.toBe('');
    expect(second.queueId).not.toBe('');
    expect(third.queueId).not.toBe('');

    // The exactly-once witness is unique per enqueue.
    expect(new Set([first.queueId, second.queueId, third.queueId]).size).toBe(3);
  });

  it('dequeues in FIFO order and carries the enqueued text', () => {
    const queue = createCompanionSendQueue();
    const alpha = queue.enqueue('alpha');
    const beta = queue.enqueue('beta');
    const gamma = queue.enqueue('gamma');

    expect(queue.dequeue()).toEqual({ id: alpha.queueId, text: 'alpha' });
    expect(queue.dequeue()).toEqual({ id: beta.queueId, text: 'beta' });
    expect(queue.dequeue()).toEqual({ id: gamma.queueId, text: 'gamma' });
    expect(queue.dequeue()).toBeUndefined();
  });

  it('removes synchronously — an item is never returned twice (exactly-once)', () => {
    const queue = createCompanionSendQueue();
    queue.enqueue('only');

    const first = queue.dequeue();
    const second = queue.dequeue();

    expect(first?.text).toBe('only');
    expect(second).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it('tracks size across enqueue and dequeue', () => {
    const queue = createCompanionSendQueue();
    expect(queue.size()).toBe(0);

    queue.enqueue('a');
    queue.enqueue('b');
    expect(queue.size()).toBe(2);

    queue.dequeue();
    expect(queue.size()).toBe(1);

    queue.dequeue();
    expect(queue.size()).toBe(0);

    // An empty dequeue is a no-op, never negative.
    expect(queue.dequeue()).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it('enqueue never throws and always accepts (even empty / whitespace text)', () => {
    const queue = createCompanionSendQueue();
    const inputs = ['', '   ', 'a'.repeat(10_000), 'line\nbreak', 'emoji 🚀'];

    expect(() => {
      for (const text of inputs) {
        const result = queue.enqueue(text);
        expect(result.outcome).toBe('queued');
      }
    }).not.toThrow();

    expect(queue.size()).toBe(inputs.length);
    expect(queue.dequeue()?.text).toBe('');
  });

  it('drainAll returns the remaining items in FIFO order and empties the queue', () => {
    const queue = createCompanionSendQueue();
    const first = queue.enqueue('one');
    const second = queue.enqueue('two');
    const third = queue.enqueue('three');

    // Drop the oldest first, then drain what remains.
    expect(queue.dequeue()?.text).toBe('one');

    const drained = queue.drainAll();
    expect(drained).toEqual([
      { id: second.queueId, text: 'two' },
      { id: third.queueId, text: 'three' },
    ]);
    expect(first.queueId).not.toBe(second.queueId);

    expect(queue.size()).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
    expect(queue.drainAll()).toEqual([]);
  });

  it('keeps instances independent (entity-scoped state, no module-level leak)', () => {
    const a = createCompanionSendQueue();
    const b = createCompanionSendQueue();

    a.enqueue('only-a');

    expect(a.size()).toBe(1);
    expect(b.size()).toBe(0);
    expect(b.dequeue()).toBeUndefined();
  });
});

// ── resolveSendOutcome — the ONE decision table (REQ-6) ───────────────────────

describe('resolveSendOutcome — disposition x generating truth table', () => {
  it('dispatches immediately when no generation is in flight (mode irrelevant)', () => {
    expect(resolveSendOutcome('queue', false)).toBe('dispatch');
    expect(resolveSendOutcome('interrupt', false)).toBe('dispatch');
  });

  it('queues while generating under the default `queue` disposition', () => {
    expect(resolveSendOutcome('queue', true)).toBe('queue');
  });

  it('interrupts while generating under the `interrupt` disposition', () => {
    expect(resolveSendOutcome('interrupt', true)).toBe('interrupt');
  });
});

// ── queuedWaitingCopy + bound constants (REQ-5/REQ-12) ────────────────────────

describe('queuedWaitingCopy — the bar waiting copy (REQ-5)', () => {
  it('returns the base sentence for a single queued send', () => {
    expect(queuedWaitingCopy(1)).toBe(QUEUED_WAITING_COPY);
    expect(QUEUED_WAITING_COPY).toBe('Queued — waiting for Fredo…');
  });

  it('returns the counted sentence for two or more queued sends', () => {
    expect(queuedWaitingCopy(2)).toBe('2 queued — waiting for Fredo…');
    expect(queuedWaitingCopy(5)).toBe('5 queued — waiting for Fredo…');
  });

  it('is defensive for non-positive counts (never rendered below 1)', () => {
    expect(queuedWaitingCopy(0)).toBe(QUEUED_WAITING_COPY);
    expect(queuedWaitingCopy(-3)).toBe(QUEUED_WAITING_COPY);
  });
});

describe('bound constants (REQ-12)', () => {
  it('exposes the bound testid the launcher renders', () => {
    expect(QUEUED_WAITING_TESTID).toBe('launcher-command-queued');
  });
});

// ── #3120 ST-3 — the companion grounding seam (R-2.2) ─────────────────────────

describe('#3120 ST-3 — companionGroundingContent', () => {
  it('returns null when no context is supplied (legacy turn)', () => {
    expect(companionGroundingContent()).toBeNull();
    expect(companionGroundingContent({})).toBeNull();
    expect(companionGroundingContent({ context: undefined })).toBeNull();
  });

  it('returns the exact JSON.stringify(context) for a supplied envelope', () => {
    const context = makeContext();
    const grounding = companionGroundingContent({ context });

    expect(grounding).toBe(JSON.stringify(context));
    expect(JSON.parse(grounding as string)).toStrictEqual(context);
  });

  it('bounds the payload by maxContextBytes (multi-byte aware)', () => {
    // 5,000 astral code points = 20,000 UTF-8 bytes > 16,384 — even though the
    // JS string is only 10,000 UTF-16 units. The cap is measured in BYTES.
    const oversized = makeContext({ appId: '🚀'.repeat(5_000) });
    expect(companionGroundingContent({ context: oversized })).toBeNull();

    // A comfortably under-cap envelope still grounds.
    const within = makeContext({ appId: 'x'.repeat(8_000) });
    const grounding = companionGroundingContent({ context: within });
    expect(grounding).toBe(JSON.stringify(within));
    expect(new TextEncoder().encode(grounding as string).length).toBeLessThanOrEqual(
      CAPABILITY_LIMITS.maxContextBytes,
    );
  });
});

describe('#3120 ST-3 — buildCompanionTurnMessages', () => {
  it('without a context returns the byte-identical legacy [persona, user] pair', () => {
    expect(buildCompanionTurnMessages('hello', PERSONA)).toStrictEqual([
      { role: 'system', content: PERSONA },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('prepends exactly ONE grounding system message before persona + user', () => {
    const context = makeContext();
    const messages = buildCompanionTurnMessages('where am I?', PERSONA, { context });

    expect(messages).toStrictEqual([
      { role: 'system', content: JSON.stringify(context) },
      { role: 'system', content: PERSONA },
      { role: 'user', content: 'where am I?' },
    ]);
    // Exactly one grounding message — the persona is the shipped one.
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(2);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('adds no transcript/history: the turn length is exactly 2 or 3', () => {
    expect(buildCompanionTurnMessages('a', PERSONA)).toHaveLength(2);
    expect(buildCompanionTurnMessages('a', PERSONA, { context: makeContext() })).toHaveLength(3);
  });

  it('never injects an over-cap context (stays bounded, never truncated JSON)', () => {
    const oversized = makeContext({ appId: 'x'.repeat(20_000) });
    expect(buildCompanionTurnMessages('hello', PERSONA, { context: oversized })).toStrictEqual([
      { role: 'system', content: PERSONA },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('keeps the audio turn clip-shaped: an empty user turn, never a fabricated transcript', () => {
    const context = makeContext();
    const messages = buildCompanionTurnMessages('', PERSONA, { context });

    expect(messages).toStrictEqual([
      { role: 'system', content: JSON.stringify(context) },
      { role: 'system', content: PERSONA },
      { role: 'user', content: '' },
    ]);
  });
});

describe('#3120 ST-3 — the FIFO carries the grounding context', () => {
  it('stores the context on the queued item and returns it on dequeue', () => {
    const queue = createCompanionSendQueue();
    const context = makeContext();

    const first = queue.enqueue('grounded', { context });
    const item = queue.dequeue();

    expect(item).toEqual({ id: first.queueId, text: 'grounded', context });
    // The same envelope reference is carried (no re-serialization on the way in).
    expect(item?.context).toBe(context);
  });

  it('omits the context key entirely for a legacy send (never an explicit undefined)', () => {
    const queue = createCompanionSendQueue();

    queue.enqueue('legacy');
    const item = queue.dequeue();

    expect(item).toBeDefined();
    expect('context' in (item as object)).toBe(false);
    expect(item).toEqual({ id: item?.id, text: 'legacy' });
  });

  it('drainAll preserves each queued item’s context', () => {
    const queue = createCompanionSendQueue();
    const context = makeContext({ appId: 'wireframe-map' });

    queue.enqueue('one');
    queue.enqueue('two', { context });

    const drained = queue.drainAll();

    expect(drained).toHaveLength(2);
    expect('context' in (drained[0] as object)).toBe(false);
    expect(drained[1].context).toBe(context);
  });
});
