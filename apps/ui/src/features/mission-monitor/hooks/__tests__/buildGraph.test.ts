/**
 * Tests for buildGraphFromEvents — stateless turn grouping.
 *
 * Run with: pnpm --filter @fredo/ui test:run -- --testPathPattern buildGraph
 */

import { describe, it, expect } from 'vitest';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';
import { buildGraphFromEvents, processChatNodeSubscription, createInitialProcessorState } from '../useMissionMonitor';
import type { ChatNodeContract, SubscriptionDelivery } from '../../../../shared/classes/EventSubscription';

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
    time: { created: Date.now() / 1000, completed: overrides.completed } as any,
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

// ── buildGraphFromEvents Tests ─────────────────────────────────────────────────

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

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { timestamp: baseTs }),
      makePartUpdated('p1', 'msg-u1', 'text', 'First question'),
      makeMsgUpdated('msg-u2', 'user', { timestamp: '2026-06-15T10:00:30.000Z' }),
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

    expect(result.nodes[0].data.payload.userPrompt).toBe('First question');
    expect(result.nodes[0].data.payload.responseText).toBe('Answer to first');
    expect(result.nodes[1].data.payload.userPrompt).toBe('Second question');
    expect(result.nodes[1].data.payload.responseText).toBe('Answer to second');
  });

  it('should handle legacy OTLP fallback (REQ-12)', () => {
    const events: FredoEvent[] = [
      makeLegacyEvent('chat', 'Hello!', 'Hi there!', 'gpt-4', '2026-06-15T10:00:00.000Z'),
      makeLegacyEvent('invoke_agent', 'How are you?', 'I am fine!', 'claude-3', '2026-06-15T10:01:00.000Z'),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);

    expect(result.nodes[0].type).toBe('chatNode');
    const payload0 = result.nodes[0].data.payload as Record<string, any>;
    expect(payload0.userPrompt).toBe('Hello!');
    expect(payload0.responseText).toBe('Hi there!');
    expect(payload0.model).toBe('gpt-4');

    const payload1 = result.nodes[1].data.payload as Record<string, any>;
    expect(payload1.userPrompt).toBe('How are you?');
    expect(payload1.responseText).toBe('I am fine!');
    expect(payload1.model).toBe('claude-3');

    expect(result.edges[0].source).toBe(result.nodes[0].id);
    expect(result.edges[0].target).toBe(result.nodes[1].id);
  });

  it('should handle legacy fallback with no chat/invoke_agent events', () => {
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

  it('should deduplicate duplicate message.updated events for the same message ID (Bug 1 regression)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs, modelID: undefined }),
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs, modelID: 'claude-sonnet-4' }),
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs, modelID: 'claude-sonnet-4', extra: true }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
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

      events.push(
        makeMsgUpdated(uid, 'user', { parentID: undefined, timestamp: userTs }),
        makeMsgUpdated(uid, 'user', { parentID: undefined, timestamp: userTs, modelID: 'test' }),
        makeMsgUpdated(uid, 'user', { parentID: undefined, timestamp: userTs, extra: true }),
        makePartUpdated(`p-${uid}`, uid, 'text', `Turn ${t}`),
        makeMsgUpdated(aid, 'assistant', { parentID: uid, timestamp: assistantTs }),
        makeMsgUpdated(aid, 'assistant', { parentID: uid, timestamp: assistantTs, completed }),
        makePartUpdated(`p-${aid}`, aid, 'text', `Response ${t}`),
      );
    }

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].data.payload.userPrompt).toBe('Turn 1');
    expect(result.nodes[1].data.payload.userPrompt).toBe('Turn 2');
    expect(result.nodes[2].data.payload.userPrompt).toBe('Turn 3');
    expect(result.edges).toHaveLength(2);
  });

  it('should skip turns with empty user prompt AND empty response text (ghost guard)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: userTs }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
      }),
    ];

    const result = buildGraphFromEvents(events);

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

// ── Subscription-Driven Processor (replaces reduceGraph) ──────────────────────

