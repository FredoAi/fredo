import React from 'react';
import { Box, Button, HStack, Icon, IconButton, Text, VStack } from '@chakra-ui/react';
import { LuChevronRight, LuGithub, LuPlus, LuTerminal, LuX } from 'react-icons/lu';
import { tint } from '../../../shared/utils/colorTint';
import {
  PREVIOUS_STATE_DOT_COLOR,
  PREVIOUS_STATE_LABEL,
  STATUS_DOT_COLOR,
  STATUS_LABEL,
  displayWorkDir,
  lastActiveAbsolute,
  lastActiveLabel,
  persistedAriaLabel,
  sessionAriaLabel,
  sessionTitle,
  type PersistedTerminalSession,
  type PreviousSessionState,
  type TerminalSessionInfo,
} from '../sessionModel';

const thinScrollbar = {
  '&::-webkit-scrollbar': { width: '5px', height: '5px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': {
    background: 'var(--scrollbar-thumb)',
    borderRadius: '3px',
  },
  '&::-webkit-scrollbar-thumb:hover': { background: 'var(--scrollbar-thumb-hover)' },
  '&::-webkit-scrollbar-corner': { background: 'transparent' },
} as const;

// Reveal the kill affordance on row hover OR while any child has focus; keep it
// visible for the selected row. Never colour-only / aria-hidden.
const killReveal = {
  '& .terminal-session-kill': { opacity: 0, transition: 'opacity 120ms' },
  '&:hover .terminal-session-kill': { opacity: 1 },
  '&:focus-within .terminal-session-kill': { opacity: 1 },
} as const;

// A resuming record fades between groups (UI/UX §9–§10). The move is the ONLY
// transition; honours `prefers-reduced-motion` (no motion, same end state).
const previousRowMotion = {
  transition: 'opacity 150ms ease',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
} as const;

/** Shared group heading — the LIVE-vs-PERSISTED signal. Never focusable. */
const SectionHeading: React.FC<{
  id: string;
  label: string;
  count: number;
  borderTop?: boolean;
}> = ({ id, label, count, borderTop = false }) => (
  <HStack
    px={3}
    pt={2}
    pb={1}
    gap={2}
    position="sticky"
    top={0}
    zIndex={1}
    bg="bg.subtle"
    borderTop={borderTop ? '1px solid var(--border-color)' : undefined}
    data-testid={`terminal-section-${id}`}
  >
    <Text
      id={id}
      fontSize="xs"
      fontWeight="600"
      color="fg.subtle"
      textTransform="uppercase"
      letterSpacing="0.06em"
    >
      {label}
    </Text>
    <Text fontSize="xs" color="fg.subtle" fontFamily="mono">
      {count}
    </Text>
  </HStack>
);

const SessionListItem: React.FC<{
  session: TerminalSessionInfo;
  sessions: readonly TerminalSessionInfo[];
  selected: boolean;
  onSelect: (id: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
}> = ({ session, sessions, selected, onSelect, onClose }) => {
  const title = sessionTitle(session, sessions);
  const statusLabel = STATUS_LABEL[session.status];
  return (
    <HStack
      as="li"
      role="listitem"
      align="stretch"
      gap={0}
      position="relative"
      css={killReveal}
      data-testid={`terminal-session-row-${session.id}`}
    >
      <HStack
        as="button"
        flex={1}
        minW={0}
        gap={2}
        px={3}
        py={2}
        align="center"
        textAlign="left"
        cursor="pointer"
        bg={selected ? tint('var(--accent-primary)', 12) : 'transparent'}
        borderLeft="3px solid"
        borderColor={selected ? 'var(--accent-strong)' : 'transparent'}
        fontWeight={selected ? 600 : 500}
        aria-current={selected ? 'true' : undefined}
        aria-label={sessionAriaLabel(session, sessions)}
        onClick={() => onSelect(session.id)}
        _hover={{
          bg: selected ? tint('var(--accent-primary)', 12) : 'var(--hover-bg)',
        }}
        _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '-2px' }}
      >
        <Icon
          as={session.cli === 'copilot' ? LuGithub : LuTerminal}
          boxSize="16px"
          flexShrink={0}
          color="fg.muted"
        />
        <VStack align="start" gap={0} flex={1} minW={0}>
          <Text fontSize="sm" color="fg.default" truncate w="100%">
            {title}
          </Text>
          <HStack gap={1.5} minW={0} w="100%">
            <Box
              as="span"
              boxSize="8px"
              borderRadius="full"
              flexShrink={0}
              bg={STATUS_DOT_COLOR[session.status]}
              aria-hidden="true"
            />
            <Text fontSize="xs" color="fg.muted" flexShrink={0}>
              {statusLabel}
            </Text>
            <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate>
              {displayWorkDir(session.workDir)}
            </Text>
          </HStack>
        </VStack>
      </HStack>
      <IconButton
        className="terminal-session-kill"
        size="xs"
        variant="ghost"
        alignSelf="center"
        mr={1}
        opacity={selected ? 1 : undefined}
        aria-label={`Close session ${title}`}
        onClick={() => onClose(session)}
        _hover={{ color: 'var(--status-error)', background: tint('var(--status-error)', 8) }}
      >
        <LuX size={14} />
      </IconButton>
    </HStack>
  );
};

