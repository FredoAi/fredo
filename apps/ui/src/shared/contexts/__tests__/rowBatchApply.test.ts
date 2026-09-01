/**
 * RTDB batch-envelope + bulk-apply tests — Spec #2788 F-33 fix (W-2/W-3).
 *
 * Pins the render-stability semantics of the F-33 fix: the backend flush
 * loop now emits ONE `{"rowBatch": RowDelivery[]}` IPC event per drained
 * flush chunk (≤512 deliveries), and the frontend applies each batch with
 * the EXACT single-delivery insert/seq/remove semantics while bumping the
 * epoch ONCE per touched partition (never per delivery).
 *
 * Legs:
 *  1. Batch envelope round-trip through the PRODUCTION validators
 *     (`isRowDeliveryBatch` / `isRowDelivery` mutual exclusion).
 *  2. Bulk-apply equivalence — a batch of N ≡ N singles on final row state.
 *  3. Epoch bump count — exactly 1 per touched partition per batch call
 *     (a 10k-envelope bulk apply → 1 bump; a no-mutation batch → 0).
 *  4. Stale-seq / remove ordering INSIDE a batch.
 *  5. Regression: a full 50k-row replay (fed in ≤512-delivery batches, the
 *     wire shape W-1 produces) produces a BOUNDED number of epoch bumps
 *     (≤ ceil(50000/512) + margin), never one per row.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  applyRowDelivery,
  applyRowDeliveries,
  resetRowStoreForTests,
  getRowEpoch,
  getRowMap,
  subscribeToRowEpoch,
} from '../StreamContext';
import { isRowDelivery, isRowDeliveryBatch, rowKeyString } from '../../classes/EventSubscription';
import type { RowDelivery, RowDeliveryBatch, RowChangeKind, RtdbRow } from '../../classes/EventSubscription';

// ── Fixtures ────────────────────────────────────────────────────────────────

function chatDelivery(
  sessionId: string,
  correlationId: string,
  overrides: Partial<RowDelivery> & { kind: RowChangeKind; seq: number },
): RowDelivery {
  return {
    queryId: 'q-test',
    eventType: 'Chat',
    key: { sessionId, correlationId },
    patch: null,
    timestamp: '2026-09-01T00:00:00+00:00',
    ...overrides,
  };
}

function fullChatPatch(sessionId: string, correlationId: string, seq: number, userMessage: string) {
  return {
    sessionId,
    correlationId,
    seq,
    startedAtNs: 1000,
    endedAtNs: null,
    updatedAt: '2026-09-01T00:00:00+00:00',
    state: 'Init' as const,
    userMessage,
    agentReply: null,
    promptTokens: 12,
    completionTokens: null,
    cacheReadTokens: null,
    costUsd: null,
    model: 'gpt-test',
    parentSessionId: null,
    compositedChildSessionId: null,
    rawJson: '{}',
  };
}

/** Snapshot a partition's rows Map as a plain object for deep comparison. */
function rowsSnapshot(eventType: Parameters<typeof getRowMap>[0]): Record<string, RtdbRow> {
  const out: Record<string, RtdbRow> = {};
  for (const [key, row] of getRowMap(eventType)) {
    out[key] = row;
  }
  return out;
}

/** Count epoch bumps via the production subscription channel. */
function epochBumpCounter(eventType: Parameters<typeof subscribeToRowEpoch>[0]) {
  let bumps = 0;
  const unsubscribe = subscribeToRowEpoch(eventType, () => {
    bumps += 1;
  });
  return {
    get count() {
      return bumps;
    },
    stop: unsubscribe,
  };
}

const RTDB_MAX_EMISSION_BATCH = 512; // mirrors flush.rs RTDB_MAX_EMISSION_BATCH

// ── 1. Envelope validation ──────────────────────────────────────────────────

describe('rowBatch envelope — production validator round-trip', () => {
  beforeEach(() => resetRowStoreForTests());

  it('a backend-shaped batch envelope passes isRowDeliveryBatch and NOT isRowDelivery', () => {
    const envelope: RowDeliveryBatch = {
      rowBatch: [
        chatDelivery('ses_a', 'c1', { kind: 'insert', seq: 1, patch: fullChatPatch('ses_a', 'c1', 1, 'hello') }),
        chatDelivery('ses_a', 'c2', { kind: 'update', seq: 2, patch: { agentReply: 'reply' } }),
      ],
    };
    expect(isRowDeliveryBatch(envelope)).toBe(true);
    expect(isRowDelivery(envelope)).toBe(false, 'the batch envelope must not be mistaken for a single delivery');
  });

  it('a single delivery passes isRowDelivery and NOT isRowDeliveryBatch', () => {
    const single = chatDelivery('ses_a', 'c1', { kind: 'insert', seq: 1, patch: null });
    expect(isRowDelivery(single)).toBe(true);
    expect(isRowDeliveryBatch(single)).toBe(false);
  });

  it('rejects a batch with any malformed element (never partially applied)', () => {
    const good = chatDelivery('ses_a', 'c1', { kind: 'insert', seq: 1, patch: null });
    const malformed = { queryId: 'q', eventType: 'Chat', kind: 'bogus', seq: 1, key: { sessionId: 'a', correlationId: 'b' } };
    expect(isRowDeliveryBatch({ rowBatch: [good, malformed] })).toBe(false);
    expect(isRowDeliveryBatch({ rowBatch: [] })).toBe(true, 'an empty chunk is still a valid envelope');
    expect(isRowDeliveryBatch({ rowBatch: 'nope' })).toBe(false);
    expect(isRowDeliveryBatch(null)).toBe(false);
  });
});

