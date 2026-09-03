/**
 * rowDerivation.test.ts — P4.2 unit coverage for the typed-row → graph-state
 * derivation (Spec #2788 R-5a).
 *
 * Pins the row-space semantics that replace the v1 collectors/lifecycle
 * handling:
 * - time-window tool→chat association (D-2: greatest startTime strictly
 *   before the call's start, span-containment guard);
 * - delegation depth stamping (D-1c: depth + sessionMaxDepth only when the
 *   session's max ≥ 2);
 * - orphan chip counting, SCOPED to the selected session's subtree (D4b) —
 *   including the attribution join derived from the typed
 *   `compositedChildSessionId` stamp (R-1e) and `parentSessionId` in the
 *   rawJson escape hatch;
 * - re-key stamp handling: parent-keyed COPIES of child rows never create
 *   duplicates (first-match insert semantics, original beats copy), and late
 *   re-key stamps never grow the unattributed count (the 234-bug kill).
 */
import { describe, it, expect } from 'vitest';
import type { ChatRow, ToolUseRow } from '../../../../shared/classes/EventSubscription';
import {
  deriveRowGraphState,
  isSubagentChatRow,
  chatRowStatus,
  ownerSessionIdFromCorrId,
  toolSummaryFromToolRow,
  nsToIso,
  sessionHasAnyRow,
} from '../rowDerivation';

let seq = 0;
const T0 = '2026-08-21T10:00:00.000Z';
const T1 = '2026-08-21T10:00:10.000Z';
const T2 = '2026-08-21T10:00:20.000Z';
const T3 = '2026-08-21T10:00:30.000Z';

function chatRow(overrides: Partial<ChatRow> = {}): ChatRow {
  seq++;
  return {
    sessionId: 's1',
    correlationId: `chat-${seq}`,
    seq,
    startedAtNs: Date.parse(T0) * 1e6,
    endedAtNs: null,
    updatedAt: T0,
    state: 'Response',
    userMessage: 'hello',
    agentReply: 'world',
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    costUsd: null,
    model: null,
    parentSessionId: null,
    compositedChildSessionId: null,
    rawJson: '{}',
    ...overrides,
  };
}

function toolRow(overrides: Partial<ToolUseRow> = {}): ToolUseRow {
  seq++;
  return {
    sessionId: 's1',
    correlationId: `tool-${seq}`,
    seq,
    startedAtNs: Date.parse(T1) * 1e6,
    endedAtNs: null,
    updatedAt: T1,
    state: 'Response',
    toolName: 'Bash',
    toolSuccess: true,
    toolError: null,
    durationMs: null,
    toolInputJson: '{}',
    toolOutputJson: 'ok',
    isSubagent: false,
    rawJson: '{}',
    ...overrides,
  };
}

describe('chat-row routing (v1 excludePayload parity)', () => {
  it('excludes subagent-session chat rows from the chat-node set — both the child-keyed original and the parent-keyed stamped copy', () => {
    expect(isSubagentChatRow(chatRow())).toBe(false);
    expect(isSubagentChatRow(chatRow({ parentSessionId: 'root' }))).toBe(true);
    expect(isSubagentChatRow(chatRow({ compositedChildSessionId: 'child' }))).toBe(true);

    const state = deriveRowGraphState(
      [
        chatRow({ correlationId: 'root-turn', parentSessionId: null, compositedChildSessionId: null }),
        chatRow({ correlationId: 'child-turn', sessionId: 'child', parentSessionId: 's1' }),
        chatRow({ correlationId: 'child-copy', parentSessionId: 's1', compositedChildSessionId: 'child' }),
      ],
      [],
    );
    expect([...state.agentNodes.keys()]).toEqual(['root-turn']);
  });

  it('maps the row state column onto graph statuses — Response/Timeout complete, Update active, Init in-progress, Error error', () => {
    expect(chatRowStatus(chatRow({ state: 'Init' }))).toBe('in-progress');
    expect(chatRowStatus(chatRow({ state: 'Update' }))).toBe('active');
    expect(chatRowStatus(chatRow({ state: 'Response' }))).toBe('complete');
    expect(chatRowStatus(chatRow({ state: 'Timeout' }))).toBe('complete');
    expect(chatRowStatus(chatRow({ state: 'Error' }))).toBe('error');
    expect(chatRowStatus(chatRow({ state: 'Response', rawJson: '{"compacted":true}' }))).toBe('compacted');
  });

  it('a transitional turn (complete + empty agentReply) is derived as such — the emission gates suppress it', () => {
    const row = chatRow({ agentReply: null });
    const state = deriveRowGraphState([row], []);
    expect(state.agentNodes.get(row.correlationId)?.payload.agentReply).toBe('');
  });

  it('prefix-owner extraction: real ses_-prefixed corrIds resolve, non-prefixed fall back', () => {
    expect(ownerSessionIdFromCorrId('ses_abc123_4')).toBe('ses_abc123');
    expect(ownerSessionIdFromCorrId('ses_abc123')).toBeUndefined();
    expect(ownerSessionIdFromCorrId('msg_9')).toBeUndefined();
  });
});

