/**
 * Tests for the ST-1 session-metadata pure functions (#2748):
 * `deriveSessionName`, `deriveDisplayName`, `computeSubagentTokenTotals`.
 *
 * Covers R-1.1 (first-message derivation + truncation + whitespace
 * normalization), R-1.2 (no-chat-message fallback), R-2.3 (custom-name
 * precedence), and R-3.1 (SUBAGENTS last-wins aggregation, build/plan
 * exclusion, breakdown-vs-aggregate rule, zero-guarding).
 */
import { describe, it, expect } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import {
  deriveSessionName,
  deriveDisplayName,
  computeSubagentTokenTotals,
  computeSubagentCostTotals,
  INTERNAL_TOOL_EXECUTION_AGENTS,
  type SessionNameFields,
} from '../sessionMeta';

// ── Fixture helpers ───────────────────────────────────────────────────────────

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T10:01:00.000Z';
const T2 = '2026-01-01T10:02:00.000Z';

function makeDelivery(
  contractName: 'chat-node' | 'tool-use-lifecycle',
  sessionId: string,
  correlationId: string,
  lifecycle: 'init' | 'update' | 'end',
  timestamp: string,
  innerPayload: Record<string, unknown>,
): ContractDelivery {
  return {
    id: crypto.randomUUID(),
    contractName,
    lifecycle,
    key: { sessionId, correlationId },
    payload: { payload: innerPayload },
    timestamp,
  };
}

/** Chat-node delivery carrying an optional adapter-injected `userMessage`. */
function chatDelivery(
  sessionId: string,
  correlationId: string,
  timestamp: string,
  userMessage?: string,
): ContractDelivery {
  return makeDelivery('chat-node', sessionId, correlationId, 'init', timestamp, {
    ...(userMessage !== undefined ? { userMessage } : {}),
    agentReply: 'reply',
    promptTokens: 100,
    completionTokens: 50,
  });
}

/** Tool-use-lifecycle delivery for a `task` span with child-completion fields. */
function taskDelivery(
  sessionId: string,
  correlationId: string,
  lifecycle: 'init' | 'update' | 'end',
  timestamp: string,
  overrides: Record<string, unknown> = {},
): ContractDelivery {
  return makeDelivery('tool-use-lifecycle', sessionId, correlationId, lifecycle, timestamp, {
    'gen_ai.tool.name': 'task',
    input: JSON.stringify({ subagent_type: 'explore', prompt: 'investigate' }),
    ...overrides,
  });
}

const SESSION = 'sess-1';
const OTHER_SESSION = 'sess-2';

// ── deriveSessionName — AC1 / R-1.1 + R-1.2 ──────────────────────────────────

