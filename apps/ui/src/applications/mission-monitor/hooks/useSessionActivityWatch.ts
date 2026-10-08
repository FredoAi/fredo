/**
 * useSessionActivityWatch — session-scoped canonical activity watch
 * (Spec #2896, ST-9; R-5.1 / R-5.2 / R-5.3).
 *
 * Owns the CONTINUOUS lifecycle of the per-session activity watch for the
 * panel's WHOLE lifetime — not only at a selection change call-site:
 *
 *  - `sessionId === null` ⇒ **no per-session watch is registered at all** and
 *    nothing per-session is delivered (R-5.1). The returned rows are empty;
 *    the session-list (table-level) watch is a different hook and keeps
 *    delivering regardless.
 *  - a change `A → B` ⇒ A's watches are unsubscribed, A's pending deliveries
 *    are dropped (they can never surface in the returned rows and never bump
 *    the returned `epoch`), then B's watches are opened (R-5.2).
 *  - the same id ⇒ no re-subscribe (no watch churn): the effect is keyed on
 *    `sessionId` only.
 *  - unmount ⇒ A's/B's watches are unsubscribed.
 *
 * It watches the canonical `chat` and `toolUse` tables with the query scope
 * `{ kind: 'query', where: [{ field: 'sessionId', eq: sessionId }] }` (R-5.3 —
 * the classifier's composited child copies ride the parent `sessionId`, so a
 * parent-scoped query already covers nested/subagent activity).
 *
 * ── Why this does not use `useFeatureWatch` ───────────────────────────────────
 * `useFeatureWatch` (ST-5) always registers a watch for its ref/scope, so a
 * null session could not be represented without opening a watch for
 * `sessionId = null` (a direct R-5.1 violation). This hook therefore drives
 * the same ST-5 client/store primitives directly so the null state is a true
 * "no watch" state.
 *
 * ── Delivering only the selected session (R-5.3) ──────────────────────────────
 * The feature-data store partitions by TABLE REF (shared across consumers), so
 * the canonical `chat`/`toolUse` partitions may transiently hold rows from a
 * previously-selected session. This hook derives its own **session-scoped view**
 * from those partitions (filter `row.sessionId === sessionId`) and exposes a
 * session-scoped `epoch` that advances ONLY when the selected session's view
 * actually changes. A late delivery for the previous session therefore never
 * appears in the returned rows and never re-renders the consumer — the
 * frontend half of R-5.2 (the backend half is ST-4's per-watch unwatch).
 *
 * ── Return shape (consumed by ST-6) ───────────────────────────────────────────
 * `chatRows` / `toolUseRows` — session-scoped row maps (stable identity until
 * the session's content changes) suitable for `deriveRowGraphState([...], [...])`.
 * `epoch` — monotonic per session; derive display state off this primitive,
 * never map identity/size (the #523 re-render-loop guard).
 * `error` — the VERBATIM backend `string[]` text (joined `; `), never
 * swallowed; `ready` — true once BOTH watches registered and their `initial`
 * snapshots were seeded.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { featureDataUnwatch, featureDataWatch } from '../../../shared/feature-data/client';
import type { DataTableRef, FeatureDataRow, WatchScope } from '../../../shared/feature-data/client';
import { featureRecordKey } from '../../../shared/feature-data/registry';
import {
  getFeatureEpoch,
  getFeatureRows,
  registerKnownFeatureWatch,
  seedFeatureRows,
  subscribeToFeatureEpoch,
  unregisterKnownFeatureWatch,
} from '../../../shared/feature-data/store';

/** The canonical tables a per-session activity watch covers. */
const CHAT_REF: DataTableRef = { source: 'canonical', table: 'chat' };
const TOOL_USE_REF: DataTableRef = { source: 'canonical', table: 'toolUse' };

/** Per-session query scope — `sessionId = <selected>` (R-5.3). */
function sessionScope(sessionId: string): WatchScope {
  return { kind: 'query', where: [{ field: 'sessionId', eq: sessionId }] };
}

// ── Session-scoped view (derived cache) ───────────────────────────────────────
//
// `useSyncExternalStore` on the shared partitions tells us when SOMETHING
// changed; this cache turns that into the selected session's view. The cache
// keeps the snapshot object (and its row maps) referentially stable while the
// session's content is unchanged, so an unrelated/late delivery cannot
// re-render the consumer and cannot bump the session `epoch` (R-5.2).

interface SessionActivitySnapshot {
  sessionId: string | null;
  chatRows: Map<string, FeatureDataRow>;
  toolUseRows: Map<string, FeatureDataRow>;
  /** Monotonic per session; advances only when this session's view changes. */
  contentVersion: number;
}

const EMPTY_SNAPSHOT: SessionActivitySnapshot = {
  sessionId: null,
  chatRows: new Map(),
  toolUseRows: new Map(),
  contentVersion: 0,
};

const sessionSnapshots = new Map<
  string,
  { fingerprint: string; snapshot: SessionActivitySnapshot }
>();
let contentVersionCounter = 0;

/** Rows of one canonical table whose session key equals `sessionId`. */
function rowsForSession(ref: DataTableRef, sessionId: string): Map<string, FeatureDataRow> {
  const filtered = new Map<string, FeatureDataRow>();
  for (const [key, row] of getFeatureRows(ref)) {
    if (row.sessionId === sessionId) {
      filtered.set(key, row);
    }
  }
  return filtered;
}

/** Content fingerprint of a session's row map (order-insensitive per row). */
function fingerprintRows(rows: Map<string, FeatureDataRow>): string {
  const entries: string[] = [];
  for (const [key, row] of rows) {
    const fields = Object.keys(row)
      .sort()
      .map((field) => `${field}=${JSON.stringify(row[field])}`)
      .join(',');
    entries.push(`${key}{${fields}}`);
  }
  return entries.join('\u0001');
}

