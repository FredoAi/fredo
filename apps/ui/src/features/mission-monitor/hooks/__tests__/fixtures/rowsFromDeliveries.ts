/**
 * rowsFromDeliveries.ts — TEST-ONLY conversion of v1 `ContractDelivery`
 * fixtures into typed RTDB rows, emulating the P3.1 ingest classifier.
 *
 * Spec #2788 P4.2 requires the existing mission-monitor suites (and the
 * real-corpus parity verifier) to feed ROWS to the migrated graph. The v1
 * fixtures describe the SAME underlying spans the classifier ingests, so the
 * conversion applies the classifier's row semantics:
 *
 * - One row per (sessionId, correlationId, eventType) — the canonical-tier PK.
 *   The v1 init/update/end lifecycles for one key collapse into ONE row via
 *   the merge.rs field rules (userMessage KeepFirst, agentReply LastNonZero,
 *   token figures LastNonZero, timestamps from the span, state from the last
 *   lifecycle).
 * - `contractName` → routing flags: `tool-use-lifecycle` rows are the
 *   session's OWN tool spans (isSubagent=false — the engine excluded
 *   is_subagent spans); `subagent-tool-activity` rows are child-session
 *   spans (isSubagent=true).
 * - `rawJson` = the last lifecycle delivery's inner payload (LastWins) — the
 *   classifier freezes the projector payload verbatim, so the v1 long-tail
 *   fields (agent, agentThinking, reasoningTokens, child* fields,
 *   input_tokens flat keys) ride the escape hatch exactly as production.
 * - `startedAtNs`/`endedAtNs` are derived from the payload's span-injected
 *   startTime/endTime (RFC3339 → epoch ns), mirroring span_timing_ns.
 *
 * Production never runs this file — rows arrive from the backend.
 */
import type {
  ChatRow,
  ContractDelivery,
  RowState,
  ToolUseRow,
} from '../../../../../shared/classes/EventSubscription';

function isoToNs(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms * 1e6 : null;
}

function lastNonZeroNumber(values: Array<number | undefined>): number | null {
  let out: number | null = null;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) out = v;
  }
  return out;
}

function lastNonEmptyString(values: Array<string | undefined>): string | null {
  let out: string | null = null;
  for (const v of values) {
    if (typeof v === 'string' && v !== '') out = v;
  }
  return out;
}

function firstNonEmptyString(values: Array<string | undefined>): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

interface ChatRowAccumulator {
  sessionId: string;
  correlationId: string;
  states: RowState[];
  userMessages: Array<string | undefined>;
  agentReplies: Array<string | undefined>;
  promptTokens: Array<number | undefined>;
  completionTokens: Array<number | undefined>;
  cacheReadTokens: Array<number | undefined>;
  costs: Array<number | undefined>;
  models: Array<string | undefined>;
  startNs: Array<number | null>;
  endNs: Array<number | null>;
  updatedAt: string;
  rawJson: string;
  parentSessionIds: Array<string | undefined>;
  compositedStamps: Array<string | undefined>;
}

interface ToolRowAccumulator {
  sessionId: string;
  correlationId: string;
  states: RowState[];
  toolNames: Array<string | undefined>;
  toolSuccess: Array<boolean | undefined>;
  toolError: Array<string | undefined>;
  durationMs: Array<number | undefined>;
  inputs: Array<string | undefined>;
  outputs: Array<string | undefined>;
  startNs: Array<number | null>;
  endNs: Array<number | null>;
  updatedAt: string;
  rawJson: string;
  /** True only when EVERY delivery for this key arrived under
   *  subagent-tool-activity — the v1 engine excluded is_subagent spans from
   *  tool-use-lifecycle, so a span that reached tool-use-lifecycle has
   *  is_subagent !== true (the classifier's flag is a span property). */
  sawOwnToolContract: boolean;
}

