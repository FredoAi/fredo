/**
 * sessionMeta.ts — Mission Monitor session-metadata pure functions (#2748 ST-1).
 *
 * A single file-independent home for the AC1 (session display name) and AC3
 * (SUBAGENTS token total) computations shared by the session-list hook, the
 * persistence layer, and the token bar. Pure functions over
 * `ContractDelivery[]` — no React, no IPC, no store access — so they are
 * trivially unit-testable and reusable across surfaces.
 *
 * Data sources (source-verified — G-028 Phase-0 live check was sandbox-denied,
 * see the ST-1 report; canonical paths confirmed in adapter/plugin source):
 * - AC1 name: the adapter-injected top-level `userMessage` field on chat-node
 *   deliveries (`infrastructure/comm/adapters/otlp.rs:1180-1181`;
 *   `opencode.rs:1508`; absent/empty when the turn has no user text).
 * - AC3 SUBAGENTS: the parent `task` tool span's child-completion fields
 *   (`apps/opencode-plugin/src/util.ts:53-61` emits `child_session_id` /
 *   `child_total_tokens` / per-family breakdown; the OTLP adapter projects the
 *   camelCase keys, `otlp.rs:81-90`). Task spans belong to the PARENT session
 *   (the `tool-use-lifecycle` contract's engine-level `excludePayload` already
 *   drops subagent events, MissionMonitorFeature.tsx:100-103) — never the
 *   ECE-composited child-delivery path, which is dead since Spec #2723 AC5.
 */
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import {
  isChatNodeDelivery,
  extractDeliveryPayload,
  deliverySessionId,
  deliveryCorrelationId,
  normalizeTokenCount,
} from './graph';

/**
 * Internal opencode tool-execution agents (#2745 AC-4 / R-4). Their `task`
 * dispatches are spawned internally to execute tool calls in sub-sessions and
 * are NOT user-requested @-subagent dispatches — they must be excluded from
 * the SUBAGENTS figure. Keyed on the SAME parsed args field the SubagentNode
 * displays (`subagent_type`). Mirrors `INTERNAL_TOOL_EXECUTION_AGENTS` in
 * hooks/useMissionMonitor.ts:66 (kept local so this pure lib never imports a
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
 * AC1 (R-1.1) — derive a session's display name from its deliveries.
 *
 * The session's FIRST (earliest-timestamp) chat-node delivery carrying a
 * non-empty `userMessage` — whitespace-normalized to a single line and
 * truncated to 40 characters including the trailing `…` when truncated.
 *
 * `session.created` init deliveries carry NO `userMessage` (the real prompt
 * arrives on later update/end deliveries — the merge at
 * useMissionMonitor.ts:909,1020), so "first user chat message" is naturally
 * the earliest delivery with non-empty text.
 *
 * @returns the normalized + truncated name, or `undefined` when the session
 *   has no chat-node delivery carrying non-empty user text (the R-1.2
 *   timestamp-label fallback).
 */
export function deriveSessionName(
  deliveries: ContractDelivery[],
  sessionId: string,
): string | undefined {
  let earliest: string | undefined;
  let earliestTs = Number.POSITIVE_INFINITY;

  for (const d of deliveries) {
    if (!isChatNodeDelivery(d)) continue;
    if (deliverySessionId(d) !== sessionId) continue;

    const p = extractDeliveryPayload(d);
    const raw = p['userMessage'];
    if (typeof raw !== 'string' || raw.trim() === '') continue;

    const ts = Date.parse(d.timestamp);
    if (Number.isNaN(ts) || ts >= earliestTs) continue;

    earliestTs = ts;
    earliest = raw;
  }

  if (earliest === undefined) return undefined;
  return formatDerivedName(earliest);
}

