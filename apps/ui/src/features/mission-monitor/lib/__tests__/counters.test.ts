/**
 * Tests for computeSessionCounters and formatTokenCount.
 *
 * Covers REQ-9 (Header Badges), REQ-10 (Accumulation), REQ-11 (Token Sources).
 *
 * ECE delivery-driven: counters read from ContractDelivery[].tools,
 * .subagents, .tools[].files[].path, and the canonical
 * p.promptTokens / p.completionTokens (per-message per Spec #2711).
 */
import { describe, it, expect } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import { computeSessionCounters, computeSessionTokenTotals } from '../counters';
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

/**
 * Mock payload builder for chat-node deliveries with token figures.
 *
 * Spec #2711 per-message semantics: `input`/`output` here are the per-message
 * values the OTLP adapter now injects — `input` is the per-turn DELTA of the
 * cumulative `gen_ai.usage.input_tokens` (2,731 → 27 → 32 → 30 → 409 in the
 * root-cause trace), `output` is that turn's own output_tokens. They are
 * NEVER session-cumulative figures (the badge sums Σ(Δinput + output) =
 * input(n) + Σ output — see counters.ts:55-58).
 */
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

// ── computeSessionTokenTotals helpers (Spec #2717 S3) ─────────────────────────
// Only explicitly-provided token families are written to the inner payload so
// "absent category" cases can be exercised (absent fields must render/sum as 0).

function makeTokenDelivery(
  sessionId: string,
  correlationId: string,
  lifecycle: 'init' | 'update' | 'end',
  tokens: { prompt?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; completion?: number },
): ContractDelivery {
  const inner: Record<string, unknown> = {};
  if (tokens.prompt !== undefined) inner.promptTokens = tokens.prompt;
  if (tokens.cacheRead !== undefined) inner.cacheReadTokens = tokens.cacheRead;
  if (tokens.cacheWrite !== undefined) inner.cacheWriteTokens = tokens.cacheWrite;
  if (tokens.reasoning !== undefined) inner.reasoningTokens = tokens.reasoning;
  if (tokens.completion !== undefined) inner.completionTokens = tokens.completion;
  const d = makeDelivery(sessionId, correlationId, inner);
  return { ...d, lifecycle };
}

/** Chat-node delivery carrying `compositedChildSessionId` in the OUTER payload. */
function makeCompositedDelivery(
  sessionId: string,
  correlationId: string,
  tokens: { prompt?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; completion?: number },
): ContractDelivery {
  const d = makeTokenDelivery(sessionId, correlationId, 'init', tokens);
  return { ...d, payload: { ...d.payload, compositedChildSessionId: 'child-sa' } };
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

// ── computeSessionTokenTotals tests ────────────────────────────────────────────
// Spec #2717 (S3) — session bottom-bar aggregation (R-3.1 / R-3.2 / R-3.3).

describe('computeSessionTokenTotals (Spec #2717 R-3.2 — session bottom bar)', () => {
  const ZERO_TOTALS = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  it('returns all-zero totals for an empty delivery list', () => {
    expect(computeSessionTokenTotals([], 'sess-1')).toEqual(ZERO_TOTALS);
  });

  it('filters chat-node deliveries to the selected session only', () => {
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, completion: 50 }),
      makeTokenDelivery('sess-2', 'corr-2', 'end', { prompt: 9999, completion: 9999 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 27, completion: 10 }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    expect(result.inputTokens).toBe(127);
    expect(result.outputTokens).toBe(60);
    expect(result.totalTokens).toBe(187);
  });

  it('skips composited child-session deliveries — child tokens never leak (Spec #523)', () => {
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'init', { prompt: 100, completion: 50 }),
      // Same sessionId but composited (becomes a SubagentNode, not an AgentNode).
      makeCompositedDelivery('sess-1', 'sa-corr-1', { prompt: 5000, reasoning: 5000 }),
      makeCompositedDelivery('sess-1', 'sa-corr-2', { prompt: 9000, cacheRead: 7000 }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.reasoningTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.totalTokens).toBe(150);
  });

  it('dedupes by composite key with last-wins per key — init+end pairs count once (G-011)', () => {
    // The OTLP adapter emits a synthetic Init + Response per turn with IDENTICAL
    // payloads — feed BOTH in one batch (G-011). A naive sum over every chat-node
    // delivery would double-count each turn; per-key last-wins must count once.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'init', { prompt: 100, completion: 50 }),
      makeTokenDelivery('sess-1', 'corr-1', 'end',  { prompt: 100, completion: 50 }),
      makeTokenDelivery('sess-1', 'corr-2', 'init', { prompt: 200, completion: 75 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end',  { prompt: 200, completion: 75 }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    // Naive double-count would be 850; last-wins per key = (100+50)+(200+75) = 425.
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(125);
    expect(result.totalTokens).toBe(425);
  });

  it('sums all four families across keys (R-3.2)', () => {
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', {
        prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780, cacheWrite: 999,
      }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, completion: 10 }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    expect(result.inputTokens).toBe(1867);
    expect(result.cacheReadTokens).toBe(1200);
    expect(result.reasoningTokens).toBe(500);
    expect(result.outputTokens).toBe(790);
    // G-023: cacheWrite carried in the struct but never summed into any figure.
    expect(result.cacheWriteTokens).toBe(999);
    // R-3.1: Total = 1867 + 1200 + 500 + 790 = 4357.
    expect(result.totalTokens).toBe(4357);
  });

  it('Total = Input + Cache + Reasoning + Output exactly — cacheWrite excluded (R-3.1)', () => {
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', {
        prompt: 100, cacheRead: 40, reasoning: 30, completion: 20, cacheWrite: 10000,
      }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    expect(result.totalTokens).toBe(190); // NOT 10190 — cacheWrite never summed.
  });

  it('treats zero/absent categories as 0 — never NaN or negative (R-3.3)', () => {
    const deliveries = [
      // Negative prompt (-5) → 0; NaN cacheRead → 0; reasoning ABSENT → 0.
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: -5, cacheRead: Number.NaN, completion: 50 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', {}), // all families absent
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    expect(result.inputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.reasoningTokens).toBe(0);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(50);
    expect(Number.isNaN(result.totalTokens)).toBe(false);
    expect(result.totalTokens).toBeGreaterThanOrEqual(0);
  });

  it('ignores non-chat-node deliveries', () => {
    const deliveries = [
      {
        id: 't1', contractName: 'tool-use-lifecycle', lifecycle: 'end' as const,
        key: { sessionId: 'sess-1', correlationId: 'corr-1' },
        payload: { payload: { promptTokens: 999, completionTokens: 999 } },
        timestamp: '',
      },
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 10, completion: 5 }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    expect(result.inputTokens).toBe(10);
    expect(result.totalTokens).toBe(15);
  });
});