function stateOf(lifecycle: string): RowState {
  if (lifecycle === 'end') return 'Response';
  if (lifecycle === 'update') return 'Update';
  return 'Init';
}

function seqCounter(): () => number {
  let seq = 0;
  return () => ++seq;
}

/**
 * Convert v1 contract deliveries into the typed row arrays the migrated
 * graph derives from. Deterministic — same input, same rows.
 */
export function rowsFromDeliveries(deliveries: ContractDelivery[]): {
  chatRows: ChatRow[];
  toolRows: ToolUseRow[];
} {
  const chatSeq = seqCounter();
  const toolSeq = seqCounter();
  const chatAcc = new Map<string, ChatRowAccumulator>();
  const toolAcc = new Map<string, ToolRowAccumulator>();

  for (const d of deliveries) {
    const key = `${d.key.sessionId}\u0000${d.key.correlationId}`;
    const inner = (d.payload?.['payload'] as Record<string, any> | undefined) ?? {};
    if (d.contractName === 'chat-node') {
      let acc = chatAcc.get(key);
      if (!acc) {
        acc = {
          sessionId: d.key.sessionId,
          correlationId: d.key.correlationId,
          states: [],
          userMessages: [],
          agentReplies: [],
          promptTokens: [],
          completionTokens: [],
          cacheReadTokens: [],
          costs: [],
          models: [],
          startNs: [],
          endNs: [],
          updatedAt: d.timestamp,
          rawJson: '',
          parentSessionIds: [],
          compositedStamps: [],
        };
        chatAcc.set(key, acc);
      }
      acc.states.push(stateOf(d.lifecycle));
      acc.parentSessionIds.push(typeof inner.parentSessionId === 'string' ? inner.parentSessionId : undefined);
      acc.compositedStamps.push(
        typeof d.payload?.['compositedChildSessionId'] === 'string'
          ? (d.payload['compositedChildSessionId'] as string)
          : undefined,
      );
      acc.userMessages.push(typeof inner.userMessage === 'string' ? inner.userMessage : undefined);
      acc.agentReplies.push(typeof inner.agentReply === 'string' ? inner.agentReply : undefined);
      acc.promptTokens.push(typeof inner.promptTokens === 'number' ? inner.promptTokens : undefined);
      acc.completionTokens.push(typeof inner.completionTokens === 'number' ? inner.completionTokens : undefined);
      acc.cacheReadTokens.push(typeof inner.cacheReadTokens === 'number' ? inner.cacheReadTokens : undefined);
      acc.costs.push(typeof inner.cost_usd === 'number' ? inner.cost_usd : undefined);
      acc.models.push(typeof inner.model === 'string' ? inner.model : undefined);
      acc.startNs.push(isoToNs(inner.startTime));
      acc.endNs.push(isoToNs(inner.endTime));
      acc.updatedAt = d.timestamp;
      acc.rawJson = JSON.stringify(inner);
    } else if (d.contractName === 'tool-use-lifecycle' || d.contractName === 'subagent-tool-activity') {
      let acc = toolAcc.get(key);
      if (!acc) {
        acc = {
          sessionId: d.key.sessionId,
          correlationId: d.key.correlationId,
          states: [],
          toolNames: [],
          toolSuccess: [],
          toolError: [],
          durationMs: [],
          inputs: [],
          outputs: [],
          startNs: [],
          endNs: [],
          updatedAt: d.timestamp,
          rawJson: '',
          sawOwnToolContract: d.contractName === 'tool-use-lifecycle',
        };
        toolAcc.set(key, acc);
      }
      if (d.contractName === 'tool-use-lifecycle') acc.sawOwnToolContract = true;
      acc.states.push(stateOf(d.lifecycle));
      const toolName =
        (typeof inner['gen_ai.tool.name'] === 'string' && inner['gen_ai.tool.name']) ||
        (typeof inner['tool_name'] === 'string' && inner['tool_name']) ||
        undefined;
      acc.toolNames.push(toolName);
      acc.toolSuccess.push(typeof inner['tool.success'] === 'boolean' ? inner['tool.success'] : undefined);
      acc.toolError.push(typeof inner['tool.error'] === 'string' ? inner['tool.error'] : undefined);
      acc.durationMs.push(typeof inner.duration_ms === 'number' ? inner.duration_ms : undefined);
      acc.inputs.push(typeof inner.input === 'string' ? inner.input : undefined);
      acc.outputs.push(typeof inner.output === 'string' ? inner.output : undefined);
      acc.startNs.push(isoToNs(inner.startTime));
      acc.endNs.push(isoToNs(inner.endTime));
      acc.updatedAt = d.timestamp;
      acc.rawJson = JSON.stringify(inner);
    }
    // Other v1 contract shapes were never part of the Mission Monitor graph.
  }

  const chatRows: ChatRow[] = [];
  for (const acc of chatAcc.values()) {
    chatRows.push({
      sessionId: acc.sessionId,
      correlationId: acc.correlationId,
      seq: chatSeq(),
      startedAtNs: acc.startNs.find((v) => v !== null) ?? null,
      endedAtNs: [...acc.endNs].reverse().find((v) => v !== null) ?? null,
      updatedAt: acc.updatedAt,
      state: acc.states[acc.states.length - 1] ?? 'Init',
      // KeepFirst (first non-absent) — the init-time user prompt survives.
      userMessage: firstNonEmptyString(acc.userMessages),
      // LastNonEmpty (LastNonZero for strings) — the completed reply wins.
      agentReply: lastNonEmptyString(acc.agentReplies),
      promptTokens: lastNonZeroNumber(acc.promptTokens),
      completionTokens: lastNonZeroNumber(acc.completionTokens),
      cacheReadTokens: lastNonZeroNumber(acc.cacheReadTokens),
      costUsd: lastNonZeroNumber(acc.costs),
      model: firstNonEmptyString(acc.models),
      // The #523 stamps: in v1 deliveries the composited stamp rode the OUTER
      // payload (ECE re-key metadata) and parentSessionId the inner payload
      // (adapter injection); the RTDB ingest hoists both onto row columns.
      parentSessionId:
        typeof acc.parentSessionIds[acc.parentSessionIds.length - 1] === 'string'
          ? (acc.parentSessionIds[acc.parentSessionIds.length - 1] as string)
          : null,
      compositedChildSessionId:
        typeof acc.compositedStamps[acc.compositedStamps.length - 1] === 'string'
          ? (acc.compositedStamps[acc.compositedStamps.length - 1] as string)
          : null,
      rawJson: acc.rawJson,
    });
  }

  const toolRows: ToolUseRow[] = [];
  for (const acc of toolAcc.values()) {
    toolRows.push({
      sessionId: acc.sessionId,
      correlationId: acc.correlationId,
      seq: toolSeq(),
      startedAtNs: acc.startNs.find((v) => v !== null) ?? null,
      endedAtNs: [...acc.endNs].reverse().find((v) => v !== null) ?? null,
      updatedAt: acc.updatedAt,
      state: acc.states[acc.states.length - 1] ?? 'Init',
      toolName: firstNonEmptyString(acc.toolNames),
      toolSuccess: [...acc.toolSuccess].reverse().find((v) => v !== undefined) ?? null,
      toolError: lastNonEmptyString(acc.toolError),
      durationMs: lastNonZeroNumber(acc.durationMs),
      // KeepFirst — the call arguments are fixed at call time.
      toolInputJson: firstNonEmptyString(acc.inputs),
      // LastNonEmpty — the completed result wins.
      toolOutputJson: lastNonEmptyString(acc.outputs),
      isSubagent: !acc.sawOwnToolContract,
      rawJson: acc.rawJson,
    });
  }

  return { chatRows, toolRows };
}
