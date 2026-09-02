/**
 * rowsFromDeliveries.ts — TEST-ONLY conversion of v1 `ContractDelivery`
 * fixtures into typed RTDB rows, emulating the P3.1 ingest classifier.
 *
 * Spec #2788 P4.4 rework: the conversion is factored into its two semantic
 * halves so the suites feed the graph through the REAL delivery currency:
 *
 * 1. `projectDelivery` — one v1 delivery → the RAW typed-row field values it
 *    carries (the classifier's per-field extract).
 * 2. the merge fold (`mergeProjectedFields`) — the classifier's explicit
 *    per-field merge rules (KeepFirst / LastWins / LastNonZero …) applied
 *    incrementally onto the working row.
 *
 * `rowsFromDeliveries` folds a whole corpus into final rows (output
 * byte-identical to the P4.2 accumulator this module replaced — pinned by
 * corpusParity + v1Golden.json); `rowSourceHelper.patchesFromDeliveries` uses
 * the SAME projection + merge to emit the `RowDelivery` patch envelopes the
 * real backend emits (first sight of a key → full-row insert, later →
 * changed-fields-only update, per-key seq) and applies them with the P4.1
 * row-store semantics. One conversion path, both consumption modes.
 *
 * Production never runs this file — rows arrive from the backend.
 */
import type {
  ChatRow,
  ContractDelivery,
  RowEventType,
  RowState,
  ToolUseRow,
} from '../../../../../shared/classes/EventSubscription';

function isoToNs(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms * 1e6 : null;
}

function stateOf(lifecycle: string): RowState {
  if (lifecycle === 'end') return 'Response';
  if (lifecycle === 'update') return 'Update';
  return 'Init';
}

// ── Per-delivery projection (the classifier's field extract) ────────────────

/** The RAW field values ONE v1 delivery carries for its row — `undefined`
 *  means the delivery does not speak for that field (absent keeps the
 *  previous value in the merge fold, except where the v1 merge semantics
 *  pin last-value-or-null — see mergeProjectedFields). */
export interface ProjectedDelivery {
  eventType: RowEventType;
  sessionId: string;
  correlationId: string;
  timestamp: string;
  fields: Record<string, unknown>;
}

export function projectDelivery(d: ContractDelivery): ProjectedDelivery | null {
  const sessionId = d.key.sessionId;
  const correlationId = d.key.correlationId;
  const inner = (d.payload?.['payload'] as Record<string, any> | undefined) ?? {};

  if (d.contractName === 'chat-node') {
    return {
      eventType: 'Chat',
      sessionId,
      correlationId,
      timestamp: d.timestamp,
      fields: {
        state: stateOf(d.lifecycle),
        // LastWins (last value or null — the v1 outer-payload stamp semantics).
        parentSessionId:
          typeof inner.parentSessionId === 'string' ? inner.parentSessionId : null,
        compositedChildSessionId:
          typeof d.payload?.['compositedChildSessionId'] === 'string'
            ? (d.payload['compositedChildSessionId'] as string)
            : null,
        // KeepFirst (first non-empty — the init-time user prompt survives).
        userMessage: typeof inner.userMessage === 'string' ? inner.userMessage : undefined,
        // LastNonEmpty (LastNonZero for strings) — the completed reply wins.
        agentReply: typeof inner.agentReply === 'string' ? inner.agentReply : undefined,
        promptTokens: typeof inner.promptTokens === 'number' ? inner.promptTokens : undefined,
        completionTokens:
          typeof inner.completionTokens === 'number' ? inner.completionTokens : undefined,
        cacheReadTokens:
          typeof inner.cacheReadTokens === 'number' ? inner.cacheReadTokens : undefined,
        costUsd: typeof inner.cost_usd === 'number' ? inner.cost_usd : undefined,
        model: typeof inner.model === 'string' ? inner.model : undefined,
        startedAtNs: isoToNs(inner.startTime),
        endedAtNs: isoToNs(inner.endTime),
        updatedAt: d.timestamp,
        rawJson: JSON.stringify(inner),
      },
    };
  }

  if (d.contractName === 'tool-use-lifecycle' || d.contractName === 'subagent-tool-activity') {
    return {
      eventType: 'ToolUse',
      sessionId,
      correlationId,
      timestamp: d.timestamp,
      fields: {
        state: stateOf(d.lifecycle),
        toolName:
          (typeof inner['gen_ai.tool.name'] === 'string' && inner['gen_ai.tool.name']) ||
          (typeof inner['tool_name'] === 'string' && inner['tool_name']) ||
          undefined,
        toolSuccess:
          typeof inner['tool.success'] === 'boolean' ? inner['tool.success'] : undefined,
        toolError: typeof inner['tool.error'] === 'string' ? inner['tool.error'] : undefined,
        durationMs: typeof inner.duration_ms === 'number' ? inner.duration_ms : undefined,
        // KeepFirst — the call arguments are fixed at call time.
        toolInputJson: typeof inner.input === 'string' ? inner.input : undefined,
        // LastNonEmpty — the completed result wins.
        toolOutputJson: typeof inner.output === 'string' ? inner.output : undefined,
        // Sticky flag: a row that EVER arrived under tool-use-lifecycle is the
        // session's OWN span (the v1 engine excluded is_subagent spans).
        isSubagent: d.contractName === 'tool-use-lifecycle' ? false : undefined,
        startedAtNs: isoToNs(inner.startTime),
        endedAtNs: isoToNs(inner.endTime),
        updatedAt: d.timestamp,
        rawJson: JSON.stringify(inner),
      },
    };
  }

  // Other v1 contract shapes were never part of the Mission Monitor graph.
  return null;
}

