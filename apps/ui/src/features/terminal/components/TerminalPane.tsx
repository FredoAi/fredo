import React, { useState } from 'react';
import { Box } from '@chakra-ui/react';
import {
  sessionTitle,
  type PersistedTerminalSession,
  type ResumeBlockedReason,
  type TerminalSessionInfo,
} from '../sessionModel';
import { SessionTerminal } from './SessionTerminal';
import {
  AllEndedState,
  EmptySessionsState,
  SessionEndedBanner,
  SessionErrorState,
  StartingState,
} from './TerminalSessionView';
import {
  ResumeBlockedState,
  ResumeSessionState,
  ResumingState,
} from './ResumableSessions';

/** The C-3 `terminal-pane` `data-surface` vocabulary (UI/UX §6). */
export type TerminalPaneSurface =
  | 'terminal'
  | 'empty'
  | 'all-ended'
  | 'starting'
  | 'error'
  | 'ended'
  | 'resume'
  | 'resuming'
  | 'resume-blocked';

interface TerminalPaneProps {
  sessions: readonly TerminalSessionInfo[];
  previous: readonly PersistedTerminalSession[];
  selected: TerminalSessionInfo | null;
  /** The selected entry is a persisted record (no process this window). */
  selectedRecord: PersistedTerminalSession | null;
  /** Every session in the window has exited (explicit window-level state). */
  allExited: boolean;
  /** sessionId -> a PTY byte has arrived (live or replayed). */
  outputSeen: Record<string, boolean>;
  /** The selected session has been `starting` for longer than the Doherty bound. */
  slowStarting: boolean;
  /** A resume is in flight for this record id. */
  resumingId: string | null;
  /** The selected record's last failed resume (null while none). */
  resumeFailure: { reason: ResumeBlockedReason; message: string } | null;
  onFirstOutput: (sessionId: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
  onRetry: (session: TerminalSessionInfo) => void;
  onChooseDirectory: (session: TerminalSessionInfo) => void;
  onCopyCommand: (session: TerminalSessionInfo) => void;
  onResume: (record: PersistedTerminalSession) => void;
  onRetryResume: (record: PersistedTerminalSession) => void;
  onCancelResume: () => void;
  onStartFresh: (record: PersistedTerminalSession) => void;
  onDelete: (record: PersistedTerminalSession) => void;
  onAdd: () => void;
}

/** The last fit receipt for a session (C-2). */
interface FitReceipt {
  sessionId: string;
  cols: number;
  rows: number;
}

/**
 * TerminalPane — the dominant `terminal-pane` region (Spec 2940 ST-3, UI/UX §2).
 *
 * It is the ONLY `flex=1 / minH=0 / minW=0` child of the window root, so it
 * absorbs all remaining height under the 44 px `SessionBar` — there is no dead
 * area. It hosts the stacked terminals (one mounted instance per live session,
 * visibility-toggled, never unmounted), the window-level state surfaces
 * (empty / all-ended), the per-session surfaces (starting / error / ended) and
 * the persisted-record surfaces (resume / resuming / blocked).
 *
 * C-2/C-3 hooks: `data-surface` names the surface currently painted;
 * `data-cols`/`data-rows` carry the ACTIVE session's last fit receipt
 * (`SessionTerminal.onFit`, passed for the active session only — no new IPC).
 * The Spec 2935 re-gated rules hold: Empty renders only when BOTH groups are
 * empty, and "All sessions ended" only when no persisted record remains.
 */
export const TerminalPane: React.FC<TerminalPaneProps> = ({
  sessions,
  previous,
  selected,
  selectedRecord,
  allExited,
  outputSeen,
  slowStarting,
  resumingId,
  resumeFailure,
  onFirstOutput,
  onClose,
  onRetry,
  onChooseDirectory,
  onCopyCommand,
  onResume,
  onRetryResume,
  onCancelResume,
  onStartFresh,
  onDelete,
  onAdd,
}) => {
  const [fit, setFit] = useState<FitReceipt | null>(null);

  const mounted = sessions.filter((s) => s.status === 'running' || s.status === 'exited');
  const selectedTitle = selected
    ? sessionTitle(selected, sessions)
    : selectedRecord?.title ?? 'Terminal';

  // The starting overlay spans `starting` AND the `running`-before-first-byte
  // window (first byte fades it). It is input-blocking only while `starting`.
  const showStartingOverlay =
    !!selected &&
    !allExited &&
    (selected.status === 'starting' ||
      (selected.status === 'running' && !outputSeen[selected.id]));

  const isResuming = !!selectedRecord && resumingId === selectedRecord.id;

  // Which surface is on top — the deterministic C-3 assertion, mirroring the
  // render conditions below exactly.
  let surface: TerminalPaneSurface;
  if (selectedRecord) {
    surface = isResuming ? 'resuming' : resumeFailure ? 'resume-blocked' : 'resume';
  } else if (sessions.length === 0 && previous.length === 0) {
    surface = 'empty';
  } else if (sessions.length > 0 && allExited && previous.length === 0) {
    surface = 'all-ended';
  } else if (selected) {
    surface = showStartingOverlay
      ? 'starting'
      : selected.status === 'error'
        ? 'error'
        : selected.status === 'exited'
          ? 'ended'
          : 'terminal';
  } else {
    surface = 'empty';
  }

  // Only the ACTIVE session's receipt stamps the pane.
  const activeId = selected?.id ?? null;
  const activeFit = fit && fit.sessionId === activeId ? fit : null;

  return (
    <Box
      data-testid="terminal-pane"
      flex={1}
      minH={0}
      minW={0}
      position="relative"
      overflow="hidden"
      role="region"
      aria-label={`${selectedTitle} terminal`}
      data-surface={surface}
      data-cols={activeFit ? activeFit.cols : undefined}
      data-rows={activeFit ? activeFit.rows : undefined}
    >
      {/* One terminal instance per session, mounted once and hidden (never
          unmounted / display:none) while inactive — switching loses no
          scrollback and never re-inits. */}
      {mounted.map((session) => {
        const isActive = selected?.id === session.id;
        return (
          <Box
            key={session.id}
            position="absolute"
            inset={0}
            visibility={isActive ? 'visible' : 'hidden'}
            pointerEvents={isActive ? 'auto' : 'none'}
            data-testid={`terminal-surface-${session.id}`}
            data-active={isActive ? 'true' : 'false'}
          >
            <SessionTerminal
              sessionId={session.id}
              active={isActive}
              onFirstOutput={onFirstOutput}
              onFit={
                isActive
                  ? (cols: number, rows: number) => setFit({ sessionId: session.id, cols, rows })
                  : undefined
              }
            />
          </Box>
        );
      })}

      {/* Empty only when there is nothing live AND nothing persisted to resume. */}
      {sessions.length === 0 && previous.length === 0 && <EmptySessionsState onAdd={onAdd} />}

      {/* "All sessions ended" must not mask resumable records (UI/UX §6). */}
      {sessions.length > 0 && allExited && previous.length === 0 && (
        <AllEndedState onAdd={onAdd} />
      )}

      {showStartingOverlay && selected && (
        <StartingState
          session={selected}
          showSlowHint={slowStarting}
          blocking={selected.status === 'starting'}
          onClose={() => onClose(selected)}
        />
      )}

      {selected && !allExited && selected.status === 'error' && (
        <SessionErrorState
          session={selected}
          handlers={{
            onRetry: () => onRetry(selected),
            onClose: () => onClose(selected),
            onChooseDirectory: () => onChooseDirectory(selected),
            onCopyCommand: () => onCopyCommand(selected),
          }}
        />
      )}

      {selected && !allExited && selected.status === 'exited' && (
        <SessionEndedBanner
          session={selected}
          onRestart={() => onRetry(selected)}
          onClose={() => onClose(selected)}
        />
      )}

      {/* Persisted-record surfaces — a resume NEVER substitutes a fresh session. */}
      {selectedRecord &&
        (isResuming ? (
          <ResumingState record={selectedRecord} onCancel={onCancelResume} />
        ) : resumeFailure ? (
          <ResumeBlockedState
            record={selectedRecord}
            reason={resumeFailure.reason}
            message={resumeFailure.message}
            onRetry={() => onRetryResume(selectedRecord)}
            onStartFresh={() => onStartFresh(selectedRecord)}
            onDelete={() => onDelete(selectedRecord)}
          />
        ) : (
          <ResumeSessionState
            record={selectedRecord}
            onResume={() => onResume(selectedRecord)}
            onStartFresh={() => onStartFresh(selectedRecord)}
            onDelete={() => onDelete(selectedRecord)}
          />
        ))}
    </Box>
  );
};
