/**
 * rowSourceHelper.ts — P4.4 test adapter: the ROW-PATCH pipeline.
 *
 * Spec #2788 P4.2 introduced this helper as a v1-deliveries → rows converter;
 * P4.4 completes the migration so every mission-monitor suite FEEDS through
 * the RTDB delivery currency:
 *
 *   v1 fixture corpus (describes the real spans)
 *     → `patchesFromDeliveries()`  — the classifier-emulating RowDelivery
 *       envelopes (first sight of a key → full-row `insert`; later →
 *       changed-fields-only `update`; per-key monotonic `seq`; camelCase
 *       envelope per `infrastructure/rtdb/project.rs`)
 *     → `createRowPatchStore()`    — applies patches with the P4.1 row-store
 *       semantics (StreamContext.applyRowDelivery: insert spread-merge +
 *       seq baseline, stale-seq update drop, remove delete, no cap/TTL)
 *     → typed row maps → `useDeliveryGraph({ rows })`
 *
 * The v1 fixtures remain the corpus DESCRIPTION (they encode the real
 * telemetry spans the golden was captured from); they never reach the system
 * under test — only RowDelivery envelopes and typed rows do. New legs author
 * `RowDelivery` envelopes directly via `rowSourceFromPatches` /
 * `createRowPatchStore`.
 *
 * STABILITY CONTRACT (kills the #523-cycle-1 loop class in tests): a render
 * callback that calls `rowSource(...)` re-executes on every render. The hook
 * memoizes on the epoch primitives, so the adapter MUST return the SAME row
 * source (same epoch) for the same fixture content — otherwise every render
 * recomputes the builder state and re-emits nodes forever. Caching: by array
 * identity (WeakMap) and, on a miss, by JSON content signature (bounded LRU —
 * inline fixture literals are recreated per render but are content-stable;
 * a rerender with NEW content gets a fresh source and recomputes, mirroring
 * a live patch batch).
 */
import type {
  ChatRow,
  ContractDelivery,
  RowDelivery,
  ToolUseRow,
} from '../../../../shared/classes/EventSubscription';
import { isRowDelivery } from '../../../../shared/classes/EventSubscription';
import {
  mergeProjectedFields,
  projectDelivery,
} from './fixtures/rowsFromDeliveries';

/** Query id stamped on every emitted envelope (a single test subscription). */
const TEST_QUERY_ID = 'test-query-rowSource';

// ── Patch-stream construction (the classifier-emulating envelopes) ──────────

function diffChangedFields(prev: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const changed: string[] = [];
  for (const field of Object.keys(next)) {
    if (field === 'seq') continue; // rides the envelope, never the patch
    if (prev[field] !== next[field]) changed.push(field);
  }
  return changed;
}

/**
 * Convert v1 contract deliveries into the RowDelivery patch stream the RTDB
 * backend would emit for the same ingest: the first qualifying delivery of a
 * key emits a full-row `insert`; later deliveries emit `update` patches
 * carrying ONLY the fields the classifier's merge rules changed (the backend
 * drops content-no-op mutations — `is_empty_update` — so those consume no
 * envelope). Per-key `seq` is strictly monotonic from 1.
 */
