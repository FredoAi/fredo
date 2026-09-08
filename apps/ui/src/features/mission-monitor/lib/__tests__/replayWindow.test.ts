/**
 * #2835 round-2 (ST-4-R2a / ST-8a) — replay-window + warm-reopen watermark
 * module tests.
 *
 * Pins the module-scoped `updatedAt` watermark semantics and the replay-args
 * builder that both Mission Monitor subscriptions mount:
 * - a COLD mount (empty watermark) builds a windowed-only `startedAtNs >=`
 *   arg (no delta bound) → the full windowed replay;
 * - a WARM reopen (non-empty watermark) adds `updatedAt > watermark` → the
 *   delta-only drain;
 * - the watermark advances monotonically on row-store epoch changes and is
 *   module-scoped (survives feature mount/unmount; `reset` clears it, the
 *   app-restart equivalent).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  advanceReplayWatermark,
  buildReplayArgs,
  getReplayWatermark,
  resetReplayWatermarksForTests,
  MM_REPLAY_WINDOW_NS,
} from '../replayWindow';
import type { ChatRow } from '../../../../shared/classes/EventSubscription';

function chatRow(updatedAt: string): ChatRow {
  return {
    sessionId: 'ses_a',
    correlationId: 'ses_a_1',
    seq: 1,
    startedAtNs: 1.7e18,
    endedAtNs: null,
    updatedAt,
    state: 'Response',
    userMessage: 'hello',
    agentReply: 'reply',
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    costUsd: null,
    model: null,
    parentSessionId: null,
    compositedChildSessionId: null,
    rawJson: '{}',
  };
}

describe('replayWindow (#2835 round-2)', () => {
  beforeEach(() => {
    resetReplayWatermarksForTests();
  });

  it('MM_REPLAY_WINDOW_NS is a 7-day WINDOW WIDTH, not an absolute bound', () => {
    // The round-1 defect: a 1970-relative 7-day width (~6.048e14) used as the
    // literal compare value; every real row (≈1.7–1.8e18 ns) passed it. A real
    // cutoff = Date.now()*1e6 − this width lands in the ~1.7–1.8e18 range.
    expect(MM_REPLAY_WINDOW_NS).toBe(7 * 24 * 60 * 60 * 1e9);
    const cutoff = Date.now() * 1e6 - MM_REPLAY_WINDOW_NS;
    expect(cutoff).toBeGreaterThan(1.6e18);
  });

  it('a COLD mount (no watermark) builds only the windowed recency arg', () => {
    expect(getReplayWatermark('Chat')).toBeUndefined();
    const args = buildReplayArgs('Chat', 1.7e18);
    expect(args.startedAtNs).toEqual({ op: '>=', value: 1.7e18 });
    expect(args.updatedAt).toBeUndefined();
    // The warm-reopen delta bound is absent — the cold boot performs the full
    // windowed replay.
    expect(Object.keys(args).sort()).toEqual(['startedAtNs']);
  });

  it('advances the watermark to the max updatedAt and a WARM reopen adds the delta arg', () => {
    const rows = new Map<string, ChatRow>([
      ['a', chatRow('2026-09-07T09:00:00+00:00')],
      ['b', chatRow('2026-09-07T10:30:00+00:00')],
    ]);
    advanceReplayWatermark('Chat', rows);
    expect(getReplayWatermark('Chat')).toBe('2026-09-07T10:30:00+00:00');

    // Warm reopen: the replay args now carry BOTH the recency window and the
    // delta bound (`updatedAt > watermark`) — the backend drain returns only
    // rows the store does NOT yet hold.
    const args = buildReplayArgs('Chat', 1.7e18);
    expect(args.startedAtNs).toEqual({ op: '>=', value: 1.7e18 });
    expect(args.updatedAt).toEqual({
      op: '>',
      value: '2026-09-07T10:30:00+00:00',
    });
  });

  it('is monotonic — older rows never lower the watermark', () => {
    const recent = new Map<string, ChatRow>([
      ['a', chatRow('2026-09-07T12:00:00+00:00')],
    ]);
    advanceReplayWatermark('Chat', recent);
    const older = new Map<string, ChatRow>([
      ['a', chatRow('2026-09-07T09:00:00+00:00')],
    ]);
    expect(advanceReplayWatermark('Chat', older)).toBe('2026-09-07T12:00:00+00:00');
    expect(getReplayWatermark('Chat')).toBe('2026-09-07T12:00:00+00:00');
  });

  it('keeps per-event-type watermarks isolated (Chat vs ToolUse)', () => {
    advanceReplayWatermark('Chat', new Map([['a', chatRow('2026-09-07T10:00:00+00:00')]]));
    expect(getReplayWatermark('Chat')).toBe('2026-09-07T10:00:00+00:00');
    expect(getReplayWatermark('ToolUse')).toBeUndefined();
    const toolArgs = buildReplayArgs('ToolUse', 1.7e18);
    expect(toolArgs.updatedAt).toBeUndefined();
  });

  it('reset clears the module state (app restart → cold full replay)', () => {
    advanceReplayWatermark('Chat', new Map([['a', chatRow('2026-09-07T10:00:00+00:00')]]));
    resetReplayWatermarksForTests();
    expect(getReplayWatermark('Chat')).toBeUndefined();
    expect(buildReplayArgs('Chat', 1.7e18).updatedAt).toBeUndefined();
  });
});
