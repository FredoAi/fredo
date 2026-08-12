/**
 * Tests for computeSessionCounters and formatTokenCount.
 *
 * Covers REQ-9 (Header Badges), REQ-10 (Accumulation), REQ-11 (Token Sources).
 *
 * ECE delivery-driven: counters read from ContractDelivery[].tools,
 * .subagents, .tools[].files[].path, and .info.turnInputTokens / .turnOutputTokens.
 */
import { describe, it, expect } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import { computeSessionCounters } from '../counters';
import { formatTokenCount } from '../graph';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDelivery(
  sessionId: string,
  correlationId: string,
  overrides: Record<string, unknown> = {},
): ContractDelivery {
  return {
    id: crypto.randomUUID(),
    contractName: 'chat-node',
    lifecycle: 'init',
    key: { sessionId, correlationId },
    payload: {
      payload: {
        promptTokens: 0,
        completionTokens: 0,
        subagents: [],
        tools: [],
        ...overrides,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function deliveryWithTokens(
  correlationId: string,
  input: number,
  output: number,
  overrides: Record<string, unknown> = {},
): ContractDelivery {
  return makeDelivery('test-session', correlationId, {
    promptTokens: input,
    completionTokens: output,
    // Legacy backward compat for old computeSessionCounters
    info: { turnInputTokens: input, turnOutputTokens: output },
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('computeSessionCounters', () => {
  it('returns zero counters for empty deliveries', () => {
    const result = computeSessionCounters([]);
    expect(result).toEqual({ tools: 0, files: 0, subagents: 0, tokens: 0 });
  });

  it('counts unique tool names from tools array', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        tools: [{ name: 'tool-1' }, { name: 'tool-2' }, { name: 'tool-3' }],
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.tools).toBe(3);
  });

  it('deduplicates tool calls by name', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        tools: [{ name: 'tool-1' }, { name: 'tool-1' }, { name: 'tool-2' }],
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.tools).toBe(2);
  });

  it('counts unique file paths from tools[].files[].path', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        tools: [{ name: 'edit', files: [{ path: 'src/main.rs' }] }],
      }),
      makeDelivery('test-session', 'corr-2', {
        tools: [{ name: 'view', files: [{ path: 'src/lib.rs' }] }],
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.files).toBe(2);
  });

  it('deduplicates file paths', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        tools: [{ name: 'edit', files: [{ path: 'src/main.rs' }] }],
      }),
      makeDelivery('test-session', 'corr-2', {
        tools: [{ name: 'view', files: [{ path: 'src/main.rs' }] }], // same path
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.files).toBe(1);
  });

  it('counts unique subagent names from subagents array', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        subagents: [{ name: 'agent-1' }, { name: 'agent-2' }],
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.subagents).toBe(2);
  });

  it('counts subagents from a single delivery', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        subagents: [{ name: 'subtask-1' }],
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.subagents).toBe(1);
  });

  it('deduplicates subagent names', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        subagents: [{ name: 'agent-1' }],
      }),
      makeDelivery('test-session', 'corr-2', {
        subagents: [{ name: 'agent-1' }], // duplicate name
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.subagents).toBe(1);
  });

  it('sums tokens from promptTokens + completionTokens', () => {
    const deliveries = [
      deliveryWithTokens('corr-1', 100, 50),
      deliveryWithTokens('corr-2', 200, 75),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.tokens).toBe(425);
  });

  it('treats missing token fields as zero', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {}),
      deliveryWithTokens('corr-2', 100, 50),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.tokens).toBe(150);
  });

  it('accumulates counters across multiple deliveries (integration)', () => {
    const deliveries: ContractDelivery[] = [
      // Turn 1
      makeDelivery('test-session', 'corr-1', {
        promptTokens: 150,
        completionTokens: 60,
        // Legacy backward compat
        info: { turnInputTokens: 150, turnOutputTokens: 60 },
        tools: [
          { name: 'tool-1' },
          { name: 'tool-2', files: [{ path: 'src/main.rs' }] },
        ],
      }),

      // Turn 2
      makeDelivery('test-session', 'corr-2', {
        promptTokens: 80,
        completionTokens: 20,
        // Legacy backward compat
        info: { turnInputTokens: 80, turnOutputTokens: 20 },
        subagents: [{ name: 'agent-1' }, { name: 'subtask-1' }],
        tools: [
          { name: 'tool-1' },        // same tool, dedup
          { name: 'tool-3' },        // new tool
          { name: 'tool-2' },        // existing tool but dedup
        ],
      }),

      // Turn 3 — same file via different tool, dedup
      makeDelivery('test-session', 'corr-3', {
        promptTokens: 0,
        completionTokens: 0,
        // Legacy backward compat
        info: { turnInputTokens: 0, turnOutputTokens: 0 },
        tools: [
          { name: 'view', files: [{ path: 'src/main.rs' }] }, // same file, dedup
          { name: 'edit', files: [{ path: 'src/lib.rs' }] },  // new file
        ],
      }),
    ];

    const result = computeSessionCounters(deliveries);
    // Tools: tool-1, tool-2, tool-3, view, edit = 5
    expect(result.tools).toBe(5);
    // Files: src/main.rs, src/lib.rs = 2
    expect(result.files).toBe(2);
    // Subagents: agent-1, subtask-1 = 2
    expect(result.subagents).toBe(2);
    // Tokens: (150+60) + (80+20) + (0+0) = 310
    expect(result.tokens).toBe(310);
  });

  it('handles deliveries with null payload gracefully', () => {
    const deliveries = [
      { id: '1', contractName: 'chat-node', lifecycle: 'init', key: { sessionId: 's', correlationId: 'c' }, payload: null, timestamp: '' },
    ] as unknown as ContractDelivery[];
    const result = computeSessionCounters(deliveries);
    expect(result).toEqual({ tools: 0, files: 0, subagents: 0, tokens: 0 });
  });

  it('handles deliveries with empty / no subagents or tools', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {}),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result).toEqual({ tools: 0, files: 0, subagents: 0, tokens: 0 });
  });

  it('counts tools when tools array contains multiple entries', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        tools: [{ name: 'tool-real-1' }],
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.tools).toBe(1);
  });

  it('counts tokens from promptTokens + completionTokens', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        promptTokens: 42,
        completionTokens: 10,
        // Legacy backward compat
        info: { turnInputTokens: 42, turnOutputTokens: 10 },
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.tokens).toBe(52);
  });

  it('counts subagents from delivery subagents array', () => {
    const deliveries = [
      makeDelivery('test-session', 'corr-1', {
        subagents: [{ name: 'agent-1' }],
      }),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.subagents).toBe(1);
  });
});

