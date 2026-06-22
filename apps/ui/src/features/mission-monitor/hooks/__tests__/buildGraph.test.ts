/**
 * Tests for processChatNodeSubscription — subscription-driven contract assembly.
 *
 * Run with: pnpm --filter @fredo/ui test:run -- --testPathPattern buildGraph
 */

import { describe, it, expect } from 'vitest';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';
import { processChatNodeSubscription, createInitialProcessorState } from '../useMissionMonitor';
import type { ChatNodeContract, SubagentContract, SubscriptionDelivery } from '../../../../shared/classes/EventSubscription';

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

// ── Subscription-Driven Processor Tests ───────────────────────────────────────

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
    const { state, deliveries } = processEvents([
      makeMsgUpdated('msg-u1', 'user', { parentID: undefined, timestamp: '2026-06-15T10:00:00.000Z' }),
      makePartUpdated('p1', 'msg-u1', 'text', 'Hi!'),
      makePartUpdated('p2', 'msg-a1', 'text', 'Sure,'),
      makePartUpdated('p3', 'msg-a1', 'text', ' I can help!'),
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

  // ── Subagent processing (REQ-2) ─────────────────────────────────

  it('should create a SubagentContract when agent part arrives (REQ-2)', () => {
    let state = createInitialProcessorState();
    const subagentDeliveries: SubscriptionDelivery<SubagentContract>[] = [];

    // Process user message
    state = processChatNodeSubscription(
      state,
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
      }),
      () => {},
      (d) => { subagentDeliveries.push(d); },
    );

    // Process agent part
    state = processChatNodeSubscription(
      state,
      makePartUpdated('agent-1', 'msg-u1', 'agent', 'Agent output', { agent: 'Coder' }),
      () => {},
      (d) => { subagentDeliveries.push(d); },
    );

    expect(subagentDeliveries).toHaveLength(1);
    expect(subagentDeliveries[0].lifecycle).toBe('Init');
    expect(subagentDeliveries[0].contract.name).toBe('subagent');
    expect(subagentDeliveries[0].contract.subagentType).toBe('agent');
    expect(subagentDeliveries[0].contract.agentName).toBe('Coder');
    expect(subagentDeliveries[0].contract.parentCorrelationId).toBe('msg-u1');
    expect(subagentDeliveries[0].contract.status).toBe('working');
    expect(subagentDeliveries[0].contract.outputText).toBe('Agent output');
  });

  it('should create a SubagentContract when subtask part arrives (REQ-2)', () => {
    let state = createInitialProcessorState();
    const subagentDeliveries: SubscriptionDelivery<SubagentContract>[] = [];

    state = processChatNodeSubscription(
      state,
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
      }),
      () => {},
      (d) => { subagentDeliveries.push(d); },
    );

    state = processChatNodeSubscription(
      state,
      makePartUpdated('subtask-1', 'msg-u1', 'subtask', 'Subtask output', { name: 'Analyzer' }),
      () => {},
      (d) => { subagentDeliveries.push(d); },
    );

    expect(subagentDeliveries).toHaveLength(1);
    expect(subagentDeliveries[0].contract.name).toBe('subagent');
    expect(subagentDeliveries[0].contract.subagentType).toBe('subtask');
    expect(subagentDeliveries[0].contract.agentName).toBe('Analyzer');
    expect(subagentDeliveries[0].contract.parentCorrelationId).toBe('msg-u1');
  });

  it('should update existing SubagentContract on subsequent agent parts (REQ-2)', () => {
    let state = createInitialProcessorState();
    const subagentDeliveries: SubscriptionDelivery<SubagentContract>[] = [];

    state = processChatNodeSubscription(
      state,
      makeMsgUpdated('msg-u1', 'user', {
        parentID: undefined,
        timestamp: '2026-06-15T10:00:00.000Z',
      }),
      () => {},
      (d) => { subagentDeliveries.push(d); },
    );

    // First agent part
    state = processChatNodeSubscription(
      state,
      makePartUpdated('agent-1', 'msg-u1', 'agent', 'Initial output', { agent: 'Coder' }),
      () => {},
      (d) => { subagentDeliveries.push(d); },
    );

    // Second agent part (same agent, same parent)
    state = processChatNodeSubscription(
      state,
      makePartUpdated('agent-2', 'msg-u1', 'agent', 'Updated output', { agent: 'Coder' }),
      () => {},
      (d) => { subagentDeliveries.push(d); },
    );

    expect(subagentDeliveries).toHaveLength(2);
    expect(subagentDeliveries[0].lifecycle).toBe('Init');
    expect(subagentDeliveries[0].contract.outputText).toBe('Initial output');
    expect(subagentDeliveries[1].lifecycle).toBe('Update');
    expect(subagentDeliveries[1].contract.outputText).toBe('Updated output');
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