describe('time-window tool→chat association (D-2)', () => {
  it('collects the non-task call with its span times — the raw material the D-2 rule resolves', () => {
    // Chat turn T0→T2 (open across T1); tool call at T1 → the hook's
    // association pass resolves it to this chat node (strictly-before start,
    // still-open end).
    const call = toolRow({ correlationId: 'call-1', startedAtNs: Date.parse(T1) * 1e6, toolName: 'Read' });
    const turn = chatRow({ startedAtNs: Date.parse(T0) * 1e6, endedAtNs: Date.parse(T2) * 1e6 });
    const state = deriveRowGraphState(
      [turn],
      [call],
    );
    const embedded = state.agentNodes.get(turn.correlationId)?.payload.tools ?? [];
    expect(embedded).toHaveLength(0); // embedding happens in the hook's association pass
    const calls = state.toolCallsBySession.get('s1')!;
    expect(calls.get('call-1')!.toolName).toBe('Read');
    expect(calls.get('call-1')!.startTime).toBe(T1);
  });

  it('the span-containment guard: a turn that COMPLETED before the call began is not a candidate', () => {
    const state = deriveRowGraphState(
      [
        chatRow({ correlationId: 'early', startedAtNs: Date.parse(T0) * 1e6, endedAtNs: Date.parse(T1) * 1e6 }),
        chatRow({ correlationId: 'open', startedAtNs: Date.parse(T2) * 1e6, endedAtNs: null }),
      ],
      [toolRow({ correlationId: 'call', startedAtNs: Date.parse(T3) * 1e6 })],
    );
    // Both chat rows exist; the association (in the hook) must pick 'open':
    // 'early' completed (endedAtNs T1) before the call started (T3).
    const summary = state.toolCallsBySession.get('s1')!.get('call')!;
    expect(summary.startTime).toBe(T3);
    // Deterministic raw-material check: the derivation carries both candidates.
    expect(state.agentNodes.has('early')).toBe(true);
    expect(state.agentNodes.has('open')).toBe(true);
    expect(nsToIso(Date.parse(T3) * 1e6)).toBe(T3);
  });

  it('a task dispatch with child attribution stays in the parent tool collector (SubagentNode path input)', () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'go' });
    const state = deriveRowGraphState(
      [chatRow({ correlationId: 'anchor' })],
      [
        toolRow({
          correlationId: 'dispatch-1',
          toolName: 'task',
          toolInputJson: TASK_ARGS,
          rawJson: JSON.stringify({ childSessionId: 'ses_child_1', childTokens: 4321 }),
        }),
      ],
    );
    const call = state.toolCallsBySession.get('s1')!.get('dispatch-1')!;
    expect(call.toolName).toBe('task');
    expect(call.childSessionId).toBe('ses_child_1');
    expect(call.childTokens).toBe(4321);
  });
});

