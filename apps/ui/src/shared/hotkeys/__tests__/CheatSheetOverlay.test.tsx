/**
 * Spec #2946 ST-14 — the app-wide hotkey cheat-sheet overlay (AC3 / F-31).
 *
 * Covers: the shipped `?` chord opening the overlay through the ONE engine, the
 * ST-16 `g g` row and the `?` row in the listing, search filtering + the empty
 * state, search focus on open, Escape closing + focus return to the invoker,
 * the close button, the shared announcer digest, the Vim-preset `@leader ?`
 * chord, and the non-goal that the overlay adds NO second document keydown
 * listener.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { getAnnouncement, resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { listHotkeyActions, resetRegistryForTests } from '@/shared/hotkeys/registry';
import { resetKeymapStoreForTests, setBinding, setLeader } from '@/shared/hotkeys/store';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import {
  getPendingPrefix,
  resetHotkeyEngineForTests,
} from '@/shared/hotkeys/engine';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';
import {
  CHEATSHEET_CLOSE_TESTID,
  CHEATSHEET_EMPTY_TESTID,
  CHEATSHEET_OVERLAY_TESTID,
  CHEATSHEET_ROW_TESTID,
  CHEATSHEET_SEARCH_TESTID,
  closeCheatSheet,
  getCheatSheetOpen,
  openCheatSheet,
  resetCheatSheetForTests,
} from '../CheatSheetOverlay';

const SRC = 'src/shared/hotkeys/CheatSheetOverlay.tsx';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function rowFor(actionId: string): HTMLElement {
  const row = screen
    .getAllByTestId(CHEATSHEET_ROW_TESTID)
    .find((candidate) => candidate.getAttribute('data-hotkey-action') === actionId);
  if (!row) throw new Error(`row not found: ${actionId}`);
  return row;
}

/** A focused, non-text, non-native-consumer element (context `default`). */
function mountInvoker(): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

