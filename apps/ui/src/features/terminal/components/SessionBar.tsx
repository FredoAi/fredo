import React from 'react';
import {
  Box,
  Button,
  chakra,
  Flex,
  HStack,
  IconButton,
  Popover,
  Portal,
  Text,
  VStack,
} from '@chakra-ui/react';
import { LuHistory, LuPlus, LuX } from 'react-icons/lu';
import { tint } from '../../../shared/utils/colorTint';
import {
  STATUS_DOT_COLOR,
  STATUS_LABEL,
  displayWorkDir,
  sessionAriaLabel,
  sessionTitle,
  type PersistedTerminalSession,
  type PreviousSessionState,
  type TerminalSessionInfo,
} from '../sessionModel';
import { PreviousSessionsPanel } from './SessionSidebar';

/**
 * Spec 2940 ST-3 (UI/UX §2–§8) — the single 44 px session rail that REPLACES the
 * retired 240 px sidebar + 32 px toolbar. Horizontal by construction: the
 * terminal pane above stays full-bleed and full-height, navigation never
 * consumes more than the rail's 44 px, and at the 560 px minimum the tab strip
 * SCROLLS instead of clipping the terminal (R-2.1/R-2.2).
 *
 * DOM contract (C-3): the root is `terminal-session-bar`; each live session is a
 * `terminal-session-row-<id>` wrapper that still contains a `button`
 * (`role="tab"`, `aria-selected`, `aria-current` when active); persisted records
 * live in the non-modal History popover (`terminal-previous-toggle` +
 * `terminal-previous-panel` + the PRESERVED `terminal-previous-session-row-<id>`
 * rows). No focus trap anywhere.
 */

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

// Reveal the close affordance on tab hover OR while any child has focus; keep it
// visible for the active tab. Never colour-only / aria-hidden.
const closeReveal = {
  '& .terminal-session-kill': { opacity: 0, transition: 'opacity 120ms' },
  '&:hover .terminal-session-kill': { opacity: 1 },
  '&:focus-within .terminal-session-kill': { opacity: 1 },
} as const;

const tabMotion = {
  transition: 'opacity 150ms ease',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
} as const;

const TAB_HEIGHT = '36px';

