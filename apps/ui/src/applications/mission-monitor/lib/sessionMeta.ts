/**
 * sessionMeta.ts — Mission Monitor session-metadata pure functions (#2748 ST-1).
 *
 * A single file-independent home for the AC1 (session display name) and AC3
 * (SUBAGENTS token total) computations shared by the session-list hook, the
 * persistence layer, and the token bar. Pure functions — no React, no IPC, no
 * store access — so they are trivially unit-testable and reusable across
 * surfaces.
 *
 * Spec #2788 P4.3/P5.1: the sidebar derives from typed RTDB rows — the v1
 * delivery-input `deriveSessionName` was deleted with the v1 pipeline; the
 * hook derives names from the Chat rows' `userMessage` via `formatDerivedName`.
 */
import type { ToolUseRow } from '../../../shared/classes/EventSubscription';
import { rawPayload } from './rowDerivation';
import { normalizeTokenCount, normalizeCost } from './graph';

/**
 * Internal opencode tool-execution agents (#2745 AC-4 / R-4). Their `task`
 * dispatches are spawned internally to execute tool calls in sub-sessions and
 * are NOT user-requested @-subagent dispatches — they must be excluded from
 * the SUBAGENTS figure. Keyed on the SAME parsed args field the SubagentNode
 * displays (`subagent_type`). Mirrors `INTERNAL_TOOL_EXECUTION_AGENTS` in
 * hooks/useMissionMonitor.ts (kept local so this pure lib never imports a
 * React hook module).
 */
export const INTERNAL_TOOL_EXECUTION_AGENTS = ['build', 'plan'];

/** The canonical display-name length budget — INCLUDING the trailing ellipsis
 *  when truncated (#2748 R-1.1: "truncated to 40 characters with a trailing
 *  `…` when truncated"; the ellipsis is counted within the 40 — QA Q-1
 *  default). */
export const DERIVED_NAME_MAX_LENGTH = 40;

/** The name fields `deriveDisplayName` resolves (custom > derived > label).
 *  `MissionMonitorSession` (lib/graph.ts) structurally satisfies this once
 *  ST-2 adds the optional name fields; the structural param keeps this
 *  function independent of the interface evolution. */
export interface SessionNameFields {
  label: string;
  customName?: string;
  derivedName?: string;
}

/**
 * Collapse runs of whitespace (spaces, tabs, newlines) to a single space and
 * trim the ends — the AC1 "whitespace-normalized to one line" rule (R-1.1).
 * A multi-line user prompt becomes a single-line display string.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Hard-truncate a normalized name to `DERIVED_NAME_MAX_LENGTH` characters
 * INCLUDING the trailing `…` (40 total): a name longer than 40 keeps its
 * first 39 code units plus `…`. A name of exactly 40 (or fewer) is returned
 * untouched. The cut boundary never splits a surrogate pair (astral/emoji
 * chars stay intact — QA AC1-1 edge: no broken surrogate pair).
 */
function truncateName(name: string): string {
  if (name.length <= DERIVED_NAME_MAX_LENGTH) return name;
  const cut = DERIVED_NAME_MAX_LENGTH - 1; // 39 source code units + '…' = 40
  const prev = name.charCodeAt(cut - 1);
  const next = name.charCodeAt(cut);
  const splitsPair =
    prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return name.slice(0, splitsPair ? cut - 1 : cut) + '…';
}

/**
 * #2748 ST-3 — normalize + truncate a raw user message into its display form.
 *
 * The single shared definition of the display-side normalization pipeline
 * (`normalizeWhitespace` → `truncateName`). The session-list hook calls it
 * directly so it can resolve every session's derived name in ONE O(N) pass
 * over the Chat rows (NFR-1). It also normalizes ST-2's persisted
 * `derived_name` (stored raw — ST-2's status note: display truncation is the
 * hook's job) into the same display form.
 *
 * Whitespace-only input normalizes to `''` → `undefined` (the R-1.2 label
 * fallback — never an empty display name).
 */
export function formatDerivedName(raw: string): string | undefined {
  const normalized = normalizeWhitespace(raw);
  if (!normalized) return undefined;
  return truncateName(normalized);
}

/**
 * AC1/AC2 — resolve a session's display name (single definition, R-1.1 +
 * R-2.3): `customName ?? derivedName ?? label`. The custom name is
 * authoritative over the derived name; the timestamp label is the fallback
 * when neither exists (R-1.2).
 */
export function deriveDisplayName(session: SessionNameFields): string {
  return session.customName ?? session.derivedName ?? session.label;
}

/** Parse the task tool's arguments JSON (`toolInputJson` = the adapter-
 *  projected gen_ai.tool.call.arguments string). A parse failure or absent
 *  input degrades to `{}`. */