function renderProvider(): void {
  renderWithChakra(
    <HotkeysProvider>
      <span data-testid="child" />
    </HotkeysProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetHotkeyAnnouncer();
  resetCheatSheetForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  resetHotkeyEngineForTests();
  resetHotkeyAnnouncer();
  resetCheatSheetForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── Open from the shipped `?` chord ──────────────────────────────────────────

describe('CheatSheetOverlay — opened by the shipped ? chord', () => {
  it('renders nothing until opened, then focuses the search', () => {
    renderProvider();
    expect(screen.queryByTestId(CHEATSHEET_OVERLAY_TESTID)).toBeNull();

    const invoker = mountInvoker();
    fireEvent.keyDown(invoker, { key: '?' });

    expect(screen.getByTestId(CHEATSHEET_OVERLAY_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(CHEATSHEET_SEARCH_TESTID)).toHaveFocus();
    expect(getCheatSheetOpen()).toBe(true);
    // The `?` chord is consumed by the engine (no native '?' reaches the page).
    expect(invoker).not.toHaveFocus();
  });

  it('opens via the Vim preset @leader ? chord', async () => {
    renderProvider();
    await act(async () => {
      await setLeader('space');
      await setBinding('fredo.help.cheatsheet', ['@leader ?']);
    });
    const invoker = mountInvoker();

    fireEvent.keyDown(invoker, { key: ' ' });
    expect(getPendingPrefix()).toBe('@leader');

    fireEvent.keyDown(invoker, { key: '?' });
    expect(screen.getByTestId(CHEATSHEET_OVERLAY_TESTID)).toBeInTheDocument();
  });
});

// ── Listing (ST-14 + the ST-16 g g row) ──────────────────────────────────────

describe('CheatSheetOverlay — listing', () => {
  it('shows the ? and g g bindings from the shipped defaults', () => {
    renderProvider();
    act(() => openCheatSheet());

    expect(rowFor('fredo.help.cheatsheet')).toHaveTextContent('?');

    const firstWindow = rowFor('fredo.window.first');
    expect(firstWindow).toHaveTextContent('Focus first window');
    const caps = within(firstWindow).getAllByTestId('hotkeys-keycap');
    expect(caps.map((cap) => cap.textContent)).toEqual(['G', 'G']);
    expect(firstWindow).toHaveAttribute('data-hotkey-tier', 'global');
  });

  it('groups the Fredo tier first with a Global tag', () => {
    renderProvider();
    act(() => openCheatSheet());

    const firstRow = screen.getAllByTestId(CHEATSHEET_ROW_TESTID)[0];
    expect(firstRow).toHaveAttribute('data-hotkey-group', 'fredo');
    expect(screen.getAllByTestId('hotkeys-cheatsheet-group')[0]).toHaveAttribute(
      'data-hotkey-group',
      'fredo',
    );
  });
});

// ── Search + empty state ─────────────────────────────────────────────────────

describe('CheatSheetOverlay — search', () => {
  it('filters on title / id / displayed key text and shows the empty state', () => {
    renderProvider();
    act(() => openCheatSheet());

    fireEvent.change(screen.getByTestId(CHEATSHEET_SEARCH_TESTID), {
      target: { value: 'launcher' },
    });
    expect(rowFor('fredo.launcher.toggle')).toBeInTheDocument();
    expect(screen.queryByTestId(CHEATSHEET_EMPTY_TESTID)).toBeNull();

    fireEvent.change(screen.getByTestId(CHEATSHEET_SEARCH_TESTID), {
      target: { value: 'g g' },
    });
    expect(rowFor('fredo.window.first')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId(CHEATSHEET_SEARCH_TESTID), {
      target: { value: 'zzznomatch' },
    });
    expect(screen.queryAllByTestId(CHEATSHEET_ROW_TESTID)).toHaveLength(0);
    const empty = screen.getByTestId(CHEATSHEET_EMPTY_TESTID);
    expect(empty).toHaveAttribute('role', 'status');
    expect(empty).toHaveTextContent('No hotkeys match "zzznomatch".');
  });
});

// ── Close paths + focus return ───────────────────────────────────────────────

describe('CheatSheetOverlay — close + focus return', () => {
  it('Escape closes and returns focus to the invoker', () => {
    renderProvider();
    const invoker = mountInvoker();
    fireEvent.keyDown(invoker, { key: '?' });

    const search = screen.getByTestId(CHEATSHEET_SEARCH_TESTID);
    fireEvent.keyDown(search, { key: 'Escape' });

    expect(screen.queryByTestId(CHEATSHEET_OVERLAY_TESTID)).toBeNull();
    expect(getCheatSheetOpen()).toBe(false);
    expect(invoker).toHaveFocus();
  });

  it('the close button closes the overlay', () => {
    renderProvider();
    act(() => openCheatSheet());
    fireEvent.click(screen.getByTestId(CHEATSHEET_CLOSE_TESTID));
    expect(screen.queryByTestId(CHEATSHEET_OVERLAY_TESTID)).toBeNull();
  });
});

// ── Announcer digest ─────────────────────────────────────────────────────────

describe('CheatSheetOverlay — shared announcer', () => {
  it('announces "Hotkey cheat sheet. N bindings." through the ONE channel', () => {
    renderProvider();
    act(() => openCheatSheet());

    const expected = listHotkeyActions().filter((action) => !action.invalid).length;
    expect(getAnnouncement()).toBe(`Hotkey cheat sheet. ${expected} bindings.`);
  });
});

// ── Non-goals / structure ────────────────────────────────────────────────────

describe('CheatSheetOverlay — structure audit', () => {
  it('adds NO second document keydown listener (the engine owns the chord)', () => {
    const code = stripComments(readFileSync(resolve(process.cwd(), SRC), 'utf8'));
    expect(code).not.toMatch(/document\.addEventListener\(\s*['"]keydown/);
  });

  it('renders a modal dialog root', () => {
    renderProvider();
    act(() => openCheatSheet());
    const overlay = screen.getByTestId(CHEATSHEET_OVERLAY_TESTID);
    expect(overlay).toHaveAttribute('role', 'dialog');
    expect(overlay).toHaveAttribute('aria-modal', 'true');
  });

  it('closeCheatSheet is idempotent', () => {
    renderProvider();
    act(() => openCheatSheet());
    act(() => closeCheatSheet());
    act(() => closeCheatSheet());
    expect(getCheatSheetOpen()).toBe(false);
  });
});
