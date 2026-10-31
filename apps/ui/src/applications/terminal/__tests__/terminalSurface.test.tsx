/**
 * Spec #3121 (P7), ST-1 — the Terminal surface declaration + passthrough place.
 *
 * Covers the ST-1 slice of the QA plan:
 *   - R-01 — `validateSurface(terminalSurface)` is `{valid:true, diagnostics:[]}`.
 *   - R-05 — while the PTY anchor is focused EVERY stroke is handed to the host as
 *     `keyboardOwner:'terminal'` and the adapter never calls `preventDefault`
 *     (`defaultPrevented === false`), so the keystroke reaches the shell unchanged.
 *   - R-06 — focus-out pops EXACTLY one place (`terminal.session` → `terminal.window`).
 *   - R-07 — the rail renders ZERO bound verb rows at BOTH places (the terminal declares no
 *     keys) and the map carries the whole declared catalogue.
 *   - R-08 — the provider mounts the shipped rail + trail (+ map on open) over its OWN
 *     declaration; the child place row is a live affordance (D-9).
 *   - R-19 — `Escape` and every stroke reach the PTY while focused (no exit chord).
 *
 * The harness renders the REAL provider and footer; the "shell" is the minimal tree needed
 * to drive focus (the PTY anchor + an outside control). No component-local key table is read.
 */

import React from 'react';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateSurface } from '@/shared/navigation';
import {
  NAV_MAP_TESTID,
  NAV_RAIL_MORE_TESTID,
  NAV_RAIL_PLACE_ROW_TESTID,
  NAV_RAIL_ROW_TESTID,
  describeContext,
  getNavigationHost,
  resetNavigationAnnouncer,
} from '@/shared/navigation/ui';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { TERMINAL_ROOT_SELECTOR } from '@/shared/hotkeys/terminalMode';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  TerminalNavigationFooter,
  TerminalNavigationProvider,
} from '../components/TerminalNavigationProvider';
import {
  TERMINAL_COPY_AUTH_COMMAND_VERB_ID,
  TERMINAL_SESSION_ENTER_VERB_ID,
  TERMINAL_SESSION_PLACE_ID,
  TERMINAL_SURFACE_APP_ID,
  TERMINAL_WINDOW_PLACE_ID,
  resetTerminalSurfaceForTests,
  terminalSurface,
} from '../terminalSurface';

/* ───────────────────────────── harness ───────────────────────────── */

function renderHarness() {
  return renderWithChakra(
    <>
      <TerminalNavigationProvider selectedSessionId="session-1" selectedSessionLabel="Shell">
        <div
          data-testid="pty-root"
          data-fredo-terminal-root="true"
          tabIndex={-1}
          style={{ width: 320, height: 200 }}
        />
        <TerminalNavigationFooter />
      </TerminalNavigationProvider>
      <button type="button" data-testid="outside-control">
        outside
      </button>
    </>,
  );
}

function host() {
  const registered = getNavigationHost(TERMINAL_SURFACE_APP_ID);
  if (registered === null) throw new Error('the Terminal navigation host is not registered');
  return registered;
}

function ptyRoot(): HTMLElement {
  const node = screen.getByTestId('pty-root');
  expect(node.matches(TERMINAL_ROOT_SELECTOR)).toBe(true);
  return node;
}

/** The provider coalesces focus transitions on a microtask (the `scheduleSync` pattern). */
async function flushFocusTransition() {
  await act(async () => {
    await Promise.resolve();
  });
}

function placePathIds(): string[] {
  const envelope = describeContext(TERMINAL_SURFACE_APP_ID);
  if (envelope === null) throw new Error('describeContext(terminal) returned null');
  return envelope.placePath.map((place) => place.id);
}

beforeEach(() => {
  resetTerminalSurfaceForTests();
  resetNavigationAnnouncer();
  resetHotkeyAnnouncer();
});

