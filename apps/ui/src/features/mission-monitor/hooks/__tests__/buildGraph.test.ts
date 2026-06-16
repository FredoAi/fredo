/**
 * Tests for buildGraphFromEvents — stateless turn grouping.
 *
 * Run with: pnpm --filter @fredo/ui test:run -- --testPathPattern buildGraph
 */

import { describe, it, expect } from 'vitest';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';
import { buildGraphFromEvents, reduceGraph, createInitialIncrementalState } from '../useMissionMonitor';
import type { IncrementalState } from '../useMissionMonitor';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeMsgUpdated(
  id: string,
  role: 'user' | 'assistant',
  overrides: Partial<Record<string, any>> = {}
): FredoEvent {
  const info: Record<string, any> = {
    id,
    role,
    sessionID: 's1',
    parentID: overrides.parentID,
    tokens: { input: 10, output: 50 },
    time: { created: Date.now() / 1000, completed: overrides.completed },
    modelID: overrides.modelID ?? 'claude-sonnet-4',
    providerID: 'anthropic',
    ...overrides,
  };
  return {
    id: `evt-${id}`,
    eventType: 'chat',
    state: 'Update',
    provider: 'open_code',
    transport: 'hook',
    sessionId: 's1',
    toolName: 'message.updated',
    // Match the OpenCodeAdapter's actual output: properties is UNWRAPPED,
    // so the payload is { info: {...} } not { properties: { info: {...} } }.
    // The buildGraphFromEvents function handles BOTH shapes via fallback.
    payload: { info },
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
}

function makePartUpdated(
  partId: string,
  messageID: string,
  type: string,
  text: string,
  overrides: Record<string, any> = {}
): FredoEvent {
  const part: Record<string, any> = {
    id: partId,
    type,
    messageID,
    text,
    sessionID: 's1',
    ...overrides,
  };
  return {
    id: `evt-part-${partId}`,
    eventType: 'chat',
    state: 'Update',
    provider: 'open_code',
    transport: 'hook',
    sessionId: 's1',
    toolName: 'message.part.updated',
    // Match the OpenCodeAdapter's actual output: properties is UNWRAPPED,
    // so the payload is { part: {...} } not { properties: { part: {...} } }.
    payload: { part },
    timestamp: new Date().toISOString(),
  };
}

/** Make a delta part (has `delta` but no `text`) */
function makeDeltaPart(
  partId: string,
  messageID: string,
  type: string,
  delta: string
): FredoEvent {
  const part: Record<string, any> = {
    id: partId,
    type,
    messageID,
    delta,
    sessionID: 's1',
  };
  return {
    id: `evt-delta-${partId}`,
    eventType: 'chat',
    state: 'Update',
    provider: 'open_code',
    transport: 'hook',
    sessionId: 's1',
    toolName: 'message.part.updated',
    // Adapter-unwrapped shape: { part: {...} }
    payload: { part },
    timestamp: new Date().toISOString(),
  };
}

function makeFileEdited(filePath: string, timestamp: string): FredoEvent {
  return {
    id: `evt-file-${filePath}`,
    eventType: 'custom',
    state: 'Response',
    provider: 'open_code',
    transport: 'hook',
    sessionId: 's1',
    toolName: 'file.edited',
    payload: { properties: { file: filePath } },
    timestamp,
  };
}

/** Make a legacy OTLP chat/invoke_agent event */
function makeLegacyEvent(
  toolName: string,
  userPrompt: string,
  response: string,
  model: string,
  timestamp: string
): FredoEvent {
  return {
    id: `evt-legacy-${timestamp}`,
    eventType: 'chat',
    state: 'Update',
    provider: 'open_code',
    transport: 'otlp_http',
    sessionId: 's1',
    toolName,
    payload: {
      'gen_ai.input.messages': JSON.stringify([
        { role: 'user', parts: [{ type: 'text', content: userPrompt }] },
      ]),
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', parts: [{ type: 'text', content: response }] },
      ]),
      'gen_ai.response.model': model,
    },
    timestamp,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildGraphFromEvents', () => {
  it('should return empty for empty events (AC-DP3 edge case)', () => {
    const result = buildGraphFromEvents([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('should create one ChatNode for a single complete turn', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: userTs,
        completed: undefined,
        modelID: 'claude-sonnet-4',
      }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello, can you help me?'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: assistantTs,
        completed,
        modelID: 'claude-sonnet-4',
      }),
      makePartUpdated('p2', 'msg-a1', 'reasoning', 'Let me think about this...'),
      makePartUpdated('p3', 'msg-a1', 'text', 'Sure, I can help!'),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].type).toBe('chatNode');
    expect(result.nodes[0].data.eventType).toBe('chat');
    expect(result.nodes[0].data.status).toBe('inactive');

    const payload = result.nodes[0].data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('Hello, can you help me?');
    expect(payload.userTimestamp).toBe(userTs);
    expect(payload.thinkingText).toBe('Let me think about this...');
    expect(payload.responseText).toBe('Sure, I can help!');
    expect(payload.turnTools).toBe(0);
    expect(payload.turnFiles).toBe(0);
    expect(payload.model).toBe('claude-sonnet-4');

    expect(result.edges).toHaveLength(0);
  });

  it('should skip incomplete turns (missing time.completed — REQ-5)', () => {
    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, completed: undefined }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
      // Assistant message WITHOUT time.completed
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        completed: undefined, // No completion time
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Hi there!'),
    ];

    const result = buildGraphFromEvents(events);

    // Incomplete turn should be skipped — no ChatNode rendered
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should ignore delta-only parts (REQ-6)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
      // Assistant with reasoning (should still be included)
      makePartUpdated('p2', 'msg-a1', 'reasoning', 'Thinking...'),
      // Delta-only parts (no text field) — should be ignored
      makeDeltaPart('p-delta1', 'msg-a1', 'text', 'stream'),
      makeDeltaPart('p-delta2', 'msg-a1', 'text', 'ing'),
      // Final text part with real text — should be included
      makePartUpdated('p3', 'msg-a1', 'text', 'Final response'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: assistantTs,
        completed,
      }),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    const payload = result.nodes[0].data.payload as Record<string, any>;
    // Response should be ONLY the final text, not delta accumulation
    expect(payload.responseText).toBe('Final response');
    expect(payload.thinkingText).toBe('Thinking...');
  });

  it('should create multiple ChatNodes with edges for multiple turns', () => {
    const baseTs = '2026-06-15T10:00:00.000Z';
    const completions = [
      { user: 'msg-u1', assistant: 'msg-a1', userPrompt: 'Turn 1', response: 'Response 1', ts: 0 },
      { user: 'msg-u2', assistant: 'msg-a2', userPrompt: 'Turn 2', response: 'Response 2', ts: 60 },
    ];

    const events: FredoEvent[] = [];
    for (const turn of completions) {
      const userTimestamp = new Date(new Date(baseTs).getTime() + turn.ts * 1000).toISOString();
      const assistantTimestamp = new Date(new Date(baseTs).getTime() + (turn.ts + 30) * 1000).toISOString();
      const completed = new Date(assistantTimestamp).getTime() / 1000;

      events.push(
        makeMsgUpdated(turn.user, 'user', { parentID: undefined, timestamp: userTimestamp, completed: undefined }),
        makePartUpdated(`p-${turn.user}`, turn.user, 'text', turn.userPrompt),
        makeMsgUpdated(turn.assistant, 'assistant', { parentID: turn.user, timestamp: assistantTimestamp, completed }),
        makePartUpdated(`p-${turn.assistant}`, turn.assistant, 'text', turn.response),
      );
    }

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);

    // First turn
    expect(result.nodes[0].data.payload.userPrompt).toBe('Turn 1');
    // Second turn
    expect(result.nodes[1].data.payload.userPrompt).toBe('Turn 2');
    // Edge connects them
    expect(result.edges[0].source).toBe(result.nodes[0].id);
    expect(result.edges[0].target).toBe(result.nodes[1].id);
  });

  it('should count unique tool parts per turn (REQ-7)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
      makeMsgUpdated('msg-a1', 'assistant', { parentID: 'msg-u1', timestamp: assistantTs, completed }),
      makePartUpdated('p2', 'msg-a1', 'reasoning', 'Let me check...'),
      // Three tool parts, one duplicate partId (should dedupe to 2)
      makePartUpdated('tool-1', 'msg-a1', 'tool', '', { tool: 'edit' }),
      makePartUpdated('tool-2', 'msg-a1', 'tool', '', { tool: 'read' }),
      makePartUpdated('tool-1', 'msg-a1', 'tool', '', { tool: 'edit' }), // duplicate partId
      makePartUpdated('p3', 'msg-a1', 'text', 'Response'),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    const payload = result.nodes[0].data.payload as Record<string, any>;
    expect(payload.turnTools).toBe(2); // 2 unique part IDs
  });

  it('should count unique file.edited paths per turn (REQ-7)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    // File events at specific times within the turn window
    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Edit files'),
      makeMsgUpdated('msg-a1', 'assistant', { parentID: 'msg-u1', timestamp: assistantTs, completed }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Done'),
      // Two unique files edited within the turn window
      makeFileEdited('/src/file1.ts', '2026-06-15T10:00:30.000Z'),
      makeFileEdited('/src/file2.ts', '2026-06-15T10:00:45.000Z'),
      makeFileEdited('/src/file1.ts', '2026-06-15T10:00:50.000Z'), // duplicate
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    const payload = result.nodes[0].data.payload as Record<string, any>;
    expect(payload.turnFiles).toBe(2); // 2 unique file paths
  });

  it('should extract model name from assistant message (REQ-7)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { timestamp: userTs, modelID: 'user-model' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: assistantTs,
        completed,
        modelID: 'claude-opus-4',
        providerID: 'anthropic',
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Hello!'),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    const payload = result.nodes[0].data.payload as Record<string, any>;
    // Model should come from assistant message, not user
    expect(payload.model).toBe('claude-opus-4');
    expect(result.nodes[0].data.label).toBe('claude-opus-4');
  });

  it('should link assistant to correct user via parentID', () => {
    const baseTs = '2026-06-15T10:00:00.000Z';
    const completed1 = new Date('2026-06-15T10:01:00.000Z').getTime() / 1000;
    const completed2 = new Date('2026-06-15T10:02:00.000Z').getTime() / 1000;

    // Two users with crossed parentIDs:
    // msg-u1 → msg-a2 (wrong)
    // msg-u2 → msg-a1 (wrong)
    // This tests that parentID correctly pairs msg-u1→msg-a1 and msg-u2→msg-a2
    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { timestamp: baseTs }),
      makePartUpdated('p1', 'msg-u1', 'text', 'First question'),
      makeMsgUpdated('msg-u2', 'user', {
        timestamp: '2026-06-15T10:00:30.000Z',
      }),
      makePartUpdated('p2', 'msg-u2', 'text', 'Second question'),

      // Assistant 1 links to msg-u1
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: completed1,
      }),
      makePartUpdated('p3', 'msg-a1', 'text', 'Answer to first'),

      // Assistant 2 links to msg-u2
      makeMsgUpdated('msg-a2', 'assistant', {
        parentID: 'msg-u2',
        timestamp: '2026-06-15T10:02:00.000Z',
        completed: completed2,
      }),
      makePartUpdated('p4', 'msg-a2', 'text', 'Answer to second'),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(2);

    // First node: msg-u1→msg-a1
    expect(result.nodes[0].data.payload.userPrompt).toBe('First question');
    expect(result.nodes[0].data.payload.responseText).toBe('Answer to first');

    // Second node: msg-u2→msg-a2
    expect(result.nodes[1].data.payload.userPrompt).toBe('Second question');
    expect(result.nodes[1].data.payload.responseText).toBe('Answer to second');
  });

  it('should handle legacy OTLP fallback (REQ-12)', () => {
    // No message.updated events — only OTLP chat/invoke_agent events
    const events: FredoEvent[] = [
      makeLegacyEvent('chat', 'Hello!', 'Hi there!', 'gpt-4', '2026-06-15T10:00:00.000Z'),
      makeLegacyEvent('invoke_agent', 'How are you?', 'I am fine!', 'claude-3',
        '2026-06-15T10:01:00.000Z'),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);

    // First ChatNode from 'chat' event
    expect(result.nodes[0].type).toBe('chatNode');
    const payload0 = result.nodes[0].data.payload as Record<string, any>;
    expect(payload0.userPrompt).toBe('Hello!');
    expect(payload0.responseText).toBe('Hi there!');
    expect(payload0.model).toBe('gpt-4');

    // Second ChatNode from 'invoke_agent' event
    const payload1 = result.nodes[1].data.payload as Record<string, any>;
    expect(payload1.userPrompt).toBe('How are you?');
    expect(payload1.responseText).toBe('I am fine!');
    expect(payload1.model).toBe('claude-3');

    // Edge connects them
    expect(result.edges[0].source).toBe(result.nodes[0].id);
    expect(result.edges[0].target).toBe(result.nodes[1].id);
  });

  it('should handle legacy fallback with no chat/invoke_agent events', () => {
    // Events with no message.updated AND no chat/invoke_agent
    const events: FredoEvent[] = [
      {
        id: 'evt-1',
        eventType: 'tool_use',
        state: 'Init',
        provider: 'open_code',
        transport: 'hook',
        sessionId: 's1',
        toolName: 'SessionStart',
        payload: { session_id: 's1' },
        timestamp: '2026-06-15T10:00:00.000Z',
      },
    ];

    const result = buildGraphFromEvents(events);

    // Should handle safely with empty result
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should handle file.edited with payload.file_path fallback', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { timestamp: userTs }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi'),
      makeMsgUpdated('msg-a1', 'assistant', { parentID: 'msg-u1', timestamp: assistantTs, completed }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Hello'),
      // File edited with payload.file_path instead of properties.file
      {
        id: 'evt-file-1',
        eventType: 'custom',
        state: 'Response',
        provider: 'open_code',
        transport: 'hook',
        sessionId: 's1',
        toolName: 'file.edited',
        payload: { file_path: '/src/app.ts' },
        timestamp: '2026-06-15T10:00:30.000Z',
      },
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    const payload = result.nodes[0].data.payload as Record<string, any>;
    expect(payload.turnFiles).toBe(1);
  });

  it('should sort user messages by timestamp', () => {
    const events: FredoEvent[] = [];

    // Out of order: second user registered before first in the events list
    for (let i = 2; i >= 1; i--) {
      const ts = new Date(`2026-06-15T10:0${i}:00.000Z`);
      const userTs = ts.toISOString();
      const assistantTs = new Date(ts.getTime() + 60000).toISOString();
      const completed = new Date(assistantTs).getTime() / 1000;

      events.push(
        makeMsgUpdated(`msg-u${i}`, 'user', { timestamp: userTs }),
        makePartUpdated(`p-u${i}`, `msg-u${i}`, 'text', `Turn ${i}`),
        makeMsgUpdated(`msg-a${i}`, 'assistant', {
          parentID: `msg-u${i}`,
          timestamp: assistantTs,
          completed,
        }),
        makePartUpdated(`p-a${i}`, `msg-a${i}`, 'text', `Response ${i}`),
      );
    }

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].data.payload.userPrompt).toBe('Turn 1');
    expect(result.nodes[1].data.payload.userPrompt).toBe('Turn 2');
  });

  // ── Bug regression: AC-DP3 deduplication ─────────────────────────────────

  it('should deduplicate duplicate message.updated events for the same message ID (Bug 1 regression)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    // Simulate what OpenCode SDK actually does: emit MULTIPLE message.updated
    // events for the same message (e.g., initial creation + later token update).
    const events: FredoEvent[] = [
      // User message — emitted 3 times (initial + updates with model info)
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs, modelID: undefined }),
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs, modelID: 'claude-sonnet-4' }),
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs, modelID: 'claude-sonnet-4', extra: true }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),

      // Assistant message — emitted twice (creation + completion with tokens)
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed: undefined,
      }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
        tokens: { input: 500, output: 200 },
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Response'),
    ];

    const result = buildGraphFromEvents(events);

    // Should produce exactly ONE ChatNode, not one per duplicate event
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].type).toBe('chatNode');
    const payload = result.nodes[0].data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('Hello!');
    expect(payload.responseText).toBe('Response');
  });

  it('should deduplicate multiple turns when each has duplicate message.updated events', () => {
    const baseTs = '2026-06-15T10:00:00.000Z';
    const events: FredoEvent[] = [];

    for (let t = 1; t <= 3; t++) {
      const userTs = new Date(new Date(baseTs).getTime() + t * 120000).toISOString();
      const assistantTs = new Date(new Date(baseTs).getTime() + t * 120000 + 60000).toISOString();
      const completed = new Date(assistantTs).getTime() / 1000;
      const uid = `msg-u${t}`;
      const aid = `msg-a${t}`;

      // 3 duplicates of user message.updated
      events.push(
        makeMsgUpdated(uid, 'user', { parentID: undefined, timestamp: userTs }),
        makeMsgUpdated(uid, 'user', { parentID: undefined, timestamp: userTs, modelID: 'test' }),
        makeMsgUpdated(uid, 'user', { parentID: undefined, timestamp: userTs, extra: true }),
        makePartUpdated(`p-${uid}`, uid, 'text', `Turn ${t}`),
        // 2 duplicates of assistant message.updated
        makeMsgUpdated(aid, 'assistant', { parentID: uid, timestamp: assistantTs }),
        makeMsgUpdated(aid, 'assistant', { parentID: uid, timestamp: assistantTs, completed }),
        makePartUpdated(`p-${aid}`, aid, 'text', `Response ${t}`),
      );
    }

    const result = buildGraphFromEvents(events);

    // Should produce exactly 3 ChatNodes (one per turn), not 9 or more
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].data.payload.userPrompt).toBe('Turn 1');
    expect(result.nodes[1].data.payload.userPrompt).toBe('Turn 2');
    expect(result.nodes[2].data.payload.userPrompt).toBe('Turn 3');
    expect(result.edges).toHaveLength(2); // edges between consecutive nodes
  });

  // ── Bug regression: Ghost node guard (Architecture Escalation D) ──────────

  it('should skip turns with empty user prompt AND empty response text (ghost guard)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      // User message with NO text part — only empty metadata
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs }),
      // Assistant message with completed time but NO text parts
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
      }),
      // Both messages have no parts, so userPrompt="" and responseText=""
      // → ghost guard should skip this turn
    ];

    const result = buildGraphFromEvents(events);

    // Ghost turn should be skipped — 0 ChatNodes
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should NOT skip turns with only user prompt (non-empty)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs }),
      makePartUpdated('p1', 'msg-u1', 'text', 'What is this?'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
      }),
      // No assistant text parts — responseText will be ""
      // But userPrompt is non-empty, so ghost guard should NOT skip
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    const payload = result.nodes[0].data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('What is this?');
    expect(payload.responseText).toBe('');
  });

  it('should NOT skip turns with only response text (non-empty)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs }),
      // No user text parts — userPrompt will be ""
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Here is the answer'),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    const payload = result.nodes[0].data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('');
    expect(payload.responseText).toBe('Here is the answer');
  });
});