// ── Merge fold (the classifier's per-field merge rules) ─────────────────────

function firstNonEmptyWins(row: Record<string, unknown>, fields: Record<string, unknown>, field: string): void {
  const v = fields[field];
  if (typeof v === 'string' && v !== '') row[field] = v;
}

function lastNonEmptyWins(row: Record<string, unknown>, fields: Record<string, unknown>, field: string): void {
  const v = fields[field];
  if (typeof v === 'string' && v !== '') row[field] = v;
}

function lastNonZeroWins(row: Record<string, unknown>, fields: Record<string, unknown>, field: string): void {
  const v = fields[field];
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) row[field] = v;
}

function lastDefinedWins(row: Record<string, unknown>, fields: Record<string, unknown>, field: string): void {
  const v = fields[field];
  if (v !== undefined) row[field] = v;
}

/**
 * Merge ONE delivery's projected fields into the working row (mutating).
 * The rules reproduce the P4.2 accumulator byte-for-byte:
 * - chat: state/parentSessionId/compositedChildSessionId LastWins,
 *   userMessage/model KeepFirst, agentReply LastNonEmpty, token/cost figures
 *   LastNonZero, startedAtNs first-non-null, endedAtNs last-non-null,
 *   updatedAt/rawJson LastWins.
 * - tool: toolName/toolInputJson KeepFirst, toolSuccess/ToolError/
 *   toolOutputJson/durationMs last-defined/non-empty/non-zero, isSubagent
 *   sticky-false (any tool-use-lifecycle delivery marks the row as the
 *   session's OWN span).
 */
