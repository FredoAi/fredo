/**
 * rowPatchPipeline.test.ts — P4.4 pins the test-feed pipeline itself (R-5b).
 *
 * The mission-monitor suites feed their systems under test through
 * `rowSourceHelper`: v1 fixture corpora are converted into the RowDelivery
 * patch envelopes the RTDB backend emits (`patchesFromDeliveries`) and
 * applied with the P4.1 row-store semantics (`createRowPatchStore`). This
 * suite pins the pipeline contract:
 *
 * 1. every emitted envelope passes the PRODUCTION validator `isRowDelivery`
 *    and carries the camelCase field set (project.rs wire shape);
 * 2. first sight of a key → full-row `insert`; later → changed-fields-only
 *    `update` (content-no-op merges emit nothing — the backend's
 *    `is_empty_update` gate);
 * 3. per-key `seq` strictly monotonic, independent across keys;
 * 4. the store's final rows are exactly `rowsFromDeliveries`' fold output
 *    (one conversion path, two consumption modes);
 * 5. PARITY with production: the same stream fed through the REAL
 *    `StreamContext.applyRowDelivery` store produces the same rows;
 * 6. `remove` deletes; a stale-seq (lower) update is dropped.
 */
import { describe, it, expect } from 'vitest';
import type {
  ChatRow,
  ContractDelivery,
  RowDelivery,
  ToolUseRow,
} from '../../../../shared/classes/EventSubscription';
import {
  CHAT_ROW_FIELDS,
  TOOL_USE_ROW_FIELDS,
  isRowDelivery,
} from '../../../../shared/classes/EventSubscription';
// NO StreamContext mock in this file — the real row store is imported for
// the production-parity leg.
import { applyRowDelivery, getRowMap } from '../../../../shared/contexts/StreamContext';
import {
  createRowPatchStore,
  patchesFromDeliveries,
  rowSource,
  rowSourceFromPatches,
} from './rowSourceHelper';
import { rowsFromDeliveries } from './fixtures/rowsFromDeliveries';

// ── v1 fixture helpers (the corpus description format) ──────────────────────

function chatDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
  payloadOverrides: Record<string, unknown> = {},
): ContractDelivery {
  return {
    id,
    contractName: 'chat-node',
    lifecycle,
    key: { sessionId, correlationId },
    payload: { payload: payloadOverrides },
    timestamp: '2027-01-01T00:00:00.000Z',
  };
}

function toolDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
  toolName: string,
  innerPayload: Record<string, unknown> = {},
): ContractDelivery {
  return {
    id,
    contractName: 'tool-use-lifecycle',
    lifecycle,
    key: { sessionId, correlationId },
    payload: { payload: { 'gen_ai.tool.name': toolName, ...innerPayload } },
    timestamp: '2027-01-01T00:00:00.000Z',
  };
}

const CHAT_ENVELOPE_FIELDS = ['queryId', 'eventType', 'kind', 'seq', 'key', 'patch', 'timestamp'];