// ── formatTokenCount tests ─────────────────────────────────────────────────────

describe('formatTokenCount', () => {
  // AC1/AC5: values below 1,000 render without a separator; 0 renders as "0".
  it('returns raw number for values < 1K (AC1, AC5)', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(420)).toBe('420');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('returns comma thousands separators for values >= 1K (AC1)', () => {
    expect(formatTokenCount(1_000)).toBe('1,000');
    expect(formatTokenCount(1_840)).toBe('1,840');
    expect(formatTokenCount(10_000)).toBe('10,000');
    expect(formatTokenCount(42_000)).toBe('42,000');
    expect(formatTokenCount(999_949)).toBe('999,949');
  });

  it('groups millions with commas (AC1)', () => {
    expect(formatTokenCount(1_000_000)).toBe('1,000,000');
    expect(formatTokenCount(2_500_000)).toBe('2,500,000');
    expect(formatTokenCount(1_234_567)).toBe('1,234,567');
    expect(formatTokenCount(10_500_000)).toBe('10,500,000');
  });

  it('never emits the compact k/M shorthand (AC1)', () => {
    expect(formatTokenCount(1_840)).not.toMatch(/k$/);
    expect(formatTokenCount(2_500_000)).not.toMatch(/M$/);
    expect(formatTokenCount(1_000)).not.toBe('1k');
  });
});