describe('deriveSessionName', () => {
  it('returns undefined for no deliveries', () => {
    expect(deriveSessionName([], SESSION)).toBeUndefined();
  });

  it('returns the EARLIEST non-empty userMessage in a multi-message session', () => {
    const deliveries = [
      chatDelivery(SESSION, 'c1', T2, 'second message, later'),
      chatDelivery(SESSION, 'c2', T0, 'first message, earliest'),
      chatDelivery(SESSION, 'c3', T1, 'middle message'),
    ];
    expect(deriveSessionName(deliveries, SESSION)).toBe('first message, earliest');
  });

  it('ignores deliveries of OTHER sessions', () => {
    const deliveries = [
      chatDelivery(OTHER_SESSION, 'c1', T0, 'another session'),
      chatDelivery(SESSION, 'c2', T1, 'this session'),
    ];
    expect(deriveSessionName(deliveries, SESSION)).toBe('this session');
  });

  it('skips deliveries whose userMessage is empty or whitespace-only', () => {
    const deliveries = [
      chatDelivery(SESSION, 'c1', T0, '   '),
      chatDelivery(SESSION, 'c2', T1, ''),
      chatDelivery(SESSION, 'c3', T2, 'real text'),
    ];
    expect(deriveSessionName(deliveries, SESSION)).toBe('real text');
  });

  it('returns undefined when NO chat delivery carries non-empty user text (R-1.2 fallback)', () => {
    const deliveries = [
      chatDelivery(SESSION, 'c1', T0, ''),
      chatDelivery(SESSION, 'c2', T1), // userMessage absent entirely
    ];
    expect(deriveSessionName(deliveries, SESSION)).toBeUndefined();
  });

  it('collapses whitespace and newlines to a single line, trimming ends', () => {
    const deliveries = [
      chatDelivery(SESSION, 'c1', T0, '  first\tline\n\nsecond  line\r\n  third  '),
    ];
    expect(deriveSessionName(deliveries, SESSION)).toBe('first line second line third');
  });

  it('truncation boundary — a name of EXACTLY 40 chars is returned untruncated', () => {
    const exactly40 = 'x'.repeat(40);
    expect(deriveSessionName([chatDelivery(SESSION, 'c1', T0, exactly40)], SESSION)).toBe(exactly40);
    expect(deriveSessionName([chatDelivery(SESSION, 'c1', T0, exactly40)], SESSION)!.length).toBe(40);
  });

  it('truncation boundary — 41+ chars keeps 39 code units + ellipsis = 40 total (ellipsis counted)', () => {
    const over = 'y'.repeat(41);
    const result = deriveSessionName([chatDelivery(SESSION, 'c1', T0, over)], SESSION)!;
    expect(result).toBe('y'.repeat(39) + '…');
    expect(result.length).toBe(40);
  });

  it('truncation does not split a surrogate pair (astral/emoji dropped intact, never broken)', () => {
    // '😀' is a surrogate pair (2 code units). With the pair straddling the
    // 39/40 cut boundary, truncation must step back BEFORE the pair — the
    // emoji is dropped as a whole rather than emitting a lone high surrogate
    // (a broken pair would render as a replacement char). The 40-char budget
    // INCLUDING the ellipsis is preserved.
    const emoji = '😀';
    const over = 'z'.repeat(38) + emoji + 'q'; // 38 + 2 + 1 = 41 code units
    const result = deriveSessionName([chatDelivery(SESSION, 'c1', T0, over)], SESSION)!;
    expect(result).toBe('z'.repeat(38) + '…');
    expect(result).not.toMatch(/[\uD800-\uDFFF]/); // no lone surrogate remains
    expect(result.length).toBe(39);
  });

  it('truncation applies AFTER whitespace normalization', () => {
    const spaced = 'a   ' + 'b'.repeat(50); // whitespace run + 50 code units
    const result = deriveSessionName([chatDelivery(SESSION, 'c1', T0, spaced)], SESSION)!;
    // Normalized first: 'a' + ' ' + 'b'*50 (52 code units), then hard-truncated
    // to 39 code units + '…' = 40 total.
    expect(result).toBe('a ' + 'b'.repeat(37) + '…');
    expect(result.length).toBe(40);
  });
});

// ── deriveDisplayName — R-1.1/R-1.2/R-2.3 ────────────────────────────────────

describe('deriveDisplayName', () => {
  const base: SessionNameFields = { label: '2026/1/1 10:00:00 AM' };

  it('prefers customName over derivedName over label', () => {
    expect(
      deriveDisplayName({ ...base, customName: 'mine', derivedName: 'derived' }),
    ).toBe('mine');
    expect(deriveDisplayName({ ...base, derivedName: 'derived' })).toBe('derived');
    expect(deriveDisplayName(base)).toBe('2026/1/1 10:00:00 AM');
  });

  it('returns an empty-string customName verbatim (?? is nullish-coalescing — empty is not nullish)', () => {
    // The persistence layer (ST-2) stores an empty save as NULL, so an empty
    // customName should not occur in production; the pure function's contract
    // is the literal `customName ?? derivedName ?? label` formula.
    expect(deriveDisplayName({ ...base, customName: '', derivedName: 'derived' })).toBe('');
  });
});

// ── computeSubagentTokenTotals — AC3 / R-3.1 ─────────────────────────────────