export function patchesFromDeliveries(deliveries: ContractDelivery[]): RowDelivery[] {
  const patches: RowDelivery[] = [];
  const chatRows = new Map<string, ChatRow>();
  const toolRows = new Map<string, ToolUseRow>();
  const chatSeqs = new Map<string, number>();
  const toolSeqs = new Map<string, number>();

  for (const d of deliveries) {
    const projected = projectDelivery(d);
    if (!projected) continue;

    const keyStr = `${projected.sessionId}\u0000${projected.correlationId}`;
    const isChat = projected.eventType === 'Chat';
    const rows = isChat
      ? (chatRows as Map<string, ChatRow | ToolUseRow>)
      : (toolRows as Map<string, ChatRow | ToolUseRow>);
    const seqs = isChat ? chatSeqs : toolSeqs;

    const prev = rows.get(keyStr);
    const next = prev
      ? ({ ...prev } as ChatRow | ToolUseRow)
      : isChat
        ? ({
            sessionId: projected.sessionId,
            correlationId: projected.correlationId,
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
          } as ChatRow)
        : ({
            sessionId: projected.sessionId,
            correlationId: projected.correlationId,
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
            isSubagent: true,
            rawJson: '',
          } as ToolUseRow);

    mergeProjectedFields(next, projected.fields);

    if (!prev) {
      const seq = (seqs.get(keyStr) ?? 0) + 1;
      seqs.set(keyStr, seq);
      next.seq = seq;
      rows.set(keyStr, next);
      patches.push({
        queryId: TEST_QUERY_ID,
        eventType: projected.eventType,
        kind: 'insert',
        seq,
        key: { sessionId: projected.sessionId, correlationId: projected.correlationId },
        patch: { ...next },
        timestamp: projected.timestamp,
      });
      continue;
    }

    const changed = diffChangedFields(
      prev as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    );
    // Content-no-op merge (the classifier's gate) — no envelope, no seq bump.
    if (changed.length === 0) continue;
    const seq = (seqs.get(keyStr) ?? 0) + 1;
    seqs.set(keyStr, seq);
    next.seq = seq;
    rows.set(keyStr, next);
    const patch: Record<string, unknown> = { seq };
    for (const field of changed) patch[field] = (next as unknown as Record<string, unknown>)[field];
    patches.push({
      queryId: TEST_QUERY_ID,
      eventType: projected.eventType,
      kind: 'update',
      seq,
      key: { sessionId: projected.sessionId, correlationId: projected.correlationId },
      patch: patch as RowDelivery['patch'],
      timestamp: projected.timestamp,
    });
  }

  return patches;
}

// ── The patch store (P4.1 row-store semantics) ──────────────────────────────

export interface RowPatchPartition<Row> {
  /** Live row map — stable identity, mutated in place. */
  rows: Map<string, Row>;
  /** Monotonic per-eventType counter — advances only on a real mutation. */
  epoch: number;
  error: null;
}

export interface RowPatchStore {
  chat: RowPatchPartition<ChatRow>;
  toolUse: RowPatchPartition<ToolUseRow>;
  /** Apply one batch of envelopes (replay snapshot, live patches, or both). */
  apply(patches: RowDelivery[]): void;
}

/**
 * Create an isolated row patch store with the StreamContext.applyRowDelivery
 * semantics (P4.1): insert = full-row set / spread-merge + seq baseline;
 * update = merge with stale-seq (lower than last applied) drop and
 * update-before-insert adoption; remove = delete. NO cap/TTL eviction.
 *
 * Parity with the production store is pinned by rowPatchPipeline.test.ts,
 * which feeds the same stream through BOTH this applier and the real
 * `applyRowDelivery`.
 */