function parseTaskArgs(input: string): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The session's own `task`-dispatch rows: keyed under the selected session,
 *  `task` tool only, NOT child-session activity (the `isSubagent` flag
 *  column replaces the v1 engine-level excludePayload — a parent's own task
 *  span is `false`, a child session's tools are `true`). One row per key —
 *  the row store's PK replaces the v1 last-wins dedupe. */
function sessionTaskRows(toolRows: ToolUseRow[], sessionId: string): ToolUseRow[] {
  return toolRows.filter(
    (row) =>
      row.sessionId === sessionId &&
      row.toolName === 'task' &&
      row.isSubagent !== true,
  );
}

/** Parsed task-args `subagent_type` (fallback `agent`) — the display name
 *  key, undefined when neither is a non-empty string. */
function taskSubagentType(row: ToolUseRow): string | undefined {
  const args = parseTaskArgs(row.toolInputJson ?? '');
  const st = args['subagent_type'];
  if (typeof st === 'string' && st) return st;
  const ag = args['agent'];
  if (typeof ag === 'string' && ag) return ag;
  return undefined;
}

/**
 * AC3 (R-3.1) — compute the selected session's SUBAGENTS token total from
 * its typed `task`-dispatch rows.
 *
 * Aggregation rule (matches the SubagentNode five-way, SubagentNode.tsx):
 * 1. The session's own task rows (see `sessionTaskRows`) — task spans belong
 *    to the parent session, never composited.
 * 2. Internal tool-execution agents excluded: parsed task-args
 *    `subagent_type` (fallback `agent`) NOT in `INTERNAL_TOOL_EXECUTION_AGENTS`.
 * 3. Per-subagent total: if ANY of the four per-family breakdown fields is
 *    present (rawJson child-completion long-tail) → sum of
 *    normalizeTokenCount(childInputTokens|childCacheReadTokens|
 *    childReasoningTokens|childOutputTokens); else the aggregate
 *    normalizeTokenCount(childTokens).
 * 4. Every figure zero-guarded via `normalizeTokenCount` (absent/NaN/negative
 *    → 0 — never NaN/negative in the figure).
 *
 * @returns the SUBAGENTS total (0 when no qualifying task dispatch carries
 *   child token fields).
 */
export function computeSubagentTokenTotals(toolRows: ToolUseRow[], sessionId: string): number {
  let total = 0;
  for (const row of sessionTaskRows(toolRows, sessionId)) {
    // Internal tool-execution agents (build/plan) — not user-requested
    // subagents, excluded from the figure (R-4 / AC-4 semantics).
    const subagentType = taskSubagentType(row);
    if (subagentType !== undefined && INTERNAL_TOOL_EXECUTION_AGENTS.includes(subagentType)) {
      continue;
    }

    // Per-subagent total: per-family breakdown when ANY field is present,
    // else the aggregate childTokens (SubagentNode.tsx rule).
    const raw = rawPayload(row);
    const hasBreakdown =
      raw.childInputTokens !== undefined ||
      raw.childCacheReadTokens !== undefined ||
      raw.childReasoningTokens !== undefined ||
      raw.childOutputTokens !== undefined;
    const subagentTotal = hasBreakdown
      ? normalizeTokenCount(raw.childInputTokens) +
        normalizeTokenCount(raw.childCacheReadTokens) +
        normalizeTokenCount(raw.childReasoningTokens) +
        normalizeTokenCount(raw.childOutputTokens)
      : normalizeTokenCount(raw.childTokens);

    total += subagentTotal;
  }

  return total;
}

/**
 * AC1 (#2750 ST-1) — compute the selected session's SUBAGENT COST share from
 * its typed `task`-dispatch rows.
 *
 * Mirrors `computeSubagentTokenTotals` exactly (same row set, same internal-
 * agent exclusion) but sums the delivered CHILD COST (`childCost`, rawJson
 * long-tail) instead of token totals.
 *
 * The session bar's ESTIMATED COST is the parent session cost PLUS this share —
 * combined in MissionMonitorPanel (never in the SessionTokenBar component).
 *
 * @returns the SUBAGENT cost share (0 when no qualifying task dispatch carries
 *   a `childCost` field).
 */
export function computeSubagentCostTotals(toolRows: ToolUseRow[], sessionId: string): number {
  let total = 0;
  for (const row of sessionTaskRows(toolRows, sessionId)) {
    const subagentType = taskSubagentType(row);
    if (subagentType !== undefined && INTERNAL_TOOL_EXECUTION_AGENTS.includes(subagentType)) {
      continue;
    }
    total += normalizeCost(rawPayload(row).childCost);
  }

  return total;
}