describe('delegation depth (D-1c)', () => {
  it('depth is computed by the association fixpoint only when max ≥ 2 — single dispatch sessions stay unstamped', () => {
    // Derivation alone creates no SubagentNodes (the association pass in the
    // hook does); pin that the raw material (childSessionId on the task call)
    // is what feeds subagentTreeDepth.
    const state = deriveRowGraphState(
      [chatRow({ correlationId: 'anchor' })],
      [toolRow({ toolName: 'task', correlationId: 'd1', rawJson: JSON.stringify({ childSessionId: 'ses_c1' }) })],
    );
    expect(state.subagentNodes.size).toBe(0);
    expect(state.toolCallsBySession.get('s1')!.get('d1')!.childSessionId).toBe('ses_c1');
  });
});

describe('orphan chip attribution (D-6/D4b, typed stamps)', () => {
  it('the child→parent map is derived from the #523 stamp on parent-keyed chat-row copies', () => {
    const state = deriveRowGraphState(
      [chatRow({ correlationId: 'parent-turn', parentSessionId: 'root', compositedChildSessionId: 'child-ses' })],
      [],
    );
    expect(state.collectorParentByChildSession.get('child-ses')).toBe('root');
  });

  it('the child→parent map also accepts parentSessionId from a child tool row rawJson (tool-only children)', () => {
    const state = deriveRowGraphState(
      [],
      [toolRow({ sessionId: 'child_ses', correlationId: 'legacy-tool-call', isSubagent: true, rawJson: JSON.stringify({ parentSessionId: 'root' }) })],
    );
    // Non-prefixed corrId → owner falls back to the row's own sessionId.
    expect(state.collectorParentByChildSession.get('child_ses')).toBe('root');
  });

  it('internal build/plan task dispatches are exempt from the orphan count (AC-4)', () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'build', prompt: 'internal work' });
    const state = deriveRowGraphState(
      [],
      [
        toolRow({
          correlationId: 'internal-1',
          toolName: 'task',
          toolInputJson: TASK_ARGS,
          rawJson: JSON.stringify({ childSessionId: 'ses_internal_child' }),
        }),
      ],
    );
    // The dispatch is in the parent collector; the association pass adds the
    // exemption. Raw-material check: the args parse to the internal name.
    const call = state.toolCallsBySession.get('s1')!.get('internal-1')!;
    expect(JSON.parse(call.input).subagent_type).toBe('build');
  });
});

describe('re-key copies (first-match insert semantics, #2770/#523)', () => {
  it('a parent-keyed COPY of a child tool row collapses into the child-owner bucket — never a second entry', () => {
    const original = toolRow({
      sessionId: 'ses_child_1',
      correlationId: 'ses_child_1_1',
      isSubagent: true,
      toolName: 'Bash',
      toolOutputJson: 'files',
      rawJson: JSON.stringify({ parentSessionId: 's1' }),
    });
    const copy = { ...original, sessionId: 's1' }; // re-key copy under the parent

    const state = deriveRowGraphState([], [original, copy]);
    const buckets = state.subagentToolCalls.get('ses_child_1')!;
    expect([...buckets.keys()]).toEqual(['ses_child_1_1']);
    expect(buckets.get('ses_child_1_1')!.output).toBe('files');
    expect(state.subagentToolCalls.has('s1')).toBe(false);
  });

  it('the ORIGINAL beats a stale copy when both exist (the original keeps receiving live patches)', () => {
    const staleCopy = toolRow({
      sessionId: 's1',
      correlationId: 'ses_child_1_1',
      isSubagent: true,
      toolOutputJson: null, // frozen at re-key time — pre-completion
      rawJson: '{}',
    });
    const original = toolRow({
      sessionId: 'ses_child_1',
      correlationId: 'ses_child_1_1',
      isSubagent: true,
      toolOutputJson: 'files',
      rawJson: '{}',
    });

    const state = deriveRowGraphState([], [staleCopy, original]);
    const buckets = state.subagentToolCalls.get('ses_child_1')!;
    expect(buckets.get('ses_child_1_1')!.output).toBe('files');
    expect([...state.subagentToolCalls.keys()]).toEqual(['ses_child_1']);
  });

  it('late re-key stamps add a parent-keyed copy but do NOT grow the orphan material (R-1e no-growth)', () => {
    // Before the relationship: the child's calls are child-keyed originals.
    const before = deriveRowGraphState(
      [],
      [toolRow({ sessionId: 'ses_child_1', correlationId: 'ses_child_1_1', isSubagent: true, rawJson: JSON.stringify({ parentSessionId: 's1' }) })],
    );
    const beforeEntries = [...(before.subagentToolCalls.get('ses_child_1')?.values() ?? [])].length;

    // After the relationship registers: a parent-keyed copy arrives (insert).
    const after = deriveRowGraphState(
      [
        // The typed chat stamp pair the re-key writes (KeepFirst through later
        // patches — the merge rules preserve it).
        chatRow({ correlationId: 'child-turn', parentSessionId: 's1', compositedChildSessionId: 'ses_child_1' }),
      ],
      [
        toolRow({ sessionId: 'ses_child_1', correlationId: 'ses_child_1_1', isSubagent: true, rawJson: JSON.stringify({ parentSessionId: 's1' }) }),
        toolRow({ sessionId: 's1', correlationId: 'ses_child_1_1', isSubagent: true, rawJson: JSON.stringify({ parentSessionId: 's1' }) }),
      ],
    );
    const afterEntries = [...(after.subagentToolCalls.get('ses_child_1')?.values() ?? [])].length;

    expect(beforeEntries).toBe(1);
    expect(afterEntries).toBe(1); // the copy collapsed — no second entry
    expect(after.collectorParentByChildSession.get('ses_child_1')).toBe('s1');
  });
});

