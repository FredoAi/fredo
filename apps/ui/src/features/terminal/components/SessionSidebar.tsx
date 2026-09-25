import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IconType } from 'react-icons';
import { LuChevronRight, LuGithub, LuSquareTerminal, LuTerminal } from 'react-icons/lu';
import { chakra, Flex, Icon, IconButton, Text } from '@chakra-ui/react';
import { tint } from '../../../shared/utils/colorTint';
import {
  PREVIOUS_STATE_LABEL,
  RENAME_EMPTY_MESSAGE,
  RENAME_MAX_LENGTH,
  lastActiveAbsolute,
  lastActiveLabel,
  persistedAriaLabel,
  type PersistedTerminalSession,
  type PreviousSessionState,
  type RenameHandler,
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
 * PRESERVED verbatim (C-3). Spec #2942 ST-3 adds the per-row rename affordance
 * (`terminal-session-rename-<id>`) and the shared inline edit field.
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

// ── Inline rename (Spec #2942 ST-3 §2) ───────────────────────────────────────
//
// ONE implementation shared by a live row (`TerminalSidebar`) and a previous row
// (`PreviousSessionListItem`). The name is the session's ONLY editable field.

/**
 * The inline session-name field: `chakra.input` with `aria-label="Session
 * name"`, autofocus + select-all, `maxLength=64`; Enter/blur commits, Esc
 * cancels with NO write. The inline error node is `aria-describedby`-linked.
 */
export const SessionRenameField: React.FC<{
  id: string;
  draft: string;
  error: string | null;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}> = ({ id, draft, error, onChange, onCommit, onCancel }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus + select-all on mount (the swap replaces a select affordance).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <>
      <chakra.input
        ref={inputRef}
        type="text"
        value={draft}
        maxLength={RENAME_MAX_LENGTH}
        data-testid={`terminal-session-rename-input-${id}`}
        aria-label="Session name"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `terminal-session-rename-error-${id}` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={onCommit}
        h="24px"
        w="100%"
        minW={0}
        flex={1}
        px={1}
        fontSize="sm"
        bg="bg.surface"
        color="fg.default"
        borderWidth="1px"
        borderColor={error ? 'var(--status-error)' : 'var(--border-color)'}
        borderRadius="sm"
        _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '-2px' }}
      />
      {error && (
        <Text
          id={`terminal-session-rename-error-${id}`}
          data-testid={`terminal-session-rename-error-${id}`}
          fontSize="xs"
          color="fg.muted"
          flexShrink={0}
        >
          {error}
        </Text>
      )}
    </>
  );
};

/**
 * Per-row inline-rename state (Spec #2942 ST-3 §2). Entering the edit re-seeds
 * the draft from the CURRENT name; a `false` result from `onRename` reverts to
 * the prior name and surfaces the inline error — the handler refuses a blank
 * name BEFORE it writes, so a revert is always a no-write (R-2.3).
 */
export function useSessionRename(
  id: string,
  name: string,
  editing: boolean,
  onRename: RenameHandler,
  onEndEdit: () => void,
): {
  draft: string;
  error: string | null;
  setDraft: (value: string) => void;
  commit: () => void;
  cancel: () => void;
} {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  // Enter commits AND blurs (the field unmounts) — commit exactly once.
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    finishedRef.current = false;
    setDraft(name);
    setError(null);
  }, [editing, name]);

  const commit = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onEndEdit();
    void Promise.resolve(onRename(id, draft)).then((result) => {
      if (result.ok) {
        setError(null);
        return;
      }
      setDraft(name);
      setError(result.message ?? RENAME_EMPTY_MESSAGE);
    });
  }, [draft, id, name, onEndEdit, onRename]);

  const cancel = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onEndEdit();
    setDraft(name);
    setError(null);
  }, [name, onEndEdit]);

  return { draft, error, setDraft, commit, cancel };
}

/** The row-action reveal (hover / focus-within; never colour-only). */
const actionReveal = {
  '& .terminal-session-rename': { opacity: 0, transition: 'opacity 120ms' },
  '&:hover .terminal-session-rename': { opacity: 1 },
  '&:focus-within .terminal-session-rename': { opacity: 1 },
} as const;

/** The rename trigger's glyph — the UI/UX §2 kebab. */
const KEBAB = '⋯';

export const PreviousSessionListItem: React.FC<{
  record: PersistedTerminalSession;
  state: PreviousSessionState;
  selected: boolean;
  /** Only the one roving-tabindex row is reachable by Tab (Spec #2942 §7). */
  focusable?: boolean;
  /** Spec #2942 ST-3: the inline-rename state, owned by the sidebar. */
  editing?: boolean;
  onStartRename?: () => void;
  onEndRename?: () => void;
  onRename?: RenameHandler;
  onSelect: (id: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}> = ({
  record,
  state,
  selected,
  focusable = false,
  editing = false,
  onStartRename,
  onEndRename,
  onRename,
  onSelect,
  onKeyDown,
}) => {
  const { draft, error, setDraft, commit, cancel } = useSessionRename(
    record.id,
    record.title,
    editing,
    onRename ?? (() => ({ ok: true })),
    onEndRename ?? (() => {}),
  );
  const renamable = !!onRename && !!onStartRename;

  return (
    <chakra.li
      role="listitem"
      position="relative"
      m={0}
      p={0}
      css={{ ...previousRowMotion, ...actionReveal }}
    >
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
          id={error ? `terminal-session-rename-error-${record.id}` : undefined}
          data-testid={error ? `terminal-session-rename-error-${record.id}` : undefined}
          title={error ?? lastActiveAbsolute(record.lastActiveAt)}
        >
          {error ?? lastActiveLabel(record.lastActiveAt)}
        </Text>
        <Icon as={LuChevronRight} boxSize="14px" color="fg.subtle" flexShrink={0} />
      </chakra.button>

      {renamable && !editing && (
        <IconButton
          className="terminal-session-rename"
          data-testid={`terminal-session-rename-${record.id}`}
          size="xs"
          variant="ghost"
          position="absolute"
          right="2px"
          top="50%"
          transform="translateY(-50%)"
          opacity={selected ? 1 : undefined}
          aria-label={`Rename session ${record.title}`}
          onClick={onStartRename}
          _hover={{ color: 'fg.default', background: 'var(--hover-bg)' }}
        >
          <Text as="span" fontSize="sm" aria-hidden="true">
            {KEBAB}
          </Text>
        </IconButton>
      )}

      {editing && (
        // The edit overlay REPLACES the row's name visually while keeping the
        // preserved row testid/aria-current in the DOM (a `<button>` may not
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
          <Icon
            as={sessionTypeIcon(String(record.cli))}
            boxSize="16px"
            flexShrink={0}
            color="fg.muted"
            aria-hidden="true"
          />
          <SessionRenameField
            id={record.id}
            draft={draft}
            error={error}
            onChange={setDraft}
            onCommit={commit}
            onCancel={cancel}
          />
        </Flex>
      )}
    </chakra.li>
  );
};
