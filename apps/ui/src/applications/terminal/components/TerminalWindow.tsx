import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Flex, Icon, Text, VisuallyHidden } from '@chakra-ui/react';
import { LuCircleCheck, LuKeyboard } from 'react-icons/lu';
import { Keycap } from '../../../shared/components/hotkeys/Keycap';
import {
  TERMINAL_PASSTHROUGH_TESTID,
  TERMINAL_RELEASE_TESTID,
  exitTerminalPassthrough,
  installTerminalPassthrough,
  useTerminalPassthrough,
} from '../../../shared/hotkeys/terminalMode';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { ensureTerminalSettingsMigrated } from '../settings';
import { TERMINAL_INTENT_AVAILABLE_EVENT } from '../presentation';
import {
  COPILOT_AUTH_COMMAND,
  RENAME_EMPTY_MESSAGE,
  STATUS_LABEL,
  normalizeKind,
  resumeBlockedReason,
  sessionDisplayTitle,
  sortPersistedSessions,
  type PersistedTerminalSession,
  type PreviousSessionState,
  type RenameResult,
  type ResumeBlockedReason,
  type ResumeResult,
  type TerminalSessionKind,
  type TerminalSessionInfo,
} from '../sessionModel';
import { TerminalSidebar } from './TerminalSidebar';
import { TerminalPane } from './TerminalPane';
import { NewSessionDialog } from './NewSessionDialog';
import { DeleteSessionDialog } from './ResumableSessions';

/** Client-only ids for optimistic rows the backend has not created (yet). */
const PENDING_PREFIX = 'pending-';

/**
 * Client watchdog behind the backend's bounded 5 s resume pre-flight: if the
 * `resume_terminal_session` promise has not settled by then the pane flips to
 * `resume-failed` with a Retry — the resume surface can never hang (UI/UX §5b).
 */
const RESUME_WATCHDOG_MS = 15000;

/**
 * A `fredo open-terminal` launch intent (`terminal-open-request`) is emitted
 * AFTER the window exists and spawns directly (zero-mouse). This grace lets the
 * intent arrive before the "nothing live, nothing persisted" add-session prompt
 * fires, so a launch is never intercepted by the dialog.
 */
const LAUNCH_INTENT_GRACE_MS = 300;