describe('P4.4 — patchesFromDeliveries emits the RTDB RowDelivery envelopes', () => {
  it('emits camelCase envelopes that pass the production isRowDelivery validator', () => {
    const deliveries = [
      chatDelivery('d1', 'init', 's1', 'c1', { userMessage: 'hello' }),
      chatDelivery('d2', 'end', 's1', 'c1', { userMessage: 'hello', agentReply: 'hi' }),
      toolDelivery('d3', 'init', 's1', 't1', 'Bash', { input: 'ls' }),
    ];
    const patches = patchesFromDeliveries(deliveries);
    expect(patches).toHaveLength(3);
    for (const p of patches) {
      // The production validator accepts every emitted envelope.
      expect(isRowDelivery(p)).toBe(true);
      // camelCase wire shape per infrastructure/rtdb/project.rs.
      expect(Object.keys(p).sort()).toEqual([...CHAT_ENVELOPE_FIELDS].sort());
      expect(p.queryId).toBe('test-query-rowSource');
      expect(['Chat', 'ToolUse']).toContain(p.eventType);
      expect(['insert', 'update', 'remove']).toContain(p.kind);
      expect(p.key).toEqual({ sessionId: expect.any(String), correlationId: expect.any(String) });
      expect(typeof p.timestamp).toBe('string');
    }
  });

  it('first sight of a key emits a FULL-row insert (every typed field present)', () => {
    const patches = patchesFromDeliveries([
      chatDelivery('d1', 'init', 's1', 'c1', { userMessage: 'hello', promptTokens: 10 }),
    ]);
    expect(patches).toHaveLength(1);
    expect(patches[0].kind).toBe('insert');
    const patch = patches[0].patch as Record<string, unknown>;
    // Full row on insert — the complete typed column set (mirrors rows.rs).
    expect(Object.keys(patch).sort()).toEqual([...CHAT_ROW_FIELDS].sort());
    expect(patch.userMessage).toBe('hello');
    expect(patch.promptTokens).toBe(10);
    expect(patch.state).toBe('Init');
  });

  it('later deliveries emit changed-fields-only updates (unchanged fields never ride the patch)', () => {
    const patches = patchesFromDeliveries([
      chatDelivery('d1', 'init', 's1', 'c1', { userMessage: 'hello' }),
      // End delivery: agentReply + endTime + state change; userMessage and
      // the absent token fields do NOT change → they must not ride the patch.
      chatDelivery('d2', 'end', 's1', 'c1', {
        userMessage: 'hello',
        agentReply: 'done',
        endTime: '2026-08-14T04:35:30.000Z',
      }),
    ]);
    expect(patches).toHaveLength(2);
    expect(patches[1].kind).toBe('update');
    const update = patches[1].patch as Record<string, unknown>;
    expect(update.agentReply).toBe('done');
    expect(update.state).toBe('Response');
    expect(update.userMessage).toBeUndefined();
    expect(update.promptTokens).toBeUndefined();
  });

  it('a content-no-op merge emits no envelope (the backend is_empty_update gate)', () => {
    const patches = patchesFromDeliveries([
      chatDelivery('d1', 'end', 's1', 'c1', { userMessage: 'hello', agentReply: 'done' }),
      // Duplicate of the same lifecycle content — nothing changes.
      chatDelivery('d2', 'end', 's1', 'c1', { userMessage: 'hello', agentReply: 'done' }),
    ]);
    expect(patches).toHaveLength(1);
    expect(patches[0].kind).toBe('insert');
  });

  it('per-key seq is strictly monotonic and independent across keys', () => {
    const patches = patchesFromDeliveries([
      chatDelivery('d1', 'init', 's1', 'c1', { userMessage: 'a' }),
      chatDelivery('d2', 'end', 's1', 'c1', { userMessage: 'a', agentReply: 'x' }),
      chatDelivery('d3', 'init', 's1', 'c2', { userMessage: 'b' }),
      chatDelivery('d4', 'end', 's1', 'c2', { userMessage: 'b', agentReply: 'y' }),
      toolDelivery('d5', 'init', 's1', 't1', 'Bash'),
      toolDelivery('d6', 'end', 's1', 't1', 'Bash', { output: 'ok' }),
    ]);
    const seqByKey = new Map<string, number[]>();
    for (const p of patches) {
      const key = `${p.key.sessionId}\u0000${p.key.correlationId}`;
      const list = seqByKey.get(key) ?? [];
      list.push(p.seq);
      seqByKey.set(key, list);
    }
    expect(seqByKey.size).toBe(3);
    for (const [, seqs] of seqByKey) {
      expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // 1, 2, … per key
    }
  });
});