// ── Incremental Graph Reducer (REQ-1 — live mode) ─────────────────────────────

describe('reduceGraph', () => {
  /** Helper: apply a series of events through the reducer and return the final state */
  function reduceEvents(events: FredoEvent[]): IncrementalState {
    let state = createInitialIncrementalState();
    for (const ev of events) {
      const next = reduceGraph(state, ev);
      expect(next).not.toBe(state); // assert each event causes a change
      state = next;
    }
    return state;
  }

  /** Helper: apply events, some of which may NOT cause a change (no assert) */
  function reduceEventsLax(events: FredoEvent[]): IncrementalState {
    let state = createInitialIncrementalState();
    for (const ev of events) {
      state = reduceGraph(state, ev);
    }
    return state;
  }

  // ── AC-1: Node creation on user message with stable ID ────────────────────

  it('should create a ChatNode when user message.updated arrives (AC-1)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
      }),
    ]);

    expect(state.nodes.size).toBe(1);
    const node = state.nodes.get('mm-msg-u1');
    expect(node).toBeDefined();
    expect(node!.id).toBe('mm-msg-u1');
    expect(node!.type).toBe('chatNode');
    expect(node!.data.status).toBe('working');
    expect(node!.data.eventType).toBe('chat');
  });

  // ── AC-1: Subsequent parts update same node ───────────────────────────────

  it('should update the same ChatNode when text parts arrive (AC-1)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
    ]);

    expect(state.nodes.size).toBe(1);
    const node = state.nodes.get('mm-msg-u1')!;
    const payload = node.data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('Hello!');
  });

  it('should append text to userPrompt for multiple user text parts', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello'),
      makePartUpdated('p2', 'msg-u1', 'text', ' world!'),
    ]);

    const payload = state.nodes.get('mm-msg-u1')!.data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('Hello world!');
  });

  // ── AC-2: New status is "working" (not inactive) ──────────────────────────

  it('should create node with status "working" (AC-2)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
    ]);

    expect(state.nodes.get('mm-msg-u1')!.data.status).toBe('working');
  });

  // ── AC-3: Reasoning → thinkingText, Assistant text → responseText ─────────

  it('should route reasoning parts to thinkingText (AC-3)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi!'),
      // Part for assistant message arrives BEFORE assistant message.updated → buffered
      makePartUpdated('p2', 'msg-a1', 'reasoning', 'Thinking...'),
      // Now assistant message.updated links msg-a1 to msg-u1 → pending parts applied
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    const payload = state.nodes.get('mm-msg-u1')!.data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('Hi!');
    expect(payload.thinkingText).toBe('Thinking...');
    expect(payload.responseText).toBe('');
  });

  it('should route assistant text parts to responseText (AC-3)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi!'),
      // Assistant parts before assistant message.updated
      makePartUpdated('p2', 'msg-a1', 'text', 'Sure,'),
      makePartUpdated('p3', 'msg-a1', 'text', ' I can help!'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    const payload = state.nodes.get('mm-msg-u1')!.data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('Hi!');
    expect(payload.responseText).toBe('Sure, I can help!');
    expect(payload.thinkingText).toBe('');
  });

  // ── AC-4: Assistant message with time.completed marks node inactive ───────

  it('should mark node as inactive when assistant message has time.completed (AC-4)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    const node = state.nodes.get('mm-msg-u1')!;
    expect(node.data.status).toBe('inactive');
  });

  it('should keep node as working when assistant message lacks time.completed', () => {
    const state = reduceEventsLax([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: undefined,
      }),
    ]);

    const node = state.nodes.get('mm-msg-u1')!;
    expect(node.data.status).toBe('working');
  });

  // ── AC-4: completedNodeCount increments on completion (REQ-7) ─────────────

  it('should increment completedNodeCount when node transitions to inactive (REQ-7)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    expect(state.completedNodeCount).toBe(1);
  });

  it('should NOT increment completedNodeCount when node stays working', () => {
    const state = reduceEventsLax([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      // Assistant without completion → node stays working
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: undefined,
      }),
    ]);

    expect(state.completedNodeCount).toBe(0);
  });

  // ── AC-5: Ghost prevention — node never removed ──────────────────────────

  it('should never remove a node once created (ghost prevention — AC-5)', () => {
    const state = reduceEventsLax([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      // Incomplete turn — but node should stay (unlike buildGraphFromEvents which skips)
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: undefined,
      }),
    ]);

    // Node should still exist even though turn is incomplete
    expect(state.nodes.size).toBe(1);
    expect(state.nodes.has('mm-msg-u1')).toBe(true);
  });

  // ── Multi-turn: Two turns produce two nodes with an edge ──────────────────

  it('should create two nodes with edge for two turns', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Turn 1'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
      makeMsgUpdated('msg-u2', 'user', { parentID: undefined, timestamp: '2026-06-15T10:02:00.000Z' }),
      makePartUpdated('p2', 'msg-u2', 'text', 'Turn 2'),
      makeMsgUpdated('msg-a2', 'assistant', {
        parentID: 'msg-u2',
        timestamp: '2026-06-15T10:03:00.000Z',
        completed: new Date('2026-06-15T10:03:00.000Z').getTime() / 1000,
      }),
    ]);

    expect(state.nodes.size).toBe(2);
    expect(state.nodes.has('mm-msg-u1')).toBe(true);
    expect(state.nodes.has('mm-msg-u2')).toBe(true);
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0].source).toBe('mm-msg-u1');
    expect(state.edges[0].target).toBe('mm-msg-u2');
    expect(state.completedNodeCount).toBe(2);
  });

  // ── Stable IDs (REQ-2) ───────────────────────────────────────────────────

  it('should use mm-{messageID} as node ID (REQ-2)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-custom-1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
    ]);

    expect(state.nodes.has('mm-msg-custom-1')).toBe(true);
    expect(state.userNodeMap.get('msg-custom-1')).toBe('mm-msg-custom-1');
  });

  // ── Logging part arrival order (parts before assistant message) ───────────

  it('should handle parts arriving before assistant message.updated (buffered)', () => {
    // Events in real-world order: user message, user text, assistant text parts,
    // assistant reasoning parts, THEN assistant message.updated
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
      // These parts belong to msg-a1 which hasn't been linked yet → buffered
      makePartUpdated('p2', 'msg-a1', 'reasoning', 'Thinking...'),
      makePartUpdated('p3', 'msg-a1', 'text', 'Response text'),
      // Now assistant message.updated arrives — links to msg-u1, applies pending
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    const payload = state.nodes.get('mm-msg-u1')!.data.payload as Record<string, any>;
    expect(payload.userPrompt).toBe('Hello!');
    expect(payload.thinkingText).toBe('Thinking...');
    expect(payload.responseText).toBe('Response text');
    expect(state.nodes.get('mm-msg-u1')!.data.status).toBe('inactive');
  });

  // ── Duplicate user message.updated (same ID) is idempotent ────────────────

  it('should ignore duplicate user message.updated events (idempotent)', () => {
    let state = createInitialIncrementalState();
    state = reduceGraph(state, makeMsgUpdated('msg-u1', 'user', {
      parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z',
    }));
    const firstNodeId = state.userNodeMap.get('msg-u1');
    expect(state.nodes.size).toBe(1);

    // Second message.updated for same ID
    const state2 = reduceGraph(state, makeMsgUpdated('msg-u1', 'user', {
      parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z',
    }));
    expect(state2).toBe(state); // reference equality = no change
    expect(state2.nodes.size).toBe(1);
  });

  // ── Delta parts are ignored (isFinalPart check) ──────────────────────────

  it('should ignore delta-only parts (isFinalPart)', () => {
    let state = createInitialIncrementalState();
    state = reduceGraph(state, makeMsgUpdated('msg-u1', 'user', {
      parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z',
    }));

    // Delta part (no text field) should be ignored
    const state2 = reduceGraph(state, makeDeltaPart('delta1', 'msg-u1', 'text', 'stream'));
    expect(state2).toBe(state); // no change
  });

  // ── tool parts are counted per turn ──────────────────────────────────────

  it('should increment turnTools for tool parts (unique partId)', () => {
    const state = reduceEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi!'),
      // Tool parts for assistant message → buffered
      makePartUpdated('tool-1', 'msg-a1', 'tool', '', { tool: 'edit' }),
      makePartUpdated('tool-2', 'msg-a1', 'tool', '', { tool: 'read' }),
      makePartUpdated('tool-1', 'msg-a1', 'tool', '', { tool: 'edit' }), // duplicate partId
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    const payload = state.nodes.get('mm-msg-u1')!.data.payload as Record<string, any>;
    expect(payload.turnTools).toBe(2); // 2 unique part IDs
  });

  // ── file.edited increments the counters ──────────────────────────────────

  it('should increment file counter on file.edited events (REQ-9)', () => {
    let state = createInitialIncrementalState();
    state = reduceGraph(state, makeFileEdited('/src/file1.ts', '2026-06-15T10:00:00.000Z'));
    expect(state.counters.files).toBe(1);

    state = reduceGraph(state, makeFileEdited('/src/file2.ts', '2026-06-15T10:00:01.000Z'));
    expect(state.counters.files).toBe(2);
  });

  // ── Empty events list → empty state ─────────────────────────────────────

  it('should return empty state for initial state', () => {
    const state = createInitialIncrementalState();
    expect(state.nodes.size).toBe(0);
    expect(state.edges).toHaveLength(0);
    expect(state.counters).toEqual({ tools: 0, files: 0, subagents: 0, tokens: 0 });
    expect(state.completedNodeCount).toBe(0);
  });

  // ── Unknown events are ignored ───────────────────────────────────────────

  it('should ignore unknown event toolNames unchanged', () => {
    const state = createInitialIncrementalState();
    const unknownEvent: FredoEvent = {
      id: 'evt-unknown',
      eventType: 'custom',
      state: 'Update',
      provider: 'open_code',
      transport: 'hook',
      sessionId: 's1',
      toolName: 'SessionStart',
      payload: {},
      timestamp: new Date().toISOString(),
    };
    const result = reduceGraph(state, unknownEvent);
    expect(result).toBe(state);
  });
});
