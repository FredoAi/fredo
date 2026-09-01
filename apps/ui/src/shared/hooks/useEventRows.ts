/**
 * useEventRows — validated-query RTDB subscription hook (Spec #2788, P4.1).
 *
 * Subscribes to the backend row store via the `subscribe_events` IPC command
 * (R-1/R-2a/R-3), builds the query TEXT for the RTDB mini query language
 * (`chat(sessionId = "ses_x") { sessionId, ... }`), and exposes the row map
 * plus a monotonic `epoch` primitive.
 *
 * ── Return shape (adopted ui-ux refinement — binding) ──────────────────────
 * `{ rows: Map<rowKey, Row>, epoch: number, error: string | null }`
 * - `rows`   — the LIVE module-scoped map (stable identity; mutate in place).
 * - `epoch`  — monotonic counter per eventType, advancing ONLY when an
 *              applied patch actually mutated the rows. Memo/effect off this
 *              primitive — never off `rows` identity or map size (kills the
 *              #523-cycle-1 re-render-loop class at the API level).
 * - `error`  — loud subscribe failure (R-3a): the verbatim backend error
 *              strings (they embed the offending query text) are surfaced
 *              here AND via console.error. Never a silent empty result.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 * - Re-subscribes when `eventType`/`args` change (args are compared via a
 *   stable serialized key — inline object literals are safe).
 * - Unsubscribes on unmount.
 * - Rows persist across mount/unmount (module-scoped store in
 *   StreamContext.tsx — refs reset on mount, per the AGENTS.md rule).
 *
 * ── Options ────────────────────────────────────────────────────────────────
 * - `replay`   — replay the SQLite snapshot as full-row inserts (replaces
 *                hydration; hydration deletion itself is P4.3).
 * - `flushMs`  — backend coalescing window; `0` = immediate emission,
 *                absent = backend default (~30ms).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { adapterBridge } from '../utils/adapterBridge';
import {
  AGENT_SESSION_ROW_FIELDS,
  CHAT_ROW_FIELDS,
  TOOL_USE_ROW_FIELDS,
} from '../classes/EventSubscription';
import {
  getRowEpoch,
  getRowMap,
  subscribeToRowEpoch,
} from '../contexts/StreamContext';
import type {
  AgentSessionRow,
  ChatRow,
  RowEventType,
  ToolUseRow,
} from '../classes/EventSubscription';

/** Equality filter args — strings are quoted, numbers/booleans/null are bare. */
export type RowArgs = Record<string, string | number | boolean | null>;

export interface UseEventRowsOptions {
  /** Replay the persisted snapshot as full-row inserts before live patches. */
  replay?: boolean;
  /** Backend flush window in ms. `0` = immediate; absent = ~30ms default. */
  flushMs?: number;
}

export interface UseEventRowsResult<Row> {
  /** Live row map keyed by `rowKeyString({ sessionId, correlationId })`. */
  rows: Map<string, Row>;
  /** Monotonic per-eventType counter — advances only on real row mutation. */
  epoch: number;
  /** Loud subscribe failure (verbatim backend error text) — `null` when subscribed. */
  error: string | null;
}

// ── Query text building ─────────────────────────────────────────────────────

/** Query-language root keyword per row event type (the parse spelling). */
const QUERY_ROOT: Record<RowEventType, string> = {
  Chat: 'chat',
  ToolUse: 'toolUse',
  AgentSession: 'agentSession',
};

/** Canonical selection field list per row event type (single source, mirrors rows.rs). */
function canonicalFieldsFor(eventType: RowEventType): readonly string[] {
  switch (eventType) {
    case 'Chat':
      return CHAT_ROW_FIELDS;
    case 'ToolUse':
      return TOOL_USE_ROW_FIELDS;
    case 'AgentSession':
      return AGENT_SESSION_ROW_FIELDS;
  }
}

function formatQueryLiteral(value: string | number | boolean | null): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value); // numbers and booleans are bare
}

/**
 * Build the query text for one RTDB subscription:
 * `chat(sessionId = "ses_x", state = "Init") { sessionId, correlationId, ... }`
 * Empty args produce a valid no-args query: `chat { ... }` (all rows of the type).
 */