function newPendingId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${PENDING_PREFIX}${uuid}`;
}

function isRealSession(session: TerminalSessionInfo): boolean {
  return !session.id.startsWith(PENDING_PREFIX);
}

interface DialogInit {
  cli: TerminalSessionKind | null;
  workDir: string | null;
  replaceId: string | null;
}

/**
 * TerminalWindow — the root of the single `terminal` window (Spec 2934 ST-3,
 * extended by Spec 2935).
 *
 * Owns the live session list (mount-time `list_terminal_sessions` + live
 * `terminal-sessions-changed`/`terminal-exited`) AND the persisted records
 * (`list_persisted_terminal_sessions` + `terminal-persisted-sessions-changed`),
 * the selection, and every per-entry action. A persisted record is a session
 * with no process this window; resuming it REUSES the record's id, so it simply
 * moves from the Previous group to This window (never both — SI adjudication).
 * Nothing is auto-resumed on mount.
 */
export const TerminalWindow: React.FC = () => {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [pending, setPending] = useState<TerminalSessionInfo[]>([]);
  const [persisted, setPersisted] = useState<PersistedTerminalSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outputSeen, setOutputSeen] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInit, setDialogInit] = useState<DialogInit>({
    cli: null,
    workDir: null,
    replaceId: null,
  });
  const [slowStartingId, setSlowStartingId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [resumeFailures, setResumeFailures] = useState<Record<string, ResumeBlockedReason>>({});
  const [resumeMessages, setResumeMessages] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<PersistedTerminalSession | null>(null);
  const [actionAnnouncement, setActionAnnouncement] = useState('');
  const [focusTarget, setFocusTarget] = useState<string | null | undefined>(undefined);

  const promptedRef = useRef(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  // Guards against a late/abandoned resume result clobbering newer UI state
  // (Cancel / watchdog bump the token).
  const resumeTokenRef = useRef(0);
  // Spec #2942 ST-5: the pane grid the UI last applied. Passed into the NEXT
  // spawn/resume so the PTY is born at pane size (the "OpenCode TUI doesn't
  // fill the pane" root cause: it used to be born at a hardcoded 80×24 and only
  // corrected on a CHANGED grid). A ref — not state — so a fit receipt never
  // re-renders the window; `null` on a cold mount keeps the backend default.
  const lastGridRef = useRef<{ cols: number; rows: number } | null>(null);

  // Spec #2946 ST-12 — the continuous terminal-passthrough state (R-5.7/R-5.8).
  // Focus tracking + the exit-chord handler; NO second keydown listener.
  const passthrough = useTerminalPassthrough();

  // ── Derived model ──────────────────────────────────────────────────────────
  const allSessions = useMemo(() => [...sessions, ...pending], [sessions, pending]);
  const liveIds = useMemo(() => new Set(allSessions.map((s) => s.id)), [allSessions]);
  /** Persisted records with no process in THIS window (newest first). */
  const previous = useMemo(
    () => persisted.filter((r) => !liveIds.has(r.id)),
    [persisted, liveIds],
  );
  /**
   * EVERY persisted record by id (including live sessions' records) — the single
   * source of truth for a session's name (Spec #2942 ST-3, SA §4). A live row
   * resolves its name here, so ONE rename updates the live row AND the
   * previous-session row (they share the record's id).
   */
  const persistedById = useMemo(
    () => new Map(persisted.map((r) => [r.id, r])),
    [persisted],
  );
  const selected = useMemo(
    () => allSessions.find((s) => s.id === selectedId) ?? null,
    [allSessions, selectedId],
  );
  const selectedRecord = useMemo(
    () => previous.find((r) => r.id === selectedId) ?? null,
    [previous, selectedId],
  );
  // Window-level "all ended" is true only when NOTHING is left to resume — with a
  // persisted record present the per-session ended banner shows instead and the
  // resumable record is not masked (UI/UX §6).
  const allExited =
    allSessions.length > 0 && allSessions.every((s) => s.status === 'exited') && previous.length === 0;

  const previousStateOf = useCallback(
    (record: PersistedTerminalSession): PreviousSessionState => {
      if (resumingId === record.id) return 'resuming';
      const reason = resumeFailures[record.id];
      if (reason === 'cli-missing') return 'unresumable';
      if (reason) return 'resume-failed';
      return 'resumable';
    },
    [resumingId, resumeFailures],
  );

  const resumeFailure = useMemo(() => {
    if (!selectedRecord) return null;
    const reason = resumeFailures[selectedRecord.id];
    if (!reason) return null;
    return { reason, message: resumeMessages[selectedRecord.id] ?? '' };
  }, [selectedRecord, resumeFailures, resumeMessages]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleFirstOutput = useCallback((sessionId: string) => {
    setOutputSeen((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: true }));
  }, []);

  // Spec #2942 ST-5 (iii): keep the last-good grid for the next spawn/resume.
  const handleGridChange = useCallback((cols: number, rows: number) => {
    lastGridRef.current = { cols, rows };
  }, []);

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  /**
   * Rename a persisted session record (Spec #2942 ST-3, R-2.1–R-2.5).
   *
   * The name is the ONLY editable field. A blank / whitespace-only name is
   * refused BEFORE any write (R-2.3): the row reverts to the prior name and
   * shows the inline error. Otherwise the record map is patched optimistically
   * — which renames the live row AND the previous-session row at once (they
   * share the record's id) — and the atomic backend UPDATE is reconciled by the
   * `terminal-persisted-sessions-changed` listener. No session is ended, no PTY
   * touched: this is a metadata-only write.
   */
  const handleRename = useCallback(
    async (id: string, name: string): Promise<RenameResult> => {
      const trimmed = name.trim();
      if (!trimmed) {
        setActionAnnouncement(RENAME_EMPTY_MESSAGE);
        return { ok: false, message: RENAME_EMPTY_MESSAGE };
      }
      const prior = persisted.find((r) => r.id === id)?.title;
      setPersisted((prev) => prev.map((r) => (r.id === id ? { ...r, title: trimmed } : r)));
      try {
        await adapterBridge.invoke('rename_terminal_session_record', {
          sessionId: id,
          name: trimmed,
        });
        setActionAnnouncement(`Renamed to ${trimmed}`);
        return { ok: true };
      } catch {
        // Roll the optimistic patch back; the next persisted-list event is the
        // backend truth either way.
        if (prior !== undefined) {
          setPersisted((prev) => prev.map((r) => (r.id === id ? { ...r, title: prior } : r)));
        }
        setActionAnnouncement("Couldn't rename this session");
        return { ok: false, message: "Couldn't rename this session" };
      }
    },
    [persisted],
  );

  const closeSession = useCallback((session: TerminalSessionInfo) => {
    const real = isRealSession(session);
    setPending((prev) => prev.filter((s) => s.id !== session.id));
    setSessions((prev) => prev.filter((s) => s.id !== session.id));
    setOutputSeen((prev) => {
      if (!(session.id in prev)) return prev;
      const next = { ...prev };
      delete next[session.id];
      return next;
    });
    if (real) {
      adapterBridge.invoke('close_terminal_session', { sessionId: session.id }).catch(() => {});
    }
  }, []);

  const spawnSession = useCallback(async (cli: TerminalSessionKind, workDir: string) => {
    const tempId = newPendingId();
    const optimistic: TerminalSessionInfo = {
      id: tempId,
      cli,
      status: 'starting',
      error: null,
      errorKind: null,
      workDir,
      cols: 80,
      rows: 24,
      pid: null,
      startedAt: Date.now(),
    };
    setPending((prev) => [...prev, optimistic]);
    setSelectedId(tempId);
    try {
      // Spec #2942 ST-5 (i): spawn the PTY at the pane grid the UI last applied
      // (undefined on a cold mount → the backend's 80×24 default; the settling
      // resize in `SessionTerminal` then corrects it).
      const grid = lastGridRef.current;
      const realId = await adapterBridge.invoke<string>('spawn_terminal_session', {
        cli,
        workDir: workDir || undefined,
        cols: grid?.cols,
        rows: grid?.rows,
      });
      setPending((prev) => prev.filter((s) => s.id !== tempId));
      if (realId) {
        setSelectedId((prev) => (prev === tempId ? realId : prev));
        const list = await adapterBridge.invoke<TerminalSessionInfo[]>('list_terminal_sessions');
        if (list) setSessions(list);
      }
    } catch (err) {
      setPending((prev) =>
        prev.map((s) =>
          s.id === tempId
            ? { ...s, status: 'error' as const, error: String(err), errorKind: 'generic' as const }
            : s,
        ),
      );
    }
  }, []);

  /** Remove a persisted record (Fredo's record only — the CLI transcript stays). */
  const removeRecord = useCallback(async (id: string) => {
    setPersisted((prev) => prev.filter((r) => r.id !== id));
    try {
      await adapterBridge.invoke('delete_terminal_session_record', { sessionId: id });
    } catch {
      /* the record list is the source of truth on the next refresh */
    }
    try {
      const records = await adapterBridge.invoke<PersistedTerminalSession[]>(
        'list_persisted_terminal_sessions',
      );
      if (records) setPersisted(sortPersistedSessions(records));
    } catch {
      /* keep the optimistic removal */
    }
  }, []);

  const handleResume = useCallback(async (record: PersistedTerminalSession) => {
    const token = ++resumeTokenRef.current;
    setResumeFailures((prev) => {
      if (!(record.id in prev)) return prev;
      const next = { ...prev };
      delete next[record.id];
      return next;
    });
    setResumeMessages((prev) => {
      if (!(record.id in prev)) return prev;
      const next = { ...prev };
      delete next[record.id];
      return next;
    });
    setResumingId(record.id);
    setActionAnnouncement(`Resuming ${record.title}`);
    try {
      // Spec #2942 ST-5 (i): a resumed PTY is born at the pane grid too.
      const grid = lastGridRef.current;
      const result = await adapterBridge.invoke<ResumeResult>('resume_terminal_session', {
        sessionId: record.id,
        cols: grid?.cols,
        rows: grid?.rows,
      });
      if (token !== resumeTokenRef.current) return; // cancelled / superseded
      if (result && result.outcome === 'resumed') {
        const liveId = result.sessionId ?? record.id;
        const list = await adapterBridge.invoke<TerminalSessionInfo[]>('list_terminal_sessions');
        if (token !== resumeTokenRef.current) return;
        if (list) setSessions(list);
        setSelectedId(liveId);
        setResumingId(null);
        setActionAnnouncement(`${record.title} resumed`);
      } else {
        const reason = result ? resumeBlockedReason(result.outcome) ?? 'resume-failed' : 'resume-failed';
        setResumeFailures((prev) => ({ ...prev, [record.id]: reason }));
        setResumeMessages((prev) => ({ ...prev, [record.id]: result?.message ?? '' }));
        setResumingId(null);
        setActionAnnouncement(`Couldn't resume ${record.title}`);
      }
    } catch (err) {
      if (token !== resumeTokenRef.current) return;
      setResumeFailures((prev) => ({ ...prev, [record.id]: 'resume-failed' }));
      setResumeMessages((prev) => ({ ...prev, [record.id]: String(err) }));
      setResumingId(null);
      setActionAnnouncement(`Couldn't resume ${record.title}`);
    }
  }, []);

  const handleCancelResume = useCallback(() => {
    resumeTokenRef.current++;
    setResumingId(null);
  }, []);

  const openDialog = useCallback(
    (opts?: { cli?: TerminalSessionKind | null; workDir?: string | null; replaceId?: string | null }) => {
      setDialogInit({
        cli: opts?.cli ?? null,
        workDir: opts?.workDir ?? null,
        replaceId: opts?.replaceId ?? null,
      });
      setDialogOpen(true);
    },
    [],
  );

  const handleConfirm = useCallback(
    (cli: TerminalSessionKind, workDir: string) => {
      const replaceId = dialogInit.replaceId;
      setDialogOpen(false);
      if (replaceId) {
        const live = allSessions.find((s) => s.id === replaceId);
        if (live) closeSession(live);
        else if (persisted.some((r) => r.id === replaceId)) void removeRecord(replaceId);
      }
      void spawnSession(cli, workDir);
    },
    [dialogInit.replaceId, allSessions, persisted, closeSession, removeRecord, spawnSession],
  );

  const handleStartFresh = useCallback(
    (record: PersistedTerminalSession) => {
      openDialog({ cli: record.cli, workDir: record.workDir, replaceId: record.id });
    },
    [openDialog],
  );

  const handleDeleteRequest = useCallback((record: PersistedTerminalSession) => {
    setDeleteTarget(record);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    const record = deleteTarget;
    setDeleteTarget(null);
    if (!record) return;
    const rest = previous.filter((r) => r.id !== record.id);
    const next = rest[0] ?? allSessions[0] ?? null;
    setFocusTarget(next ? next.id : null);
    setResumeFailures((prev) => {
      if (!(record.id in prev)) return prev;
      const copy = { ...prev };
      delete copy[record.id];
      return copy;
    });
    setResumeMessages((prev) => {
      if (!(record.id in prev)) return prev;
      const copy = { ...prev };
      delete copy[record.id];
      return copy;
    });
    setActionAnnouncement(`${record.title} removed`);
    await removeRecord(record.id);
  }, [deleteTarget, previous, allSessions, removeRecord]);

  const handleRetry = useCallback(
    (session: TerminalSessionInfo) => {
      closeSession(session);
      void spawnSession(session.cli, session.workDir);
    },
    [closeSession, spawnSession],
  );

  const handleChooseDirectory = useCallback(
    (session: TerminalSessionInfo) => {
      openDialog({ cli: session.cli, workDir: session.workDir, replaceId: session.id });
    },
    [openDialog],
  );

  const handleCopyCommand = useCallback(() => {
    void navigator.clipboard?.writeText(COPILOT_AUTH_COMMAND).catch(() => {});
  }, []);

  // Spec #2946 ST-12 — install terminal passthrough tracking for this webview.
  // Idempotent; installs focus listeners + the exit-chord handler only (the ONE
  // document keydown listener stays owned by the ST-4 engine).
  useEffect(() => installTerminalPassthrough(), []);

  // ── Mount: idempotent migration, mount-time truth, live listeners ──────────
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<Promise<() => void>> = [];

    const refresh = async () => {
      const [sessionsResult, recordsResult] = await Promise.allSettled([
        adapterBridge.invoke<TerminalSessionInfo[]>('list_terminal_sessions'),
        adapterBridge.invoke<PersistedTerminalSession[]>('list_persisted_terminal_sessions'),
      ]);
      if (cancelled) return;
      if (sessionsResult.status === 'fulfilled' && sessionsResult.value) {
        setSessions(sessionsResult.value);
      }
      if (recordsResult.status === 'fulfilled' && recordsResult.value) {
        setPersisted(sortPersistedSessions(recordsResult.value));
      }
      setLoaded(true);
    };

    unlisteners.push(
      adapterBridge.listen<{ sessions: TerminalSessionInfo[] }>(
        'terminal-sessions-changed',
        (ev) => {
          if (ev?.sessions) setSessions(ev.sessions);
        },
      ),
      adapterBridge.listen<{ sessionId: string }>('terminal-exited', (ev) => {
        if (!ev?.sessionId) return;
        setSessions((prev) =>
          prev.map((s) => (s.id === ev.sessionId ? { ...s, status: 'exited' } : s)),
        );
      }),
      adapterBridge.listen<{ sessions: PersistedTerminalSession[] }>(
        'terminal-persisted-sessions-changed',
        (ev) => {
          if (ev?.sessions) setPersisted(sortPersistedSessions(ev.sessions));
        },
      ),
      // Launch intent from `fredo open-terminal` (SI adjudication: the event works
      // for a created AND a reused window). The backend validated cli/dir before
      // opening, so this always spawns directly — no dialog, auto-selected.
      adapterBridge.listen<{ cli?: string; workDir?: string }>('terminal-open-request', (ev) => {
        if (!ev) return;
        void spawnSession(normalizeKind(ev.cli), ev.workDir ?? '');
      }),
      // Spec #2947 ST-4 — WARM-path intent drain (R-4.2). ST-5 emits
      // `terminal-intent-available` to the active host when a same-window CLI
      // launch confirms `opened`. If this workspace is ALREADY mounted, its mount
      // refresh above has long since consumed the one-shot `PendingTerminalOpen`,
      // so re-invoking `list_terminal_sessions` IS the backend drain handshake:
      // it `take()`s the armed intent and emits `terminal-open-request` over the
      // listener registered just above — the SAME single spawner. No direct spawn
      // here, no second spawner, and `take()` stays one-shot so a reload/later
      // list call (or the cold path) can never double-spawn. Registered with the
      // existing set, BEFORE the mount refresh below.
      adapterBridge.listen(TERMINAL_INTENT_AVAILABLE_EVENT, () => {
        void adapterBridge
          .invoke<TerminalSessionInfo[]>('list_terminal_sessions')
          .catch(() => {});
      }),
    );

    // Spec #2940 ST-9: register EVERY listener BEFORE the mount refresh, so
    // `refresh`'s `list_terminal_sessions` — the backend mount handshake that
    // drains a cold-launch intent — provably runs after the listener is live.
    // Each `adapterBridge.listen` promise resolves only once the Rust
    // `plugin:event|listen` completes, so this ordering is a guarantee, not a
    // timing hope (a cold intent delivered before the listener is registered
    // would be dropped).
    void Promise.all(unlisteners)
      .then(() => ensureTerminalSettingsMigrated().catch(() => {}))
      .then(refresh);

    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [spawnSession]);

  // ── Keep a valid selection (live first, then the most-recent record) ────────
  useEffect(() => {
    if (
      selectedId &&
      (allSessions.some((s) => s.id === selectedId) || previous.some((r) => r.id === selectedId))
    ) {
      return;
    }
    const next =
      allSessions.find((s) => s.status === 'running') ??
      allSessions.find((s) => s.status === 'starting') ??
      allSessions[0] ??
      previous[0] ??
      null;
    setSelectedId(next ? next.id : null);
  }, [allSessions, previous, selectedId]);

  // ── A launch with an empty window IS "adding a session" — prompt on open, but
  //    NEVER when persisted records exist to resume (UI/UX §6 / R-5.2), and never
  //    before a `fredo open-terminal` launch intent has had the grace window to
  //    arrive (an intent spawns directly — the prompt must not steal that). ─────
  useEffect(() => {
    if (!loaded || promptedRef.current) return;
    if (allSessions.length > 0 || previous.length > 0) return;
    const timer = window.setTimeout(() => {
      if (promptedRef.current) return;
      if (allSessions.length > 0 || previous.length > 0) return;
      promptedRef.current = true;
      setDialogOpen(true);
    }, LAUNCH_INTENT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [loaded, allSessions.length, previous.length]);

  // ── Doherty ≥10s hint for a session stuck in `starting` ─────────────────────
  useEffect(() => {
    if (selected?.status !== 'starting') {
      setSlowStartingId((prev) => (prev === selected?.id ? null : prev));
      return;
    }
    const timer = window.setTimeout(() => setSlowStartingId(selected.id), 10000);
    return () => window.clearTimeout(timer);
  }, [selected?.id, selected?.status]);

  // ── Resume watchdog: bounded surface, never an unbounded spinner ────────────
  useEffect(() => {
    if (!resumingId) return;
    const id = resumingId;
    const timer = window.setTimeout(() => {
      resumeTokenRef.current++; // ignore a late resolution
      setResumeFailures((prev) => ({ ...prev, [id]: 'resume-failed' as const }));
      setResumeMessages((prev) => ({
        ...prev,
        [id]: 'Resume timed out. The session record is unchanged.',
      }));
      setResumingId(null);
      setActionAnnouncement("Couldn't resume this session");
    }, RESUME_WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [resumingId]);

  // ── Focus restoration after Delete (next row, else "Add session") ───────────
  useEffect(() => {
    if (focusTarget === undefined) return;
    const target = focusTarget;
    const raf = requestAnimationFrame(() => {
      const node = target
        ? document.querySelector<HTMLElement>(
            `[data-testid="terminal-previous-session-row-${target}"], [data-testid="terminal-session-row-${target}"]`,
          )
        : null;
      const focusable = node?.matches('button') ? node : node?.querySelector<HTMLElement>('button');
      (focusable ?? addButtonRef.current)?.focus();
      setFocusTarget(undefined);
    });
    return () => cancelAnimationFrame(raf);
  }, [focusTarget]);

  const statusAnnouncement = selected
    ? `${sessionDisplayTitle(selected, allSessions, persistedById)}, ${STATUS_LABEL[selected.status]}`
    : selectedRecord
      ? `${selectedRecord.title}, ${statusLabelForState(previousStateOf(selectedRecord))}`
      : '';
  const announcement = actionAnnouncement || statusAnnouncement;

  return (
    <Flex direction="row" h="100%" minH={0} w="100%" bg="bg.canvas" position="relative">
      <TerminalSidebar
        sessions={allSessions}
        previous={previous}
        persistedById={persistedById}
        selectedId={selectedId}
        previousStateOf={previousStateOf}
        onSelect={handleSelect}
        onClose={closeSession}
        onRename={handleRename}
        onAdd={() => openDialog()}
        addButtonRef={addButtonRef}
      />
      <TerminalPane
        sessions={allSessions}
        previous={previous}
        selected={selected}
        selectedRecord={selectedRecord}
        allExited={allExited}
        outputSeen={outputSeen}
        slowStarting={!!selected && slowStartingId === selected.id}
        resumingId={resumingId}
        resumeFailure={resumeFailure}
        onFirstOutput={handleFirstOutput}
        onGridChange={handleGridChange}
        onClose={closeSession}
        onRetry={handleRetry}
        onChooseDirectory={handleChooseDirectory}
        onCopyCommand={handleCopyCommand}
        onResume={handleResume}
        onRetryResume={handleResume}
        onCancelResume={handleCancelResume}
        onStartFresh={handleStartFresh}
        onDelete={handleDeleteRequest}
        onAdd={() => openDialog()}
      />
      {/* Spec #2946 ST-12 — the PERSISTENT passthrough indicator (R-5.8). It is
          terminal chrome (OUTSIDE the `data-fredo-terminal-root` session root),
          so activating its real release button moves focus out of the terminal
          session and resumes dispatch immediately. */}
      {selected && (
        <TerminalPassthroughIndicator
          active={passthrough.active}
          exitChord={passthrough.exitChord}
        />
      )}
      <NewSessionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={handleConfirm}
        initialCli={dialogInit.cli}
        initialWorkDir={dialogInit.workDir}
      />
      <DeleteSessionDialog
        record={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={() => void handleDeleteConfirm()}
      />
      <VisuallyHidden aria-live="polite">{announcement}</VisuallyHidden>
    </Flex>
  );
};

export interface TerminalPassthroughIndicatorProps {
  /** Passthrough is active — the terminal session owns the keyboard. */
  readonly active: boolean;
  /** The effective exit binding (`ctrl+shift+f10` unless rebound). */
  readonly exitChord: string | null;
}

/**
 * Spec #2946 ST-12 — the persistent, non-colour-only passthrough indicator
 * (R-5.8; UI/UX §6).
 *
 * A terminal-chrome pill that names the exit chord with the shared `Keycap` and
 * carries a REAL `<button>` (`hotkeys-terminal-passthrough-exit`) so an AT user
 * can release the keyboard even mid-passthrough. The state is conveyed by an
 * icon + a text swap (`Passthrough` → `Hotkeys active`), never by colour alone.
 * It lives OUTSIDE the `data-fredo-terminal-root` session root so activating it
 * leaves passthrough; it is present in every passthrough state (never a toast).
 */
export const TerminalPassthroughIndicator: React.FC<TerminalPassthroughIndicatorProps> = ({
  active,
  exitChord,
}) => {
  const StateIcon = active ? LuKeyboard : LuCircleCheck;
  const stateLabel = active ? 'Passthrough' : 'Hotkeys active';
  return (
    <Flex
      data-testid={TERMINAL_PASSTHROUGH_TESTID}
      data-passthrough={active ? 'true' : 'false'}
      role="group"
      aria-label={`Terminal keyboard mode: ${stateLabel}`}
      position="absolute"
      top="3"
      right="3"
      zIndex={20}
      align="center"
      gap="2"
      px="2"
      py="1"
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="md"
      boxShadow="var(--shadow-dialog)"
    >
      <Icon
        as={StateIcon}
        aria-hidden="true"
        boxSize="14px"
        color={active ? 'accent.fg' : 'status.success'}
      />
      <Text fontSize="xs" fontWeight="medium" color="fg.default" whiteSpace="nowrap">
        {stateLabel}
      </Text>
      {exitChord && <Keycap sequence={exitChord} />}
      <Button
        type="button"
        size="xs"
        variant="solid"
        colorPalette="accent"
        data-testid={TERMINAL_RELEASE_TESTID}
        onClick={exitTerminalPassthrough}
      >
        Release keyboard
      </Button>
    </Flex>
  );
};

function statusLabelForState(state: PreviousSessionState): string {
  switch (state) {
    case 'resuming':
      return STATUS_LABEL.starting;
    case 'unresumable':
    case 'resume-failed':
      return 'error';
    default:
      return 'exited';
  }
}
