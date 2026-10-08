/**
 * lateCompletion.test.ts — R-5c: the 234-bug kill on the RTDB path (P4.4).
 *
 * THE BUG CLASS (#234 / R-5c): a subagent dispatch whose completion fields
 * (childSessionId, tokens) arrive arbitrarily late. Under the v1 contract
 * engine the child's buffer was already `completed` (500ms update cadence +
 * the 300s `timeout: 300000` window), so a later completion event hit the
 * completed-buffer discard (contract/engine.rs:372-393) — the SubagentNode
 * never received its attribution and the `⚠ N unattributed` chip grew (the
 * "234 unattributed" incident).
 *
 * THE RTDB PROPERTY (R-1a/R-1d): there is NO completion window. A completion
 * is an ordinary per-field patch that merges into the row at ANY elapsed
 * time; the attribution join runs on content, never on arrival time. This
 * suite simulates a T+ arbitrarily-late completion patch (T+20min and
 * T+40min — both far beyond the legacy 300s window) and asserts:
 *   1. the late patch is delivered and APPLIED (no discard);
 *   2. the SubagentNode shows the correct attribution (childSessionId) and
 *      the child's collected tool activity attaches;
 *   3. the unattributed counter does NOT grow — 1 (pre-attribution orphan)
 *      → 0 (attributed) → 0 (stays, under later late patches).
 *
 * The feed is AUTHORED RowDelivery envelopes (insert/update, per-key seq,
 * camelCase) applied incrementally through the P4.1 row-store semantics —
 * the replay-then-live patch application, not rebuilt fixture arrays.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type {
  ChatRow,
  RowDelivery,
  ToolUseRow,
} from '../../../../shared/classes/EventSubscription';
import { useDeliveryGraph } from '../useMissionMonitor';
import { createRowPatchStore } from './rowSourceHelper';

// ── Envelope authoring helpers (typed rows / patches, NOT v1 fixtures) ──────

const T0 = Date.parse('2026-08-21T10:00:00.000Z');
const DISPATCH_T0 = '2026-08-21T10:00:00.000Z';
/** Arbitrarily late — the legacy ECE window was 300s; these land at 20min/40min. */
const LATE_COMPLETION_ISO = '2026-08-21T10:20:00.000Z';
const LATE_REFINEMENT_ISO = '2026-08-21T10:40:00.000Z';
const LATE_COMPLETION_NS = Date.parse(LATE_COMPLETION_ISO) * 1e6;

const PARENT = 'ses_parent_mm';
const CHILD = 'ses_child_late';
const TASK_CORR = `${PARENT}_t1`;
const CHILD_TOOL_CORR = `${CHILD}_1`;

function chatRow(overrides: Partial<ChatRow>): ChatRow {
  return {
    sessionId: PARENT,
    correlationId: `${PARENT}_1`,
    seq: 1,
    startedAtNs: T0,
    endedAtNs: T0 + 60_000 * 1e6,
    updatedAt: DISPATCH_T0,
    state: 'Response',
    userMessage: 'delegate long work',
    agentReply: 'delegated',
    promptTokens: 100,
    completionTokens: 40,
    cacheReadTokens: null,
    costUsd: null,
    model: 'test-model',
    parentSessionId: null,
    compositedChildSessionId: null,
    rawJson: '{}',
    ...overrides,
  };
}

function toolRow(overrides: Partial<ToolUseRow>): ToolUseRow {
  return {
    sessionId: PARENT,
    correlationId: TASK_CORR,
    seq: 1,
    startedAtNs: T0 + 10_000 * 1e6,
    endedAtNs: null,
    updatedAt: DISPATCH_T0,
    state: 'Update',
    toolName: 'task',
    toolSuccess: null,
    toolError: null,
    durationMs: null,
    toolInputJson: JSON.stringify({ subagent_type: 'explore', prompt: 'long dispatch' }),
    toolOutputJson: null,
    isSubagent: false,
    rawJson: '{}',
    ...overrides,
  };
}