describe('computeSubagentTokenTotals', () => {
  it('returns 0 for no deliveries and for sessions without task spans', () => {
    expect(computeSubagentTokenTotals([], SESSION)).toBe(0);
    const nonTask = [
      makeDelivery('tool-use-lifecycle', SESSION, 'c1', 'end', T0, {
        'gen_ai.tool.name': 'bash',
        input: JSON.stringify({ command: 'ls' }),
      }),
    ];
    expect(computeSubagentTokenTotals(nonTask, SESSION)).toBe(0);
  });

  it('last-wins per composite key — the END delivery overrides the INIT', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'init', T0, { childTokens: 0 }),
      taskDelivery(SESSION, 'task-1', 'end', T1, { childTokens: 1_234 }),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(1_234);
  });

  it('sums multiple distinct subagent dispatches (per composite key)', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, { childTokens: 1_234 }),
      taskDelivery(SESSION, 'task-2', 'end', T1, { childTokens: 5_678 }),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(1_234 + 5_678);
  });

  it('is scoped to the requested session only', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, { childTokens: 100 }),
      taskDelivery(OTHER_SESSION, 'task-2', 'end', T1, { childTokens: 9_999 }),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(100);
  });

  it('excludes internal tool-execution agents build/plan (parsed from subagent_type)', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, {
        input: JSON.stringify({ subagent_type: 'build', prompt: 'execute tool' }),
        childTokens: 999,
      }),
      taskDelivery(SESSION, 'task-2', 'end', T1, {
        input: JSON.stringify({ subagent_type: 'plan', prompt: 'plan' }),
        childTokens: 888,
      }),
      taskDelivery(SESSION, 'task-3', 'end', T2, {
        input: JSON.stringify({ subagent_type: 'explore', prompt: 'real subagent' }),
        childTokens: 100,
      }),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(100);
    expect(INTERNAL_TOOL_EXECUTION_AGENTS).toEqual(['build', 'plan']);
  });

  it('uses the per-family breakdown (sum of four) when ANY breakdown field is present', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, {
        childInputTokens: 100,
        childCacheReadTokens: 20,
        childReasoningTokens: 10,
        childOutputTokens: 40,
        childTokens: 999, // aggregate deliberately ≠ breakdown sum — must be ignored
      }),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(170);
  });

  it('uses the aggregate childTokens when NO breakdown field is present (legacy)', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, { childTokens: 1_840 }),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(1_840);
  });

  it('falls back to the legacy `tool_name` key when gen_ai.tool.name is absent', () => {
    const deliveries = [
      makeDelivery('tool-use-lifecycle', SESSION, 'task-1', 'end', T0, {
        tool_name: 'task',
        input: JSON.stringify({ subagent_type: 'explore' }),
        childTokens: 500,
      }),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(500);
  });

  it('zero-guards NaN/negative/absent token figures — never NaN, never negative', () => {
    const deliveries = [
      // Breakdown with NaN/negative members → 0 per family.
      taskDelivery(SESSION, 'task-1', 'end', T0, {
        childInputTokens: Number.NaN,
        childCacheReadTokens: -5,
        childReasoningTokens: undefined,
        childOutputTokens: 0,
      }),
      // Aggregate NaN → 0.
      taskDelivery(SESSION, 'task-2', 'end', T1, { childTokens: Number.NaN }),
      // Aggregate negative → 0.
      taskDelivery(SESSION, 'task-3', 'end', T2, { childTokens: -100 }),
      // No child token fields at all → 0.
      taskDelivery(SESSION, 'task-4', 'end', T2, {}),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(0);
  });

  it('ignores malformed task-args JSON (degrades to no exclusion) and non-task spans', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, {
        input: 'not-json{{{',
        childTokens: 321,
      }),
    ];
    expect(computeSubagentTokenTotals(deliveries, SESSION)).toBe(321);
  });
});

// ── computeSubagentCostTotals — #2750 AC1 ────────────────────────────────────
//
// Mirrors computeSubagentTokenTotals exactly (same last-wins per composite
// key, task-tool-only filter, build/plan exclusion) but sums the delivered
// `childCost` (normalizeCost-guarded) — the SUBAGENT share of the session's
// ESTIMATED COST. The parent + subagent combine happens in the panel.

