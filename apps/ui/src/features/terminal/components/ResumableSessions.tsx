import React, { useEffect, useState } from 'react';
import { Box, Button, Dialog, Flex, HStack, Icon, Spinner, Text, VStack } from '@chakra-ui/react';
import {
  LuCircleX,
  LuFolderOpen,
  LuHistory,
  LuPlay,
  LuRefreshCw,
  LuRotateCcw,
  LuTerminal,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu';
import { tint } from '../../../shared/utils/colorTint';
import {
  CLI_LABEL,
  PREVIOUS_STATE_DOT_COLOR,
  PREVIOUS_STATE_LABEL,
  displayWorkDir,
  lastActiveAbsolute,
  lastActiveLabel,
  type PersistedTerminalSession,
  type ResumeBlockedReason,
} from '../sessionModel';

/**
 * The pane surfaces for a SELECTED persisted record (Spec 2935 UI/UX §5).
 *
 * All three are centred-column siblings of `EmptyShell` in the pane region and
 * render INSTEAD of a terminal (a persisted record has no PTY). Resume never
 * silently falls back to a fresh session: a failure leaves the record exactly as
 * it was and shows `ResumeBlockedState` (AC1/AC4).
 */

const surface = {
  position: 'absolute',
  inset: 0,
  zIndex: 2,
  direction: 'column',
  align: 'center',
  justify: 'center',
  gap: 4,
  p: 8,
  textAlign: 'center',
  bg: 'bg.canvas',
} as const;

const RecordMeta: React.FC<{ record: PersistedTerminalSession }> = ({ record }) => (
  <HStack gap={1.5} fontSize="xs" color="fg.muted" fontFamily="mono">
    <Box
      as="span"
      boxSize="8px"
      borderRadius="full"
      flexShrink={0}
      bg={PREVIOUS_STATE_DOT_COLOR.resumable}
      aria-hidden="true"
    />
    <Text>{PREVIOUS_STATE_LABEL.resumable}</Text>
    <Text title={lastActiveAbsolute(record.lastActiveAt)}>
      {`last active ${lastActiveLabel(record.lastActiveAt)}`}
    </Text>
  </HStack>
);

// ── 5a. Resumable: the Resume card (auto-shown for the most-recent record) ────

export const ResumeSessionState: React.FC<{
  record: PersistedTerminalSession;
  onResume: () => void;
  onStartFresh: () => void;
  onDelete: () => void;
}> = ({ record, onResume, onStartFresh, onDelete }) => {
  const cliLabel = CLI_LABEL[record.cli];
  return (
    <Flex
      role="region"
      aria-label="Resume session"
      {...surface}
      data-testid="terminal-resume-state"
    >
      <Icon as={LuHistory} boxSize="48px" color="fg.muted" />
      <VStack gap={1} minW={0} maxW="520px">
        <Text fontSize="lg" fontWeight="600" color="fg.default" truncate w="100%">
          {record.title}
        </Text>
        <Text fontSize="sm" color="fg.muted">
          {`Resume this ${cliLabel} session in ${displayWorkDir(record.workDir)}.`}
        </Text>
        <RecordMeta record={record} />
        <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate w="100%" title={record.workDir}>
          {record.workDir || '~'}
        </Text>
      </VStack>
      <HStack gap={3}>
        <Button
          variant="solid"
          size="sm"
          bg="var(--accent-primary)"
          color="var(--accent-contrast)"
          _hover={{ opacity: 0.9 }}
          onClick={onResume}
        >
          <LuPlay size={14} />
          Resume
        </Button>
        <Button variant="ghost" size="sm" onClick={onStartFresh}>
          <LuRotateCcw size={14} />
          Start fresh
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          _hover={{ color: 'var(--status-error)', background: tint('var(--status-error)', 8) }}
        >
          <LuTrash2 size={14} />
          Delete
        </Button>
      </HStack>
    </Flex>
  );
};

// ── 5b. Resuming: bounded, cancellable (Doherty hints at 3s / 10s) ────────────

export const ResumingState: React.FC<{
  record: PersistedTerminalSession;
  onCancel: () => void;
}> = ({ record, onCancel }) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setElapsed(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => window.clearInterval(timer);
  }, [record.id]);

  const showHint = elapsed >= 3000;
  const showLongHint = elapsed >= 10000;

  return (
    <Flex {...surface} data-testid="terminal-resuming-state">
      <Spinner size="md" color="var(--accent-primary)" aria-label={`Resuming ${record.title}`} />
      <Text fontSize="sm" color="fg.muted">{`Resuming ${record.title}…`}</Text>
      {showHint && !showLongHint && (
        <Text fontSize="xs" color="fg.muted">Reconnecting to your last session…</Text>
      )}
      {showLongHint && (
        <Text fontSize="xs" color="fg.muted">
          Still resuming… (this can take a moment)
        </Text>
      )}
      {showLongHint && (
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <LuCircleX size={14} />
          Cancel
        </Button>
      )}
    </Flex>
  );
};

// ── 5c. Blocked: one distinct, persistent, `role="alert"` state per cause ─────