/**
 * #2748 ST-3 — normalize + truncate a raw user message into its display form.
 *
 * The single shared definition of the display-side normalization pipeline
 * (`normalizeWhitespace` → `truncateName`). `deriveSessionName` formats the
 * earliest message it selects with it; the session-list hook calls it directly
 * so it can resolve every session's derived name in ONE O(N) pass over
 * deliveries (NFR-1) instead of re-scanning per session. It also normalizes
 * ST-2's persisted `derived_name` (stored raw — ST-2's status note: display
 * truncation is the hook's job) into the same display form.
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

/**
 * AC3 (R-3.1) — compute the selected session's SUBAGENTS token total from its
 * `tool-use-lifecycle` `task`-span deliveries.
 *
 * Aggregation rule (matches the SubagentNode five-way, SubagentNode.tsx:129-136):
 * 1. `tool-use-lifecycle` deliveries only, scoped to `deliverySessionId(d) ===
 *    sessionId` (task spans belong to the parent session — never composited).
 * 2. Last-wins per composite key `(sessionId, correlationId)` — the LAST
 *    lifecycle delivery per task dispatch wins (end beats init/update), the
 *    same rule the graph builder applies to SubagentNode entries.
 * 3. `task` tool only: `payload['gen_ai.tool.name'] === 'task'` with the
 *    legacy `tool_name` fallback.
 * 4. Internal tool-execution agents excluded: the parsed task-args
 *    `subagent_type` (fallback `agent`) NOT in `INTERNAL_TOOL_EXECUTION_AGENTS`.
 * 5. Per-subagent total: if ANY of the four per-family breakdown fields is
 *    present → sum of normalizeTokenCount(childInputTokens|childCacheReadTokens|
 *    childReasoningTokens|childOutputTokens); else the aggregate
 *    normalizeTokenCount(childTokens) (legacy deliveries).
 * 6. Every figure zero-guarded via `normalizeTokenCount` (absent/NaN/negative
 *    → 0 — never NaN/negative in the figure).
 *
 * @returns the SUBAGENTS total (0 when no qualifying task dispatch carries
 *   child token fields).
 */
export function computeSubagentTokenTotals(
  deliveries: ContractDelivery[],
  sessionId: string,
): number {
  // Last-wins per composite key over the session's tool-use-lifecycle deliveries.
  const lastByKey = new Map<string, ContractDelivery>();
  for (const d of deliveries) {
    if (d.contractName !== 'tool-use-lifecycle') continue;
    if (deliverySessionId(d) !== sessionId) continue;
    lastByKey.set(`${sessionId}:${deliveryCorrelationId(d)}`, d);
  }

  let total = 0;
  for (const d of lastByKey.values()) {
    const p = extractDeliveryPayload(d);

    // Task tool only — `gen_ai.tool.name` first, legacy `tool_name` fallback.
    const toolName =
      typeof p['gen_ai.tool.name'] === 'string' && p['gen_ai.tool.name']
        ? p['gen_ai.tool.name']
        : typeof p['tool_name'] === 'string' && p['tool_name']
          ? p['tool_name']
          : undefined;
    if (toolName !== 'task') continue;

    // Internal tool-execution agents (build/plan) — not user-requested
    // subagents, excluded from the figure (R-4 / AC-4 semantics).
    const args = parseTaskArgs(typeof p['input'] === 'string' ? p['input'] : '');
    const subagentType =
      typeof args['subagent_type'] === 'string' && args['subagent_type']
        ? args['subagent_type']
        : typeof args['agent'] === 'string' && args['agent']
          ? args['agent']
          : undefined;
    if (subagentType !== undefined && INTERNAL_TOOL_EXECUTION_AGENTS.includes(subagentType)) {
      continue;
    }

    // Per-subagent total: per-family breakdown when ANY field is present,
    // else the aggregate childTokens (SubagentNode.tsx:129-136 rule).
    const hasBreakdown =
      p['childInputTokens'] !== undefined ||
      p['childCacheReadTokens'] !== undefined ||
      p['childReasoningTokens'] !== undefined ||
      p['childOutputTokens'] !== undefined;
    const subagentTotal = hasBreakdown
      ? normalizeTokenCount(p['childInputTokens']) +
        normalizeTokenCount(p['childCacheReadTokens']) +
        normalizeTokenCount(p['childReasoningTokens']) +
        normalizeTokenCount(p['childOutputTokens'])
      : normalizeTokenCount(p['childTokens']);

    total += subagentTotal;
  }

  return total;
}

/** Parse the task tool's arguments JSON (payload['input'] = the adapter-
 *  projected gen_ai.tool.call.arguments string). A parse failure or absent
 *  input degrades to `{}` (mirrors parseTaskArgs in useMissionMonitor.ts:72). */
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
