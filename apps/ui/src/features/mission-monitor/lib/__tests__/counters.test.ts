/**
 * Tests for the session bottom-bar aggregation (Spec #2717 R-3.2 / #2743) —
 * now derived from typed chat rows (Spec #2788 P4.2). The v1 delivery
 * fixtures are converted through the classifier-semantics converter the
 * graph suites use. `computeSessionCounters` (the delivery-driven header-
 * badge counter) was removed with the collectors.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import { computeSessionTokenTotals, computeSessionMetrics } from '../counters';
import { formatTokenCount } from '../graph';
import { rowsFromDeliveries } from '../../hooks/__tests__/fixtures/rowsFromDeliveries';

/** P4.2 adapter: convert v1 delivery fixtures into the typed chat rows the
 *  session-total functions now consume (the sessionId arg is kept for call-
 *  site readability — the functions filter by row.sessionId internally). */
function chatRowsOf(deliveries: ContractDelivery[], _sessionId?: string) {
  return rowsFromDeliveries(deliveries).chatRows;
}

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
  rawPerRequest?: { input?: number; cacheRead?: number; output?: number; reasoning?: number },
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
  // Billed-semantics keys: the adapter preserves the RAW PER-REQUEST values as
  // flat attrs in every delivery payload (`input_tokens` / `cache_read_tokens` /
  // `output_tokens` / `reasoning_tokens` — the values DeepSeek bills per
  // request, where `cache_read_tokens` is session-cumulative and re-reported
  // every request). When present, the session bar sums THESE, not the derived
  // per-turn deltas.
  if (rawPerRequest?.input !== undefined) inner['input_tokens'] = rawPerRequest.input;
  if (rawPerRequest?.cacheRead !== undefined) inner['cache_read_tokens'] = rawPerRequest.cacheRead;
  if (rawPerRequest?.output !== undefined) inner['output_tokens'] = rawPerRequest.output;
  if (rawPerRequest?.reasoning !== undefined) inner['reasoning_tokens'] = rawPerRequest.reasoning;
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
    expect(computeSessionTokenTotals(chatRowsOf([]), 'sess-1')).toEqual(ZERO_TOTALS);
  });

  it('filters chat-node deliveries to the selected session only', () => {
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, completion: 50 }),
      makeTokenDelivery('sess-2', 'corr-2', 'end', { prompt: 9999, completion: 9999 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 27, completion: 10 }),
    ];
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
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
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
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
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
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
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
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
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    expect(result.totalTokens).toBe(190); // NOT 10190 — cacheWrite never summed.
  });

  it('treats zero/absent categories as 0 — never NaN or negative (R-3.3)', () => {
    const deliveries = [
      // Negative prompt (-5) → 0; NaN cacheRead → 0; reasoning ABSENT → 0.
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: -5, cacheRead: Number.NaN, completion: 50 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', {}), // all families absent
    ];
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
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
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
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

describe('Spec #2723 ST-3: 3+ node billed-semantics Σ (session bar = Σ RAW per-request)', () => {
  it('session CACHE sums the RAW per-request cache-read values (billed), not the delta telescope', () => {
    // Live DeepSeek semantics: `cache_read_tokens` is SESSION-CUMULATIVE and
    // re-reported on every request (each request re-reads the whole cached
    // prefix). The platform bills Σ per-request cache-hit — 512,000 + 513,536 +
    // 515,840 = 1,541,376 — NOT the delta telescope (515,840). The derived
    // per-turn deltas (512,000 / 1,536 / 2,304) are the per-NODE graph figures;
    // the session bar must sum the raw values the provider bills.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', {
        prompt: 100, cacheRead: 512000, reasoning: 5, completion: 10,
      }, undefined, { input: 100, cacheRead: 512000, output: 10, reasoning: 5 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', {
        prompt: 27, cacheRead: 1536, reasoning: 3, completion: 13,
      }, undefined, { input: 27, cacheRead: 513536, output: 13, reasoning: 3 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', {
        prompt: 32, cacheRead: 2304, reasoning: 7, completion: 9,
      }, undefined, { input: 32, cacheRead: 515840, output: 9, reasoning: 7 }),
    ];
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    // Billed semantics: CACHE = Σ raw per-request cache-read (the platform's
    // "Input (Cache hit)" column) — never the delta telescope.
    expect(result.cacheReadTokens).toBe(512000 + 513536 + 515840);
    expect(result.cacheReadTokens).not.toBe(512000 + 1536 + 2304);
    // INPUT = Σ raw per-request input; output/reasoning are per-turn already.
    expect(result.inputTokens).toBe(100 + 27 + 32);
    expect(result.reasoningTokens).toBe(5 + 3 + 7);
    expect(result.outputTokens).toBe(10 + 13 + 9);
    // R-3.1: Total = Input + Cache + Reasoning + Output exactly.
    expect(result.totalTokens).toBe(100 + 27 + 32 + 512000 + 513536 + 515840 + 5 + 3 + 7 + 10 + 13 + 9);
  });

  it('legacy deliveries without the raw flat keys fall back to the derived deltas (unchanged behavior)', () => {
    // Pre-billed-semantics fixtures (Hook transport / legacy) carry only the
    // derived per-turn deltas — no `cache_read_tokens` raw flat key. The bar
    // falls back to the deltas (Δ telescopes to the last cumulative), so the
    // figure is the same as before the change.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, cacheRead: 512000, completion: 10 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, cacheRead: 1536, completion: 13 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 32, cacheRead: 2304, completion: 9 }),
    ];
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    expect(result.cacheReadTokens).toBe(512000 + 1536 + 2304);
    expect(result.cacheReadTokens).not.toBe(512000 + 513536 + 515840);
  });

  it('3-node init+end pairs with raw keys reconcile exactly once per node (G-011)', () => {
    // The OTLP adapter emits a synthetic Init + Response per turn with IDENTICAL
    // payloads — feed BOTH in one batch. Per-key last-wins must count each node
    // once, and the billed sum uses the raw per-request values.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'init', { prompt: 100, cacheRead: 512000, completion: 10 }, undefined, { input: 100, cacheRead: 512000, output: 10 }),
      makeTokenDelivery('sess-1', 'corr-1', 'end',  { prompt: 100, cacheRead: 512000, completion: 10 }, undefined, { input: 100, cacheRead: 512000, output: 10 }),
      makeTokenDelivery('sess-1', 'corr-2', 'init', { prompt: 27, cacheRead: 1536, completion: 13 }, undefined, { input: 27, cacheRead: 513536, output: 13 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end',  { prompt: 27, cacheRead: 1536, completion: 13 }, undefined, { input: 27, cacheRead: 513536, output: 13 }),
      makeTokenDelivery('sess-1', 'corr-3', 'init', { prompt: 32, cacheRead: 2304, completion: 9 }, undefined, { input: 32, cacheRead: 515840, output: 9 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end',  { prompt: 32, cacheRead: 2304, completion: 9 }, undefined, { input: 32, cacheRead: 515840, output: 9 }),
    ];
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    // Naive double-count of cache would be 2 × (512000+513536+515840); last-wins
    // per key = exactly the three nodes' raw values.
    expect(result.cacheReadTokens).toBe(512000 + 513536 + 515840);
    expect(result.inputTokens).toBe(159);
    expect(result.totalTokens).toBe(100 + 27 + 32 + 512000 + 513536 + 515840 + 10 + 13 + 9);
  });

  it('live-session regression: parent raw per-request sums reconcile to the DeepSeek billed figures', () => {
    // Session `ses_fdfa371d…` (12:08–12:14 local, deepseek-v4-flash): the app
    // previously showed CACHE 85,632 (Δ telescope) while DeepSeek billed the Σ
    // per-request cache-read. The parent's RAW flat keys per request are
    // 63,634 input / 800,640 cache-read / 2,897 output / 2,631 reasoning —
    // exactly the telemetry sums (parent + subagent → 174,768 / 1,541,504 /
    // 8,741 / 10,957, which matches the platform's billed figures). This pins
    // the billed-semantics aggregation against the real reconciled numbers.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 10399, cacheRead: 20096, reasoning: 81, completion: 138 }, undefined, { input: 10399, cacheRead: 20096, output: 138, reasoning: 81 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 3831, cacheRead: 10496, reasoning: 36, completion: 119 }, undefined, { input: 3831, cacheRead: 30592, output: 119, reasoning: 36 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 5033, cacheRead: 3968, reasoning: 165, completion: 155 }, undefined, { input: 5033, cacheRead: 34560, output: 155, reasoning: 165 }),
      makeTokenDelivery('sess-1', 'corr-4', 'end', { prompt: 18136, cacheRead: 5248, reasoning: 53, completion: 67 }, undefined, { input: 18136, cacheRead: 39808, output: 67, reasoning: 53 }),
      makeTokenDelivery('sess-1', 'corr-5', 'end', { prompt: 4502, cacheRead: 18176, reasoning: 585, completion: 338 }, undefined, { input: 4502, cacheRead: 57984, output: 338, reasoning: 585 }),
      makeTokenDelivery('sess-1', 'corr-6', 'end', { prompt: 60, cacheRead: 5376, reasoning: 704, completion: 153 }, undefined, { input: 60, cacheRead: 63360, output: 153, reasoning: 704 }),
      makeTokenDelivery('sess-1', 'corr-7', 'end', { prompt: 207, cacheRead: 896, reasoning: 108, completion: 131 }, undefined, { input: 207, cacheRead: 64256, output: 131, reasoning: 108 }),
      makeTokenDelivery('sess-1', 'corr-8', 'end', { prompt: 76, cacheRead: 384, reasoning: 25, completion: 84 }, undefined, { input: 76, cacheRead: 64640, output: 84, reasoning: 25 }),
      makeTokenDelivery('sess-1', 'corr-9', 'end', { prompt: 72, cacheRead: 128, completion: 129 }, undefined, { input: 72, cacheRead: 64768, output: 129 }),
      makeTokenDelivery('sess-1', 'corr-10', 'end', { prompt: 3526, cacheRead: 128, reasoning: 37, completion: 84 }, undefined, { input: 3526, cacheRead: 64896, output: 84, reasoning: 37 }),
      makeTokenDelivery('sess-1', 'corr-11', 'end', { prompt: 868, cacheRead: 3584, reasoning: 84, completion: 157 }, undefined, { input: 868, cacheRead: 68480, output: 157, reasoning: 84 }),
      makeTokenDelivery('sess-1', 'corr-12', 'end', { prompt: 2369, cacheRead: 1024, reasoning: 118, completion: 149 }, undefined, { input: 2369, cacheRead: 69504, output: 149, reasoning: 118 }),
      makeTokenDelivery('sess-1', 'corr-13', 'end', { prompt: 12626, cacheRead: 2560, reasoning: 329, completion: 708 }, undefined, { input: 12626, cacheRead: 72064, output: 708, reasoning: 329 }),
      makeTokenDelivery('sess-1', 'corr-14', 'end', { prompt: 1929, cacheRead: 13568, reasoning: 306, completion: 485 }, undefined, { input: 1929, cacheRead: 85632, output: 485, reasoning: 306 }),
    ];
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    // Billed sums (raw per-request) — matches the telemetry sums for the parent.
    expect(result.inputTokens).toBe(63634);
    expect(result.cacheReadTokens).toBe(800640);
    expect(result.outputTokens).toBe(2897);
    expect(result.reasoningTokens).toBe(2631);
    // NOT the delta telescope (the old displayed figures).
    expect(result.cacheReadTokens).not.toBe(85632);
    expect(result.inputTokens).not.toBe(40063);
  });
});