function envelope(
  kind: 'insert' | 'update' | 'remove',
  eventType: 'Chat' | 'ToolUse',
  seq: number,
  sessionId: string,
  correlationId: string,
  patch: Record<string, unknown> | null,
  timestamp: string,
): RowDelivery {
  return {
    queryId: 'q-late-completion',
    eventType,
    kind,
    seq,
    key: { sessionId, correlationId },
    patch: (patch ?? null) as RowDelivery['patch'],
    timestamp,
  };
}

function rowsProp(store: ReturnType<typeof createRowPatchStore>) {
  return { chat: store.chat, toolUse: store.toolUse };
}

// ── The drive ────────────────────────────────────────────────────────────────

/** Replay/live batch 1 — DISPATCH time: the parent turn completes around a
 *  task dispatch whose childSessionId is NOT yet known (the child is still
 *  running), and the child's own tool activity streams into the collectors. */
function dispatchPatches(): RowDelivery[] {
  return [
    envelope('insert', 'Chat', 1, PARENT, `${PARENT}_1`, { ...chatRow({}) }, DISPATCH_T0),
    // The task dispatch row — registered, in flight (no childSessionId yet).
    envelope(
      'insert', 'ToolUse', 1, PARENT, TASK_CORR,
      { ...toolRow({ rawJson: JSON.stringify({ childAgent: 'explore' }) }) },
      DISPATCH_T0,
    ),
    // The child session's own tool activity (isSubagent) — attributed only
    // once the dispatch's completion fields name its childSessionId.
    envelope(
      'insert', 'ToolUse', 1, CHILD, CHILD_TOOL_CORR,
      {
        ...toolRow({
          sessionId: CHILD,
          correlationId: CHILD_TOOL_CORR,
          toolName: 'Grep',
          toolSuccess: true,
          isSubagent: true,
          startedAtNs: T0 + 30_000 * 1e6,
          toolInputJson: JSON.stringify({ pattern: 'needle' }),
          toolOutputJson: 'hit',
          rawJson: JSON.stringify({ parentSessionId: PARENT }),
        }),
      },
      DISPATCH_T0,
    ),
  ];
}

/** The T+20min completion patch — changed fields ONLY (exactly what the RTDB
 *  backend projects): the task row gains its child-completion long-tail
 *  (childSessionId + tokens via rawJson), the span closes, state → Response. */
function lateCompletionPatch(): RowDelivery {
  return envelope(
    'update', 'ToolUse', 2, PARENT, TASK_CORR,
    {
      state: 'Response',
      endedAtNs: LATE_COMPLETION_NS,
      durationMs: 20 * 60 * 1000,
      toolSuccess: true,
      updatedAt: LATE_COMPLETION_ISO,
      rawJson: JSON.stringify({
        childAgent: 'explore',
        childSessionId: CHILD,
        childTokens: 420,
      }),
    },
    LATE_COMPLETION_ISO,
  );
}

/** A T+40min refinement patch (token reconciliation) — attribution already
 *  set; the counter must stay at 0. */
function lateRefinementPatch(): RowDelivery {
  return envelope(
    'update', 'ToolUse', 3, PARENT, TASK_CORR,
    {
      updatedAt: LATE_REFINEMENT_ISO,
      rawJson: JSON.stringify({
        childAgent: 'explore',
        childSessionId: CHILD,
        childTokens: 500,
      }),
    },
    LATE_REFINEMENT_ISO,
  );
}