describe('processChatNodeSubscription', () => {
  /** Helper: apply a series of events through the subscription processor and collect deliveries */
  interface CollectedDelivery {
    delivery: SubscriptionDelivery<ChatNodeContract>;
    userTimestamp: string;
  }

  function processEvents(events: FredoEvent[]): {
    state: ReturnType<typeof createInitialProcessorState>;
    deliveries: CollectedDelivery[];
  } {
    let state = createInitialProcessorState();
    const deliveries: CollectedDelivery[] = [];

    for (const ev of events) {
      const next = processChatNodeSubscription(
        state,
        ev,
        (delivery, userTimestamp) => {
          deliveries.push({ delivery, userTimestamp });
        },
      );
      expect(next).not.toBe(state); // assert each event causes a change
      state = next;
    }

    return { state, deliveries };
  }

  /** Helper: apply events, some of which may NOT cause a change (no assert) */
  function processEventsLax(events: FredoEvent[]): {
    state: ReturnType<typeof createInitialProcessorState>;
    deliveries: CollectedDelivery[];
  } {
    let state = createInitialProcessorState();
    const deliveries: CollectedDelivery[] = [];

    for (const ev of events) {
      state = processChatNodeSubscription(
        state,
        ev,
        (delivery, userTimestamp) => {
          deliveries.push({ delivery, userTimestamp });
        },
      );
    }

    return { state, deliveries };
  }

  // ── AC-1: Node creation on user message with stable ID ────────────────────

  it('should create a ChatNodeContract when user message.updated arrives (AC-1)', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
      }),
    ]);

    expect(state.contracts.size).toBe(1);
    const contract = state.contracts.get('msg-u1');
    expect(contract).toBeDefined();
    expect(contract!.name).toBe('chat-node');
    expect(contract!.userMessage).toBe('');
    expect(contract!.agentThinking).toBe('');
    expect(contract!.agentReply).toBe('');
  });

  it('should deliver Init lifecycle for new user message', () => {
    const { deliveries } = processEvents([
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
      }),
    ]);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].delivery.lifecycle).toBe('Init');
    expect(deliveries[0].delivery.correlationId).toBe('msg-u1');
    expect(deliveries[0].delivery.contract.userMessage).toBe('');
    expect(deliveries[0].delivery.contract.agentThinking).toBe('');
    expect(deliveries[0].delivery.contract.agentReply).toBe('');
  });

  // ── AC-1: Subsequent parts update same contract ───────────────────────────

  it('should update the same ChatNodeContract when text parts arrive (AC-1)', () => {
    const { state, deliveries } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
    ]);

    expect(state.contracts.size).toBe(1);
    const contract = state.contracts.get('msg-u1')!;
    expect(contract.userMessage).toBe('Hello!'); // user text goes to userMessage
    expect(contract.agentReply).toBe(''); // no assistant text yet
  });

  it('should deliver Update lifecycle for parts', () => {
    const { deliveries } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
    ]);

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].delivery.lifecycle).toBe('Init');
    expect(deliveries[1].delivery.lifecycle).toBe('Update');
  });

  // ── Reasonig → agentThinking ─────────────────────────────────

  it('should route reasoning parts to agentThinking', () => {
    const { state, deliveries } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi!'),
      makePartUpdated('p2', 'msg-a1', 'reasoning', 'Thinking...'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.agentThinking).toBe('Thinking...');
    expect(contract.agentReply).toBe('');
  });

  it('should route assistant text parts to agentReply', () => {
    // message.part.updated carries FULL accumulated text of the part, not deltas.
    // Multiple updates to the same part ID replace, not concatenate.
    const { state, deliveries } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi!'),
      makePartUpdated('p2', 'msg-a1', 'text', 'Sure,'),
      makePartUpdated('p2', 'msg-a1', 'text', 'Sure, I can help!'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.agentReply).toBe('Sure, I can help!');
  });

  // ── End lifecycle delivery ───────────────────────────────────

  it('should deliver End lifecycle when assistant message has time.completed', () => {
    const { deliveries } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    // Init + End
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].delivery.lifecycle).toBe('Init');
    expect(deliveries[1].delivery.lifecycle).toBe('End');
  });

  it('should deliver Update (not End) when assistant message lacks time.completed', () => {
    const { deliveries } = processEventsLax([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: undefined,
      }),
    ]);

    // Init + Update (no End because incomplete)
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].delivery.lifecycle).toBe('Init');
    expect(deliveries[1].delivery.lifecycle).toBe('Update');
  });

  // ── Model from assistant message ──────────────────────────────

  it('should set model from assistant message', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi!'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
        modelID: 'claude-opus-4',
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.model).toBe('claude-opus-4');
  });

  // ── Multi-turn: Two turns produce two contracts ──────────────────

  it('should create two contracts for two turns', () => {
    const { state } = processEvents([
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

    expect(state.contracts.size).toBe(2);
    expect(state.contracts.has('msg-u1')).toBe(true);
    expect(state.contracts.has('msg-u2')).toBe(true);
  });

  // ── Stable IDs ────────────────────────────────────────────────

  it('should use messageID as correlationId (stable ID)', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-custom-1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
    ]);

    expect(state.contracts.has('msg-custom-1')).toBe(true);
  });

  // ── Pending parts (parts before assistant message) ────────────

  it('should handle parts arriving before assistant message.updated (buffered)', () => {
    const { state } = processEvents([
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

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.agentThinking).toBe('Thinking...');
    expect(contract.agentReply).toBe('Response text');
  });

  // ── Duplicate user message.updated is idempotent ──────────────

  it('should ignore duplicate user message.updated events (idempotent)', () => {
    let state = createInitialProcessorState();
    state = processChatNodeSubscription(
      state,
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      () => {},
    );
    expect(state.contracts.size).toBe(1);

    // Second message.updated for same ID
    const state2 = processChatNodeSubscription(
      state,
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      () => {},
    );
    expect(state2).toBe(state); // reference equality = no change
    expect(state2.contracts.size).toBe(1);
  });

  // ── Delta parts are ignored ──────────────────────────────────

  it('should ignore delta-only parts (isFinalPart)', () => {
    let state = createInitialProcessorState();
    state = processChatNodeSubscription(
      state,
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      () => {},
    );

    const state2 = processChatNodeSubscription(
      state,
      makeDeltaPart('delta1', 'msg-u1', 'text', 'stream'),
      () => {},
    );
    expect(state2).toBe(state); // no change
  });

  // ── Tool parts ───────────────────────────────────────────────

  it('should increment turnTools for tool parts', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi!'),
      makePartUpdated('tool-1', 'msg-a1', 'tool', '', { tool: 'edit' }),
      makePartUpdated('tool-2', 'msg-a1', 'tool', '', { tool: 'read' }),
      makePartUpdated('tool-1', 'msg-a1', 'tool', '', { tool: 'edit' }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.turnTools).toBe(3); // Each tool part increments turnTools
  });

  // ── Empty initial state ──────────────────────────────────────

  it('should return empty state for initial state', () => {
    const state = createInitialProcessorState();
    expect(state.contracts.size).toBe(0);
    expect(state.nodeOrder).toHaveLength(0);
  });

  // ── Unknown events are ignored ───────────────────────────────

  // ── AC-6: Token extraction from assistant events ──────────────

  it('should capture turnInputTokens and turnOutputTokens from assistant info.tokens (AC-6)', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
        // Custom tokens override the default makeMsgUpdated tokens
        tokens: { input: 100, output: 500, reasoning: 20, cache: { read: 0, write: 0 } },
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.turnInputTokens).toBe(100);
    expect(contract.turnOutputTokens).toBe(500);
  });

  it('should accumulate tokens when multiple assistant events arrive (AC-6)', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hello!'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: undefined,
        tokens: { input: 60, output: 30 },
      }),
      // Second event with more tokens
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:30.000Z',
        completed: new Date('2026-06-15T10:01:30.000Z').getTime() / 1000,
        tokens: { input: 90, output: 70 },
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.turnInputTokens).toBe(150); // 60 + 90
    expect(contract.turnOutputTokens).toBe(100); // 30 + 70
  });

  it('should not set tokens when assistant event has no tokens field (AC-6 edge case)', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
        tokens: undefined as any,
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.turnInputTokens).toBeUndefined();
    expect(contract.turnOutputTokens).toBeUndefined();
  });

  // ── AC-7: Agent extraction from user events ───────────────────

  it('should capture agent from user message.updated info.agent (AC-7)', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
        agent: 'Architect',
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.agent).toBe('Architect');
  });

  it('should preserve agent throughout turn lifecycle (AC-7)', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
        agent: 'Debugger',
      }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Fix this bug'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1',
        timestamp: '2026-06-15T10:01:00.000Z',
        completed: new Date('2026-06-15T10:01:00.000Z').getTime() / 1000,
        modelID: 'claude-sonnet-4',
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Fixed!'),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.agent).toBe('Debugger');
  });

  it('should leave agent undefined when user message has no agent (AC-7 edge case)', () => {
    const { state } = processEvents([
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
        agent: undefined,
      }),
    ]);

    const contract = state.contracts.get('msg-u1')!;
    expect(contract.agent).toBeUndefined();
  });

  // ── AC-1 / AC-3: buildGraphFromEvents surfaces tokens + agent in TurnPayload ──

  it('should surface turnInputTokens and turnOutputTokens in buildGraphFromEvents TurnPayload (AC-1)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined, timestamp: userTs, completed: undefined,
        agent: 'Architect',
      }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Show tokens'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
        modelID: 'claude-sonnet-4',
        tokens: { input: 420, output: 1840 },
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Here they are'),
    ];

    const result = buildGraphFromEvents(events);

    expect(result.nodes).toHaveLength(1);
    const payload = result.nodes[0].data.payload as Record<string, any>;
    expect(payload.turnInputTokens).toBe(420);
    expect(payload.turnOutputTokens).toBe(1840);
    expect(payload.agent).toBe('Architect');
    expect(payload.model).toBe('claude-sonnet-4');
  });

  it('should compute label with agent·model format in buildGraphFromEvents (AC-3)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined, timestamp: userTs,
        agent: 'Architect',
      }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Build it'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
        modelID: 'claude-sonnet-4',
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Done'),
    ];

    const result = buildGraphFromEvents(events);
    expect(result.nodes).toHaveLength(1);
    // Label should include agent and model
    expect(result.nodes[0].data.label).toBe('Architect · claude-sonnet-4');
  });

  it('should fall back to model-only label when agent is absent (AC-3b)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined, timestamp: userTs,
        agent: undefined,
      }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi'),
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
        modelID: 'claude-sonnet-4',
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Hello'),
    ];

    const result = buildGraphFromEvents(events);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].data.label).toBe('claude-sonnet-4');
  });

  it('should fall back to "Assistant" when neither agent nor model present (AC-3c)', () => {
    const userTs = '2026-06-15T10:00:00.000Z';
    const assistantTs = '2026-06-15T10:01:00.000Z';
    const completed = new Date(assistantTs).getTime() / 1000;

    const events: FredoEvent[] = [
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined, timestamp: userTs,
        agent: undefined, modelID: undefined,
      }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi'),
      // Clear both modelID and providerID to force fallback to "Assistant"
      makeMsgUpdated('msg-a1', 'assistant', {
        parentID: 'msg-u1', timestamp: assistantTs, completed,
        modelID: undefined,
        providerID: undefined,
      }),
      makePartUpdated('p2', 'msg-a1', 'text', 'Hello'),
    ];

    const result = buildGraphFromEvents(events);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].data.label).toBe('Assistant');
  });

  it('should ignore unknown event toolNames unchanged', () => {
    const state = createInitialProcessorState();
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
    const result = processChatNodeSubscription(state, unknownEvent, () => {});
    expect(result).toBe(state);
  });
});