describe('chat chain + ordering', () => {
  it('nodeOrder is chronological (span start ascending, unresolved last) and prevCorrId chains per session', () => {
    const state = deriveRowGraphState(
      [
        chatRow({ correlationId: 'late', startedAtNs: Date.parse(T2) * 1e6 }),
        chatRow({ correlationId: 'early', startedAtNs: Date.parse(T0) * 1e6 }),
        chatRow({ correlationId: 'mid', startedAtNs: Date.parse(T1) * 1e6, sessionId: 's2' }),
      ],
      [],
    );
    expect(state.agentOrder).toEqual(['early', 'mid', 'late']);
    expect(state.lastAgentBySession.get('s1')).toBe('late');
    expect(state.lastAgentBySession.get('s2')).toBe('mid');
    // 'late' chains to 'early' (its session's nearest preceding row).
    expect(state.agentNodes.get('late')?.prevCorrId).toBe('early');
  });
});

describe('sessionHasAnyRow (G-074 ghost boundary, Spec #2791)', () => {
  it('is true when the session has a chat row, a tool row, or both', () => {
    expect(sessionHasAnyRow([chatRow({ sessionId: 's1' })], [], 's1')).toBe(true);
    expect(sessionHasAnyRow([], [toolRow({ sessionId: 's1' })], 's1')).toBe(true);
    expect(sessionHasAnyRow([chatRow({ sessionId: 's1' })], [toolRow({ sessionId: 's1' })], 's1')).toBe(true);
  });

  it('is false when the session has NO rows in either source', () => {
    expect(sessionHasAnyRow([], [], 's1')).toBe(false);
  });

  it('scopes to the selected session (does not match other sessions\u2019 rows)', () => {
    const chat = [chatRow({ sessionId: 's1' }), chatRow({ sessionId: 's2' })];
    const tools = [toolRow({ sessionId: 's2' })];
    expect(sessionHasAnyRow(chat, tools, 's1')).toBe(true); // s1 has a chat row
    expect(sessionHasAnyRow(chat, tools, 's3')).toBe(false); // s3 has none
    expect(sessionHasAnyRow([chatRow({ sessionId: 's1' })], tools, 's2')).toBe(true); // s2 has a tool row
  });

  it('is false for an empty/no selection (nothing can be a ghost)', () => {
    expect(sessionHasAnyRow([chatRow()], [], '')).toBe(false);
  });
});