describe('P4.4 — createRowPatchStore applies the P4.1 row-store semantics', () => {
  it('final store rows equal the rowsFromDeliveries fold (one conversion path)', () => {
    const deliveries = [
      chatDelivery('d1', 'init', 's1', 'c1', { userMessage: 'run the tests', promptTokens: 100 }),
      chatDelivery('d2', 'end', 's1', 'c1', {
        userMessage: 'run the tests',
        agentReply: 'done',
        endTime: '2026-08-14T04:35:30.000Z',
        promptTokens: 100,
        completionTokens: 50,
      }),
      toolDelivery('d3', 'init', 's1', 't1', 'Edit', { input: 'file.ts' }),
      toolDelivery('d4', 'end', 's1', 't1', 'Edit', { input: 'file.ts', output: 'applied' }),
    ];
    const store = createRowPatchStore();
    store.apply(patchesFromDeliveries(deliveries));

    const { chatRows, toolRows } = rowsFromDeliveries(deliveries);
    // Every merged field must match. `seq` is excluded from the comparison:
    // the pipeline allocates the RTDB per-key monotonic seq (patch count per
    // key), the fold helper a positional convenience counter — the merge
    // semantics (the thing parity pins) are identical by construction.
    const withoutSeq = (r: ChatRow | ToolUseRow): Record<string, unknown> => {
      const { seq: _seq, ...rest } = r;
      return rest;
    };
    const chatExpected = new Map(
      chatRows.map((r) => [`${r.sessionId}\u0000${r.correlationId}`, withoutSeq(r)]),
    );
    const toolExpected = new Map(
      toolRows.map((r) => [`${r.sessionId}\u0000${r.correlationId}`, withoutSeq(r)]),
    );
    expect(
      [...store.chat.rows.entries()].map(([k, r]) => [k, withoutSeq(r)]),
    ).toEqual([...chatExpected.entries()]);
    expect(
      [...store.toolUse.rows.entries()].map(([k, r]) => [k, withoutSeq(r)]),
    ).toEqual([...toolExpected.entries()]);
  });

  it('feeds the same rows through the REAL StreamContext.applyRowDelivery — production parity', () => {
    const deliveries = [
      chatDelivery('d1', 'init', 'ses-parity', 'c1', { userMessage: 'hello', promptTokens: 7 }),
      chatDelivery('d2', 'end', 'ses-parity', 'c1', { userMessage: 'hello', agentReply: 'hi' }),
      toolDelivery('d3', 'init', 'ses-parity', 't1', 'Read', { input: 'x' }),
      toolDelivery('d4', 'end', 'ses-parity', 't1', 'Read', { input: 'x', output: 'y' }),
    ];
    const patches = patchesFromDeliveries(deliveries);

    // Production store (module-scoped; unique session id isolates this test).
    for (const p of patches) applyRowDelivery(p as RowDelivery);
    const prodChat = getRowMap('Chat') as Map<string, ChatRow>;
    const prodTool = getRowMap('ToolUse') as Map<string, ToolUseRow>;

    // Test-harness store.
    const store = createRowPatchStore();
    store.apply(patches);

    const prodChatRow = prodChat.get('ses-parity\u0000c1');
    const testChatRow = store.chat.rows.get('ses-parity\u0000c1');
    expect(prodChatRow).toBeDefined();
    expect(testChatRow).toBeDefined();
    // Both stores converged to the SAME merged row (seq included).
    expect(testChatRow).toEqual(prodChatRow);
    expect(store.toolUse.rows.get('ses-parity\u0000t1')).toEqual(
      prodTool.get('ses-parity\u0000t1'),
    );
  });

  it('remove deletes the row and a stale-seq (lower) update is dropped', () => {
    const store = createRowPatchStore();
    const key = { sessionId: 'ses-rm', correlationId: 'c1' };
    store.apply([
      {
        queryId: 'q', eventType: 'Chat', kind: 'insert', seq: 1, key,
        patch: {
          sessionId: 'ses-rm', correlationId: 'c1', seq: 1, startedAtNs: null,
          endedAtNs: null, updatedAt: '2027-01-01T00:00:00.000Z', state: 'Init',
          userMessage: 'hello', agentReply: null, promptTokens: null,
          completionTokens: null, cacheReadTokens: null, costUsd: null, model: null,
          parentSessionId: null, compositedChildSessionId: null, rawJson: '',
        },
        timestamp: '2027-01-01T00:00:00.000Z',
      },
    ]);
    expect(store.chat.rows.has('ses-rm\u0000c1')).toBe(true);

    // Stale update (seq 0 < last applied 1) — dropped.
    store.apply([
      {
        queryId: 'q', eventType: 'Chat', kind: 'update', seq: 0, key,
        patch: { agentReply: 'stale' }, timestamp: '2027-01-01T00:00:00.000Z',
      },
    ]);
    expect(store.chat.rows.get('ses-rm\u0000c1')?.agentReply).toBeNull();

    // Live update applies…
    store.apply([
      {
        queryId: 'q', eventType: 'Chat', kind: 'update', seq: 2, key,
        patch: { agentReply: 'fresh', state: 'Response' },
        timestamp: '2027-01-01T00:00:01.000Z',
      },
    ]);
    const row = store.chat.rows.get('ses-rm\u0000c1');
    expect(row?.agentReply).toBe('fresh');
    expect(row?.state).toBe('Response');
    // …and the epoch advanced once per real mutation (insert + update, not the stale drop).
    expect(store.chat.epoch).toBe(2);

    // Remove deletes the row (retention eviction — R-2d).
    store.apply([
      { queryId: 'q', eventType: 'Chat', kind: 'remove', seq: 3, key, patch: null, timestamp: '2027-01-01T00:00:02.000Z' },
    ]);
    expect(store.chat.rows.has('ses-rm\u0000c1')).toBe(false);
  });
});

describe('P4.4 — the feed adapters preserve the render-stability contract', () => {
  it('rowSource returns the SAME source object for the same fixture content', () => {
    const deliveries = [
      chatDelivery('d1', 'init', 's1', 'c1', { userMessage: 'hello' }),
    ];
    const a = rowSource(deliveries);
    const b = rowSource(deliveries);
    expect(a).toBe(b);
    // Inline (content-identical) literals are also cached.
    const c = rowSource([
      chatDelivery('d1', 'init', 's1', 'c1', { userMessage: 'hello' }),
    ]);
    expect(c).toBe(a);
  });

  it('rowSourceFromPatches applies authored RowDelivery envelopes through the same store', () => {
    const key = { sessionId: 'ses-auth', correlationId: 'c1' };
    const patches: RowDelivery[] = [
      {
        queryId: 'q', eventType: 'Chat', kind: 'insert', seq: 1, key,
        patch: {
          sessionId: 'ses-auth', correlationId: 'c1', seq: 1, startedAtNs: null,
          endedAtNs: null, updatedAt: '2027-01-01T00:00:00.000Z', state: 'Init',
          userMessage: 'authored patch', agentReply: null, promptTokens: null,
          completionTokens: null, cacheReadTokens: null, costUsd: null, model: null,
          parentSessionId: null, compositedChildSessionId: null, rawJson: '',
        },
        timestamp: '2027-01-01T00:00:00.000Z',
      },
    ];
    const source = rowSourceFromPatches(patches) as {
      chat: { rows: Map<string, ChatRow>; epoch: number };
      toolUse: { rows: Map<string, ToolUseRow> };
    };
    expect(source.chat.rows.get('ses-auth\u0000c1')?.userMessage).toBe('authored patch');
    // Same content → same source object (stability contract).
    expect(rowSourceFromPatches(patches)).toBe(source);
  });
});
