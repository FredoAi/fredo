/**
 * Component tests for SessionHistoryDrawer — the Mission Monitor sidebar
 * session list (#2748 ST-4).
 *
 * Covers the AC-1 row surface (derived/custom/fallback display name + compact
 * start date-time, no `N deliveries` line) and the AC-2 inline rename
 * interaction (hover-revealed edit button, pre-filled input with select-all,
 * Enter saves / Escape cancels / empty reverts / blur commits, focus return to
 * the edit button, row keyboard operability).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionHistoryDrawer } from '../SessionHistoryDrawer';
import type { MissionMonitorSession } from '../../lib/graph';

afterEach(() => cleanup());

/** A session starting Mar 5, 2021 10:30 local — a fixed past date so the
 *  compact date-time deterministically appends the year (2021 ≠ current). */
function makeSession(overrides: Partial<MissionMonitorSession> & { sessionId: string }): MissionMonitorSession {
  return {
    label: `Fallback ${overrides.sessionId}`,
    startTime: new Date(2021, 2, 5, 10, 30).getTime(),
    latestTimestamp: '2021-03-05T10:30:00.000Z',
    deliveryCount: 3,
    ...overrides,
  };
}

interface DrawerTestProps {
  sessions: MissionMonitorSession[];
  selectedSessionId?: string | null;
  searchFilter?: string;
  open?: boolean;
  onSelect?: ReturnType<typeof vi.fn>;
  onDelete?: ReturnType<typeof vi.fn>;
  onRename?: ReturnType<typeof vi.fn>;
}

function renderDrawer(props: DrawerTestProps) {
  const onSelect = props.onSelect ?? vi.fn();
  const onDelete = props.onDelete ?? vi.fn();
  const onRename = props.onRename ?? vi.fn();
  const onToggle = vi.fn();
  const onSearchChange = vi.fn();
  const selectedSessionId = props.selectedSessionId ?? null;
  const open = props.open ?? true;
  const searchFilter = props.searchFilter ?? '';

  const ui = (
    <SessionHistoryDrawer
      sessions={props.sessions}
      filteredSessions={props.sessions}
      selectedSessionId={selectedSessionId}
      onSelect={onSelect}
      onDelete={onDelete}
      onToggle={onToggle}
      open={open}
      searchFilter={searchFilter}
      onSearchChange={onSearchChange}
      onRename={onRename}
    />
  );
  const result = render(ui);
  return {
    onSelect,
    onDelete,
    onRename,
    onToggle,
    onSearchChange,
    /** Re-render with a new sessions array (mirrors the hook updating after a rename). */
    rerender(sessions: MissionMonitorSession[]) {
      result.rerender(
        <SessionHistoryDrawer
          sessions={sessions}
          filteredSessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelect={onSelect}
          onDelete={onDelete}
          onToggle={onToggle}
          open={open}
          searchFilter={searchFilter}
          onSearchChange={onSearchChange}
          onRename={onRename}
        />,
      );
    },
  };
}

/** The rename input — disambiguated from the search textbox by its aria-label. */
function renameInput(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Session name' }) as HTMLInputElement;
}

/**
 * The edit button. FIX-2 (AC2-4): the control must be present in the a11y tree
 * WITHOUT hover — the resting state uses `opacity: 0` (not `visibility:hidden`,
 * which removed the control from the a11y tree + tab order and made the round-1
 * test fall back to a `getByTitle` workaround). `getByRole` succeeds at rest.
 */
function editButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Rename session' }) as HTMLButtonElement;
}

describe('SessionHistoryDrawer — #2748 session rows (AC1)', () => {
  it('renders the derived display name + compact start date-time, with NO "N deliveries" line (R-1.1/R-1.3)', () => {
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Derived Session Name' })] });

    const name = screen.getByTitle('Derived Session Name');
    expect(name.textContent).toBe('Derived Session Name');
    // 2021 ≠ current year → year appended.
    expect(screen.getByText('Mar 5, 10:30, 2021')).toBeDefined();
    // deliveryCount stays in the data model but is never rendered (R-1.3).
    expect(screen.queryByText(/deliveries/)).toBeNull();
    expect(screen.queryByText(/3 deliveries/)).toBeNull();
  });

  it('omits the year when the session started in the current year', () => {
    const now = new Date();
    const startTime = new Date(now.getFullYear(), 0, 15, 9, 5).getTime();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', startTime })] });

    expect(screen.getByText('Jan 15, 09:05')).toBeDefined();
    expect(screen.queryByText(/Jan 15, 09:05, \d{4}/)).toBeNull();
  });

  it('shows the timestamp-label fallback italicized for a session with no chat message (R-1.2)', () => {
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', label: 'No Chat Session' })] });

    const name = screen.getByTitle('No Chat Session');
    expect(name.textContent).toBe('No Chat Session');
    expect(name.style.fontStyle).toBe('italic');
    // The compact date-time sub-line still renders beneath it.
    expect(screen.getByText('Mar 5, 10:30, 2021')).toBeDefined();
  });

  it('renders a custom name at text-primary weight 600 (outranks derived) and a derived name at secondary/400', () => {
    renderDrawer({
      sessions: [
        makeSession({ sessionId: 's1', derivedName: 'Derived Only' }),
        makeSession({ sessionId: 's2', derivedName: 'Derived', customName: 'My Custom' }),
      ],
    });

    const derived = screen.getByTitle('Derived Only');
    expect(derived.style.color).toBe('var(--text-secondary)');
    expect(derived.style.fontWeight).toBe('400');
    expect(derived.style.fontStyle).toBe('normal');

    const custom = screen.getByTitle('My Custom');
    expect(custom.textContent).toBe('My Custom');
    expect(custom.style.color).toBe('var(--text-primary)');
    expect(custom.style.fontWeight).toBe('600');
  });

  it('carries the full display name in the title while the row truncates visually (long custom name)', () => {
    const longName = 'A'.repeat(60);
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', customName: longName })] });

    const name = screen.getByTitle(longName);
    expect(name).toBeDefined();
    expect(name.style.textOverflow).toBe('ellipsis');
    expect(name.style.whiteSpace).toBe('nowrap');
    expect(name.style.overflow).toBe('hidden');
  });
});