// ── Spec #2734 ST-3 (R-3 / AC3): billed-semantics cache reconciliation guard ──
//
// The billed-semantics invariant: the session CACHE total sums the RAW
// per-request `cache_read_tokens` (each request re-reports the cumulative
// cached-prefix size; DeepSeek bills the sum across requests). A cache-bearing
// delivery that lacks the raw flat key falls back to its derived per-turn DELTA,
// under-stating the billed figure. The guard warns on that fallback so an
// adapter regression (raw key dropped) surfaces in the console — NEVER a silent
// correction (Bug #586 full-chain lesson). These tests pin the guard:
// (a) raw-key-carrying deliveries sum the billed figure and stay silent,
// (b) a no-cache turn contributes 0 and stays silent, and (c) a cache-bearing
// delivery WITHOUT the raw key fires the warning.

describe('Spec #2734 ST-3: billed-semantics cache reconciliation guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('raw per-request cache keys present → billed sum; guard silent', () => {
    // Live DeepSeek series: cumulative cache 512,000 → 513,536 → 515,840;
    // per-turn deltas 512,000 / 1,536 / 2,304. Every delivery preserves its own
    // per-request cumulative as the raw flat key; the bar sums them (billed).
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, cacheRead: 512000, completion: 10 }, undefined, { input: 100, cacheRead: 512000, output: 10 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, cacheRead: 1536, completion: 13 }, undefined, { input: 27, cacheRead: 513536, output: 13 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 32, cacheRead: 2304, completion: 9 }, undefined, { input: 32, cacheRead: 515840, output: 9 }),
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    // Billed figure: Σ per-request cache-read (512000+513536+515840), NOT the
    // delta telescope (515840).
    expect(result.cacheReadTokens).toBe(512000 + 513536 + 515840);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no-cache turn (R-4/AC4): contributes 0 — guard silent', () => {
    // Turn 2 consumed NO cached tokens: its span carries no cache_read family,
    // so both the raw key and the derived delta are ABSENT (→ 0). The turn adds
    // 0 to the session cache total; the two cache-bearing turns carry their raw
    // keys — no warning.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, cacheRead: 512000, completion: 10 }, undefined, { input: 100, cacheRead: 512000, output: 10 }),
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, completion: 13 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 32, cacheRead: 1536, completion: 9 }, undefined, { input: 32, cacheRead: 513536, output: 9 }),
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    expect(result.cacheReadTokens).toBe(512000 + 513536);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('cache-bearing delivery WITHOUT the raw flat key falls back to its delta — guard fires (never a silent correction)', () => {
    // Adapter regression shape: a cache-bearing delivery carries the derived
    // per-turn cache DELTA but the raw per-request `cache_read_tokens` flat key
    // was dropped. The bar falls back to the delta (under-stating the billed
    // figure) — and the guard warns, never silently corrects.
    const deliveries = [
      makeTokenDelivery('sess-1', 'corr-1', 'end', { prompt: 100, cacheRead: 512000, completion: 10 }, undefined, { input: 100, cacheRead: 512000, output: 10 }),
      // Turn 2: cache-bearing (delta 1,536) but NO raw flat key → fallback.
      makeTokenDelivery('sess-1', 'corr-2', 'end', { prompt: 27, cacheRead: 1536, completion: 13 }),
      makeTokenDelivery('sess-1', 'corr-3', 'end', { prompt: 32, cacheRead: 2304, completion: 9 }, undefined, { input: 32, cacheRead: 515840, output: 9 }),
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    // Fallback: turn 2 contributes its delta (1,536) instead of the billed raw
    // cumulative (513,536) — the figure under-states and the guard MUST fire.
    expect(result.cacheReadTokens).toBe(512000 + 1536 + 515840);
    expect(result.cacheReadTokens).not.toBe(512000 + 513536 + 515840);
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
    const result = computeSessionMetrics(chatRowsOf([]), 'sess-1');
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
    const result = computeSessionMetrics(chatRowsOf(deliveries), 'sess-1');
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
    const result = computeSessionMetrics(chatRowsOf(deliveries), 'sess-1');
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
    const result = computeSessionMetrics(chatRowsOf(deliveries), 'sess-1');
    expect(result.totalCostUsd).toBeCloseTo(0.01, 10);
    expect(result.totalMessages).toBe(1);
  });

  it('absent / invalid cost_usd sums as 0 — never NaN (no hardcoded figure)', () => {
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'end', undefined, { prompt: 10 }),
      makeCostDelivery('sess-1', 'corr-2', 'end', -1, { prompt: 20 }), // negative → 0
      makeCostDelivery('sess-1', 'corr-3', 'end', 0.02, { prompt: 30 }),
    ];
    const result = computeSessionMetrics(chatRowsOf(deliveries), 'sess-1');
    expect(result.totalCostUsd).toBeCloseTo(0.02, 10);
    expect(Number.isNaN(result.totalCostUsd)).toBe(false);
    expect(result.totalMessages).toBe(3);
  });

  it('a delivered $0.00 cost still counts as a message — never a hardcoded figure', () => {
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'end', 0, { prompt: 10 }),
    ];
    const result = computeSessionMetrics(chatRowsOf(deliveries), 'sess-1');
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
    const metrics = computeSessionMetrics(chatRowsOf(deliveries), 'sess-1');
    const totals = computeSessionTokenTotals(chatRowsOf(deliveries), 'sess-1');
    expect(metrics.inputTokens).toBe(totals.inputTokens);
    expect(metrics.cacheReadTokens).toBe(totals.cacheReadTokens);
    expect(metrics.cacheWriteTokens).toBe(totals.cacheWriteTokens);
    expect(metrics.reasoningTokens).toBe(totals.reasoningTokens);
    expect(metrics.outputTokens).toBe(totals.outputTokens);
    expect(metrics.totalTokens).toBe(totals.totalTokens);
    expect(metrics.totalCostUsd).toBeCloseTo(0.01 + 0.02, 10);
    expect(metrics.totalMessages).toBe(2);
  });

  it('reconciliation contract (R-27): bar == Σ node totals with zero residual — cost + messages + tokens (G-011 init+end pairs)', () => {
    // The reconciliation contract the top bar must satisfy: TOTAL MESSAGES =
    // the number of distinct last-wins chat keys (one per graph node) and
    // ESTIMATED COST = Σ per-key cost_usd over that same node set — zero
    // residual. Round-3 AC-12 regression shape: the OTLP adapter emits a
    // synthetic Init + Response per turn with identical payloads, and a
    // composited child-session delivery must be excluded from BOTH figures.
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'init', 0.01, { prompt: 100, completion: 50 }),
      makeCostDelivery('sess-1', 'corr-1', 'end',  0.01, { prompt: 100, completion: 50 }),
      makeCostDelivery('sess-1', 'corr-2', 'init', 0.0234, { prompt: 200, completion: 75 }),
      makeCostDelivery('sess-1', 'corr-2', 'end',  0.0234, { prompt: 200, completion: 75 }),
      makeCostDelivery('sess-1', 'corr-3', 'end',  0.005, { prompt: 30, completion: 10 }),
      // Composited child-session delivery (same sessionId, marked composited)
      // — becomes a SubagentNode, NEVER an AgentNode; must not count toward
      // messages or cost (Spec #523 exclusion).
      makeCompositedDelivery('sess-1', 'sa-corr-1', { prompt: 5000, reasoning: 5000 }),
    ];
    const metrics = computeSessionMetrics(chatRowsOf(deliveries), 'sess-1');

    // Messages == the 3 distinct parent chat keys (init+end dedupes to one key
    // per turn; the composited child key is excluded).
    expect(metrics.totalMessages).toBe(3);
    // Cost == Σ per-key cost_usd over exactly those 3 keys.
    expect(metrics.totalCostUsd).toBeCloseTo(0.01 + 0.0234 + 0.005, 12);
    // Token families reconcile to the same node set — zero residual.
    expect(metrics.inputTokens).toBe(100 + 200 + 30);
    expect(metrics.outputTokens).toBe(50 + 75 + 10);
    expect(metrics.totalTokens).toBe(100 + 200 + 30 + 50 + 75 + 10);
    // The bar == Σ node totals identity holds exactly (no double-count from
    // the init+end pairs, no leak from the composited child).
    expect(metrics.totalCostUsd).toBeCloseTo(
      0.01 + 0.0234 + 0.005,
      12,
    );
  });

  it('#2750 round-6 (AC1): reproduces the round-5 fixture session byte-exactly — TWO parent chat spans + one task span → estimatedCost $0.0023', () => {
    // Session `ses_fed7699aaffejpWUiOZM4y2eai` (round-5 AC1 fail): the tester
    // summed ONE parent chat span (0.0001225168) + the task childCost
    // (0.0020461224) and expected `$0.0022` — but the session has a SECOND
    // parent chat span (the reply turn `_3`, cost_usd 0.0000982352), so the
    // true parent total is 0.0001225168 + 0.0000982352 = 0.000220752 and the
    // byte-exact session cost is 0.000220752 + 0.0020461224 = 0.0022668744 →
    // `$0.0023`. This test pins the PARENT-side computation with the exact
    // span numbers (the subagent side is pinned in sessionMeta.test.ts and the
    // combined byte-exact display in SessionTokenBar.test.tsx).
    const deliveries = [
      makeCostDelivery('sess-1', 'corr-1', 'init', 0.0001225168),
      makeCostDelivery('sess-1', 'corr-1', 'end', 0.0001225168),
      makeCostDelivery('sess-1', 'corr-2', 'init', 0.0000982352),
      makeCostDelivery('sess-1', 'corr-2', 'end', 0.0000982352),
    ];
    const metrics = computeSessionMetrics(chatRowsOf(deliveries), 'sess-1');
    expect(metrics.totalCostUsd).toBeCloseTo(0.000220752, 12);
    expect(metrics.totalMessages).toBe(2);
  });
});