describe('computeSubagentCostTotals (#2750 AC1)', () => {
  it('returns 0 for no deliveries and for sessions without task spans', () => {
    expect(computeSubagentCostTotals([], SESSION)).toBe(0);
    const nonTask = [
      makeDelivery('tool-use-lifecycle', SESSION, 'c1', 'end', T0, {
        'gen_ai.tool.name': 'bash',
        input: JSON.stringify({ command: 'ls' }),
      }),
    ];
    expect(computeSubagentCostTotals(nonTask, SESSION)).toBe(0);
  });

  it('last-wins per composite key — the END delivery overrides the INIT', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'init', T0, { childCost: 0 }),
      taskDelivery(SESSION, 'task-1', 'end', T1, { childCost: 0.0123 }),
    ];
    expect(computeSubagentCostTotals(deliveries, SESSION)).toBe(0.0123);
  });

  it('sums multiple distinct subagent dispatches (per composite key)', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, { childCost: 0.0123 }),
      taskDelivery(SESSION, 'task-2', 'end', T1, { childCost: 0.0567 }),
    ];
    expect(computeSubagentCostTotals(deliveries, SESSION)).toBeCloseTo(0.069, 6);
  });

  it('is scoped to the requested session only', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, { childCost: 0.01 }),
      taskDelivery(OTHER_SESSION, 'task-2', 'end', T1, { childCost: 9.99 }),
    ];
    expect(computeSubagentCostTotals(deliveries, SESSION)).toBeCloseTo(0.01, 6);
  });

  it('excludes internal tool-execution agents build/plan (parsed from subagent_type)', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, {
        input: JSON.stringify({ subagent_type: 'build', prompt: 'execute tool' }),
        childCost: 0.5,
      }),
      taskDelivery(SESSION, 'task-2', 'end', T1, {
        input: JSON.stringify({ subagent_type: 'plan', prompt: 'plan' }),
        childCost: 0.4,
      }),
      taskDelivery(SESSION, 'task-3', 'end', T2, {
        input: JSON.stringify({ subagent_type: 'explore', prompt: 'real subagent' }),
        childCost: 0.01,
      }),
    ];
    expect(computeSubagentCostTotals(deliveries, SESSION)).toBeCloseTo(0.01, 6);
  });

  it('zero-guards NaN/negative/absent cost figures — never NaN, never negative', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, { childCost: Number.NaN }),
      taskDelivery(SESSION, 'task-2', 'end', T1, { childCost: -5 }),
      taskDelivery(SESSION, 'task-3', 'end', T2, {}), // no childCost at all
      taskDelivery(SESSION, 'task-4', 'end', T2, { childCost: 0 }),
    ];
    expect(computeSubagentCostTotals(deliveries, SESSION)).toBe(0);
  });

  it('falls back to the legacy `tool_name` key when gen_ai.tool.name is absent', () => {
    const deliveries = [
      makeDelivery('tool-use-lifecycle', SESSION, 'task-1', 'end', T0, {
        tool_name: 'task',
        input: JSON.stringify({ subagent_type: 'explore' }),
        childCost: 0.005,
      }),
    ];
    expect(computeSubagentCostTotals(deliveries, SESSION)).toBeCloseTo(0.005, 6);
  });

  it('ignores malformed task-args JSON (degrades to no exclusion)', () => {
    const deliveries = [
      taskDelivery(SESSION, 'task-1', 'end', T0, {
        input: 'not-json{{{',
        childCost: 0.0321,
      }),
    ];
    expect(computeSubagentCostTotals(deliveries, SESSION)).toBeCloseTo(0.0321, 6);
  });

  it('#2750 round-6 (AC1): reproduces the round-5 fixture task span byte-exactly — childCost 0.0020461224 (general subagent, legacy tool_name key)', () => {
    // Session `ses_fed7699aaffejpWUiOZM4y2eai` round-5 task span: the persisted
    // delivery carries the tool name under the LEGACY `tool_name` key (the
    // round-5 evidence confirmed `gen_ai.tool.name` is ABSENT from the
    // persisted JSON), `subagent_type: 'general'` (a user-requested subagent,
    // NOT build/plan), and `childCost: 0.0020461223999999997`. The subagent
    // cost share MUST be byte-exact 0.0020461224 — the exact figure the
    // SessionTokenBar test combines with the two parent spans for `$0.0023`.
    const deliveries = [
      makeDelivery('tool-use-lifecycle', SESSION, 'task-1', 'init', T0, {
        tool_name: 'task',
        input: JSON.stringify({
          description: 'Research current date',
          prompt: 'Research the current date.',
          subagent_type: 'general',
        }),
        childCost: 0.0020461223999999997,
      }),
      makeDelivery('tool-use-lifecycle', SESSION, 'task-1', 'end', T1, {
        tool_name: 'task',
        input: JSON.stringify({
          description: 'Research current date',
          prompt: 'Research the current date.',
          subagent_type: 'general',
        }),
        childCost: 0.0020461223999999997,
      }),
    ];
    expect(computeSubagentCostTotals(deliveries, SESSION)).toBeCloseTo(0.0020461224, 12);
  });
});