describe('SessionHistoryDrawer — inline rename (AC2)', () => {
  it('hides the edit button by default and reveals it on row hover (R-2.1)', () => {
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Hover Row' })] });

    const edit = editButton();
    const row = screen.getByRole('button', { name: 'Hover Row' });
    // Resting state: visually hidden via the .mm-row-edit-btn CSS class
    // (opacity 0 + pointer-events none) — NOT visibility:hidden (FIX-2 keeps
    // the control in the a11y tree + tab order while hidden).
    expect(getComputedStyle(edit).opacity).toBe('0');
    expect(getComputedStyle(edit).pointerEvents).toBe('none');

    fireEvent.mouseOver(row, { relatedTarget: document.body });
    expect(edit.style.opacity).toBe('1');

    fireEvent.mouseOut(row, { relatedTarget: document.body });
    expect(getComputedStyle(edit).opacity).toBe('0');
  });

  it('is present in the a11y tree WITHOUT hover — getByRole finds it at rest (FIX-2 / AC2-4)', () => {
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'A11y Row' })] });

    // QA Q-3 contract: the rename control must be keyboard-reachable without
    // hovering. The round-1 test used getByTitle as a workaround for the
    // visibility:hidden state — that state is exactly the defect; FIX-2 removes
    // it, so the control is findable by role with no hover/focus at all.
    const edit = screen.getByRole('button', { name: 'Rename session' });
    expect(edit).toBeDefined();
    expect(edit.className).toBe('mm-row-edit-btn');
  });

  it('is in the tab order at rest — Tab reaches it without hover or focus (FIX-2 / AC2-4)', async () => {
    const user = userEvent.setup();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Tab Row' })] });

    const edit = editButton();
    expect(getComputedStyle(edit).opacity).toBe('0'); // hidden by default

    // Tab cycles the whole drawer from document.body: Close → search → row →
    // edit → delete. The edit button participates in the tab order WITHOUT any
    // hover or focus (the round-1 defect: visibility:hidden skipped it).
    let reachedEdit = false;
    for (let i = 0; i < 8; i++) {
      await user.tab();
      if (document.activeElement === edit) {
        reachedEdit = true;
        break;
      }
    }
    expect(reachedEdit).toBe(true);
  });

  it('reveals the edit button when the row receives keyboard focus (focus-within without hover)', () => {
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Focus Row' })] });

    const edit = editButton();
    const row = screen.getByRole('button', { name: 'Focus Row' });
    expect(getComputedStyle(edit).opacity).toBe('0');

    act(() => { row.focus(); });
    expect(edit.style.opacity).toBe('1');
  });

  it('opens an inline rename field pre-filled with the display name, focused with select-all (R-2.2)', () => {
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Current Name' })] });

    fireEvent.click(editButton());

    const input = renameInput();
    expect(input).toBeDefined();
    expect(input.value).toBe('Current Name');
    expect(input.title).toBe('Enter to save, Esc to cancel');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Current Name'.length);
  });

  it('commits on Enter — calls onRename and the displayed name updates (R-2.3)', () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const d = renderDrawer({
      sessions: [makeSession({ sessionId: 's1', derivedName: 'Original Name' })],
      onRename,
    });

    fireEvent.click(editButton());
    const input = renameInput();
    fireEvent.change(input, { target: { value: 'My Custom Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('s1', 'My Custom Name');
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull();

    // The hook updates persisted state → the drawer re-renders with the
    // custom name set and the precedence rule surfaces it.
    d.rerender([makeSession({ sessionId: 's1', derivedName: 'Original Name', customName: 'My Custom Name' })]);
    const name = screen.getByTitle('My Custom Name');
    expect(name.textContent).toBe('My Custom Name');
    expect(name.style.color).toBe('var(--text-primary)');
    expect(name.style.fontWeight).toBe('600');
  });

  it('cancels on Escape — discards the edit and restores the prior name (R-2.5)', () => {
    const onRename = vi.fn();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Original Name' })], onRename });

    fireEvent.click(editButton());
    const input = renameInput();
    fireEvent.change(input, { target: { value: 'Changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull();
    expect(screen.getByTitle('Original Name')).toBeDefined();
  });

  it('silently reverts on an empty/whitespace commit — never persists an empty custom name', () => {
    const onRename = vi.fn();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Original Name' })], onRename });

    fireEvent.click(editButton());
    const input = renameInput();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull();
    expect(screen.getByTitle('Original Name')).toBeDefined();
  });

  it('commits on blur (Tab-or-blur saves — Q-2 default)', () => {
    const onRename = vi.fn();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Original Name' })], onRename });

    fireEvent.click(editButton());
    const input = renameInput();
    fireEvent.change(input, { target: { value: 'Blur Save' } });
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('s1', 'Blur Save');
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull();
  });

  it('returns focus to the edit button after commit (AC-2 a11y — no focus loss)', async () => {
    const onRename = vi.fn();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Original Name' })], onRename });

    const edit = editButton();
    fireEvent.click(edit);
    const input = renameInput();
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('s1', 'New Name');

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(edit);
  });

  it('supports renaming the currently selected session — selection styling preserved (AC2-1)', () => {
    const onRename = vi.fn();
    renderDrawer({
      sessions: [makeSession({ sessionId: 's1', derivedName: 'Selected Name' })],
      selectedSessionId: 's1',
      onRename,
    });

    const row = screen.getByRole('button', { name: 'Selected Name' });
    expect(row.style.background).toBe('var(--accent-primary)15');
    expect(row.style.borderLeft).toBe('2px solid var(--accent-primary)');

    fireEvent.click(editButton());
    const input = renameInput();
    expect(input.value).toBe('Selected Name');
    fireEvent.change(input, { target: { value: 'Renamed Selected' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('s1', 'Renamed Selected');
    // Selected row still renders its accent tint after the rename closes.
    expect(screen.getByRole('button', { name: 'Selected Name' }).style.background).toBe('var(--accent-primary)15');
  });

  it('clicks on the rename input do not select the row (stopPropagation — AC2-1)', () => {
    const onSelect = vi.fn();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Row Name' })], onSelect });

    fireEvent.click(editButton());
    const input = renameInput();
    fireEvent.click(input);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('SessionHistoryDrawer — row keyboard operability + delete (a11y NFR)', () => {
  it('selects the session on row click and via Enter/Space on the focused row', () => {
    const onSelect = vi.fn();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Row Name' })], onSelect });

    const row = screen.getByRole('button', { name: 'Row Name' });
    expect(row.tabIndex).toBe(0);

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('s1');

    act(() => { row.focus(); });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(row, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it('keeps the delete control working — stopPropagation prevents row selection', () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    renderDrawer({ sessions: [makeSession({ sessionId: 's1', derivedName: 'Row Name' })], onDelete, onSelect });

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('s1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('supports the pure-keyboard rename flow end to end — Tab to edit → Enter opens → type → Enter saves → focus returns (AC2-4)', async () => {
    const onRename = vi.fn();
    const user = userEvent.setup();
    renderDrawer({
      sessions: [makeSession({ sessionId: 's1', derivedName: 'Keyboard Row' })],
      onRename,
    });

    const row = screen.getByRole('button', { name: 'Keyboard Row' });
    const edit = editButton();
    expect(getComputedStyle(edit).opacity).toBe('0');

    // Tab reaches the row (tabIndex 0) → the edit button is revealed without
    // any mouse hover (focus-within).
    act(() => { row.focus(); });
    expect(edit.style.opacity).toBe('1');

    // Next Tab lands on the edit button (it is in the tab order at rest).
    await user.tab();
    expect(document.activeElement).toBe(edit);

    // Enter on the focused edit button opens the inline field with focus +
    // select-all.
    await user.keyboard('{Enter}');
    const input = renameInput();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Keyboard Row');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Keyboard Row'.length);

    // Typing replaces the selected text; Enter saves.
    await user.keyboard('Typed Name');
    expect(input.value).toBe('Typed Name');
    await user.keyboard('{Enter}');
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('s1', 'Typed Name');

    // Focus returns to the edit button after commit (AC-2: no focus loss).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(edit);
  });

  it('cancels the pure-keyboard flow with Escape — restores the prior name and returns focus to the edit button', async () => {
    const onRename = vi.fn();
    const user = userEvent.setup();
    renderDrawer({
      sessions: [makeSession({ sessionId: 's1', derivedName: 'Original Name' })],
      onRename,
    });

    const row = screen.getByRole('button', { name: 'Original Name' });
    const edit = editButton();
    act(() => { row.focus(); });
    await user.tab(); // → edit button
    expect(document.activeElement).toBe(edit);

    await user.keyboard('{Enter}'); // opens the inline field
    const input = renameInput();
    await user.keyboard('Changed'); // type unsaved text
    await user.keyboard('{Escape}'); // cancel

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull();
    expect(screen.getByTitle('Original Name')).toBeDefined();

    // Focus returns to the edit button after cancel (AC-2: no focus loss).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(edit);
  });
});
