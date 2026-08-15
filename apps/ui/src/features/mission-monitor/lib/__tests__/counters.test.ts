/**
 * Tests for computeSessionCounters and formatTokenCount.
 *
 * Covers REQ-9 (Header Badges), REQ-10 (Accumulation), REQ-11 (Token Sources).
 *
 * ECE delivery-driven: counters read from ContractDelivery[].tools,
 * .subagents, .tools[].files[].path, and the canonical
 * p.promptTokens / p.completionTokens (per-message per Spec #2711).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import { computeSessionCounters, computeSessionTokenTotals, computeSessionMetrics } from '../counters';
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
  rawCumulativeCache?: number,
): ContractDelivery {
  const inner: Record<string, unknown> = {};
  if (tokens.prompt !== undefined) inner.promptTokens = tokens.prompt;
  if (tokens.cacheRead !== undefined) inner.cacheReadTokens = tokens.cacheRead;
  if (tokens.cacheWrite !== undefined) inner.cacheWriteTokens = tokens.cacheWrite;
  if (tokens.reasoning !== undefined) inner.reasoningTokens = tokens.reasoning;
  if (tokens.completion !== undefined) inner.completionTokens = tokens.completion;
  // ST-3 (#2734): the adapter preserves the raw session-cumulative cache-read
  // value as a FLAT attr in every delivery payload (otlp.rs:998 attrs.clone()).
  // The reconciliation guard compares Σ per-node cacheReadTokens against the
  // last delivery's preserved value — fixtures must carry it when exercising
  // the guard.
  if (rawCumulativeCache !== undefined) {
    inner['gen_ai.usage.cache_read.input_tokens'] = rawCumulativeCache;
  }
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

// ── Spec #2723 ST-3 (R-3 / AC3): 3+ node per-node correctness + Σ-reconciliation ──
//
// Live diagnostic (ses_044bb36d7ffeeh5kwPSzvQ1Aum, 57 turns): the adapter now
// delivers per-turn cache-read DELTAS (512,000 / 1,536 / 2,304 / 384 / 1,920)
// derived from the session-cumulative gen_ai.usage.cache_read.input_tokens. The
// session bar Cache = Σ per-node cacheReadTokens (the deltas telescope to the
// final cumulative cache read). These tests pin the reconciliation contract:
// (1) every node's per-turn figure is non-contaminated across 3+ nodes,
// (2) session totals == Σ per-node exactly (zero residual), and (3) a
// session-cumulative cache value fed as a node's figure must NOT silently
// inflate the session total to the wrong reconciliation target.

describe('Spec #2723 ST-3: 3+ node Σ-reconciliation (session bar = Σ per-node)', () => {
  it('session totals equal the exact sum of 3+ per-node per-turn figures (zero residual)', () => {
    // 3 nodes, distinct per-turn cache deltas (mirrors the live session turns
    // 1-3: 512,000 / 1,536 / 2,304). Σ per-node must equal the session figure
    // for every category — the reconciliation contract (Q-3.3).
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', {
        prompt: 100, cacheRead: 512000, reasoning: 5, completion: 10,
      }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', {
        prompt: 27, cacheRead: 1536, reasoning: 3, completion: 13,
      }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', {
        prompt: 32, cacheRead: 2304, reasoning: 7, completion: 9,
      }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    // Σ per-node per category — zero residual by construction.
    expect(result.inputTokens).toBe(100 + 27 + 32);
    expect(result.cacheReadTokens).toBe(512000 + 1536 + 2304);
    expect(result.reasoningTokens).toBe(5 + 3 + 7);
    expect(result.outputTokens).toBe(10 + 13 + 9);
    // R-3.1: Total = Input + Cache + Reasoning + Output exactly.
    expect(result.totalTokens).toBe(100 + 27 + 32 + 512000 + 1536 + 2304 + 5 + 3 + 7 + 10 + 13 + 9);
  });

  it('a node carrying the session-cumulative cache value does not inflate the reconciled total to the raw sum', () => {
    // Contamination guard: if a node's delivery carried the RAW cumulative
    // cache value (513,536 = Σ turns 1..2) instead of its per-turn delta
    // (1,536), the session bar would over-count. The adapter fix (H1) prevents
    // this at the source; this test pins that the Σ-reconciliation arithmetic
    // (Σ per-node) is what the bar displays — the cumulative value must not be
    // treated as additional per-turn consumption beyond the nodes' own figures.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, cacheRead: 512000, completion: 10 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, cacheRead: 1536, completion: 13 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 32, cacheRead: 2304, completion: 9 }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    // The bar shows Σ per-node (515,840) — NOT the inflated sum that would
    // result from re-adding the cumulative cache of an earlier node (which a
    // naive "session total" could double-count as 512,000 + 513,536 + …).
    expect(result.cacheReadTokens).toBe(512000 + 1536 + 2304);
    expect(result.cacheReadTokens).not.toBe(512000 + 513536 + 515840);
  });

  it('3-node init+end pairs reconcile exactly once per node (G-011) with per-turn cache deltas', () => {
    // The OTLP adapter emits a synthetic Init + Response per turn with IDENTICAL
    // payloads — feed BOTH in one batch (G-011). Per-key last-wins must count
    // each node once, and the deltas must telescope to the session figure.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'init', { prompt: 100, cacheRead: 512000, completion: 10 }),
      makeTokenDelivery('sess-1', 'corr-1', 'end',  { prompt: 100, cacheRead: 512000, completion: 10 }),
      makeTokenDelivery('sess-1', 'corr-2', 'init', { prompt: 27, cacheRead: 1536, completion: 13 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end',  { prompt: 27, cacheRead: 1536, completion: 13 }),
      makeTokenDelivery('sess-1', 'corr-3', 'init', { prompt: 32, cacheRead: 2304, completion: 9 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end',  { prompt: 32, cacheRead: 2304, completion: 9 }),
    ];
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    // Naive double-count of cache would be 2 × (512000+1536+2304); last-wins
    // per key = exactly the three nodes' deltas.
    expect(result.cacheReadTokens).toBe(512000 + 1536 + 2304);
    expect(result.inputTokens).toBe(159);
    expect(result.totalTokens).toBe(100 + 27 + 32 + 512000 + 1536 + 2304 + 10 + 13 + 9);
  });
});

// ── Spec #2734 ST-3 (R-3 / AC3): session-total cache reconciliation guard ──────
//
// The reconciliation invariant (telescoping): Σ per-node cacheReadTokens == the
// LAST chat delivery's preserved raw cumulative
// gen_ai.usage.cache_read.input_tokens (a flat attr cloned verbatim into every
// delivery payload from the span attrs — otlp.rs:998). The adapter owns
// correctness (it derives per-turn cache deltas, otlp.rs:1322-1335);
// computeSessionTokenTotals NEVER corrects — it warns on a mismatch so an
// adapter regression (the raw-cumulative fallback at otlp.rs:1105-1108 placing
// the session total on every node) surfaces in the console before the live
// tester does (Bug #586 full-chain lesson). These tests pin the guard:
// (a) the telescoping invariant holds silently, (b) a no-cache turn (R-4/AC4)
// contributes 0 and the guard stays silent, and (c) the N×-duplication
// regression (every node carrying the same cumulative) fires the warning —
// never a silent correction.

describe('Spec #2734 ST-3: cache reconciliation guard (Σ per-node == last cumulative)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('telescoping invariant: Σ per-node cacheReadTokens == last cumulative — guard silent', () => {
    // Live ses_044bb36d… series: cumulative cache 512,000 → 513,536 → 515,840;
    // per-turn deltas 512,000 / 1,536 / 2,304. Every delivery preserves its own
    // cumulative as a flat attr; the LAST delivery carries 515,840.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, cacheRead: 512000, completion: 10 }, 512000),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, cacheRead: 1536, completion: 13 }, 513536),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 32, cacheRead: 2304, completion: 9 }, 515840),
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    // Σ per-node (512000+1536+2304) == last cumulative (515840) — the
    // reconciliation invariant holds exactly (R-3); cache counted once.
    expect(result.cacheReadTokens).toBe(515840);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no-cache turn (R-4/AC4): delta 0 contributes 0 — guard silent', () => {
    // Turn 2 consumed NO cached tokens: its span carries no cache_read family,
    // so cacheReadTokens is ABSENT (→ 0) and the flat cumulative attr is absent
    // (the plugin emits it only when > 0). The turn adds 0 to the session
    // cache total; Σ per-node (512000 + 0 + 1536) still telescopes to the last
    // delivery's cumulative (513536) — no warning.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, cacheRead: 512000, completion: 10 }, 512000),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, completion: 13 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 32, cacheRead: 1536, completion: 9 }, 513536),
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    expect(result.cacheReadTokens).toBe(512000 + 0 + 1536);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('N×-duplication regression: the same cumulative on every node fires the guard — never a silent correction', () => {
    // Adapter regression shape (otlp.rs:1105-1108 raw-cumulative fallback):
    // EVERY node carries the same session-cumulative cache (515,840) as its
    // cacheReadTokens AND the identical flat cumulative — the R1 bug that put
    // the session total on every node. Σ per-node = 3 × 515,840.
    const C = 515840;
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, cacheRead: C, completion: 10 }, C),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, cacheRead: C, completion: 13 }, C),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 32, cacheRead: C, completion: 9 }, C),
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = computeSessionTokenTotals(deliveries, 'sess-1');
    // NO silent correction: the bar sums what the nodes carry (N × C) — the
    // adapter owns correctness, the guard surfaces the regression.
    expect(result.cacheReadTokens).toBe(3 * C);
    expect(result.cacheReadTokens).not.toBe(C);
    // The guard MUST fire: Σ (N × C) != last cumulative (C) — the R-3 identity
    // "count cache exactly once" is broken and the diagnostic warns.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ── #2743 ST-1 (AC-12): computeSessionMetrics — session cost + messages ───────
//
// The Total Top Bar derives totalCostUsd / totalMessages frontend-side from the
// chat-node deliveries it already consumes, under the IDENTICAL
// last-wins-per-composite-key + composited-child-exclusion rules as the token
// totals. Σ per-turn cost_usd over last-wins keys telescopes to the session
// cost; TOTAL MESSAGES = count of distinct chat composite keys.

function makeCostDelivery(
  sessionId: string,
  correlationId: string,
  lifecycle: 'init' | 'update' | 'end',
  costUsd?: number,
  tokens: { prompt?: number; completion?: number } = {},
): ContractDelivery {
  const d = makeTokenDelivery(sessionId, correlationId, lifecycle, tokens);
  if (costUsd !== undefined) {
    const inner = (d.payload.payload as Record<string, unknown>) ?? {};
    inner.cost_usd = costUsd;
  }
  return d;
}

describe('computeSessionMetrics (#2743 ST-1 / AC-12)', () => {
  it('returns zero cost + zero messages for an empty delivery list', () => {
    const result = computeSessionMetrics([], 'sess-1');
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalMessages).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it('sums cost_usd over last-wins chat keys (init+end pair counts once — G-011)', () => {
    // The OTLP adapter emits a synthetic Init + Response per turn with IDENTICAL
    // payloads — feed BOTH in one batch. Naive double-count would sum 2× each
    // turn; per-key last-wins must count each turn once.
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'init', 0.01, { prompt: 100, completion: 50 }),
      makeCostDelivery('sess-1', 'corr-1', 'end', 0.01, { prompt: 100, completion: 50 }),
      makeCostDelivery('sess-1', 'corr-2', 'init', 0.0234, { prompt: 200, completion: 75 }),
      makeCostDelivery('sess-1', 'corr-2', 'end', 0.0234, { prompt: 200, completion: 75 }),
    ];
    const result = computeSessionMetrics(deliveries, 'sess-1');
    expect(result.totalCostUsd).toBeCloseTo(0.01 + 0.0234, 10);
    expect(result.totalMessages).toBe(2);
    expect(result.totalTokens).toBe(425);
  });

  it('counts distinct last-wins chat keys as messages — same node-set as tokens', () => {
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'end', 0.005, { prompt: 10 }),
      makeCostDelivery('sess-1', 'corr-2', 'end', 0.007, { prompt: 20 }),
      makeCostDelivery('sess-1', 'corr-3', 'end', 0.003, { prompt: 30 }),
      makeCostDelivery('sess-2', 'other-1', 'end', 99, { prompt: 999 }),
    ];
    const result = computeSessionMetrics(deliveries, 'sess-1');
    expect(result.totalMessages).toBe(3);
    expect(result.totalCostUsd).toBeCloseTo(0.005 + 0.007 + 0.003, 10);
  });

  it('skips composited child-session deliveries — child cost/messages never leak (Spec #523)', () => {
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'end', 0.01, { prompt: 100, completion: 50 }),
      makeCompositedDelivery('sess-1', 'sa-corr-1', { prompt: 5000, reasoning: 5000 }),
    ];
    // The composited child carries no cost_usd — assert its composite key does
    // NOT count toward messages either (same exclusion rule).
    const result = computeSessionMetrics(deliveries, 'sess-1');
    expect(result.totalCostUsd).toBeCloseTo(0.01, 10);
    expect(result.totalMessages).toBe(1);
  });

  it('absent / invalid cost_usd sums as 0 — never NaN (no hardcoded figure)', () => {
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'end', undefined, { prompt: 10 }),
      makeCostDelivery('sess-1', 'corr-2', 'end', -1, { prompt: 20 }), // negative → 0
      makeCostDelivery('sess-1', 'corr-3', 'end', 0.02, { prompt: 30 }),
    ];
    const result = computeSessionMetrics(deliveries, 'sess-1');
    expect(result.totalCostUsd).toBeCloseTo(0.02, 10);
    expect(Number.isNaN(result.totalCostUsd)).toBe(false);
    expect(result.totalMessages).toBe(3);
  });

  it('a delivered $0.00 cost still counts as a message — never a hardcoded figure', () => {
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'end', 0, { prompt: 10 }),
    ];
    const result = computeSessionMetrics(deliveries, 'sess-1');
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalMessages).toBe(1);
  });

  it('extends SessionTokenTotals — token families byte-identical to computeSessionTokenTotals', () => {
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'end', 0.01, {
        prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780, cacheWrite: 999,
      }),
      makeCostDelivery('sess-1', 'corr-2', 'end', 0.02, { prompt: 27, completion: 10 }),
    ];
    const metrics = computeSessionMetrics(deliveries, 'sess-1');
    const totals = computeSessionTokenTotals(deliveries, 'sess-1');
    expect(metrics.inputTokens).toBe(totals.inputTokens);
    expect(metrics.cacheReadTokens).toBe(totals.cacheReadTokens);
    expect(metrics.cacheWriteTokens).toBe(totals.cacheWriteTokens);
    expect(metrics.reasoningTokens).toBe(totals.reasoningTokens);
    expect(metrics.outputTokens).toBe(totals.outputTokens);
    expect(metrics.totalTokens).toBe(totals.totalTokens);
    expect(metrics.totalCostUsd).toBeCloseTo(0.01 + 0.02, 10);
    expect(metrics.totalMessages).toBe(2);
  });
});