export function mergeProjectedFields(
  row: ChatRow | ToolUseRow,
  fields: Record<string, unknown>,
): void {
  const r = row as unknown as Record<string, unknown>;
  lastDefinedWins(r, fields, 'state');
  if ('toolName' in row) {
    // ToolUse row rules.
    firstNonEmptyWins(r, fields, 'toolName');
    lastDefinedWins(r, fields, 'toolSuccess');
    lastNonEmptyWins(r, fields, 'toolError');
    lastNonZeroWins(r, fields, 'durationMs');
    firstNonEmptyWins(r, fields, 'toolInputJson');
    lastNonEmptyWins(r, fields, 'toolOutputJson');
    if (fields.isSubagent === false) r.isSubagent = false;
  } else {
    // Chat row rules.
    lastDefinedWins(r, fields, 'parentSessionId');
    lastDefinedWins(r, fields, 'compositedChildSessionId');
    firstNonEmptyWins(r, fields, 'userMessage');
    lastNonEmptyWins(r, fields, 'agentReply');
    lastNonZeroWins(r, fields, 'promptTokens');
    lastNonZeroWins(r, fields, 'completionTokens');
    lastNonZeroWins(r, fields, 'cacheReadTokens');
    lastNonZeroWins(r, fields, 'costUsd');
    firstNonEmptyWins(r, fields, 'model');
  }
  // Shared span-timing + last-write rules.
  const startNs = fields.startedAtNs;
  if (row.startedAtNs === null && typeof startNs === 'number') row.startedAtNs = startNs;
  const endNs = fields.endedAtNs;
  if (typeof endNs === 'number') row.endedAtNs = endNs;
  lastDefinedWins(r, fields, 'updatedAt');
  lastDefinedWins(r, fields, 'rawJson');
}

function newChatRowState(sessionId: string, correlationId: string): ChatRow {
  return {
    sessionId,
    correlationId,
    seq: 0,
    startedAtNs: null,
    endedAtNs: null,
    updatedAt: '',
    state: 'Init',
    userMessage: null,
    agentReply: null,
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    costUsd: null,
    model: null,
    parentSessionId: null,
    compositedChildSessionId: null,
    rawJson: '',
  };
}

function newToolRowState(sessionId: string, correlationId: string): ToolUseRow {
  return {
    sessionId,
    correlationId,
    seq: 0,
    startedAtNs: null,
    endedAtNs: null,
    updatedAt: '',
    state: 'Init',
    toolName: null,
    toolSuccess: null,
    toolError: null,
    durationMs: null,
    toolInputJson: null,
    toolOutputJson: null,
    // A row born from subagent-tool-activity is child activity until a
    // tool-use-lifecycle delivery for the same key proves it is the
    // session's OWN span (isSubagent sticky-false in the merge).
    isSubagent: true,
    rawJson: '',
  };
}

function seqCounter(): () => number {
  let seq = 0;
  return () => ++seq;
}

/**
 * Convert v1 contract deliveries into the typed row arrays the migrated
 * graph derives from. Deterministic — same input, same rows. Output is
 * byte-identical to the P4.2 accumulator this module replaced (pinned by
 * corpusParity + v1Golden.json + the counters/sessionMeta suites).
 */
export function rowsFromDeliveries(deliveries: ContractDelivery[]): {
  chatRows: ChatRow[];
  toolRows: ToolUseRow[];
} {
  const chatSeq = seqCounter();
  const toolSeq = seqCounter();
  const chatAcc = new Map<string, ChatRow>();
  const toolAcc = new Map<string, ToolUseRow>();

  for (const d of deliveries) {
    const projected = projectDelivery(d);
    if (!projected) continue;
    const key = `${projected.sessionId}\u0000${projected.correlationId}`;
    if (projected.eventType === 'Chat') {
      let row = chatAcc.get(key);
      if (!row) {
        row = newChatRowState(projected.sessionId, projected.correlationId);
        chatAcc.set(key, row);
      }
      mergeProjectedFields(row, projected.fields);
    } else {
      let row = toolAcc.get(key);
      if (!row) {
        row = newToolRowState(projected.sessionId, projected.correlationId);
        toolAcc.set(key, row);
      }
      mergeProjectedFields(row, projected.fields);
    }
  }

  const chatRows: ChatRow[] = [];
  for (const row of chatAcc.values()) {
    chatRows.push({ ...row, seq: chatSeq() });
  }

  const toolRows: ToolUseRow[] = [];
  for (const row of toolAcc.values()) {
    toolRows.push({ ...row, seq: toolSeq() });
  }

  return { chatRows, toolRows };
}