/**
 * The selected session's view. Returns the cached snapshot (stable identity)
 * when the content is unchanged — a late previous-session delivery therefore
 * produces the SAME snapshot and never advances the epoch.
 */
function computeSessionSnapshot(sessionId: string | null): SessionActivitySnapshot {
  if (sessionId === null) {
    return EMPTY_SNAPSHOT;
  }
  const chatRows = rowsForSession(CHAT_REF, sessionId);
  const toolUseRows = rowsForSession(TOOL_USE_REF, sessionId);
  const fingerprint = `${fingerprintRows(chatRows)}\u0002${fingerprintRows(toolUseRows)}`;
  const cached = sessionSnapshots.get(sessionId);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.snapshot;
  }
  contentVersionCounter += 1;
  const snapshot: SessionActivitySnapshot = {
    sessionId,
    chatRows,
    toolUseRows,
    contentVersion: contentVersionCounter,
  };
  sessionSnapshots.set(sessionId, { fingerprint, snapshot });
  return snapshot;
}

/** Normalize a hard named `string[]` rejection (or any error) to display text. */
function describeSessionWatchError(err: unknown): string {
  if (Array.isArray(err)) {
    return err.map((entry) => String(entry)).join('; ');
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/** The session's activity rows + lifecycle state. */
export interface SessionActivityWatchResult {
  /** Live canonical chat rows for the selected session (empty when none). */
  chatRows: Map<string, FeatureDataRow>;
  /** Live canonical tool-use rows for the selected session (empty when none). */
  toolUseRows: Map<string, FeatureDataRow>;
  /** Monotonic per session; advances only on a real mutation of that session. */
  epoch: number;
  /** Verbatim backend error text, or `null`. Never swallowed. */
  error: string | null;
  /** True once both watches (and their `initial` snapshots) resolved. */
  ready: boolean;
}

/**
 * Open the `chat` + `toolUse` query watches for `sessionId`, or open nothing
 * when it is `null`. Returns the session's current rows/state.
 */
export function useSessionActivityWatch(
  sessionId: string | null,
): SessionActivityWatchResult {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // ── Re-render trigger: a real mutation of either shared canonical partition.
  const subscribeChat = useCallback(
    (listener: () => void) => subscribeToFeatureEpoch(CHAT_REF, listener),
    [],
  );
  const subscribeTool = useCallback(
    (listener: () => void) => subscribeToFeatureEpoch(TOOL_USE_REF, listener),
    [],
  );
  const chatEpoch = useSyncExternalStore(subscribeChat, () => getFeatureEpoch(CHAT_REF));
  const toolUseEpoch = useSyncExternalStore(subscribeTool, () => getFeatureEpoch(TOOL_USE_REF));

  // ── The session-scoped view (R-5.3). Referentially stable while unchanged,
  // so a previous session's late delivery cannot re-render the consumer.
  const snapshot = useMemo(
    () => computeSessionSnapshot(sessionId),
    [sessionId, chatEpoch, toolUseEpoch],
  );

  // ── Lifecycle: null ⇒ nothing; change A→B ⇒ close A, open B; same id ⇒ no
  // re-subscribe; unmount ⇒ close. Keyed on `sessionId` only (no churn).
  useEffect(() => {
    if (sessionId === null) {
      // R-5.1 — no per-session watch is registered at all.
      setReady(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const openWatchIds: string[] = [];
    setReady(false);
    setError(null);

    const openOne = async (ref: DataTableRef): Promise<boolean> => {
      const result = await featureDataWatch({
        ref,
        scope: sessionScope(sessionId),
        initial: true,
      });
      if (cancelled) {
        // Switch/unmount happened while registration was in flight — tear the
        // watch down immediately so it cannot outlive its session (R-5.2).
        void featureDataUnwatch({ watchIds: [result.watchId] }).catch((unwatchErr) => {
          console.error('[useSessionActivityWatch] feature_data_unwatch failed:', unwatchErr);
        });
        return false;
      }
      openWatchIds.push(result.watchId);
      registerKnownFeatureWatch({
        watchId: result.watchId,
        featureId: null,
        table: ref.table,
        scope: `query sessionId=${sessionId}`,
        fields: null,
        registeredAt: new Date().toISOString(),
      });
      if (result.rows) {
        seedFeatureRows(ref, result.version, result.rows, (row) => featureRecordKey(ref, row));
      }
      return true;
    };

    void Promise.all([openOne(CHAT_REF), openOne(TOOL_USE_REF)])
      .then((opened) => {
        if (cancelled || !opened.every(Boolean)) return;
        setReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = describeSessionWatchError(err);
        console.error('[useSessionActivityWatch] feature_data_watch failed:', message);
        setError(message);
        setReady(false);
      });

    return () => {
      cancelled = true;
      for (const watchId of openWatchIds) {
        unregisterKnownFeatureWatch(watchId);
        void featureDataUnwatch({ watchIds: [watchId] }).catch((unwatchErr) => {
          console.error('[useSessionActivityWatch] feature_data_unwatch failed:', unwatchErr);
        });
      }
    };
  }, [sessionId]);

  return {
    chatRows: snapshot.chatRows,
    toolUseRows: snapshot.toolUseRows,
    epoch: snapshot.contentVersion,
    error,
    ready,
  };
}

/** Test-only: clear the derived session-view cache. */
export function resetSessionActivityWatchForTests(): void {
  sessionSnapshots.clear();
  contentVersionCounter = 0;
}
