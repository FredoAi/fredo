/**
 * Tests for sessionStorage.ts — contract persistence and session lifecycle.
 *
 * Covers REQ-4 (Contract Persistence), StoredSessionContracts read/write.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatNodeContract, SubagentContract } from '../../../../shared/classes/EventSubscription';
import { persistContracts, loadContracts, loadSessions, finalizeSession, deleteSession } from '../sessionStorage';
import type { StoredSessionContracts } from '../sessionStorage';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeContracts(sessionId: string, overrides: Partial<StoredSessionContracts> = {}): StoredSessionContracts {
  return {
    sessionId,
    chatNodes: [],
    subagents: [],
    ...overrides,
  };
}

function makeChatContract(overrides: Partial<ChatNodeContract> = {}): ChatNodeContract {
  return {
    name: 'chat-node',
    userMessage: 'Hello',
    agentThinking: '',
    agentReply: 'Hi',
    ...overrides,
  };
}

function makeSubagentContract(overrides: Partial<SubagentContract> = {}): SubagentContract {
  return {
    name: 'subagent',
    parentCorrelationId: 'msg-u1',
    subagentType: 'agent',
    status: 'working',
    agentName: 'Coder',
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('persistContracts / loadContracts', () => {
  it('stores and retrieves contracts', () => {
    const contracts = makeContracts('test-session', {
      chatNodes: [
        {
          correlationId: 'msg-u1',
          lifecycle: 'End',
          contract: makeChatContract(),
          timestamp: '2026-06-15T10:00:00.000Z',
        },
      ],
    });

    persistContracts('test-session', contracts);
    const loaded = loadContracts('test-session');
    expect(loaded).toBeDefined();
    expect(loaded!.sessionId).toBe('test-session');
    expect(loaded!.chatNodes).toHaveLength(1);
    expect(loaded!.chatNodes[0].contract.userMessage).toBe('Hello');
  });

  it('stores and retrieves subagent contracts', () => {
    const contracts = makeContracts('test-session', {
      chatNodes: [
        {
          correlationId: 'msg-u1',
          lifecycle: 'End',
          contract: makeChatContract(),
          timestamp: '2026-06-15T10:00:00.000Z',
        },
      ],
      subagents: [
        {
          correlationId: 'sub-msg-u1:agent:Coder',
          lifecycle: 'Init',
          contract: makeSubagentContract(),
          timestamp: '2026-06-15T10:00:30.000Z',
        },
      ],
    });

    persistContracts('test-session', contracts);
    const loaded = loadContracts('test-session');
    expect(loaded).toBeDefined();
    expect(loaded!.subagents).toHaveLength(1);
    expect(loaded!.subagents[0].contract.agentName).toBe('Coder');
    expect(loaded!.subagents[0].contract.subagentType).toBe('agent');
  });

  it('returns null for nonexistent session', () => {
    const loaded = loadContracts('nonexistent');
    expect(loaded).toBeNull();
  });

  it('overwrites existing contracts on subsequent persist', () => {
    const first = makeContracts('overwrite-session', {
      chatNodes: [
        {
          correlationId: 'msg-u1',
          lifecycle: 'Init',
          contract: makeChatContract({ userMessage: 'First' }),
          timestamp: '2026-06-15T10:00:00.000Z',
        },
      ],
    });
    const second = makeContracts('overwrite-session', {
      chatNodes: [
        {
          correlationId: 'msg-u1',
          lifecycle: 'End',
          contract: makeChatContract({ userMessage: 'Second' }),
          timestamp: '2026-06-15T10:01:00.000Z',
        },
      ],
    });

    persistContracts('overwrite-session', first);
    persistContracts('overwrite-session', second);
    const loaded = loadContracts('overwrite-session');
    expect(loaded!.chatNodes).toHaveLength(1);
    expect(loaded!.chatNodes[0].contract.userMessage).toBe('Second');
    expect(loaded!.chatNodes[0].lifecycle).toBe('End');
  });

  it('handles empty contracts', () => {
    const contracts = makeContracts('empty-session');
    persistContracts('empty-session', contracts);
    const loaded = loadContracts('empty-session');
    expect(loaded).toBeDefined();
    expect(loaded!.chatNodes).toHaveLength(0);
    expect(loaded!.subagents).toHaveLength(0);
  });
});

describe('finalizeSession / deleteSession', () => {
  it('finalizeSession sets endTime', () => {
    // First persist some contracts to create a session record
    const contracts = makeContracts('fin-session', {
      chatNodes: [
        {
          correlationId: 'msg-u1',
          lifecycle: 'End',
          contract: makeChatContract(),
          timestamp: '2026-06-15T10:00:00.000Z',
        },
      ],
    });
    persistContracts('fin-session', contracts);

    finalizeSession('fin-session');
    const sessions = loadSessions();
    const s = sessions.find((s) => s.sessionId === 'fin-session');
    expect(s).toBeDefined();
    expect(s!.endTime).toBeGreaterThan(0);
  });

  it('deleteSession removes contracts and session record', () => {
    const contracts = makeContracts('del-session', {
      chatNodes: [
        {
          correlationId: 'msg-u1',
          lifecycle: 'End',
          contract: makeChatContract(),
          timestamp: '2026-06-15T10:00:00.000Z',
        },
      ],
    });
    persistContracts('del-session', contracts);
    expect(loadContracts('del-session')).toBeDefined();
    expect(loadSessions().length).toBe(1);

    deleteSession('del-session');
    expect(loadContracts('del-session')).toBeNull();
    expect(loadSessions().length).toBe(0);
  });
});