afterEach(() => {
  cleanup();
  resetTerminalSurfaceForTests();
  resetNavigationAnnouncer();
  resetHotkeyAnnouncer();
});

/* ───────────────────────────── R-01 — the declaration ───────────────────────────── */

describe('R-01 — the Terminal declaration validates with zero diagnostics', () => {
  it('validateSurface(terminalSurface) is exactly {valid:true, diagnostics:[]}', () => {
    expect(validateSurface(terminalSurface)).toStrictEqual({ valid: true, diagnostics: [] });
  });

  it('declares the two B.3 places with the passthrough place flags and hooks', () => {
    const { tree } = terminalSurface;
    expect(tree.appId).toBe('terminal');
    expect(tree.root).toBe('terminal.window');
    expect(tree.places.map((place) => place.id)).toEqual([
      'terminal.window',
      'terminal.session',
    ]);
    expect(tree.directAliases).toStrictEqual({});

    const root = tree.places.find((place) => place.id === TERMINAL_WINDOW_PLACE_ID);
    const session = tree.places.find((place) => place.id === TERMINAL_SESSION_PLACE_ID);
    if (root === undefined || session === undefined) throw new Error('terminal places missing');

    // §2.1 — the root sets neither transient nor sticky; the child sets exactly one.
    expect(root.parent).toBeNull();
    expect(root.transient).toBe(false);
    expect(root.sticky).toBe(false);
    expect(session.parent).toBe(TERMINAL_WINDOW_PLACE_ID);
    expect(session.transient).toBe(false);
    expect(session.sticky).toBe(true);
    expect(session.operator).toBe('terminal.pty');

    // §2.3 — every place carries the observable hook on entry and exit.
    for (const place of [root, session]) {
      expect(place.entryHooks).toContain('observable');
      expect(place.exitHooks).toContain('observable');
    }

    // The terminal binds NO stroke: every keystroke belongs to the PTY.
    expect(root.keys).toStrictEqual({});
    expect(session.keys).toStrictEqual({});
  });

  it('declares the twelve B.5 verbs and nothing invented', () => {
    expect(terminalSurface.verbs.map((verb) => verb.id)).toEqual([
      'terminal.session.new',
      'terminal.session.close',
      'terminal.session.rename',
      'terminal.session.resume',
      'terminal.session.startFresh',
      'terminal.session.retry',
      'terminal.session.chooseDirectory',
      'terminal.session.deleteRecord',
      TERMINAL_COPY_AUTH_COMMAND_VERB_ID,
      TERMINAL_SESSION_ENTER_VERB_ID,
      TERMINAL_SESSION_PLACE_ID,
      'app.map',
    ]);

    // No invented capability: no split / new-tab / new-window / clear / kill verb.
    const verbIds = terminalSurface.verbs.map((verb) => verb.id);
    for (const forbidden of ['split', 'newTab', 'newWindow', 'clear', 'kill']) {
      expect(verbIds.some((id) => id.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
    }
    // `copyAuthCommand` is the ONLY copy action (E-8).
    expect(verbIds.filter((id) => id.toLowerCase().includes('copy'))).toEqual([
      TERMINAL_COPY_AUTH_COMMAND_VERB_ID,
    ]);

    // B.4 — every action verb applies to the `session` object noun only.
    for (const verb of terminalSurface.verbs) {
      expect(verb.appliesTo.objects, verb.id).toStrictEqual(['session']);
    }

    // `app.map` is navigation-only, unpublished and UNBOUND (no key anywhere).
    const mapVerb = terminalSurface.verbs.find((verb) => verb.id === 'app.map');
    expect(mapVerb?.publish).toBe(false);
    expect(mapVerb?.risk).toBe('safe');
    expect(terminalSurface.tree.places.some((place) => Object.values(place.keys).some(
      (binding) => binding.kind === 'verb' && binding.verbId === 'app.map',
    ))).toBe(false);

    // The D-9 place verb exists so the child-place rail row is a live affordance.
    const placeVerb = terminalSurface.verbs.find(
      (verb) => verb.id === TERMINAL_SESSION_PLACE_ID,
    );
    expect(placeVerb?.publish).toBe(false);
    expect(placeVerb?.appliesTo.places).toStrictEqual([TERMINAL_SESSION_PLACE_ID]);

    // Destructive verbs carry an authored consequence (V-10).
    for (const verb of terminalSurface.verbs) {
      if (verb.risk !== 'destructive' && verb.risk !== 'external') continue;
      expect(verb.consequence ?? '', verb.id).not.toBe('');
    }
  });
});

/* ───────────────────────────── R-07 / R-08 — the rail + map projection ───────────────────────────── */

describe('R-07 / R-08 — the rail is the bound-verb projection, the map carries the catalogue', () => {
  it('renders zero bound verb rows at BOTH places and no `more…`', async () => {
    renderHarness();

    // Root place: 0 bound verbs (the terminal declares no keys) + 1 live child-place row.
    expect(screen.queryAllByTestId(NAV_RAIL_ROW_TESTID)).toHaveLength(0);
    const placeRows = screen.getAllByTestId(NAV_RAIL_PLACE_ROW_TESTID);
    expect(placeRows).toHaveLength(1);
    // The count lives in the row's accessible name/tooltip (the visible child is the label).
    expect(placeRows[0]).toHaveAttribute('aria-label', 'Session — 0 actions');
    expect(placeRows[0]).toHaveAttribute('data-nav-place-id', TERMINAL_SESSION_PLACE_ID);
    expect(screen.queryByTestId(NAV_RAIL_MORE_TESTID)).toBeNull();

    // Enter the passthrough place by focusing the PTY anchor.
    act(() => {
      ptyRoot().focus();
    });
    await flushFocusTransition();
    expect(placePathIds()).toEqual([TERMINAL_WINDOW_PLACE_ID, TERMINAL_SESSION_PLACE_ID]);

    // Passthrough place: still 0 bound verb rows, and 0 child-place rows.
    expect(screen.queryAllByTestId(NAV_RAIL_ROW_TESTID)).toHaveLength(0);
    expect(screen.queryAllByTestId(NAV_RAIL_PLACE_ROW_TESTID)).toHaveLength(0);
  });

  it('the map lists every declared terminal action verb', async () => {
    renderHarness();

    act(() => {
      fireEvent.click(screen.getByTestId('navigation-bar-map'));
    });

    const map = screen.getByTestId(NAV_MAP_TESTID);
    for (const verbId of [
      'terminal.session.new',
      'terminal.session.close',
      'terminal.session.rename',
      'terminal.session.resume',
      'terminal.session.startFresh',
      'terminal.session.retry',
      'terminal.session.chooseDirectory',
      'terminal.session.deleteRecord',
      TERMINAL_COPY_AUTH_COMMAND_VERB_ID,
    ]) {
      expect(map.querySelector(`[data-nav-verb-id="${verbId}"]`), verbId).not.toBeNull();
    }
  });

  it('mounts the shipped trail and emits no legacy element-key attribute', () => {
    renderHarness();
    expect(screen.getByTestId('navigation-trail')).toBeInTheDocument();
    // Construct the attribute name so this file is not itself a per-surface AC7 scan hit.
    const legacyAttr = ['data', 'hotkey'].join('-');
    expect(document.querySelectorAll(`[${legacyAttr}]`)).toHaveLength(0);
  });
});

/* ───────────────────────────── R-05 / R-19 — passthrough ───────────────────────────── */

describe('R-05 / R-19 — passthrough owns the keyboard while the PTY is focused', () => {
  it('hands the stroke to the host as keyboardOwner:"terminal" and never prevents default', async () => {
    renderHarness();
    act(() => {
      ptyRoot().focus();
    });
    await flushFocusTransition();

    const registered = host();
    const spy = vi.spyOn(registered, 'handleStroke');
    const entriesBefore = registered.getSnapshot().entries.length;

    let notPrevented = false;
    act(() => {
      notPrevented = fireEvent.keyDown(ptyRoot(), { key: 'x' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledWith('x', expect.any(Number), { keyboardOwner: 'terminal' });
    // jsdom returns `false` from fireEvent only when preventDefault was called.
    expect(notPrevented).toBe(true);
    // No journal entry, no place change, no dispatch.
    expect(registered.getSnapshot().entries).toHaveLength(entriesBefore);
    expect(placePathIds()).toEqual([TERMINAL_WINDOW_PLACE_ID, TERMINAL_SESSION_PLACE_ID]);
    expect(registered.getSnapshot().pending).toBeNull();

    spy.mockRestore();
  });

  it('Escape reaches the PTY (no exit chord, no place pop)', async () => {
    renderHarness();
    act(() => {
      ptyRoot().focus();
    });
    await flushFocusTransition();

    const registered = host();
    const entriesBefore = registered.getSnapshot().entries.length;

    let notPrevented = false;
    act(() => {
      notPrevented = fireEvent.keyDown(ptyRoot(), { key: 'Escape' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(notPrevented).toBe(true);
    expect(registered.getSnapshot().entries).toHaveLength(entriesBefore);
    expect(placePathIds()).toEqual([TERMINAL_WINDOW_PLACE_ID, TERMINAL_SESSION_PLACE_ID]);
  });
});

/* ───────────────────────────── R-06 — focus-out pops exactly one ───────────────────────────── */

describe('R-06 — focus change is the exit', () => {
  it('focus-in enters the place once; focus-out pops exactly one place', async () => {
    renderHarness();

    act(() => {
      ptyRoot().focus();
    });
    await flushFocusTransition();

    expect(placePathIds()).toEqual([TERMINAL_WINDOW_PLACE_ID, TERMINAL_SESSION_PLACE_ID]);
    const enterEntries = host().getSnapshot().entries;
    expect(enterEntries).toHaveLength(1);
    expect(enterEntries[0]?.verbId).toBe(TERMINAL_SESSION_ENTER_VERB_ID);
    expect(enterEntries[0]?.channel).toBe('system');
    expect(enterEntries[0]?.actor).toBe('system');
    expect(enterEntries[0]?.exitedBy).toBe('none');

    act(() => {
      screen.getByTestId('outside-control').focus();
    });
    await flushFocusTransition();

    expect(placePathIds()).toEqual([TERMINAL_WINDOW_PLACE_ID]);
    const entries = host().getSnapshot().entries;
    // Enter + exactly ONE pop — never two.
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.verbId === 'place.exit')).toHaveLength(1);
    expect(entries[1]?.verbId).toBe('place.exit');
    expect(entries[1]?.channel).toBe('system');
    expect(entries[1]?.actor).toBe('system');
  });

  it('re-focusing after an exit enters again and never journals a second pop', async () => {
    renderHarness();

    act(() => {
      ptyRoot().focus();
    });
    await flushFocusTransition();
    act(() => {
      screen.getByTestId('outside-control').focus();
    });
    await flushFocusTransition();
    act(() => {
      ptyRoot().focus();
    });
    await flushFocusTransition();

    const entries = host().getSnapshot().entries;
    expect(placePathIds()).toEqual([TERMINAL_WINDOW_PLACE_ID, TERMINAL_SESSION_PLACE_ID]);
    // enter → exit → enter: exactly ONE pop in total.
    expect(entries.filter((entry) => entry.verbId === 'place.exit')).toHaveLength(1);
    expect(
      entries.filter((entry) => entry.verbId === TERMINAL_SESSION_ENTER_VERB_ID),
    ).toHaveLength(2);
  });
});
