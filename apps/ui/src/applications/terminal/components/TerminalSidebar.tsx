import React, { useCallback, useState } from 'react';
import { LuPlus, LuX } from 'react-icons/lu';
import { chakra, Flex, Icon, IconButton, Text } from '@chakra-ui/react';
import { tint } from '../../../shared/utils/colorTint';
import {
  STATUS_DOT_COLOR,
  STATUS_LABEL,
  sessionAriaLabel,
  sessionDisplayTitle,
  type PersistedTerminalSession,
  type PreviousSessionState,
  type RenameHandler,
  type TerminalSessionInfo,
} from '../sessionModel';
import {
  PreviousSessionListItem,
  SessionRenameField,
  sessionTypeIcon,
  useSessionRename,
} from './SessionSidebar';

/**
 * Spec #2942 ST-5 (UI/UX §1, §5, §7; SA §8) — the compact VERTICAL session
 * sidebar that replaces the superseded 44 px horizontal `SessionBar` rail.
 *
 * One column: a pinned `+ Add session` header, a `This window` list of live
 * (and optimistic pending) sessions, and a `Previous` list of persisted records
 * — no popover. The dominant `terminal-pane` sits beside it in a row flex, so
 * at the 560×360 window minimum the pane keeps the wide majority of the width
 * (200 px sidebar → ~360 px pane) while the sidebar scrolls vertically only.
 *
 * DOM contract (SUPERSEDES the #2940 rail):
 *   - root: `terminal-session-sidebar` (`nav`, `aria-label="Terminal sessions"`)
 *   - add: `terminal-session-sidebar-add` (`<button>`, `aria-label="Add session"`)
 *   - section headers: `terminal-session-sidebar-live-section` /
 *     `terminal-session-sidebar-previous-section`
 *   - live rows: `terminal-session-row-<id>` (PRESERVED — wraps a `<button>`)
 *   - previous rows: `terminal-previous-session-row-<id>` (PRESERVED)
 *   - close: `terminal-session-kill-<id>` (class `terminal-session-kill` kept)
 *   - rename (Spec #2942 ST-3): `terminal-session-rename-<id>` (the per-row
 *     kebab, revealed on hover/focus-within, plus the F2 power path) swaps the
 *     name for `terminal-session-rename-input-<id>` on BOTH live and previous
 *     rows — the name is the session's only editable field.
 *
 * There is no `tablist`/`tab` role: a mixed live + previous list with per-row
 * action buttons is a `nav` of two lists with `aria-current` on the active row
 * (§7) — the asserted contract is `aria-current`, not `aria-selected`.
 *
 * Keyboard: ONE roving tabindex across the combined live+previous order
 * (active row, else the first), Arrow Up/Down (Left/Right aliases), Home/End
 * follow-focus selection, Enter/Space select (native `<button>`). No focus
 * trap — Tab leaves the sidebar.
 */

const SIDEBAR_WIDTH = '200px';
const ADD_HEIGHT = '36px';
const ROW_HEIGHT = '32px';
const SECTION_HEIGHT = '24px';
/**
 * The REAL outer height of the pinned add header: its 36 px button plus the
 * 1 px `borderBottom` (measured `{y:0,h:37}` — ST-5a / F-80). Sticky section
 * offsets are derived from the actual pinned stack so a section header never
 * paints over the first row beneath it.
 */
const ADD_HEADER_STACK_HEIGHT = '37px';
/** A section header pins directly below the pinned add header. */
const FIRST_SECTION_TOP = ADD_HEADER_STACK_HEIGHT;
/**
 * The Previous header pins below the add header + the live section header.
 * When there is NO live section (`sessions.length === 0`) the Previous header
 * is the FIRST section and pins at the add-header stack height (37 px); with a
 * live section present it sits below that section's 24 px header (37 + 24 = 61).
 */
const PREVIOUS_SECTION_TOP_WITH_LIVE = '61px';

/** Vertical-only scroll with the shipped thin scrollbar (UI/UX §1). */
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