export function createRowPatchStore(): RowPatchStore {
  const chat: RowPatchPartition<ChatRow> = { rows: new Map(), epoch: 0, error: null };
  const toolUse: RowPatchPartition<ToolUseRow> = { rows: new Map(), epoch: 0, error: null };
  // Last applied seq per row key — stale-patch detection (per partition).
  const chatSeqs = new Map<string, number>();
  const toolSeqs = new Map<string, number>();

  function applyPartition<Row extends ChatRow | ToolUseRow>(
    partition: RowPatchPartition<Row>,
    seqs: Map<string, number>,
    delivery: RowDelivery,
  ): void {
    if (!isRowDelivery(delivery)) return; // malformed envelopes are ignored (AppProvider contract)
    const key = `${delivery.key.sessionId}\u0000${delivery.key.correlationId}`;
    const patch = (delivery.patch ?? {}) as Partial<Row>;

    if (delivery.kind === 'remove') {
      if (partition.rows.has(key)) {
        partition.rows.delete(key);
        seqs.delete(key);
        partition.epoch += 1;
      }
      return;
    }

    if (delivery.kind === 'insert') {
      const prev = partition.rows.get(key);
      if (!prev) {
        partition.rows.set(key, { ...patch } as Row);
        seqs.set(key, delivery.seq);
        partition.epoch += 1;
        return;
      }
      // Key exists — spread-merge so init-time fields are never wiped.
      const merged = { ...prev, ...patch } as Row;
      seqs.set(key, delivery.seq);
      const changed = diffChangedFields(
        prev as unknown as Record<string, unknown>,
        merged as unknown as Record<string, unknown>,
      );
      if (changed.length > 0) {
        partition.rows.set(key, merged);
        partition.epoch += 1;
      }
      return;
    }

    // update — drop patches stale relative to the last applied seq.
    const lastSeq = seqs.get(key);
    if (lastSeq !== undefined && delivery.seq < lastSeq) return;
    const prev = partition.rows.get(key);
    if (!prev) {
      // Update-before-insert (burst reordering): adopt the patch as the row.
      partition.rows.set(key, { ...patch } as Row);
      seqs.set(key, delivery.seq);
      partition.epoch += 1;
      return;
    }
    const merged = { ...prev, ...patch } as Row;
    seqs.set(key, delivery.seq);
    const changed = diffChangedFields(
      prev as unknown as Record<string, unknown>,
      merged as unknown as Record<string, unknown>,
    );
    if (changed.length > 0) {
      partition.rows.set(key, merged);
      partition.epoch += 1;
    }
  }

  return {
    chat,
    toolUse,
    apply(patches: RowDelivery[]): void {
      for (const delivery of patches) {
        if (delivery.eventType === 'Chat') applyPartition(chat, chatSeqs, delivery);
        else if (delivery.eventType === 'ToolUse') applyPartition(toolUse, toolSeqs, delivery);
      }
    },
  };
}

// ── Feed adapters (the suites' entry points) ────────────────────────────────

let __rowSourceEpoch = 0;
const byIdentity = new WeakMap<object, object>();
const byContent = new Map<string, object>();
const CONTENT_CACHE_MAX = 8;

function cachedByContent(contentKey: string, build: () => object): object {
  const contentHit = byContent.get(contentKey);
  if (contentHit) return contentHit;
  const built = build();
  byContent.set(contentKey, built);
  if (byContent.size > CONTENT_CACHE_MAX) {
    const oldest = byContent.keys().next();
    if (!oldest.done) byContent.delete(oldest.value);
  }
  return built;
}

/**
 * Feed v1 delivery FIXTURES to the graph: convert them into the RowDelivery
 * patch stream (classifier-emulating) and apply it through the patch store.
 * The returned row maps are keyed exactly like the module-scoped row store
 * (`sessionId` + NUL + `correlationId`) and shaped like `useEventRows`
 * results. Content-cached — the same fixture array yields the SAME source
 * object (the render-stability contract above).
 */
export function rowSource(deliveries: ContractDelivery[]): object {
  const identityHit = byIdentity.get(deliveries);
  if (identityHit) return identityHit;

  const built = cachedByContent(JSON.stringify(deliveries), () => {
    const store = createRowPatchStore();
    store.apply(patchesFromDeliveries(deliveries));
    return { chat: store.chat, toolUse: store.toolUse };
  });
  byIdentity.set(deliveries, built);
  return built;
}

/**
 * Feed AUTHORED RowDelivery envelopes directly (the P4.4 legs — late
 * completion, replay/live parity — write patches, not v1 fixtures).
 * Content-cached like `rowSource`.
 */
export function rowSourceFromPatches(patches: RowDelivery[]): object {
  const identityHit = byIdentity.get(patches);
  if (identityHit) return identityHit;

  const built = cachedByContent(JSON.stringify(patches), () => {
    const store = createRowPatchStore();
    store.apply(patches);
    return { chat: store.chat, toolUse: store.toolUse };
  });
  byIdentity.set(patches, built);
  return built;
}