// ── 2. Bulk-apply equivalence ───────────────────────────────────────────────

describe('applyRowDeliveries — bulk apply ≡ N singles on final row state', () => {
  beforeEach(() => resetRowStoreForTests());

  const STREAM: RowDelivery[] = [
    chatDelivery('ses_a', 'c1', { kind: 'insert', seq: 1, patch: fullChatPatch('ses_a', 'c1', 1, 'q1') }),
    chatDelivery('ses_a', 'c2', { kind: 'insert', seq: 1, patch: fullChatPatch('ses_a', 'c2', 1, 'q2') }),
    // Same-key update spread-merge (partial patch, init fields survive).
    chatDelivery('ses_a', 'c1', { kind: 'update', seq: 2, patch: { agentReply: 'r1', state: 'Response', completionTokens: 42 } }),
    // Content-identical mutation → no store change.
    chatDelivery('ses_a', 'c1', { kind: 'update', seq: 3, patch: { agentReply: 'r1' } }),
    // Stale-seq update (lower than last applied) → dropped.
    chatDelivery('ses_a', 'c1', { kind: 'update', seq: 0, patch: { agentReply: 'STALE' } }),
    // Update-before-insert on a fresh key (burst reordering) → adopted as the row.
    chatDelivery('ses_a', 'c3', { kind: 'update', seq: 5, patch: { userMessage: 'q3-early' } }),
    chatDelivery('ses_a', 'c3', { kind: 'insert', seq: 6, patch: fullChatPatch('ses_a', 'c3', 6, 'q3') }),
    // ToolUse partition rows (multi-partition stream).
    chatDelivery('ses_b', 't1', { eventType: 'ToolUse', kind: 'insert', seq: 1, patch: { sessionId: 'ses_b', correlationId: 't1', seq: 1, toolName: 'bash', state: 'Init', rawJson: '{}' } as RtdbRow }),
  ];

  it('batch of N converges to the identical final rows as N singles', () => {
    // Grouped: apply the whole stream as ONE batch.
    applyRowDeliveries(STREAM);
    const batched = rowsSnapshot('Chat');
    const batchedTool = rowsSnapshot('ToolUse');

    // Ungrouped: same envelopes, one applyRowDelivery each.
    resetRowStoreForTests();
    for (const delivery of STREAM) {
      applyRowDelivery(delivery);
    }
    const singles = rowsSnapshot('Chat');
    const singlesTool = rowsSnapshot('ToolUse');

    expect(batched).toEqual(singles);
    expect(batchedTool).toEqual(singlesTool);

    // Sanity on the settled state itself (the semantics being pinned).
    const c1 = batched[rowKeyString({ sessionId: 'ses_a', correlationId: 'c1' })];
    expect(c1.agentReply).toBe('r1', 'highest-seq update value survives');
    expect(c1.userMessage).toBe('q1', 'init-time field survives the spread-merge');
    expect(c1.completionTokens).toBe(42);
    expect(batched[rowKeyString({ sessionId: 'ses_a', correlationId: 'c3' })]?.userMessage).toBe('q3');
    expect(batchedTool[rowKeyString({ sessionId: 'ses_b', correlationId: 't1' })]?.toolName).toBe('bash');
  });

  it('insert + remove inside ONE batch nets to the key never landing', () => {
    applyRowDeliveries([
      chatDelivery('ses_a', 'c9', { kind: 'insert', seq: 1, patch: fullChatPatch('ses_a', 'c9', 1, 'gone') }),
      chatDelivery('ses_a', 'c9', { kind: 'remove', seq: 2, patch: null }),
    ]);
    expect(rowsSnapshot('Chat')).toEqual({}, 'the client must never hold the evicted key');
  });

  it('remove only touches keys the batch actually delivered/persisted', () => {
    applyRowDeliveries([
      chatDelivery('ses_a', 'c1', { kind: 'insert', seq: 1, patch: fullChatPatch('ses_a', 'c1', 1, 'stay') }),
      chatDelivery('ses_a', 'never-seen', { kind: 'remove', seq: 1, patch: null }),
    ]);
    const rows = rowsSnapshot('Chat');
    expect(Object.keys(rows)).toEqual([rowKeyString({ sessionId: 'ses_a', correlationId: 'c1' })]);
  });
});