// Reveal the per-row actions on row hover OR while any child has focus; keep
// them visible for the active row. Never colour-only / aria-hidden.
const actionReveal = {
  '& .terminal-session-kill, & .terminal-session-rename': { opacity: 0, transition: 'opacity 120ms' },
  '&:hover .terminal-session-kill, &:hover .terminal-session-rename': { opacity: 1 },
  '&:focus-within .terminal-session-kill, &:focus-within .terminal-session-rename': { opacity: 1 },
} as const;

const rowMotion = {
  transition: 'opacity 150ms ease',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
} as const;

/** A pinned section heading (`This window (N)` / `Previous (N)`). */
const SectionHeader: React.FC<{ testid: string; label: string; top: string }> = ({
  testid,
  label,
  top,
}) => (
  <Flex
    data-testid={testid}
    position="sticky"
    top={top}
    zIndex={1}
    h={SECTION_HEIGHT}
    minH={SECTION_HEIGHT}
    px={2}
    align="center"
    bg="bg.subtle"
  >
    <Text
      fontSize="xs"
      fontWeight="600"
      color="fg.subtle"
      textTransform="uppercase"
      letterSpacing="0.06em"
      truncate
    >
      {label}
    </Text>
  </Flex>
);

const LiveSessionRow: React.FC<{
  session: TerminalSessionInfo;
  sessions: readonly TerminalSessionInfo[];
  /** The name to render — the persisted record's title, else the derived title. */
  name: string;
  selected: boolean;
  /** Only the one roving-tabindex row is reachable by Tab. */
  focusable: boolean;
  /** The session has a persisted record, so its name is renamable (ST-3). */
  renamable: boolean;
  /** This row is the one being inline-renamed (sidebar-owned, ST-3). */
  editing: boolean;
  onStartRename: () => void;
  onEndRename: () => void;
  onRename: RenameHandler;
  onSelect: (id: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}> = ({
  session,
  sessions,
  name,
  selected,
  focusable,
  renamable,
  editing,
  onStartRename,
  onEndRename,
  onRename,
  onSelect,
  onClose,
  onKeyDown,
}) => {
  const rename = useSessionRename(session.id, name, editing, onRename, onEndRename);
  const isPending = session.id.startsWith('pending-');
  // The compact row shows a status WORD only for the non-nominal states; the
  // accessible name always carries it (never colour alone). A rename error
  // replaces the status word (the name itself reverts to the prior value).
  const statusWord = session.status === 'running' ? null : STATUS_LABEL[session.status];
  return (
    <chakra.li
      role="listitem"
      position="relative"
      display="flex"
      alignItems="center"
      m={0}
      p={0}
      data-testid={`terminal-session-row-${session.id}`}
      css={{ ...actionReveal, ...rowMotion }}
    >
      <chakra.button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-busy={isPending ? 'true' : undefined}
        aria-label={sessionAriaLabel(session, sessions, name)}
        title={name}
        tabIndex={focusable ? 0 : -1}
        h={ROW_HEIGHT}
        w="100%"
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
        onClick={() => onSelect(session.id)}
        onKeyDown={onKeyDown}
        _hover={{ bg: selected ? tint('var(--accent-primary)', 12) : 'var(--hover-bg)' }}
        _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '-2px' }}
      >
        <chakra.span
          boxSize="8px"
          borderRadius="full"
          flexShrink={0}
          bg={STATUS_DOT_COLOR[session.status]}
          aria-hidden="true"
        />
        <Icon
          as={sessionTypeIcon(String(session.cli))}
          boxSize="16px"
          flexShrink={0}
          color="fg.muted"
          aria-hidden="true"
        />
        <Text fontSize="sm" color="fg.default" truncate flex={1} minW={0}>
          {name}
        </Text>
        {rename.error && (
          <Text
            id={`terminal-session-rename-error-${session.id}`}
            data-testid={`terminal-session-rename-error-${session.id}`}
            fontSize="xs"
            color="fg.muted"
            flexShrink={0}
          >
            {rename.error}
          </Text>
        )}
        {!rename.error && statusWord && (
          <Text fontSize="xs" color="fg.muted" flexShrink={0}>
            {statusWord}
          </Text>
        )}
      </chakra.button>

      {renamable && !editing && (
        <IconButton
          className="terminal-session-rename"
          data-testid={`terminal-session-rename-${session.id}`}
          size="xs"
          variant="ghost"
          position="absolute"
          right="28px"
          top="50%"
          transform="translateY(-50%)"
          opacity={selected ? 1 : undefined}
          aria-label={`Rename session ${name}`}
          onClick={onStartRename}
          _hover={{ color: 'fg.default', background: 'var(--hover-bg)' }}
        >
          <Text as="span" fontSize="sm" aria-hidden="true">
            ⋯
          </Text>
        </IconButton>
      )}

      <IconButton
        className="terminal-session-kill"
        data-testid={`terminal-session-kill-${session.id}`}
        size="xs"
        variant="ghost"
        position="absolute"
        right="2px"
        top="50%"
        transform="translateY(-50%)"
        opacity={selected ? 1 : undefined}
        aria-label={`Close session ${name}`}
        onClick={() => onClose(session)}
        _hover={{ color: 'var(--status-error)', background: tint('var(--status-error)', 8) }}
      >
        <LuX size={14} />
      </IconButton>

      {editing && (
        // The edit overlay REPLACES the row's name visually while keeping the
        // PRESERVED row testid + `<button>` in the DOM (a `<button>` may not
        // contain a nested interactive input).
        <Flex
          position="absolute"
          inset={0}
          px={2}
          gap={2}
          align="center"
          bg="bg.subtle"
          borderLeft="3px solid"
          borderColor={selected ? 'var(--accent-strong)' : 'transparent'}
        >
          <chakra.span
            boxSize="8px"
            borderRadius="full"
            flexShrink={0}
            bg={STATUS_DOT_COLOR[session.status]}
            aria-hidden="true"
          />
          <SessionRenameField
            id={session.id}
            draft={rename.draft}
            error={rename.error}
            onChange={rename.setDraft}
            onCommit={rename.commit}
            onCancel={rename.cancel}
          />
        </Flex>
      )}
    </chakra.li>
  );
};

