import React from 'react';
import { Box, Button, Flex, HStack, Icon, Spinner, Text, VStack } from '@chakra-ui/react';
import { LuCircleX, LuCopy, LuFolderOpen, LuRefreshCw, LuSquare, LuTerminal } from 'react-icons/lu';
import { tint } from '../../../shared/utils/colorTint';
import {
  CLI_LABEL,
  errorStateMeta,
  sessionTitle,
  type ErrorAction,
  type TerminalSessionInfo,
} from '../sessionModel';

// ── Starting overlay (status `starting`, or `running` before the first byte) ──

export const StartingState: React.FC<{
  session: TerminalSessionInfo;
  showSlowHint: boolean;
  /** While `starting` the overlay blocks input; once the PTY is live (no byte
   *  yet) it lets input fall through to the terminal. */
  blocking: boolean;
  onClose: () => void;
}> = ({ session, showSlowHint, blocking, onClose }) => {
  const cliLabel = CLI_LABEL[session.cli];
  return (
    <Flex
      position="absolute"
      inset={0}
      zIndex={2}
      direction="column"
      align="center"
      justify="center"
      gap={3}
      bg="bg.canvas"
      transition="opacity 180ms ease"
      pointerEvents={blocking ? 'auto' : 'none'}
      data-testid="terminal-starting-state"
    >
      <Spinner size="md" color="var(--accent-primary)" aria-label={`Starting ${cliLabel} session`} />
      <Text fontSize="sm" color="fg.muted">{`Starting ${cliLabel}…`}</Text>
      {showSlowHint && (
        <Text fontSize="xs" color="fg.muted">
          Still starting… (check the CLI is installed)
        </Text>
      )}
      <Button variant="ghost" size="xs" onClick={onClose}>
        <LuCircleX size={14} />
        Close session
      </Button>
    </Flex>
  );
};

// ── Per-session error surface (typed `errorKind`, never regex) ────────────────

interface ErrorActionHandlers {
  onRetry: () => void;
  onClose: () => void;
  onChooseDirectory: () => void;
  onCopyCommand: () => void;
}

const ACTION_LABELS: Record<ErrorAction, string> = {
  retry: 'Retry',
  close: 'Close session',
  'choose-directory': 'Choose directory',
  'copy-command': 'Copy command',
};

const ACTION_ICONS: Record<ErrorAction, React.ElementType> = {
  retry: LuRefreshCw,
  close: LuCircleX,
  'choose-directory': LuFolderOpen,
  'copy-command': LuCopy,
};

const ACTION_HANDLERS: Record<ErrorAction, keyof ErrorActionHandlers> = {
  retry: 'onRetry',
  close: 'onClose',
  'choose-directory': 'onChooseDirectory',
  'copy-command': 'onCopyCommand',
};

export const SessionErrorState: React.FC<{
  session: TerminalSessionInfo;
  handlers: ErrorActionHandlers;
}> = ({ session, handlers }) => {
  const meta = errorStateMeta(session);
  return (
    <Flex
      role="alert"
      position="absolute"
      inset={0}
      zIndex={3}
      direction="column"
      align="center"
      justify="center"
      gap={4}
      p={8}
      textAlign="center"
      bg="bg.canvas"
      data-testid="terminal-error-state"
      data-error-kind={session.errorKind ?? 'generic'}
    >
      <Icon as={meta.icon} boxSize="48px" color="var(--status-error)" />
      <VStack gap={1}>
        <Text fontSize="lg" fontWeight="600" color="fg.default">{meta.title}</Text>
        {meta.body && (
          <Text fontSize="sm" color="fg.muted" maxW="520px">{meta.body}</Text>
        )}
        {meta.showRawMessage && (
          <Text fontSize="xs" color="fg.muted" maxW="520px">{session.error}</Text>
        )}
      </VStack>
      <HStack gap={3}>
        {meta.actions.map((action) => (
          <Button
            key={action}
            variant={action === 'retry' ? 'solid' : 'ghost'}
            size="sm"
            bg={action === 'retry' ? 'var(--accent-primary)' : undefined}
            color={action === 'retry' ? 'var(--accent-contrast)' : undefined}
            onClick={handlers[ACTION_HANDLERS[action]]}
          >
            {React.createElement(ACTION_ICONS[action], { size: 14 })}
            {ACTION_LABELS[action]}
          </Button>
        ))}
      </HStack>
    </Flex>
  );
};

// ── Per-session ended banner (terminal kept mounted + visible underneath) ─────

export const SessionEndedBanner: React.FC<{
  session: TerminalSessionInfo;
  onRestart: () => void;
  onClose: () => void;
}> = ({ session, onRestart, onClose }) => (
  <HStack
    position="absolute"
    top={0}
    left={0}
    right={0}
    zIndex={2}
    gap={3}
    px={3}
    py={2}
    bg="bg.subtle"
    borderBottom="1px solid var(--border-color)"
    data-testid="terminal-ended-banner"
  >
    <Text fontSize="sm" color="fg.default" flex={1}>
      This session has ended
    </Text>
    <Button variant="ghost" size="xs" onClick={onRestart}>
      <LuRefreshCw size={14} />
      Restart session
    </Button>
    <Button
      variant="ghost"
      size="xs"
      onClick={onClose}
      _hover={{ color: 'var(--status-error)', background: tint('var(--status-error)', 8) }}
    >
      <LuCircleX size={14} />
      Close session
    </Button>
  </HStack>
);

// ── Window-level empty states ─────────────────────────────────────────────────

const EmptyShell: React.FC<{
  icon: React.ElementType;
  iconColor: string;
  title: string;
  body: string;
  onAdd: () => void;
  testId: string;
}> = ({ icon, iconColor, title, body, onAdd, testId }) => (
  <Flex
    position="absolute"
    inset={0}
    direction="column"
    align="center"
    justify="center"
    gap={3}
    p={8}
    textAlign="center"
    data-testid={testId}
  >
    <Icon as={icon} boxSize="48px" color={iconColor} />
    <Text fontSize="lg" fontWeight="600" color="fg.default">{title}</Text>
    <Text fontSize="sm" color="fg.muted" maxW="420px">{body}</Text>
    <Button
      size="sm"
      background="var(--accent-primary)"
      color="var(--accent-contrast)"
      onClick={onAdd}
      _hover={{ opacity: 0.9 }}
    >
      Add session
    </Button>
  </Flex>
);

export const EmptySessionsState: React.FC<{ onAdd: () => void }> = ({ onAdd }) => (
  <EmptyShell
    icon={LuTerminal}
    iconColor="fg.muted"
    title="No sessions yet"
    body="Add a session to run OpenCode or GitHub Copilot."
    onAdd={onAdd}
    testId="terminal-empty-state"
  />
);

export const AllEndedState: React.FC<{ onAdd: () => void }> = ({ onAdd }) => (
  <EmptyShell
    icon={LuSquare}
    iconColor="var(--text-secondary)"
    title="All sessions ended"
    body="Every session in this window has exited."
    onAdd={onAdd}
    testId="terminal-all-ended-state"
  />
);
