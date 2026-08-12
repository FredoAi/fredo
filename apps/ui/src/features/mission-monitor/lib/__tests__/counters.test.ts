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

/**
 * Mock payload builder for chat-node deliveries with token figures.
 *
 * Spec #2711 (round 2) per-message semantics: `input`/`output` here are the
 * per-message values the OTLP adapter now injects, style-robust per session
 * (latched at turn 2):
 *  - Cumulative style: `input` is the per-turn DELTA of the cumulative
 *    `gen_ai.usage.input_tokens` (2,731 → 27 → 32 → 30 → 409 in the
 *    root-cause trace).
 *  - PerMessage style: `input` is the DIRECT per-message input (27,693 → 2,394
 *    → 2,439 in the round-1 nemotron trace — a drop is a real smaller message,
 *    NEVER clamped).
 * `output` is that turn's own output_tokens. They are NEVER session-cumulative
 * figures (the badge sums Σ(input + output) = input(n) + Σ output under
 * Cumulative, and Σ per-message inputs + Σ outputs under PerMessage — see
 * counters.ts:55-65).
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

  it('Cumulative style: badge telescopes to input(n) + Σ output (#2711 round 2)', () => {
    // Root-cause cumulative trace: per-turn prompt deltas 2,731 / 27 / 32 /
    // 30 / 409 (cumulative inputs 2,731 → 2,758 → 2,790 → 2,820 → 3,229,
    // cache pinned 25,344), outputs 9 / 13 / 9 / 393 / 112. The badge sums
    // Σ(Δinput + output) which telescopes to input(5) + Σ output =
    // 3,229 + 536 = 3,765 — the correct session-level total under Cumulative.
    const deliveries = [
      deliveryWithTokens('corr-1', 2731, 9),
      deliveryWithTokens('corr-2', 27, 13),
      deliveryWithTokens('corr-3', 32, 9),
      deliveryWithTokens('corr-4', 30, 393),
      deliveryWithTokens('corr-5', 409, 112),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.tokens).toBe(3229 + 536); // input(5) 3,229 + Σ outputs 536
    expect(result.tokens).toBe(3765);
  });

  it('PerMessage style: badge = Σ per-message inputs + Σ outputs (#2711 round 2)', () => {
    // Nemotron per-message trace: promptTokens are the DIRECT per-message
    // inputs 27,693 / 2,394 / 2,439 (a DROP — never clamped), outputs
    // 14 / 19 / 13. The badge sums each delivery's own per-message
    // consumption: Σ per-message inputs 32,526 + Σ outputs 46 = 32,572 —
    // a correct session-level total under PerMessage (never 0/45 clamps).
    const deliveries = [
      deliveryWithTokens('corr-1', 27693, 14),
      deliveryWithTokens('corr-2', 2394, 19),
      deliveryWithTokens('corr-3', 2439, 13),
    ];
    const result = computeSessionCounters(deliveries);
    expect(result.tokens).toBe(27693 + 2394 + 2439 + 46);
    expect(result.tokens).toBe(32572);
    // Explicitly reject the round-1 wrong clamped values: the badge is NOT
    // the round-1 delta sum (27,693 + 0 + 45 = 27,738) nor 0.
    expect(result.tokens).not.toBe(27738);
    expect(result.tokens).not.toBe(0);
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