// ── 3. Epoch bump counts ────────────────────────────────────────────────────

describe('applyRowDeliveries — epoch bumps ONCE per touched partition per batch', () => {
  beforeEach(() => resetRowStoreForTests());

  it('a 10k-envelope bulk apply bumps the partition epoch exactly 1', () => {
    const counter = epochBumpCounter('Chat');
    const batch: RowDelivery[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      batch.push(chatDelivery('ses_bulk', `c${i}`, { kind: 'insert', seq: 1, patch: fullChatPatch('ses_bulk', `c${i}`, 1, `q${i}`) }));
    }
    applyRowDeliveries(batch);
    expect(counter.count).toBe(1, 'one batch → one render, regardless of envelope count');
    expect(getRowEpoch('Chat')).toBe(1);
    expect(getRowMap('Chat').size).toBe(10_000);
    counter.stop();
  });

  it('a mixed-partition batch bumps each touched partition exactly once', () => {
    const chatCounter = epochBumpCounter('Chat');
    const toolCounter = epochBumpCounter('ToolUse');
    applyRowDeliveries([
      chatDelivery('ses_a', 'c1', { kind: 'insert', seq: 1, patch: fullChatPatch('ses_a', 'c1', 1, 'q') }),
      chatDelivery('ses_b', 't1', { eventType: 'ToolUse', kind: 'insert', seq: 1, patch: { sessionId: 'ses_b', correlationId: 't1', seq: 1, toolName: 'bash', state: 'Init', rawJson: '{}' } as RtdbRow }),
    ]);
    expect(chatCounter.count).toBe(1);
    expect(toolCounter.count).toBe(1);
    chatCounter.stop();
    toolCounter.stop();
  });

  it('a batch of content-no-ops bumps nothing (epoch advances only on real mutation)', () => {
    applyRowDeliveries([
      chatDelivery('ses_a', 'c1', { kind: 'insert', seq: 1, patch: fullChatPatch('ses_a', 'c1', 1, 'q') }),
    ]);
    const before = getRowEpoch('Chat');
    const counter = epochBumpCounter('Chat');
    applyRowDeliveries([
      chatDelivery('ses_a', 'c1', { kind: 'update', seq: 2, patch: { agentReply: null } }),
      chatDelivery('ses_a', 'ghost', { kind: 'remove', seq: 1, patch: null }),
    ]);
    expect(counter.count).toBe(0);
    expect(getRowEpoch('Chat')).toBe(before);
    counter.stop();
  });

  it('chunked delivery (window >512) bumps once PER batch call, not per row', () => {
    const counter = epochBumpCounter('Chat');
    for (let chunk = 0; chunk < 3; chunk += 1) {
      const batch: RowDelivery[] = [];
      for (let i = 0; i < RTDB_MAX_EMISSION_BATCH; i += 1) {
        const id = chunk * RTDB_MAX_EMISSION_BATCH + i;
        batch.push(chatDelivery('ses_chunks', `c${id}`, { kind: 'insert', seq: 1, patch: fullChatPatch('ses_chunks', `c${id}`, 1, `q${id}`) }));
      }
      applyRowDeliveries(batch);
    }
    expect(counter.count).toBe(3, '1200 rows across 3 chunk envelopes → 3 bumps');
    expect(getRowMap('Chat').size).toBe(3 * RTDB_MAX_EMISSION_BATCH);
    counter.stop();
  });
});

// ── 4. Regression: bounded epoch bumps on a full 50k-row replay ─────────────

describe('applyRowDeliveries — FM-33 regression: full 50k-row replay is bounded', () => {
  beforeEach(() => resetRowStoreForTests());

  it('50k replay rows fed as ≤512-delivery envelopes produce a bounded number of epoch bumps', () => {
    const counter = epochBumpCounter('Chat');
    const ROWS = 50_000;
    for (let start = 0; start < ROWS; start += RTDB_MAX_EMISSION_BATCH) {
      const batch: RowDelivery[] = [];
      for (let i = start; i < Math.min(start + RTDB_MAX_EMISSION_BATCH, ROWS); i += 1) {
        batch.push(
          chatDelivery(`ses_replay${i % 7}`, `c${i}`, {
            kind: 'insert',
            seq: 1,
            patch: fullChatPatch(`ses_replay${i % 7}`, `c${i}`, 1, `replay ${i}`),
          }),
        );
      }
      applyRowDeliveries(batch);
    }
    // Bound, not exact count: ~98 envelopes of 512 → ~98 bumps, never 50k.
    const maxBatches = Math.ceil(ROWS / RTDB_MAX_EMISSION_BATCH);
    expect(counter.count).toBeGreaterThan(0);
    expect(counter.count).toBeLessThanOrEqual(maxBatches + 2);
    expect(getRowMap('Chat').size).toBe(ROWS, 'full replay content lands');
    counter.stop();
  });
});
