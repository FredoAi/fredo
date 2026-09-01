import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { MissionMonitorSession } from '../lib/graph';
import { loadPersistedSessions, deleteSessionFromStore, markSessionDeleted, isSessionDeleted, saveCustomName, seedDeletedSessionIdsIntoModule } from '../lib/persistence';
import { formatDerivedName, deriveDisplayName } from '../lib/sessionMeta';
import { useEventRows } from '../../../shared/hooks/useEventRows';
import type { ChatRow } from '../../../shared/classes/EventSubscription';

// ── Spec #2788 (P4.3): replay replaces hydration ─────────────────────────────
//
// The session list derives from the typed RTDB Chat rows via
// `useEventRows('Chat', {}, { replay: true })`. The v1 machinery this
// replaces (and that Phase 5 deletes with the rest of the ECE path):
// - `contract_events_hydrate` + `shared/lib/contractHydration.ts` — replay
//   delivers the persisted snapshot as full-row `insert` envelopes (R-2a),
//   routed by the backend BEFORE `subscribe_events` resolves, so there is no
//   separate mount-time fetch.
// - the module-scoped `hydratedDeliveryIds` set — replay inserts dedupe by
//   ROW KEY in the row store (one row per (sessionId, correlationId), spread-
//   merge, seq-guarded), so hydrated rows can never double-add.
// - `useStream()` deliveries — the row store has no TTL eviction and no
//   5000-cap, so a session's rows are visible for the panel's whole lifetime
//   and restored by replay on remount (the v1 TTL-shrink vanish bug class is
//   structurally gone).
//
// Count semantics: the ROW STORE is authoritative for every session it holds
// rows for (replay restores the FULL row history). The FeatureStore snapshot
// contributes only the name prefs (customName/derivedName) and acts as a
// fallback for sessions whose rows are retention-evicted (R-2d) — its
// deliveryCount is never ADDED on top of a row count, so no double counting
// is possible by construction.

/**
 * useDeliverySessions — derives sessions from the replayed Chat rows merged
 * with the persisted FeatureStore snapshot (names + retention fallback).
 *
 * @returns sessions, filteredSessions, selectedSessionId, selectSession,
 *          followSession, deleteSession, renameSession, refreshSessions,
 *          searchFilter, setSearchFilter, userPickedRef
 */
