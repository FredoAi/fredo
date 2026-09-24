import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Flex, VisuallyHidden } from '@chakra-ui/react';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { ensureTerminalSettingsMigrated } from '../settings';
import {
  COPILOT_AUTH_COMMAND,
  STATUS_LABEL,
  sessionTitle,
  type TerminalCli,
  type TerminalSessionInfo,
} from '../sessionModel';
import { SessionSidebar } from './SessionSidebar';
import { TerminalPane } from './TerminalPane';
import { NewSessionDialog } from './NewSessionDialog';

/** Client-only ids for optimistic rows the backend has not created (yet). */
const PENDING_PREFIX = 'pending-';

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
  cli: TerminalCli | null;
  workDir: string | null;
  replaceId: string | null;
}

/**
 * TerminalWindow — the root of the single `terminal` window (Spec #2934 ST-3).
 *
 * Owns the session list (mount-time `list_terminal_sessions` + live
 * `terminal-sessions-changed`/`terminal-exited`), the selection, and the
 * per-session actions. Switching only flips `selectedId` — it never spawns,
 * kills, or remounts anything (AC2/NFR).
 */
export const TerminalWindow: React.FC = () => {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [pending, setPending] = useState<TerminalSessionInfo[]>([]);
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
  const promptedRef = useRef(false);

  const allSessions = useMemo(() => [...sessions, ...pending], [sessions, pending]);
  const selected = useMemo(
    () => allSessions.find((s) => s.id === selectedId) ?? null,
    [allSessions, selectedId],
  );
  const allExited = allSessions.length > 0 && allSessions.every((s) => s.status === 'exited');

  // ── Mount: idempotent migration, mount-time truth, live listeners ──────────
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<Promise<() => void>> = [];

    const refresh = async () => {
      try {
        const list = await adapterBridge.invoke<TerminalSessionInfo[]>('list_terminal_sessions');
        if (cancelled || !list) return;
        setSessions(list);
      } catch {
        /* window is open — keep the last known list */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };

    void ensureTerminalSettingsMigrated().then(refresh);

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
    );

    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, []);

  // ── Keep a valid selection ─────────────────────────────────────────────────
  useEffect(() => {
    if (selectedId && allSessions.some((s) => s.id === selectedId)) return;
    const next =
      allSessions.find((s) => s.status === 'running') ??
      allSessions.find((s) => s.status === 'starting') ??
      allSessions[0];
    setSelectedId(next ? next.id : null);
  }, [allSessions, selectedId]);

  // ── A launch with an empty window IS "adding a session" — prompt on open ────
  useEffect(() => {
    if (!loaded || promptedRef.current) return;
    promptedRef.current = true;
    if (allSessions.length === 0) setDialogOpen(true);
  }, [loaded, allSessions.length]);

  // ── Doherty ≥10s hint for a session stuck in `starting` ─────────────────────
  useEffect(() => {
    if (selected?.status !== 'starting') {
      setSlowStartingId((prev) => (prev === selected?.id ? null : prev));
      return;
    }
    const timer = window.setTimeout(() => setSlowStartingId(selected.id), 10000);
    return () => window.clearTimeout(timer);
  }, [selected?.id, selected?.status]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleFirstOutput = useCallback((sessionId: string) => {
    setOutputSeen((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: true }));
  }, []);

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

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

  const spawnSession = useCallback(async (cli: TerminalCli, workDir: string) => {
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
      const realId = await adapterBridge.invoke<string>('spawn_terminal_session', {
        cli,
        workDir: workDir || undefined,
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

  const openDialog = useCallback(
    (opts?: { cli?: TerminalCli | null; workDir?: string | null; replaceId?: string | null }) => {
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
    (cli: TerminalCli, workDir: string) => {
      const replaceId = dialogInit.replaceId;
      setDialogOpen(false);
      if (replaceId) {
        const target = allSessions.find((s) => s.id === replaceId);
        if (target) closeSession(target);
      }
      void spawnSession(cli, workDir);
    },
    [dialogInit.replaceId, allSessions, closeSession, spawnSession],
  );

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

  const announcement = selected
    ? `${sessionTitle(selected, allSessions)}, ${STATUS_LABEL[selected.status]}`
    : '';

  return (
    <Flex direction="row" h="100%" bg="bg.canvas">
      <SessionSidebar
        sessions={allSessions}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={closeSession}
        onAdd={() => openDialog()}
      />
      <TerminalPane
        sessions={allSessions}
        selected={selected}
        allExited={allExited}
        outputSeen={outputSeen}
        slowStarting={!!selected && slowStartingId === selected.id}
        onFirstOutput={handleFirstOutput}
        onClose={closeSession}
        onRetry={handleRetry}
        onChooseDirectory={handleChooseDirectory}
        onCopyCommand={handleCopyCommand}
        onAdd={() => openDialog()}
      />
      <NewSessionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={handleConfirm}
        initialCli={dialogInit.cli}
        initialWorkDir={dialogInit.workDir}
      />
      <VisuallyHidden aria-live="polite">{announcement}</VisuallyHidden>
    </Flex>
  );
};