export function buildQueryText(
  eventType: RowEventType,
  args: RowArgs,
  fields?: readonly string[],
): string {
  const root = QUERY_ROOT[eventType];
  const selection = fields ?? canonicalFieldsFor(eventType);
  const argParts: string[] = [];
  for (const [field, value] of Object.entries(args)) {
    if (value === undefined) continue;
    argParts.push(`${field} = ${formatQueryLiteral(value)}`);
  }
  const argsClause = argParts.length > 0 ? `(${argParts.join(', ')})` : '';
  return `${root}${argsClause} { ${selection.join(', ')} }`;
}

/** Backend `RegisteredQuery` element of the subscribe_events success shape. */
interface RegisteredQuery {
  queryId: string;
  eventType: RowEventType;
}

/**
 * Normalize the `subscribe_events` Err rejection (hard named errors, each
 * embedding the offending query text) into displayable text. The rejection
 * arrives as `string[]` per the backend contract; a bare string is accepted
 * as-is (never silently swallowed).
 */
function describeSubscribeError(err: unknown): string {
  if (Array.isArray(err)) {
    return err.map((e) => String(e)).join('; ');
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/**
 * Stable dep key for the args object — inline object literals in call sites
 * are safe (string comparison, no reference identity).
 */
function stableArgsKey(args: RowArgs): string {
  const entries: Array<[string, string | number | boolean | null]> = [];
  for (const [field, value] of Object.entries(args)) {
    if (value === undefined) continue;
    entries.push([field, value]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

// ── Typed overloads ─────────────────────────────────────────────────────────

export function useEventRows(
  eventType: 'Chat',
  args?: RowArgs,
  options?: UseEventRowsOptions,
): UseEventRowsResult<ChatRow>;
export function useEventRows(
  eventType: 'ToolUse',
  args?: RowArgs,
  options?: UseEventRowsOptions,
): UseEventRowsResult<ToolUseRow>;
export function useEventRows(
  eventType: 'AgentSession',
  args?: RowArgs,
  options?: UseEventRowsOptions,
): UseEventRowsResult<AgentSessionRow>;
export function useEventRows(
  eventType: RowEventType,
  args: RowArgs = {},
  options?: UseEventRowsOptions,
): UseEventRowsResult<ChatRow | ToolUseRow | AgentSessionRow> {
  // Primitive deps only — inline `args`/`options` literals never re-trigger.
  const argsKey = stableArgsKey(args);
  const replay = options?.replay ?? false;
  const flushMs = options?.flushMs;

  const [error, setError] = useState<string | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToRowEpoch(eventType, onStoreChange),
    [eventType],
  );
  const epoch = useSyncExternalStore(subscribe, () => getRowEpoch(eventType));

  useEffect(() => {
    let cancelled = false;
    let queryId: string | undefined;

    const queryText = buildQueryText(eventType, args, canonicalFieldsFor(eventType));
    const invokeArgs: Record<string, unknown> = { queries: [queryText], replay };
    if (flushMs !== undefined) {
      invokeArgs.flushMs = flushMs;
    }

    adapterBridge
      .invoke<RegisteredQuery[]>('subscribe_events', invokeArgs)
      .then((registered) => {
        if (!registered || registered.length === 0) {
          throw new Error('subscribe_events returned no registered query');
        }
        if (cancelled) {
          // Unmounted before the subscription resolved — tear it down.
          void adapterBridge.invoke('unsubscribe_events', {
            queryIds: [registered[0].queryId],
          });
          return;
        }
        queryId = registered[0].queryId;
        setError(null);
      })
      .catch((err) => {
        // R-3a: loud mount error surfacing — console.error + exposed state,
        // backend error text passed through verbatim.
        const message = describeSubscribeError(err);
        console.error(
          `[useEventRows] subscribe_events failed for query "${queryText}":`,
          message,
        );
        if (!cancelled) {
          setError(message);
        }
      });

    return () => {
      cancelled = true;
      if (queryId !== undefined) {
        void adapterBridge
          .invoke('unsubscribe_events', { queryIds: [queryId] })
          .catch((unsubErr) => {
            console.error('[useEventRows] unsubscribe_events failed:', unsubErr);
          });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType, argsKey, replay, flushMs]);

  return {
    rows: getRowMap(eventType) as Map<string, ChatRow | ToolUseRow | AgentSessionRow>,
    epoch,
    error,
  };
}