interface BlockedAction {
  key: string;
  label: string;
  icon: React.ElementType;
  primary?: boolean;
  onClick: () => void;
}

export const ResumeBlockedState: React.FC<{
  record: PersistedTerminalSession;
  reason: ResumeBlockedReason;
  message: string;
  onRetry: () => void;
  onStartFresh: () => void;
  onDelete: () => void;
}> = ({ record, reason, message, onRetry, onStartFresh, onDelete }) => {
  const cliLabel = CLI_LABEL[record.cli];

  let icon: React.ElementType = LuTriangleAlert;
  let title = "Couldn't resume this session";
  let body = message || 'The resume did not complete.';
  let actions: BlockedAction[] = [
    { key: 'retry', label: 'Retry', icon: LuRefreshCw, primary: true, onClick: onRetry },
    { key: 'start-fresh', label: 'Start fresh', icon: LuRotateCcw, onClick: onStartFresh },
    { key: 'delete', label: 'Delete', icon: LuTrash2, onClick: onDelete },
  ];

  if (reason === 'cli-missing') {
    icon = LuTerminal;
    title = `${cliLabel} isn't installed`;
    body = `${cliLabel} wasn't found on your PATH. Install it, then reopen Terminal to resume. You can also start a fresh session.`;
    actions = [
      { key: 'start-fresh', label: 'Start fresh', icon: LuRotateCcw, primary: true, onClick: onStartFresh },
      { key: 'delete', label: 'Delete', icon: LuTrash2, onClick: onDelete },
    ];
  } else if (reason === 'invalid-cwd') {
    icon = LuFolderOpen;
    title = 'Working directory not found';
    body = `${record.workDir || 'The saved directory'} doesn't exist. Restore the folder, or start a fresh session in another directory.`;
    actions = [
      { key: 'start-fresh', label: 'Start fresh', icon: LuRotateCcw, primary: true, onClick: onStartFresh },
      { key: 'delete', label: 'Delete', icon: LuTrash2, onClick: onDelete },
    ];
  } else {
    // resume-failed — the raw backend message + the "nothing was started" promise.
    body = `${message || 'The resume did not complete.'} Nothing was started. The session record is unchanged.`;
  }

  return (
    <Flex
      role="alert"
      {...surface}
      zIndex={3}
      data-testid="terminal-resume-blocked-state"
      data-reason={reason}
    >
      <Icon as={icon} boxSize="48px" color="var(--status-error)" />
      <VStack gap={1} minW={0} maxW="520px">
        <Text fontSize="lg" fontWeight="600" color="fg.default" truncate w="100%">
          {title}
        </Text>
        <Text fontSize="sm" color="fg.muted">{body}</Text>
      </VStack>
      <HStack gap={3}>
        {actions.map((action) => (
          <Button
            key={action.key}
            variant={action.primary ? 'solid' : 'ghost'}
            size="sm"
            bg={action.primary ? 'var(--accent-primary)' : undefined}
            color={action.primary ? 'var(--accent-contrast)' : undefined}
            _hover={
              action.key === 'delete'
                ? { color: 'var(--status-error)', background: tint('var(--status-error)', 8) }
                : action.primary
                  ? { opacity: 0.9 }
                  : undefined
            }
            onClick={action.onClick}
          >
            {React.createElement(action.icon, { size: 14 })}
            {action.label}
          </Button>
        ))}
      </HStack>
    </Flex>
  );
};

// ── 5d. Delete confirmation (destructive; tokens only) ────────────────────────

export const DeleteSessionDialog: React.FC<{
  record: PersistedTerminalSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}> = ({ record, open, onOpenChange, onConfirm }) => (
  <Dialog.Root open={open} onOpenChange={(details) => onOpenChange(details.open)}>
    <Dialog.Backdrop bg="var(--overlay-bg)" />
    <Dialog.Positioner>
      <Dialog.Content
        bg="bg.surface"
        borderColor="border.default"
        borderWidth="1px"
        borderRadius="lg"
        data-testid="terminal-delete-session-dialog"
      >
        <Dialog.Header>
          <Dialog.Title color="fg.default">
            <HStack gap={2}>
              <Box color="var(--status-error)" fontSize="lg">
                <LuTriangleAlert />
              </Box>
              <Text>Delete this session?</Text>
            </HStack>
          </Dialog.Title>
        </Dialog.Header>
        <Dialog.Body>
          <Text color="fg.default">
            {`Remove ${record?.title ?? 'this session'} from your saved sessions. This cannot be undone. ` +
              "The CLI's own conversation transcript is not deleted — Fredo only removes its record."}
          </Text>
        </Dialog.Body>
        <Dialog.Footer gap={2}>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            bg="var(--status-error)"
            color="white"
            _hover={{ opacity: 0.9 }}
            onClick={onConfirm}
          >
            <LuTrash2 size={14} />
            Delete
          </Button>
        </Dialog.Footer>
        <Dialog.CloseTrigger
          position="absolute"
          top="8px"
          right="8px"
          color="fg.muted"
          onClick={() => onOpenChange(false)}
        />
      </Dialog.Content>
    </Dialog.Positioner>
  </Dialog.Root>
);