const SessionTab: React.FC<{
  session: TerminalSessionInfo;
  sessions: readonly TerminalSessionInfo[];
  selected: boolean;
  /** Only the one roving-tabindex tab is reachable by Tab. */
  focusable: boolean;
  onSelect: (id: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
}> = ({ session, sessions, selected, focusable, onSelect, onClose }) => {
  const title = sessionTitle(session, sessions);
  const statusLabel = STATUS_LABEL[session.status];
  return (
    <HStack
      as="div"
      role="presentation"
      position="relative"
      flexShrink={0}
      h={TAB_HEIGHT}
      css={{ ...closeReveal, ...tabMotion }}
      data-testid={`terminal-session-row-${session.id}`}
    >
      <chakra.button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-current={selected ? 'true' : undefined}
        aria-label={sessionAriaLabel(session, sessions)}
        tabIndex={focusable ? 0 : -1}
        minW="108px"
        maxW="200px"
        h={TAB_HEIGHT}
        px={3}
        gap={2}
        display="flex"
        alignItems="center"
        textAlign="left"
        cursor="pointer"
        bg={selected ? tint('var(--accent-primary)', 12) : 'transparent'}
        borderBottom="2px solid"
        borderColor={selected ? 'var(--accent-primary)' : 'transparent'}
        fontWeight={selected ? 600 : 500}
        onClick={() => onSelect(session.id)}
        _hover={{ bg: selected ? tint('var(--accent-primary)', 12) : 'var(--hover-bg)' }}
        _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '-2px' }}
      >
        <Box
          as="span"
          boxSize="8px"
          borderRadius="full"
          flexShrink={0}
          bg={STATUS_DOT_COLOR[session.status]}
          aria-hidden="true"
        />
        <VStack align="start" gap={0} flex={1} minW={0}>
          <Text fontSize="sm" color="fg.default" fontWeight={selected ? 600 : 500} truncate w="100%">
            {title}
          </Text>
          <HStack gap={1.5} minW={0} w="100%">
            <Text fontSize="xs" color="fg.muted" flexShrink={0}>
              {statusLabel}
            </Text>
            <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate title={session.workDir}>
              {displayWorkDir(session.workDir)}
            </Text>
          </HStack>
        </VStack>
      </chakra.button>
      <IconButton
        className="terminal-session-kill"
        size="xs"
        variant="ghost"
        position="absolute"
        right="2px"
        top="50%"
        transform="translateY(-50%)"
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

export interface SessionBarProps {
  sessions: readonly TerminalSessionInfo[];
  previous: readonly PersistedTerminalSession[];
  selectedId: string | null;
  previousStateOf: (record: PersistedTerminalSession) => PreviousSessionState;
  onSelect: (id: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
  onAdd: () => void;
  addButtonRef?: React.RefObject<HTMLButtonElement>;
}

export const SessionBar: React.FC<SessionBarProps> = ({
  sessions,
  previous,
  selectedId,
  previousStateOf,
  onSelect,
  onClose,
  onAdd,
  addButtonRef,
}) => {
  // Roving tabindex: exactly one live tab is reachable by Tab (the selected one,
  // else the first). Arrow/Home/End move the selection over the LIVE tabs
  // (UI/UX §5/§8) — persisted records live behind the History toggle.
  const selectedIndex = sessions.findIndex((s) => s.id === selectedId);
  const focusableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const handleTablistKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (sessions.length === 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (focusableIndex + 1) % sessions.length;
    else if (event.key === 'ArrowLeft') next = (focusableIndex - 1 + sessions.length) % sessions.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sessions.length - 1;
    if (next === null) return;
    event.preventDefault();
    const id = sessions[next].id;
    onSelect(id);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-testid="terminal-session-row-${id}"] button`)
        ?.focus();
    });
  };

  return (
    <Flex
      data-testid="terminal-session-bar"
      h="44px"
      minH="44px"
      flexShrink={0}
      w="100%"
      align="center"
      gap={1}
      px={2}
      bg="bg.subtle"
      borderBottom="1px solid var(--border-color)"
    >
      <IconButton
        ref={addButtonRef}
        size="xs"
        variant="ghost"
        flexShrink={0}
        aria-label="Add session"
        onClick={onAdd}
        _hover={{ color: 'fg.default', background: 'var(--hover-bg)' }}
      >
        <LuPlus size={14} />
      </IconButton>

      <Flex
        role="tablist"
        aria-label="Terminal sessions"
        flex={1}
        minW={0}
        h="100%"
        align="center"
        gap={1}
        overflowX="auto"
        overflowY="hidden"
        css={thinScrollbar}
        onKeyDown={handleTablistKeyDown}
      >
        {sessions.map((session, index) => (
          <SessionTab
            key={session.id}
            session={session}
            sessions={sessions}
            selected={session.id === selectedId}
            focusable={index === focusableIndex}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}
      </Flex>

      {previous.length > 0 && (
        <Popover.Root
          lazyMount={false}
          unmountOnExit={false}
          ids={{ content: 'terminal-previous-panel' }}
          positioning={{ placement: 'bottom-end' }}
        >
          <Popover.Trigger asChild>
            <Button
              data-testid="terminal-previous-toggle"
              size="xs"
              variant="ghost"
              flexShrink={0}
              gap={1.5}
              aria-label={`Previous sessions (${previous.length})`}
              aria-haspopup="dialog"
              aria-controls="terminal-previous-panel"
              _hover={{ color: 'fg.default', background: 'var(--hover-bg)' }}
            >
              <LuHistory size={14} />
              <Text as="span" fontFamily="mono" fontSize="xs">
                {previous.length}
              </Text>
            </Button>
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner>
              <Popover.Content
                id="terminal-previous-panel"
                data-testid="terminal-previous-panel"
                role="dialog"
                aria-label="Previous sessions"
                maxW="360px"
                maxH="min(70vh, 420px)"
                overflowY="auto"
                bg="bg.surface"
                borderColor="border.default"
                borderWidth="1px"
                borderRadius="md"
                boxShadow="lg"
                p={0}
                css={thinScrollbar}
              >
                <PreviousSessionsPanel
                  previous={previous}
                  selectedId={selectedId}
                  previousStateOf={previousStateOf}
                  onSelect={onSelect}
                />
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
      )}
    </Flex>
  );
};
