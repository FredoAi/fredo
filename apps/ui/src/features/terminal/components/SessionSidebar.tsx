import React from 'react';
import { Box, Button, HStack, Icon, IconButton, Text, VStack } from '@chakra-ui/react';
import { LuGithub, LuPlus, LuTerminal, LuX } from 'react-icons/lu';
import { tint } from '../../../shared/utils/colorTint';
import {
  STATUS_DOT_COLOR,
  STATUS_LABEL,
  displayWorkDir,
  sessionAriaLabel,
  sessionTitle,
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

export const SessionSidebar: React.FC<{
  sessions: readonly TerminalSessionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
  onAdd: () => void;
}> = ({ sessions, selectedId, onSelect, onClose, onAdd }) => (
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
    <VStack as="ul" role="list" aria-label="Terminal sessions" align="stretch" gap={0} m={0} p={0}>
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
  </VStack>
);