describe('R-5c (P4.4) — an arbitrarily-late subagent completion patch attributes correctly and never grows the unattributed counter', () => {
  it('a T+20min completion patch is applied, attributes the SubagentNode, and the orphan count drops 1 → 0', async () => {
    const store = createRowPatchStore();
    store.apply(dispatchPatches());

    const { result, rerender } = renderHook(
      ({ rows }: { rows: ReturnType<typeof rowsProp> }) =>
        useDeliveryGraph({ rows, sessionId: PARENT }),
      { initialProps: { rows: rowsProp(store) } },
    );

    // ── Dispatch-time state: the SubagentNode renders its working state
    //    (no attribution yet) and the child's call counts as unattributed.
    await waitFor(() => {
      expect(result.current.nodes.find((n) => n.id === `agent-${PARENT}_1`)).toBeDefined();
      expect(result.current.nodes.find((n) => n.id === `subagent-${TASK_CORR}`)).toBeDefined();
    });
    const nodeBefore = result.current.nodes.find((n) => n.id === `subagent-${TASK_CORR}`)!;
    expect((nodeBefore.data.payload as Record<string, unknown>).childSessionId).toBeUndefined();
    // The 234-bug precondition: the orphan IS counted while attribution is
    // pending (one collected child call with a recorded parent, no owner).
    expect(result.current.unattributedCount).toBe(1);

    // ── T+20min: the completion patch lands (no completed-buffer discard —
    //    the RTDB path has NO 300s window, R-1a).
    store.apply([lateCompletionPatch()]);
    rerender({ rows: rowsProp(store) });

    await waitFor(() => {
      const node = result.current.nodes.find((n) => n.id === `subagent-${TASK_CORR}`);
      expect(node).toBeDefined();
      expect((node!.data.payload as Record<string, unknown>).childSessionId).toBe(CHILD);
    });
    // Correct attribution: the child's collected tool activity attaches to
    // the SubagentNode (the TOOLS accordion data).
    const node = result.current.nodes.find((n) => n.id === `subagent-${TASK_CORR}`)!;
    const tools = ((node.data.payload as Record<string, unknown>).tools ?? []) as Array<{
      toolName: string;
      correlationId: string;
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe('Grep');
    expect(tools[0].correlationId).toBe(CHILD_TOOL_CORR);
    expect((node.data.payload as Record<string, unknown>).childTokens).toBe(420);

    // THE ASSERTION: the unattributed counter did NOT grow — the orphan was
    // claimed by the late attribution (1 → 0), never 1 → 2 (the 234 shape).
    expect(result.current.unattributedCount).toBe(0);
  });

  it('later late patches (T+40min refinement) keep the attribution and the counter stays 0', async () => {
    const store = createRowPatchStore();
    store.apply(dispatchPatches());

    const { result, rerender } = renderHook(
      ({ rows }: { rows: ReturnType<typeof rowsProp> }) =>
        useDeliveryGraph({ rows, sessionId: PARENT }),
      { initialProps: { rows: rowsProp(store) } },
    );
    await waitFor(() => {
      expect(result.current.unattributedCount).toBe(1);
    });

    store.apply([lateCompletionPatch()]);
    rerender({ rows: rowsProp(store) });
    await waitFor(() => {
      expect(result.current.unattributedCount).toBe(0);
    });

    // T+40min: a refinement patch re-writes the completion long-tail — the
    // attribution holds and the counter never resurfaces.
    store.apply([lateRefinementPatch()]);
    rerender({ rows: rowsProp(store) });
    await waitFor(() => {
      const node = result.current.nodes.find((n) => n.id === `subagent-${TASK_CORR}`);
      expect((node!.data.payload as Record<string, unknown>).childSessionId).toBe(CHILD);
      expect((node!.data.payload as Record<string, unknown>).childTokens).toBe(500);
    });
    expect(result.current.unattributedCount).toBe(0);
  });

  it('the completion patch merges into the row store at any elapsed time — no timeout discard on the row path (R-1a/R-1d)', () => {
    // Store-level pin: the late update patch merges (seq 2 > 1) — the v1
    // "non-Init event for a completed buffer is silently dropped" failure
    // mode (contract/engine.rs:372-393) has no RTDB analog.
    const store = createRowPatchStore();
    store.apply(dispatchPatches());
    const taskKey = `${PARENT}\u0000${TASK_CORR}`;
    expect(store.toolUse.rows.get(taskKey)?.state).toBe('Update');
    expect(JSON.parse(store.toolUse.rows.get(taskKey)!.rawJson).childSessionId).toBeUndefined();

    store.apply([lateCompletionPatch()]);
    const merged = store.toolUse.rows.get(taskKey)!;
    expect(merged.state).toBe('Response');
    expect(merged.endedAtNs).toBe(LATE_COMPLETION_NS);
    const raw = JSON.parse(merged.rawJson);
    expect(raw.childSessionId).toBe(CHILD);
    expect(raw.childTokens).toBe(420);
    // The merge kept the dispatch-time fields (KeepFirst on the input args).
    expect(JSON.parse(merged.toolInputJson ?? '{}').subagent_type).toBe('explore');
  });
});