/** Focus the row's own focusable element (live rows wrap a `<button>`). */
function focusRow(id: string): void {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(
        `[data-testid="terminal-session-row-${id}"] button, [data-testid="terminal-previous-session-row-${id}"]`,
      )
      ?.focus();
  });
}

export interface TerminalSidebarProps {
  sessions: readonly TerminalSessionInfo[];
  previous: readonly PersistedTerminalSession[];
  /**
   * EVERY persisted record by id (not just the Previous group) — the single
   * source of truth for a session's name (Spec #2942 ST-3, SA §4).
   */
  persistedById: ReadonlyMap<string, PersistedTerminalSession>;
  selectedId: string | null;
  previousStateOf: (record: PersistedTerminalSession) => PreviousSessionState;
  onSelect: (id: string) => void;
  onClose: (session: TerminalSessionInfo) => void;
  /** Commit (or refuse) an inline rename; blank names never write (ST-3). */
  onRename: RenameHandler;
  onAdd: () => void;
  addButtonRef?: React.RefObject<HTMLButtonElement>;
}

export const TerminalSidebar: React.FC<TerminalSidebarProps> = ({
  sessions,
  previous,
  persistedById,
  selectedId,
  previousStateOf,
  onSelect,
  onClose,
  onRename,
  onAdd,
  addButtonRef,
}) => {
  // ST-3: exactly ONE row is inline-renamed at a time; the rename affordance and
  // F2 both open it. A live row with no persisted record (pending / failed
  // spawn) has no name to write, so it is not renamable.
  const [renameId, setRenameId] = useState<string | null>(null);
  const canRename = useCallback((id: string) => persistedById.has(id), [persistedById]);
  const handleStartRename = useCallback((id: string) => setRenameId(id), []);
  const handleEndRename = useCallback(() => setRenameId(null), []);

  // ONE roving tabindex across the combined live+previous order (§7): arrows
  // move the selection AND the focus (follow-focus), so exactly one row is
  // reachable by Tab.
  const orderedIds = [...sessions.map((s) => s.id), ...previous.map((r) => r.id)];
  const selectedIndex = selectedId ? orderedIds.indexOf(selectedId) : -1;
  const focusableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const handleRowKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    id: string,
  ): void => {
    // F2 is the keyboard power path to rename the focused row (ST-3 §2).
    if (event.key === 'F2') {
      if (!canRename(id)) return;
      event.preventDefault();
      handleStartRename(id);
      return;
    }
    if (orderedIds.length === 0) return;
    const index = orderedIds.indexOf(id);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = (index + 1) % orderedIds.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (index - 1 + orderedIds.length) % orderedIds.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = orderedIds.length - 1;
    }
    if (next === null) return;
    event.preventDefault();
    const targetId = orderedIds[next];
    onSelect(targetId);
    focusRow(targetId);
  };

  return (
    <chakra.nav
      data-testid="terminal-session-sidebar"
      aria-label="Terminal sessions"
      w={SIDEBAR_WIDTH}
      minW={SIDEBAR_WIDTH}
      flexShrink={0}
      h="100%"
      minH={0}
      bg="bg.subtle"
      borderRight="1px solid var(--border-color)"
      overflowY="auto"
      overflowX="hidden"
      css={thinScrollbar}
    >
      <Flex
        position="sticky"
        top={0}
        zIndex={2}
        bg="bg.subtle"
        borderBottom="1px solid var(--border-color)"
      >
        <chakra.button
          ref={addButtonRef}
          type="button"
          data-testid="terminal-session-sidebar-add"
          aria-label="Add session"
          h={ADD_HEIGHT}
          w="100%"
          flexShrink={0}
          px={2}
          gap={2}
          display="flex"
          alignItems="center"
          textAlign="left"
          cursor="pointer"
          color="fg.muted"
          bg="transparent"
          onClick={onAdd}
          _hover={{ color: 'fg.default', background: 'var(--hover-bg)' }}
          _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '-2px' }}
        >
          <LuPlus size={14} />
          <Text as="span" fontSize="sm" fontWeight="600" truncate>
            Add session
          </Text>
        </chakra.button>
      </Flex>

      {sessions.length > 0 && (
        <>
          <SectionHeader
            testid="terminal-session-sidebar-live-section"
            label={`This window (${sessions.length})`}
            top={FIRST_SECTION_TOP}
          />
          <chakra.ul role="list" aria-label="This window sessions" m={0} p={0} listStyleType="none">
            {sessions.map((session, index) => (
              <LiveSessionRow
                key={session.id}
                session={session}
                sessions={sessions}
                name={sessionDisplayTitle(session, sessions, persistedById)}
                selected={session.id === selectedId}
                focusable={index === focusableIndex}
                renamable={canRename(session.id)}
                editing={renameId === session.id}
                onStartRename={() => handleStartRename(session.id)}
                onEndRename={handleEndRename}
                onRename={onRename}
                onSelect={onSelect}
                onClose={onClose}
                onKeyDown={(event) => handleRowKeyDown(event, session.id)}
              />
            ))}
          </chakra.ul>
        </>
      )}

      {previous.length > 0 && (
        <>
          <SectionHeader
            testid="terminal-session-sidebar-previous-section"
            label={`Previous (${previous.length})`}
            top={sessions.length > 0 ? PREVIOUS_SECTION_TOP_WITH_LIVE : FIRST_SECTION_TOP}
          />
          <chakra.ul role="list" aria-label="Previous sessions" m={0} p={0} listStyleType="none">
            {previous.map((record, index) => (
              <PreviousSessionListItem
                key={record.id}
                record={record}
                state={previousStateOf(record)}
                selected={record.id === selectedId}
                focusable={sessions.length + index === focusableIndex}
                editing={renameId === record.id}
                onStartRename={() => handleStartRename(record.id)}
                onEndRename={handleEndRename}
                onRename={onRename}
                onSelect={onSelect}
                onKeyDown={(event) => handleRowKeyDown(event, record.id)}
              />
            ))}
          </chakra.ul>
        </>
      )}
    </chakra.nav>
  );
};
