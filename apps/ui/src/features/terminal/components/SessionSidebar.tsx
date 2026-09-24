import React from 'react';
import { Box, HStack, Icon, Text, VStack } from '@chakra-ui/react';
import { LuChevronRight, LuGithub, LuTerminal } from 'react-icons/lu';
import { tint } from '../../../shared/utils/colorTint';
import {
  PREVIOUS_STATE_DOT_COLOR,
  PREVIOUS_STATE_LABEL,
  displayWorkDir,
  lastActiveAbsolute,
  lastActiveLabel,
  persistedAriaLabel,
  type PersistedTerminalSession,
  type PreviousSessionState,
} from '../sessionModel';

/**
 * Spec 2940 ST-3 — the persisted-record rows RELOCATED from the retired 240 px
 * sidebar into the `SessionBar`'s non-modal History popover. The row markup and
 * behaviour are unchanged from Spec 2935 UI/UX §4: a persisted record is NOT a
 * live session (distinct state wording, trailing chevron, no action buttons —
 * the actions live in the pane), it keeps its `terminal-previous-session-row-<id>`
 * testid and its `persistedAriaLabel` accessible name. Only its container moved.
 */

// A resuming record fades between surfaces (UI/UX §9–§10). The move is the ONLY
// transition; honours `prefers-reduced-motion` (no motion, same end state).
const previousRowMotion = {
  transition: 'opacity 150ms ease',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
} as const;

/**
 * A persisted record's row (Spec 2935 UI/UX §4). Deliberately distinct from a
 * live tab: the state label wording ("not running" — never "exited"/"running")
 * and the trailing chevron. It carries NO action buttons — the actions live in
 * the pane (§4 rationale), and the most-recent record is auto-selected so Resume
 * is reachable with zero clicks. Never opacity-dimmed (G-235); distinction is
 * carried by the label. Testid + accessible name are PRESERVED verbatim (C-3).
 */
export const PreviousSessionListItem: React.FC<{
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
 * The History popover body: the `Previous sessions (N)` heading over the
 * persisted-record list. The heading deliberately is NOT a `Popover.Title` so
 * the popover content keeps its explicit `aria-label="Previous sessions"`
 * accessible name (the `terminal-section-previous` heading it replaces is
 * superseded — C-3).
 */
export const PreviousSessionsPanel: React.FC<{
  previous: readonly PersistedTerminalSession[];
  selectedId: string | null;
  previousStateOf: (record: PersistedTerminalSession) => PreviousSessionState;
  onSelect: (id: string) => void;
}> = ({ previous, selectedId, previousStateOf, onSelect }) => (
  <VStack align="stretch" gap={0} w="100%">
    <HStack px={3} pt={2} pb={1} gap={2} flexShrink={0}>
      <Text
        fontSize="xs"
        fontWeight="600"
        color="fg.subtle"
        textTransform="uppercase"
        letterSpacing="0.06em"
      >
        Previous sessions
      </Text>
      <Text fontSize="xs" color="fg.subtle" fontFamily="mono">
        {previous.length}
      </Text>
    </HStack>
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
  </VStack>
);
