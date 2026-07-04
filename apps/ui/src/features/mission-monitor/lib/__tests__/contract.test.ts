/**
 * Tests for ECE contract helpers and payload makers.
 *
 * Covers:
 * - isToolUseDelivery / isSubagentDelivery helpers
 * - makeToolNodePayload / makeSubagentNodePayload payload makers
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import {
  isChatNodeDelivery,
  isToolUseDelivery,
  isSubagentDelivery,
  makeToolNodePayload,
  makeSubagentNodePayload,
  deliverySessionId,
  deliveryCorrelationId,
  extractAgentReply,
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

// ── extractAgentReply ─────────────────────────────────────────────────────────

describe('extractAgentReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Existing extraction paths (must still work) ───────────────────────────

  it('extracts from OTLP flat gen_ai.response.body (path 1)', () => {
    const result = extractAgentReply({ 'gen_ai.response.body': 'Hello world' });
    expect(result).toBe('Hello world');
  });

  it('extracts from payload.text + payload.type === text (path 2)', () => {
    const result = extractAgentReply({ text: 'Hello world', type: 'text' });
    expect(result).toBe('Hello world');
  });

  it('extracts from properties.part.text (path 3)', () => {
    const result = extractAgentReply({ properties: { part: { text: 'Hello world' } } });
    expect(result).toBe('Hello world');
  });

  it('extracts from properties.text (path 4)', () => {
    const result = extractAgentReply({ properties: { text: 'Hello world' } });
    expect(result).toBe('Hello world');
  });

  it('extracts from part.text (path 5)', () => {
    const result = extractAgentReply({ part: { text: 'Hello world' } });
    expect(result).toBe('Hello world');
  });

  it('extracts from properties.info.text (path 6)', () => {
    const result = extractAgentReply({ properties: { info: { text: 'Hello world' } } });
    expect(result).toBe('Hello world');
  });

  it('extracts from top-level agentReply (path 7)', () => {
    const result = extractAgentReply({ agentReply: 'Hello world' });
    expect(result).toBe('Hello world');
  });

  it('extracts from OTLP fallback gen_ai.response.completion (path 8)', () => {
    const result = extractAgentReply({ 'gen_ai.response.completion': 'Hello world' });
    expect(result).toBe('Hello world');
  });

  // ── New extraction paths (REQ-2) ──────────────────────────────────────────

  it('extracts from state.output (new path A)', () => {
    const result = extractAgentReply({ state: { output: 'Subagent response' } });
    expect(result).toBe('Subagent response');
  });

  it('extracts from part.state.output (new path B)', () => {
    const result = extractAgentReply({ part: { state: { output: 'Nested subagent response' } } });
    expect(result).toBe('Nested subagent response');
  });

  it('extracts from bare top-level text (new path C)', () => {
    const result = extractAgentReply({ text: 'Bare text response' });
    expect(result).toBe('Bare text response');
  });

  // ── Diagnostic logging (REQ-1) ────────────────────────────────────────────

  it('logs diagnostic when extraction fails but payload has content-bearing keys', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const payload = { state: { not_output: 'foo' }, part: { not_text: 'bar' } };
    const result = extractAgentReply(payload);
    expect(result).toBe('');
    expect(debugSpy).toHaveBeenCalledWith(
      '[extractAgentReply] No text extracted. Payload keys:',
      expect.arrayContaining(['state', 'part']),
      'Payload preview:',
      expect.any(String),
    );
    debugSpy.mockRestore();
  });

  it('does not log diagnostic when payload has no content-bearing keys', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const result = extractAgentReply({ foo: 'bar' });
    expect(result).toBe('');
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  // ── Priority ordering (REQ-2 + REQ-4) ─────────────────────────────────────

  it('prioritizes gen_ai.response.body over all other paths', () => {
    const result = extractAgentReply({
      'gen_ai.response.body': 'OTLP response',
      part: { text: 'Part text' },
      state: { output: 'State output' },
    });
    expect(result).toBe('OTLP response');
  });

  it('prioritizes part.text over state.output', () => {
    const result = extractAgentReply({
      part: { text: 'Part text' },
      state: { output: 'State output' },
    });
    expect(result).toBe('Part text');
  });

  it('prioritizes state.output over properties.info.text', () => {
    const result = extractAgentReply({
      state: { output: 'State output' },
      properties: { info: { text: 'Info text' } },
    });
    expect(result).toBe('State output');
  });

  it('extracts state.output when part.text is absent', () => {
    const result = extractAgentReply({
      state: { output: 'Subagent output' },
    });
    expect(result).toBe('Subagent output');
  });
});
