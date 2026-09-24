import React from 'react';
import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { LuSquare } from 'react-icons/lu';
import { tint } from '../../../shared/utils/colorTint';
import {
  PREVIOUS_STATE_DOT_COLOR,
  STATUS_DOT_COLOR,
  STATUS_LABEL,
  sessionTitle,
  displayWorkDir,
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

const SessionToolbar: React.FC<{
  selected: TerminalSessionInfo | null;
  selectedRecord: PersistedTerminalSession | null;
  sessions: readonly TerminalSessionInfo[];
  onClose: (session: TerminalSessionInfo) => void;
}> = ({ selected, selectedRecord, sessions, onClose }) => {
  const toolbarProps = {
    h: '32px',
    flexShrink: 0,
    align: 'center' as const,
    gap: 3,
    px: 3,
    bg: 'bg.subtle',
    borderBottom: '1px solid var(--border-color)',
  };

  if (!selected && !selectedRecord) {
    return (
      <Flex {...toolbarProps}>
        <Text fontSize="xs" color="fg.muted">No session selected</Text>
      </Flex>
    );
  }

  if (!selected && selectedRecord) {
    return (
      <Flex {...toolbarProps}>
        <Box
          boxSize="8px"
          borderRadius="full"
          flexShrink={0}
          bg={PREVIOUS_STATE_DOT_COLOR.resumable}
          aria-label="Session status: not running"
        />
        <Text fontSize="xs" color="fg.muted" flexShrink={0}>
          {selectedRecord.title}
        </Text>
        <Text fontSize="xs" color="fg.muted" fontFamily="mono" flex={1} minW={0} truncate>
          {selectedRecord.workDir || '~'}
        </Text>
      </Flex>
    );
  }

  if (!selected) return null;
  const statusLabel = STATUS_LABEL[selected.status];
  return (
    <Flex {...toolbarProps}>
      <Box
        boxSize="8px"
        borderRadius="full"
        flexShrink={0}
        bg={STATUS_DOT_COLOR[selected.status]}
        aria-label={`Session status: ${statusLabel}`}
      />
      <Text fontSize="xs" color="fg.muted" flexShrink={0}>
        {sessionTitle(selected, sessions)}
      </Text>
      <Text fontSize="xs" color="fg.muted" fontFamily="mono" flex={1} minW={0} truncate>
        {displayWorkDir(selected.workDir) === '~' ? '~' : selected.workDir}
      </Text>
      {selected.status === 'running' && (
        <Button
          variant="ghost"
          size="xs"
          title="Kill session"
          onClick={() => onClose(selected)}
          _hover={{ color: 'var(--status-error)', background: tint('var(--status-error)', 8) }}
        >
          <LuSquare size={14} />
          Kill session
        </Button>
      )}
    </Flex>
  );
};

/**
 * TerminalPane — the selected entry's toolbar plus the stacked terminals (one
 * mounted instance per live session, hidden when inactive), the window-level
 * state surfaces (empty / all-ended), the per-session surfaces (starting / error
 * / ended) and the persisted-record surfaces (resume / resuming / blocked).
 *
 * Spec 2935 re-gates two rules (UI/UX §6): the Empty state renders only when BOTH
 * groups are empty, and "All sessions ended" only when there are no persisted
 * records left to resume — so an earlier session is never masked.
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

  return (
    <Flex direction="column" flex={1} minW={0}>
      <SessionToolbar
        selected={selected}
        selectedRecord={selectedRecord}
        sessions={sessions}
        onClose={onClose}
      />
      <Box
        position="relative"
        flex={1}
        minH={0}
        role="region"
        aria-label={`${selectedTitle} terminal`}
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
    </Flex>
  );
};
