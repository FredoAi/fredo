/**
 * Tests for ECE contract helpers and payload makers.
 *
 * Covers:
 * - isToolUseDelivery / isSubagentDelivery helpers
 * - makeToolNodePayload / makeSubagentNodePayload payload makers
 */
import { describe, it, expect } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import {
  isChatNodeDelivery,
  isToolUseDelivery,
  isSubagentDelivery,
  makeToolNodePayload,
  makeSubagentNodePayload,
  deliverySessionId,
  deliveryCorrelationId,
} from '../contract';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDelivery(overrides: Partial<ContractDelivery> = {}): ContractDelivery {
  return {
    id: 'test-id',
    contractName: 'chat-node',
    lifecycle: 'init',
    key: { sessionId: 's1', correlationId: 'corr-1' },
    payload: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── isToolUseDelivery ────────────────────────────────────────────────────────

describe('isToolUseDelivery', () => {
  it('returns true for tool-use-lifecycle contract', () => {
    const d = makeDelivery({ contractName: 'tool-use-lifecycle' });
    expect(isToolUseDelivery(d)).toBe(true);
  });

  it('returns false for chat-node contract', () => {
    const d = makeDelivery({ contractName: 'chat-node' });
    expect(isToolUseDelivery(d)).toBe(false);
  });

  it('returns false for subagent-lifecycle contract', () => {
    const d = makeDelivery({ contractName: 'subagent-lifecycle' });
    expect(isToolUseDelivery(d)).toBe(false);
  });

  it('returns false for unknown contract', () => {
    const d = makeDelivery({ contractName: 'unknown' });
    expect(isToolUseDelivery(d)).toBe(false);
  });
});

// ── isSubagentDelivery ───────────────────────────────────────────────────────

describe('isSubagentDelivery', () => {
  it('returns true for subagent-lifecycle contract', () => {
    const d = makeDelivery({ contractName: 'subagent-lifecycle' });
    expect(isSubagentDelivery(d)).toBe(true);
  });

  it('returns false for chat-node contract', () => {
    const d = makeDelivery({ contractName: 'chat-node' });
    expect(isSubagentDelivery(d)).toBe(false);
  });

  it('returns false for tool-use-lifecycle contract', () => {
    const d = makeDelivery({ contractName: 'tool-use-lifecycle' });
    expect(isSubagentDelivery(d)).toBe(false);
  });
});

// ── isChatNodeDelivery (backward compat) ─────────────────────────────────────

describe('isChatNodeDelivery', () => {
  it('returns true for chat-node contract', () => {
    expect(isChatNodeDelivery(makeDelivery({ contractName: 'chat-node' }))).toBe(true);
  });

  it('returns false for tool-use-lifecycle', () => {
    expect(isChatNodeDelivery(makeDelivery({ contractName: 'tool-use-lifecycle' }))).toBe(false);
  });
});

// ── makeToolNodePayload ──────────────────────────────────────────────────────

describe('makeToolNodePayload', () => {
  it('extracts toolName from delivery payload top-level field', () => {
    const d = makeDelivery({
      contractName: 'tool-use-lifecycle',
      key: { sessionId: 's1', correlationId: 'tool-corr-1' },
      payload: {
        toolName: 'Bash',
        state: 'Init',
        payload: { input: 'ls -la', output: '' },
      },
    });
    const result = makeToolNodePayload(d, 'agent-corr-1');
    expect(result.toolName).toBe('Bash');
    expect(result.parentCorrelationId).toBe('agent-corr-1');
    expect(result.correlationId).toBe('tool-corr-1');
    expect(result.sessionId).toBe('s1');
  });

  it('reads input/output from inner payload', () => {
    const d = makeDelivery({
      contractName: 'tool-use-lifecycle',
      key: { sessionId: 's1', correlationId: 'tool-corr-1' },
      payload: {
        toolName: 'Edit',
        payload: { input: 'src/main.ts', output: 'changes applied' },
      },
    });
    const result = makeToolNodePayload(d, 'agent-corr-1');
    expect(result.input).toBe('src/main.ts');
    expect(result.output).toBe('changes applied');
  });

  it('handles missing inner payload gracefully', () => {
    const d = makeDelivery({
      contractName: 'tool-use-lifecycle',
      key: { sessionId: 's1', correlationId: 'tool-corr-1' },
      payload: { toolName: 'Read' },
    });
    const result = makeToolNodePayload(d, 'agent-corr-1');
    expect(result.toolName).toBe('Read');
    expect(result.input).toBeUndefined();
    expect(result.output).toBeUndefined();
  });

  it('falls back to unknown-tool when toolName missing', () => {
    const d = makeDelivery({
      contractName: 'tool-use-lifecycle',
      key: { sessionId: 's1', correlationId: 'tool-corr-1' },
      payload: { payload: { input: 'test' } },
    });
    const result = makeToolNodePayload(d, 'agent-corr-1');
    expect(result.toolName).toBe('unknown-tool');
    expect(result.input).toBe('test');
  });
});

// ── makeSubagentNodePayload ──────────────────────────────────────────────────

describe('makeSubagentNodePayload', () => {
  it('extracts name from toolName field in delivery payload', () => {
    const d = makeDelivery({
      contractName: 'subagent-lifecycle',
      key: { sessionId: 's1', correlationId: 'sa-corr-1' },
      payload: {
        toolName: 'Coder',
        state: 'Init',
        payload: { instruction: 'Implement feature X', output: '' },
      },
    });
    const result = makeSubagentNodePayload(d, 'agent-corr-1');
    expect(result.name).toBe('Coder');
    expect(result.parentCorrelationId).toBe('agent-corr-1');
    expect(result.correlationId).toBe('sa-corr-1');
    expect(result.sessionId).toBe('s1');
  });

  it('reads instruction/output from inner payload', () => {
    const d = makeDelivery({
      contractName: 'subagent-lifecycle',
      key: { sessionId: 's1', correlationId: 'sa-corr-1' },
      payload: {
        toolName: 'Reviewer',
        payload: { instruction: 'Review PR', output: 'LGTM' },
      },
    });
    const result = makeSubagentNodePayload(d, 'agent-corr-1');
    expect(result.instruction).toBe('Review PR');
    expect(result.output).toBe('LGTM');
  });

  it('handles missing inner payload gracefully', () => {
    const d = makeDelivery({
      contractName: 'subagent-lifecycle',
      key: { sessionId: 's1', correlationId: 'sa-corr-1' },
      payload: { toolName: 'Tester' },
    });
    const result = makeSubagentNodePayload(d, 'agent-corr-1');
    expect(result.name).toBe('Tester');
    expect(result.instruction).toBe('');
    expect(result.output).toBe('');
  });

  it('falls back to unknown-subagent when name missing', () => {
    const d = makeDelivery({
      contractName: 'subagent-lifecycle',
      key: { sessionId: 's1', correlationId: 'sa-corr-1' },
      payload: { payload: { instruction: 'test' } },
    });
    const result = makeSubagentNodePayload(d, 'agent-corr-1');
    expect(result.name).toBe('unknown-subagent');
    expect(result.instruction).toBe('test');
  });
});

// ── Integration: delivery helpers ────────────────────────────────────────────

describe('delivery helpers with new contract types', () => {
  it('deliverySessionId extracts sessionId from any contract', () => {
    const d = makeDelivery({
      contractName: 'tool-use-lifecycle',
      key: { sessionId: 'sess-42', correlationId: 'c1' },
    });
    expect(deliverySessionId(d)).toBe('sess-42');
  });

  it('deliveryCorrelationId extracts correlationId from any contract', () => {
    const d = makeDelivery({
      contractName: 'subagent-lifecycle',
      key: { sessionId: 's1', correlationId: 'sub-corr' },
    });
    expect(deliveryCorrelationId(d)).toBe('sub-corr');
  });
});