export function useDeliverySessions() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [persistedSessions, setPersistedSessions] = useState<MissionMonitorSession[]>([]);
  const [persistedLoadDone, setPersistedLoadDone] = useState(false);
  const userPickedRef = useRef(false);

  // Track deleted session IDs to prevent resurrection via replayed/live rows
  const deletedSessionIdsRef = useRef<Set<string>>(new Set());

  // Replay subscription — the session list's live data source. Shares the
  // module-scoped row store with the panel's own Chat subscription (duplicate
  // envelopes dedupe by row key in the store — idempotent).
  const chatRows = useEventRows('Chat', {}, { replay: true });

  // The `loaded` gate (the UX ladder's spinner state — MissionMonitorPanel
  // renders its spinner empty-state while `sessions` is empty). It covers
  // BOTH async loads, per the UI/UX parity constraint (no blank-screen flash):
  // - the FeatureStore snapshot load below, and
  // - the replay subscription's SNAPSHOT PHASE — round-3 F-33: the backend
  //   replay leg is a spawned background drain (commands.rs registers the
  //   live sub first, then hands the snapshot SELECT to
  //   `tauri::async_runtime::spawn_blocking`), so `ready` stays FALSE while
  //   the snapshot drains and resolves ONLY on the backend's
  //   `replayCompleteQueryId` marker for this subscription (never on
  //   subscribe resolution alone — that would park the gate on a half-drained
  //   snapshot). The empty state before the settle is the same spinner.
  // A FAILED subscription must never wedge the gate (v1 hydration-failure
  // contract): `error !== null` opens it with the persisted data only — the
  // failure itself surfaces loudly through useEventRows (R-3a).
  const loaded = persistedLoadDone && (chatRows.ready || chatRows.error !== null);

  // Load the persisted session snapshot (name prefs + retention fallback) AND
  // seed the module-level deleted set from the durable tombstones — both
  // before `loaded` flips, so a deleted session's replayed rows are filtered
  // from the FIRST derived list (no deleted-session flash on mount).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedSessions] = await Promise.all([
          loadPersistedSessions(),
          seedDeletedSessionIdsIntoModule(),
        ]);
        if (!cancelled) {
          setPersistedSessions(loadedSessions);
          setPersistedLoadDone(true);
        }
      } catch (err) {
        console.warn('[MM] mount load failed:', err);
        if (!cancelled) {
          setPersistedLoadDone(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh the persisted-session snapshot from SQLite. Exposed for parity
  // with the v1 hook API (and used by the tests); with the rows-authoritative
  // merge the snapshot only feeds name prefs + the retention fallback.
  const refreshSessions = useCallback(async () => {
    try {
      const sessions = await loadPersistedSessions();
      setPersistedSessions(sessions);
    } catch (err) {
      console.warn('[MM] refreshSessions failed:', err);
    }
  }, []);

  // Merge the persisted snapshot with the replayed row data. ONE O(N) pass
  // over the row store per recompute (NFR-1 — never a per-session rescan);
  // memoized on the monotonic row-store epoch, never on map identity or size
  // (the #523-cycle-1 no-loop rule).
  const sessions = useMemo<MissionMonitorSession[]>(() => {
    if (!loaded) return [];

    // REQ-1: Deduplicate persisted sessions by sessionId (dual-transport rows).
    // Last entry wins for metadata.
    const dedupedPersisted = new Map<string, MissionMonitorSession>();
    for (const s of persistedSessions) {
      dedupedPersisted.set(s.sessionId, s);
    }
    const uniquePersisted = Array.from(dedupedPersisted.values());

    // Single pass over the Chat rows, grouped by sessionId:
    // - count   = rows for the session (one row per chat turn — the sidebar
    //             figure; child-session turns arrive re-keyed under the parent
    //             per the #523 compositing, so they count toward the root).
    // - latest  = max updatedAt (RFC3339 string compare, append order-safe).
    // - start   = min startedAtNs (span start), falling back to updatedAt.
    // - #2748 ST-3 (AC1 R-1.1): earliest-timestamp non-empty userMessage per
    //   session — selection mirrors deriveSessionName; formatting is
    //   delegated to formatDerivedName (single definition of
    //   normalize+truncate).
    const rowCounts = new Map<string, number>();
    const rowLatest = new Map<string, string>();
    const rowStart = new Map<string, number>();
    const rowUserMessages = new Map<string, { ts: number; message: string }>();

    for (const row of chatRows.rows.values() as IterableIterator<ChatRow>) {
      const sid = row.sessionId;
      if (!sid) continue;

      rowCounts.set(sid, (rowCounts.get(sid) ?? 0) + 1);

      const existingTs = rowLatest.get(sid);
      if (!existingTs || row.updatedAt > existingTs) {
        rowLatest.set(sid, row.updatedAt);
      }

      const updatedAtMs = Date.parse(row.updatedAt);
      const rowStartMs =
        row.startedAtNs !== null && row.startedAtNs !== undefined
          ? row.startedAtNs / 1e6
          : updatedAtMs;
      if (Number.isFinite(rowStartMs)) {
        const existingStart = rowStart.get(sid);
        if (!existingStart || rowStartMs < existingStart) {
          rowStart.set(sid, rowStartMs);
        }
      }

      const userMessage = typeof row.userMessage === 'string' ? row.userMessage : '';
      if (userMessage.trim() === '' || !Number.isFinite(updatedAtMs)) continue;
      const existingMsg = rowUserMessages.get(sid);
      if (!existingMsg || updatedAtMs < existingMsg.ts) {
        rowUserMessages.set(sid, { ts: updatedAtMs, message: userMessage });
      }
    }

    // Merge persisted sessions with row data.
    const merged = uniquePersisted
      .map((s) => {
        const rowCount = rowCounts.get(s.sessionId);
        if (rowCount === undefined) {
          // No rows for this session (RTDB retention evicted them, or the
          // session predates the replay window) — the persisted snapshot is
          // the only source. Values unchanged (v1 fallback) except the
          // derived-name normalization (display form — the hook's job).
          const fallbackSession: MissionMonitorSession = { ...s };
          const fallbackDerived =
            s.derivedName ? formatDerivedName(s.derivedName) : undefined;
          if (fallbackDerived !== undefined) fallbackSession.derivedName = fallbackDerived;
          return fallbackSession;
        }
        // Rows authoritative — replay restores the FULL row history (no TTL,
        // no cap), so the row count IS the session's chat-turn count. The
        // persisted deliveryCount is never added on top (the replay-dedupe
        // guarantee — no double counting by construction).
        const mergedSession: MissionMonitorSession = {
          ...s,
          deliveryCount: rowCount,
          latestTimestamp: rowLatest.get(s.sessionId) ?? s.latestTimestamp,
          startTime: rowStart.get(s.sessionId) ?? s.startTime,
        };

        // #2748 ST-3 (AC1/AC2): resolve the session's derived name. The
        // persisted value (capture-at-persist — the session's TRUE first
        // message) is authoritative; row derivation fills the gap for
        // sessions whose name was never captured (live-only sessions). Both
        // run through formatDerivedName so the drawer always receives the
        // display form. Display precedence (customName ?? derivedName ??
        // label) is resolved by deriveDisplayName at render time.
        const rowMsg = rowUserMessages.get(s.sessionId);
        const derived =
          (s.derivedName ? formatDerivedName(s.derivedName) : undefined) ??
          (rowMsg ? formatDerivedName(rowMsg.message) : undefined);
        if (derived !== undefined) mergedSession.derivedName = derived;

        return mergedSession;
      });

    // Add sessions from rows that aren't in the persisted snapshot.
    const persistedIds = new Set(uniquePersisted.map((s) => s.sessionId));

    for (const [sid, rowCount] of rowCounts) {
      if (persistedIds.has(sid)) continue;

      persistedIds.add(sid);
      const startMs = rowStart.get(sid) ?? Date.now();
      const rowMsg = rowUserMessages.get(sid);
      const rowOnlySession: MissionMonitorSession = {
        sessionId: sid,
        label: new Date(startMs).toLocaleString(),
        startTime: startMs,
        latestTimestamp: rowLatest.get(sid) ?? new Date(startMs).toISOString(),
        deliveryCount: rowCount,
      };
      // #2748 ST-3 (AC1): row-only sessions carry their derived name from the
      // single-pass collection — no per-row scan.
      if (rowMsg) {
        const derived = formatDerivedName(rowMsg.message);
        if (derived !== undefined) rowOnlySession.derivedName = derived;
      }
      merged.push(rowOnlySession);
    }

    // Exclude deleted sessions from all merge paths (REQ-3: prevent
    // resurrection). Checks BOTH the local ref (immediate UI feedback) and
    // the module-level set (cross-mount persistence, tombstone-seeded).
    const deleted = deletedSessionIdsRef.current;
    let filtered = merged.filter((s) => !deleted.has(s.sessionId) && !isSessionDeleted(s.sessionId));

    // Sort newest-first by latestTimestamp
    return filtered.sort((a, b) => {
      return new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime();
    });
    // `chatRows.rows` is the stable module-scoped map (identity never changes)
    // — the epoch is the real recompute signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedSessions, chatRows.epoch, chatRows.rows, loaded]);

  // Reset selected session if it no longer exists
  useEffect(() => {
    if (selectedSessionId && !sessions.some((s) => s.sessionId === selectedSessionId)) {
      setSelectedSessionId(null);
      userPickedRef.current = false;
    }
  }, [sessions, selectedSessionId]);

  // Auto-select the newest session when no session is selected and user hasn't manually picked one.
  //
  // Uses startTime (session creation time) instead of sessions[0] from the sorted list,
  // because sessions is sorted by latestTimestamp which gets overwritten by the newest
  // row update. An old session with recent live rows would sort before a newer-but-idle
  // session, causing the wrong session to be auto-selected.
  useEffect(() => {
    if (userPickedRef.current === false && sessions.length > 0 && selectedSessionId === null) {
      const newest = sessions.reduce((a, b) => a.startTime > b.startTime ? a : b);
      setSelectedSessionId(newest.sessionId);
    }
  }, [sessions, selectedSessionId]);

  // ── Selection FOLLOWS the newly started live session (#2758 round-22 C1) ───
  // A NEWLY SEEN chat-row sessionId arriving in the row store retargets the
  // selection whenever the user has NOT explicitly picked one this lifetime
  // (an explicit row click flips userPickedRef and permanently disables
  // following — never steal focus).
  //
  // Known sessionIds live in a ref SEEDED ON THE FIRST PASS (the first
  // render's row snapshot): everything observable at mount predates this hook
  // instance and must not steal the pre-existing auto-select. Within the
  // lifetime the set only grows, so repeat rows for an already-seen session
  // never re-trigger. Keyed on the row-store EPOCH (never on map size —
  // AGENTS.md no-loop rule).
  const seenLiveSessionIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seenLiveSessionIdsRef.current === null) {
      // First pass (mount): SEED ONLY — never retarget on restored/parked traffic.
      const seed = new Set<string>();
      for (const row of chatRows.rows.values()) {
        if (row.sessionId) seed.add(row.sessionId);
      }
      seenLiveSessionIdsRef.current = seed;
      return;
    }

    const seen = seenLiveSessionIdsRef.current;
    let newestNewSid: string | null = null;
    // Map iteration order is row-key insertion order = arrival order (replay
    // delivers in seq order) — the LAST newly seen sessionId wins when
    // several appear in one batch.
    for (const row of chatRows.rows.values()) {
      const sid = row.sessionId;
      if (sid && !seen.has(sid)) {
        newestNewSid = sid;
      }
    }

    if (newestNewSid === null) return;

    if (userPickedRef.current) {
      // Explicit user pick is active — burn the pending new sessionId so it
      // cannot resurface as a steal after a later deselect/reset.
      seen.add(newestNewSid);
      return;
    }

    // Only follow sessions that exist in the derived list — excludes deleted
    // (REQ-3 anti-resurrection) and any filtered-out session. If the derived
    // list has not caught up yet (snapshot load still in flight), the
    // sessionId stays unseen and retries on the next epoch bump
    // (self-healing).
    if (sessions.some((s) => s.sessionId === newestNewSid)) {
      seen.add(newestNewSid);
      // Programmatic follow must NOT flip userPickedRef (unlike selectSession)
      // — following stays armed across multiple newly started sessions until
      // the user explicitly clicks a row.
      setSelectedSessionId(newestNewSid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatRows.epoch, sessions]);

  // Filtered sessions by search — #2750 ST-3 (AC3): the filter matches the
  // session's display Name (`deriveDisplayName` = customName ?? derivedName ??
  // label) IN ADDITION to the sessionId. A single `.filter` pass keeps the
  // exactly-once edge (AC3-2) automatic — a query matching one session's Name
  // and another's sessionId returns each matching session exactly once. Empty
  // query → all sessions (unchanged).
  //
  // #2750 AC3 round-2: the predicate queries EXACTLY the string the drawer row
  // renders — the drawer derives the same `deriveDisplayName(session)` from
  // the same session object. `derivedName` is stored in its DISPLAY form
  // (truncated to 40 chars incl. `…` by formatDerivedName at capture), so
  // BOTH the row text and this filter see the truncated string (documented
  // behavior; pinned by the truncation test below).
  const filteredSessions = useMemo(() => {
    if (!searchFilter) return sessions;
    const lower = searchFilter.toLowerCase();
    return sessions.filter(
      (s) =>
        s.sessionId.toLowerCase().includes(lower) ||
        deriveDisplayName(s).toLowerCase().includes(lower),
    );
  }, [sessions, searchFilter]);

  const selectSession = useCallback((id: string | null) => {
    userPickedRef.current = true;
    setSelectedSessionId(id);
  }, []);

  /**
   * #2758 round-22 C1: programmatically retarget selection WITHOUT flipping
   * userPickedRef (unlike selectSession). Used by the panel's follow guard so
   * following remains armed across multiple newly started sessions until the
   * user explicitly picks a row.
   */
  const followSession = useCallback((id: string | null) => {
    setSelectedSessionId(id);
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    // Track deleted ID in BOTH local ref AND module-level set (REQ-3)
    // Local ref provides immediate UI feedback via re-render → useMemo re-run.
    // Module-level set provides cross-mount persistence (survives dialog
    // close/reopen); the store's durable tombstone (P4.3) additionally
    // survives an app restart against RTDB replay.
    deletedSessionIdsRef.current.add(id);
    markSessionDeleted(id);
    // Remove from SQLite (also records the restart-durable tombstone)
    await deleteSessionFromStore(id);
    // Remove from local state immediately (REQ-7)
    setPersistedSessions((prev) => prev.filter((s) => s.sessionId !== id));
    // Clear selection if the deleted session was selected (REQ-8)
    if (selectedSessionId === id) {
      setSelectedSessionId(null);
      userPickedRef.current = false;
    }
  }, [selectedSessionId]);

  /**
   * #2748 ST-3 (AC2 R-2.4): rename a session.
   *
   * Persists via ST-2's `saveCustomName` (atomic featureStoreUpdate;
   * empty/whitespace clears the custom name), then updates local state so the
   * drawer re-renders immediately with the new custom name. A row-only
   * session (not in the mount snapshot) is upserted into `persistedSessions`
   * from the current merged view — otherwise the rename would not surface
   * until a remount.
   *
   * The session carries `customName` (authoritative) + `derivedName`; display
   * precedence (`customName ?? derivedName ?? label`) is resolved by
   * `deriveDisplayName` at render time.
   */
  const renameSession = useCallback(async (id: string, name: string) => {
    await saveCustomName(id, name);
    const trimmed = name.trim();
    const customName = trimmed.length > 0 ? trimmed : undefined;

    setPersistedSessions((prev) => {
      const existing = prev.some((s) => s.sessionId === id);
      if (existing) {
        return prev.map((s) => (s.sessionId === id ? { ...s, customName } : s));
      }
      // Row-only session — carry its merged view into the snapshot so the
      // memo re-renders the renamed row immediately (no-op if it vanished).
      const live = sessions.find((s) => s.sessionId === id);
      if (!live) return prev;
      return [...prev, { ...live, customName }];
    });
  }, [sessions]);

  return {
    sessions,
    filteredSessions,
    selectedSessionId,
    selectSession,
    followSession,
    deleteSession,
    renameSession,
    refreshSessions,
    searchFilter,
    setSearchFilter,
    userPickedRef,
  };
}