/**
 * A persisted record's row (Spec 2935 UI/UX §4). Deliberately distinct from a
 * live row: the section, the state label wording ("not running" — never
 * "exited"/"running") and the trailing chevron. It carries NO action buttons —
 * the actions live in the pane (§4 rationale), and the most-recent record is
 * auto-selected so Resume is reachable with zero clicks. Never opacity-dimmed
 * (G-235); distinction is carried by section + label.
 */
const PreviousSessionListItem: React.FC<{
  record: PersistedTerminalSession;
  state: PreviousSessionState;
  selected: boolean;
  onSelect: (id: string) => void;
}> = ({ record, state, selected, onSelect }) => (
  <HStack as="li" role="listitem" align="stretch" gap={0} css={previousRowMotion}>
    <HStack
      as="button"
      flex={1}
      minW={0}
      gap={2}
      px={3}
      py={2}
      align="center"
      textAlign="left"
      cursor="pointer"
      bg={selected ? tint('var(--accent-primary)', 12) : 'transparent'}
      borderLeft="3px solid"
      borderColor={selected ? 'var(--accent-strong)' : 'transparent'}
      fontWeight={selected ? 600 : 500}
      aria-current={selected ? 'true' : undefined}
      aria-label={persistedAriaLabel(record, state)}
      data-testid={`terminal-previous-session-row-${record.id}`}
      onClick={() => onSelect(record.id)}
      _hover={{
        bg: selected ? tint('var(--accent-primary)', 12) : 'var(--hover-bg)',
      }}
      _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '-2px' }}
    >
      <Icon
        as={record.cli === 'copilot' ? LuGithub : LuTerminal}
        boxSize="16px"
        flexShrink={0}
        color="fg.muted"
      />
      <VStack align="start" gap={0} flex={1} minW={0}>
        <HStack w="100%" gap={1} minW={0}>
          <Text fontSize="sm" color="fg.default" truncate>
            {record.title}
          </Text>
          <Icon as={LuChevronRight} boxSize="14px" color="fg.subtle" flexShrink={0} ml="auto" />
        </HStack>
        <HStack gap={1.5} minW={0} w="100%">
          <Box
            as="span"
            boxSize="8px"
            borderRadius="full"
            flexShrink={0}
            bg={PREVIOUS_STATE_DOT_COLOR[state]}
            aria-hidden="true"
          />
          <Text fontSize="xs" color="fg.muted" flexShrink={0}>
            {PREVIOUS_STATE_LABEL[state]}
          </Text>
          <Text
            fontSize="xs"
            color="fg.muted"
            flexShrink={0}
            title={lastActiveAbsolute(record.lastActiveAt)}
          >
            {lastActiveLabel(record.lastActiveAt)}
          </Text>
          <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate>
            {displayWorkDir(record.workDir)}
          </Text>
        </HStack>
      </VStack>
    </HStack>
  </HStack>
);

/**
 * SessionSidebar — two labelled groups inside one nav (Spec 2935 UI/UX §3):
 * `This window` (live sessions) and `Previous sessions` (persisted records with
 * no process this window). A group renders only when non-empty; its header still
 * renders when it is the only group, so the live-vs-persisted distinction is
 * never ambiguous.
 */
export const SessionSidebar: React.FC<{
  sessions: readonly TerminalSessionInfo[];
  previous: readonly PersistedTerminalSession[];
  selectedId: string | null;
  previousStateOf: (record: PersistedTerminalSession) => PreviousSessionState;
  onSelect: (id: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
  onAdd: () => void;
  addButtonRef?: React.RefObject<HTMLButtonElement>;
}> = ({
  sessions,
  previous,
  selectedId,
  previousStateOf,
  onSelect,
  onClose,
  onAdd,
  addButtonRef,
}) => (
  <VStack
    align="stretch"
    gap={0}
    w="240px"
    flexShrink={0}
    bg="bg.subtle"
    borderRight="1px solid var(--border-color)"
    overflowY="auto"
    css={thinScrollbar}
  >
    <Box px={3} py={2} flexShrink={0}>
      <Button
        ref={addButtonRef}
        size="xs"
        variant="ghost"
        w="100%"
        justifyContent="flex-start"
        color="fg.muted"
        aria-label="Add session"
        onClick={onAdd}
        _hover={{ color: 'fg.default', background: 'var(--hover-bg)' }}
      >
        <LuPlus size={14} />
        Add session
      </Button>
    </Box>
    <Box as="nav" aria-label="Terminal sessions" flex={1} minH={0}>
      {sessions.length > 0 && (
        <Box role="group" aria-labelledby="terminal-active-heading">
          <SectionHeading id="terminal-active-heading" label="This window" count={sessions.length} />
          <VStack as="ul" role="list" aria-label="Active sessions" align="stretch" gap={0} m={0} p={0}>
            {sessions.map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                sessions={sessions}
                selected={session.id === selectedId}
                onSelect={onSelect}
                onClose={onClose}
              />
            ))}
          </VStack>
        </Box>
      )}

      {previous.length > 0 && (
        <Box role="group" aria-labelledby="terminal-previous-heading">
          <SectionHeading
            id="terminal-previous-heading"
            label="Previous sessions"
            count={previous.length}
            borderTop
          />
          <VStack
            as="ul"
            role="list"
            aria-label="Previous sessions"
            align="stretch"
            gap={0}
            m={0}
            p={0}
          >
            {previous.map((record) => (
              <PreviousSessionListItem
                key={record.id}
                record={record}
                state={previousStateOf(record)}
                selected={record.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </VStack>
        </Box>
      )}
    </Box>
  </VStack>
);
