import React from 'react';
import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { LuSquare } from 'react-icons/lu';
import { tint } from '../../../shared/utils/colorTint';
import {
  STATUS_DOT_COLOR,
  STATUS_LABEL,
  sessionTitle,
  displayWorkDir,
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

interface TerminalPaneProps {
  sessions: readonly TerminalSessionInfo[];
  selected: TerminalSessionInfo | null;
  /** Every session in the window has exited (explicit window-level state). */
  allExited: boolean;
  /** sessionId -> a PTY byte has arrived (live or replayed). */
  outputSeen: Record<string, boolean>;
  /** The selected session has been `starting` for longer than the Doherty bound. */
  slowStarting: boolean;
  onFirstOutput: (sessionId: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
  onRetry: (session: TerminalSessionInfo) => void;
  onChooseDirectory: (session: TerminalSessionInfo) => void;
  onCopyCommand: (session: TerminalSessionInfo) => void;
  onAdd: () => void;
}

const SessionToolbar: React.FC<{
  selected: TerminalSessionInfo | null;
  sessions: readonly TerminalSessionInfo[];
  onClose: (session: TerminalSessionInfo) => void;
}> = ({ selected, sessions, onClose }) => {
  if (!selected) {
    return (
      <Flex
        h="32px"
        flexShrink={0}
        align="center"
        gap={3}
        px={3}
        bg="bg.subtle"
        borderBottom="1px solid var(--border-color)"
      >
        <Text fontSize="xs" color="fg.muted">No session selected</Text>
      </Flex>
    );
  }
  const statusLabel = STATUS_LABEL[selected.status];
  return (
    <Flex
      h="32px"
      flexShrink={0}
      align="center"
      gap={3}
      px={3}
      bg="bg.subtle"
      borderBottom="1px solid var(--border-color)"
    >
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
 * TerminalPane — the selected session's toolbar plus the stacked terminals
 * (one mounted instance per session, hidden when inactive) and the window-level
 * state surfaces (empty / all-ended) and per-session surfaces (starting / error
 * / ended). See the UI/UX spec §1–§3.
 */
export const TerminalPane: React.FC<TerminalPaneProps> = ({
  sessions,
  selected,
  allExited,
  outputSeen,
  slowStarting,
  onFirstOutput,
  onClose,
  onRetry,
  onChooseDirectory,
  onCopyCommand,
  onAdd,
}) => {
  const mounted = sessions.filter((s) => s.status === 'running' || s.status === 'exited');
  const selectedTitle = selected ? sessionTitle(selected, sessions) : 'Terminal';

  // The starting overlay spans `starting` AND the `running`-before-first-byte
  // window (first byte fades it). It is input-blocking only while `starting`.
  const showStartingOverlay =
    !!selected &&
    !allExited &&
    (selected.status === 'starting' ||
      (selected.status === 'running' && !outputSeen[selected.id]));

  return (
    <Flex direction="column" flex={1} minW={0}>
      <SessionToolbar selected={selected} sessions={sessions} onClose={onClose} />
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

        {sessions.length === 0 && <EmptySessionsState onAdd={onAdd} />}

        {sessions.length > 0 && allExited && <AllEndedState onAdd={onAdd} />}

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
      </Box>
    </Flex>
  );
};
