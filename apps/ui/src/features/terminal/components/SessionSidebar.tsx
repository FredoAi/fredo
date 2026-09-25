import type { IconType } from 'react-icons';
import { LuChevronRight, LuGithub, LuSquareTerminal, LuTerminal } from 'react-icons/lu';
import { chakra, Icon, Text } from '@chakra-ui/react';
import { tint } from '../../../shared/utils/colorTint';
import {
  PREVIOUS_STATE_LABEL,
  lastActiveAbsolute,
  lastActiveLabel,
  persistedAriaLabel,
  type PersistedTerminalSession,
  type PreviousSessionState,
} from '../sessionModel';

/**
 * The persisted-record row (Spec 2935 UI/UX §4; compacted by Spec #2942 ST-5).
 *
 * A persisted record is NOT a live session: it has no process, and its actions
 * (Resume / Start fresh / Delete) live in the pane — the row carries the
 * persisted accessible name (`persistedAriaLabel`), a trailing chevron, and the
 * distinct state wording. Spec #2942 moves the row OUT of the retired History
 * popover into the vertical `TerminalSidebar`'s `Previous` section and
 * compacts it to ONE 32 px line: type icon · truncated title · state word (for
 * the non-resumable states) · relative time · chevron. The work-dir basename no
 * longer has a visible line (it stays in the row `title` and the pane).
 *
 * Never opacity-dimmed (G-235) — the state label carries the distinction. The
 * `terminal-previous-session-row-<id>` testid and `persistedAriaLabel` are
 * PRESERVED verbatim (C-3).
 */

/** The move-in transition (UI/UX §9–§10); honours `prefers-reduced-motion`. */
const previousRowMotion = {
  transition: 'opacity 150ms ease',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
} as const;

/**
 * A session type's glyph. Keyed off the wire value as a STRING so this stays
 * correct across the session-kind model (Spec #2942 ST-1 adds the plain-shell
 * `shell` kind) without duplicating the enum at the row level.
 * `LuSquareTerminal` gives the plain shell a distinct glyph from OpenCode's
 * `LuTerminal`.
 */
export function sessionTypeIcon(cli: string): IconType {
  if (cli === 'copilot') return LuGithub;
  if (cli === 'shell') return LuSquareTerminal;
  return LuTerminal;
}

export const PreviousSessionListItem: React.FC<{
  record: PersistedTerminalSession;
  state: PreviousSessionState;
  selected: boolean;
  /** Only the one roving-tabindex row is reachable by Tab (Spec #2942 §7). */
  focusable?: boolean;
  onSelect: (id: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}> = ({ record, state, selected, focusable = false, onSelect, onKeyDown }) => (
  <chakra.li role="listitem" m={0} p={0} css={previousRowMotion}>
    <chakra.button
      type="button"
      w="100%"
      h="32px"
      px={2}
      gap={2}
      display="flex"
      alignItems="center"
      textAlign="left"
      cursor="pointer"
      bg={selected ? tint('var(--accent-primary)', 12) : 'transparent'}
      borderLeft="3px solid"
      borderColor={selected ? 'var(--accent-strong)' : 'transparent'}
      fontWeight={selected ? 600 : 500}
      aria-current={selected ? 'true' : undefined}
      aria-label={persistedAriaLabel(record, state)}
      tabIndex={focusable ? 0 : -1}
      data-testid={`terminal-previous-session-row-${record.id}`}
      onClick={() => onSelect(record.id)}
      onKeyDown={onKeyDown}
      _hover={{
        bg: selected ? tint('var(--accent-primary)', 12) : 'var(--hover-bg)',
      }}
      _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '-2px' }}
    >
      <Icon
        as={sessionTypeIcon(String(record.cli))}
        boxSize="16px"
        flexShrink={0}
        color="fg.muted"
        aria-hidden="true"
      />
      <Text fontSize="sm" color="fg.default" truncate flex={1} minW={0} title={record.title}>
        {record.title}
      </Text>
      {state !== 'resumable' && (
        <Text fontSize="xs" color="fg.muted" flexShrink={0}>
          {PREVIOUS_STATE_LABEL[state]}
        </Text>
      )}
      <Text
        fontSize="xs"
        color="fg.muted"
        flexShrink={0}
        title={lastActiveAbsolute(record.lastActiveAt)}
      >
        {lastActiveLabel(record.lastActiveAt)}
      </Text>
      <Icon as={LuChevronRight} boxSize="14px" color="fg.subtle" flexShrink={0} />
    </chakra.button>
  </chakra.li>
);
