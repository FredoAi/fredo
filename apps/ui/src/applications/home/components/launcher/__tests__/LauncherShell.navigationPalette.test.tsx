/**
 * Spec #3120 (P6), ST-6 — `LauncherShell` navigation integration (UI/UX §1–§5).
 *
 * Pins the shell on the shipped ST-1/ST-4 seams + ST-5 modules:
 *   1. the context header renders from the FRESH envelope before typing, and `>` switches
 *      the ONE results region to the ST-5 navigation palette (never the shipped list);
 *   2. Enter routes through `resolveLauncherRoute` → `host.runIntent` (one funnel, no
 *      `runHotkeyAction` in the navigation source);
 *   3. an unavailable row is a selectable no-op that announces the reason;
 *   4. the close/stay matrix (navigation stays, mutation closes, rejected/noop/failed stay
 *      with the response line, canceled-confirmation stays silently);
 *   5. Cmd/Ctrl+K opens / toggles the level-2 actions, and the Esc stack pops one level
 *      per press before the shipped close + focus restore;
 *   6. the confirmation host accepts/cancels through the ST-1 store (cancel mutates
 *      nothing);
 *   7. undo-by-description dispatches `journal.undo` with the matched args; a miss renders
 *      the clarify line;
 *   8. `/ Ask` raises the launcher, focuses the input and keeps the context header;
 *   9. the ONE announcer carries the focused-row / secondary / response text;
 *  10. the no-surface launcher renders NONE of it (byte-identical shipped branches).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';
import { registerFredoAction, resetRegistryForTests } from '@/shared/hotkeys/registry';
import { resetKeymapStoreForTests } from '@/shared/hotkeys/store';
import { resetHotkeyEngineForTests } from '@/shared/hotkeys/engine';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { FredoApplicationClass } from '@/shared/classes/FredoApplicationClass';
import type { WindowEntry } from '@/shared/window-system/windowTypes';
import {
  NOTHING_TO_UNDO,
  createJournalStore,
  type ConfirmationRequest,
  type Intent,
  type JournalStore,
} from '@/shared/navigation';
import {
  createNavigationHost,
  requestLauncherConfirmation,
  requestLauncherOpen,
  registerNavigationHost,
  type NavigationHost,
} from '@/shared/navigation/ui';
import {
  FIXTURE_APP_ID,
  FIXTURE_PLACES,
  fixtureSnapshot,
  navTestSurface,
  seedEntries,
} from '@/shared/navigation/ui/__tests__/fixtures';
import { LauncherShell } from '../LauncherShell';
import { UNDO_NO_MATCH_COPY } from '../launcherUndoQuery';
import {
  LAUNCHER_ACTION_KIND_ATTR,
  LAUNCHER_ANNOUNCER_LABEL,
  LAUNCHER_CONTEXT_TESTID,
  LAUNCHER_CONTEXT_ARIA_LABEL,
  LAUNCHER_CONTEXT_PATH_TESTID,
  LAUNCHER_CONTEXT_SELECTION_TESTID,
  LAUNCHER_CONTEXT_VERB_TESTID,
  LAUNCHER_CONFIRMATION_ACCEPT_TESTID,
  LAUNCHER_CONFIRMATION_CANCEL_TESTID,
  LAUNCHER_CONFIRMATION_TESTID,
  LAUNCHER_PALETTE_ANNOUNCER_TESTID,
  LAUNCHER_PALETTE_LIST_TESTID,
  LAUNCHER_PALETTE_ROW_TESTID,
  LAUNCHER_PALETTE_SECONDARY_ITEM_TESTID,
  LAUNCHER_PALETTE_SECONDARY_TESTID,
  LAUNCHER_RESPONSE_ATTR,
  LAUNCHER_RESPONSE_CODE_ATTR,
  LAUNCHER_RESPONSE_TESTID,
} from '../launcherConstants';

/* ───────────────────────────── module mocks ───────────────────────────── */

// LauncherShell reads the live connection flag via useConnectionStatus (no StreamProvider in
// this isolated harness) — stub the one consumer.
vi.mock('@/shared/contexts/StreamContext', () => ({
  useConnectionStatus: () => ({ isConnected: true }),
  useStreamHealth: () => ({ health: 'healthy', isConnected: true }),
}));

const companionMock = vi.hoisted(() => ({
  current: {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    replyInFlight: false,
    queuedSendCount: 0,
  },
}));
vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => companionMock.current,
}));

const companionDispatchMock = vi.hoisted(() => ({
  askActiveCompanion: vi.fn((_text: string, _options?: unknown) => ({
    outcome: 'dispatched' as const,
  })),
  askActiveCompanionWithAudio: vi.fn((_clip: string, _options?: unknown) => ({
    outcome: 'dispatched' as const,
  })),
}));
vi.mock('@/shared/components/companion', () => ({
  CompanionEntity: () => null,
  askActiveCompanion: companionDispatchMock.askActiveCompanion,
  askActiveCompanionWithAudio: companionDispatchMock.askActiveCompanionWithAudio,
}));

// The own-kernel window list is controlled per test (the ACTIVE app id is the focused,
// non-minimized window); the actions context (only read by the Open-apps row) is stubbed.
const windowsMock = vi.hoisted(() => ({ current: [] as WindowEntry[] }));
vi.mock('@/shared/window-system/useWindows', () => ({
  useWindows: () => windowsMock.current,
}));
const windowActionsMock = vi.hoisted(() => ({
  openWindow: vi.fn(),
  closeWindow: vi.fn(),
  updateWindow: vi.fn(),
  focusWindow: vi.fn(),
}));
vi.mock('@/shared/window-system/useWindowActions', () => ({
  useWindowActions: () => windowActionsMock,
}));

/* ───────────────────────────── harness ───────────────────────────── */

type BarField = HTMLInputElement | HTMLTextAreaElement;

const APP = { id: 'settings', name: 'Settings', icon: () => null } as unknown as FredoApplicationClass;

const disposers: Array<() => void> = [];

interface HostOptions {
  readonly journal?: JournalStore;
  readonly confirm?: (request: ConfirmationRequest, intent: Intent) => boolean | Promise<boolean>;
}

function makeHost(options: HostOptions = {}): {
  host: NavigationHost;
  journal: JournalStore;
} {
  const surface = navTestSurface();
  const journal = options.journal ?? createJournalStore();
  const host = createNavigationHost({
    surface,
    getContext: () => fixtureSnapshot([FIXTURE_PLACES.canvas]),
    journal,
    now: () => '2026-01-01T09:00:00.000Z',
    applyPatch: () => undefined,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
  disposers.push(registerNavigationHost({ appId: FIXTURE_APP_ID, surface, host }));
  return { host, journal };
}

function focusWindow(id: string | null, isMinimized = false): void {
  windowsMock.current =
    id === null
      ? []
      : [
          {
            id,
            title: id,
            icon: null as unknown as React.ReactNode,
            component: null as unknown as React.ReactNode,
            canClose: true,
            canMaximize: true,
            canMinimize: true,
            isMaximized: false,
            isMinimized,
            focused: true,
            zIndex: 1,
          },
        ];
}

function renderShell(features: FredoApplicationClass[] = [APP]): void {
  renderWithChakra(
    <HotkeysProvider>
      <LauncherShell showableFeatures={features} onOpenFeature={vi.fn()} />
    </HotkeysProvider>,
  );
}

/**
 * R-9.2 live lever — replace the shipped `false` stub AFTER the shell mounted. The hook must
 * re-read the current `matchMedia` on the next render (the palette/confirmation are mounted at
 * app start, so a mount-time read alone can never observe this).
 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

const input = (): BarField => screen.getByRole('searchbox') as BarField;

const type = (value: string): void => {
  act(() => {
    fireEvent.change(input(), { target: { value } });
  });
};

const keyDown = (key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    fireEvent.keyDown(input(), { key, ...init });
  });
};

const ctrlSpace = (): void => {
  act(() => {
    fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
  });
};

/** Press Enter and let the (async) host dispatch settle. */
const pressEnter = async (): Promise<void> => {
  await act(async () => {
    fireEvent.keyDown(input(), { key: 'Enter' });
    await Promise.resolve();
  });
};

const announcer = (): HTMLElement => screen.getByTestId(LAUNCHER_PALETTE_ANNOUNCER_TESTID);
const responseLine = (): HTMLElement | null =>
  screen.queryByTestId(LAUNCHER_RESPONSE_TESTID);

const rowFor = (verbId: string): HTMLElement | null =>
  screen
    .queryAllByTestId(LAUNCHER_PALETTE_ROW_TESTID)
    .find((row) => row.getAttribute('data-nav-verb-id') === verbId) ?? null;

beforeEach(() => {
  windowsMock.current = [];
  resetRegistryForTests();
  resetKeymapStoreForTests();
  companionMock.current = {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    replyInFlight: false,
    queuedSendCount: 0,
  };
  companionDispatchMock.askActiveCompanion.mockReset();
  companionDispatchMock.askActiveCompanion.mockReturnValue({ outcome: 'dispatched' });
  companionDispatchMock.askActiveCompanionWithAudio.mockReset();
  companionDispatchMock.askActiveCompanionWithAudio.mockReturnValue({ outcome: 'dispatched' });
  adapterBridge.setInvoke((async () => undefined) as never);
  adapterBridge.setListen((async () => () => {}) as never);
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  resetHotkeyEngineForTests();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ───────────────────────────── 1–2. header + source switch ───────────────────────────── */

describe('LauncherShell — navigation context header + source switch (R-1.1/R-2.1)', () => {
  it('renders the context header from the fresh envelope BEFORE typing', () => {
    makeHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();

    ctrlSpace();

    const header = screen.getByTestId(LAUNCHER_CONTEXT_TESTID);
    expect(header).toHaveAttribute('role', 'group');
    expect(header).toHaveAttribute('aria-label', LAUNCHER_CONTEXT_ARIA_LABEL);
    expect(screen.getByTestId(LAUNCHER_CONTEXT_PATH_TESTID)).toHaveTextContent('Canvas');
    // No selection in the fixture snapshot ⇒ the selection segment is absent (never "0 selected").
    expect(screen.queryByTestId(LAUNCHER_CONTEXT_SELECTION_TESTID)).toBeNull();

    const chips = screen.getAllByTestId(LAUNCHER_CONTEXT_VERB_TESTID);
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.getAttribute('data-nav-verb-id'))).toEqual([
      'test.create',
      'test.edit',
      'test.arrange',
    ]);
  });

  it('`>` switches the results region to the navigation palette (not the shipped list)', () => {
    makeHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();

    type('>rect');

    expect(screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID)).toBeInTheDocument();
    expect(screen.queryByTestId('launcher-action-list')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(rowFor('test.rect')).not.toBeNull();
  });

  it('a plain query sends the FRESH context envelope to the companion (R-2.2)', async () => {
    companionMock.current.state.isVisible = true;
    makeHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();

    type('make it nicer');
    await pressEnter();

    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledTimes(1);
    const [text, options] = companionDispatchMock.askActiveCompanion.mock.calls[0];
    expect(text).toBe('make it nicer');
    const context = (options as { context?: { appId: string; placePath: Array<{ label: string }> } })
      ?.context;
    expect(context?.appId).toBe(FIXTURE_APP_ID);
    expect(context?.placePath[0]?.label).toBe('Canvas');
    // The results region never becomes a chat transcript — the header remains the proof.
    expect(screen.getByTestId(LAUNCHER_CONTEXT_TESTID)).toBeInTheDocument();
  });

  it('exposes exactly ONE announcer and announces the focused row on every move', () => {
    makeHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();

    type('>');
    const list = screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID);
    expect(list).toHaveAttribute('role', 'listbox');
    expect(screen.getAllByTestId(LAUNCHER_PALETTE_ANNOUNCER_TESTID)).toHaveLength(1);
    expect(announcer()).toHaveAttribute('role', 'status');
    expect(announcer()).toHaveAttribute('aria-live', 'polite');
    expect(announcer()).toHaveAttribute('aria-label', LAUNCHER_ANNOUNCER_LABEL);

    const selected = (): HTMLElement =>
      screen
        .getAllByTestId(LAUNCHER_PALETTE_ROW_TESTID)
        .find((row) => row.getAttribute('aria-selected') === 'true')!;

    expect(announcer()).toHaveTextContent(selected().getAttribute('aria-label')!);
    keyDown('ArrowDown');
    expect(announcer()).toHaveTextContent(selected().getAttribute('aria-label')!);
  });
});

/* ───────────────────────── 3–4. Enter funnel + close/stay matrix ───────────────────────── */

describe('LauncherShell — Enter through the ONE navigation funnel (R-3.1/R-4.2)', () => {
  it('runs the focused row through host.runIntent (never a hotkey action) and closes on a mutation', async () => {
    const hotkeyRun = vi.fn();
    registerFredoAction({
      actionId: 'fredo.test.nav',
      title: 'Navigation test action',
      description: 'never runs from the navigation palette',
      defaultSequence: 'primary+t',
      run: hotkeyRun,
    });
    const { host, journal } = makeHost();
    const runSpy = vi.spyOn(host, 'runIntent');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    focusWindow(FIXTURE_APP_ID);
    renderShell();

    ctrlSpace();
    type('>rect');
    await pressEnter();

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toMatchObject({
      verbId: 'test.rect',
      args: {},
      channel: 'launcher',
      actor: 'human',
    });
    expect(hotkeyRun).not.toHaveBeenCalled();
    expect(journal.entries()).toHaveLength(1);
    expect(journal.entries()[0]).toMatchObject({
      verbId: 'test.rect',
      effect: 'mutation',
      channel: 'launcher',
      actor: 'human',
    });
    // Mutation ⇒ close + focus restore to the pre-open element.
    await waitFor(() => expect(screen.queryByTestId(LAUNCHER_CONTEXT_TESTID)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(outside));
  });

  it('navigates, STAYS open, refreshes the header and announces the new place', async () => {
    const { journal } = makeHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();

    ctrlSpace();
    expect(screen.getByTestId(LAUNCHER_CONTEXT_PATH_TESTID)).toHaveTextContent('Canvas');
    type('>create');
    await pressEnter();

    // The launcher stays open; the fresh envelope names the entered place (one host epoch).
    await waitFor(() =>
      expect(screen.getByTestId(LAUNCHER_CONTEXT_PATH_TESTID)).toHaveTextContent(
        'Canvas › Create',
      ),
    );
    expect(journal.entries()).toHaveLength(1);
    expect(journal.entries()[0]).toMatchObject({
      verbId: 'test.create',
      effect: 'navigation',
      channel: 'launcher',
      actor: 'human',
    });
    expect(announcer().textContent).toMatch(/^Create — \d+ actions?$/);
  });

  it('an unavailable row is a selectable no-op that announces the reason', async () => {
    const { host, journal } = makeHost();
    const runSpy = vi.spyOn(host, 'runIntent');
    focusWindow(FIXTURE_APP_ID);
    renderShell();

    ctrlSpace();
    type('>paste');
    const row = rowFor('test.paste');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveAttribute('data-nav-availability', 'disabled');

    await pressEnter();

    expect(runSpy).not.toHaveBeenCalled();
    expect(journal.entries()).toHaveLength(0);
    expect(announcer().textContent).toContain('Not available for the current selection');
    // No error line: the row itself carries the reason (UI/UX §1.5).
    expect(responseLine()).toBeNull();
  });

  it('rejected / failed stay open with the typed response line; canceled-confirmation stays silent', async () => {
    const { host } = makeHost();
    const runSpy = vi.spyOn(host, 'runIntent');
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();
    type('>recta');

    runSpy.mockResolvedValueOnce({ status: 'rejected', code: 'invalid-args' });
    await pressEnter();
    expect(responseLine()).toHaveAttribute(LAUNCHER_RESPONSE_ATTR, 'rejected');
    expect(responseLine()).toHaveAttribute(LAUNCHER_RESPONSE_CODE_ATTR, 'invalid-args');
    expect(screen.getByTestId(LAUNCHER_CONTEXT_TESTID)).toBeInTheDocument();

    // The next keystroke re-resolves the route (the response is replaced, never stacked).
    type('>rectan');
    runSpy.mockResolvedValueOnce({ status: 'failed', code: 'failed-run' });
    await pressEnter();
    expect(responseLine()).toHaveAttribute(LAUNCHER_RESPONSE_CODE_ATTR, 'failed-run');

    type('>rect');
    runSpy.mockResolvedValueOnce({ status: 'rejected', code: 'canceled-confirmation' });
    await pressEnter();
    expect(responseLine()).toBeNull();
    expect(screen.getByTestId(LAUNCHER_CONTEXT_TESTID)).toBeInTheDocument();
  });

  it('a navigation no-op stays open with NOTHING_TO_UNDO on the undo route', async () => {
    const { host } = makeHost();
    const runSpy = vi.spyOn(host, 'runIntent');
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();

    type('undo');
    runSpy.mockResolvedValueOnce({ status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO });
    await pressEnter();

    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({ verbId: 'journal.undo', args: { count: '1' } }),
    );
    expect(responseLine()).toHaveTextContent(NOTHING_TO_UNDO);
    expect(responseLine()).toHaveAttribute(LAUNCHER_RESPONSE_ATTR, 'undo-nothing');
    expect(announcer()).toHaveTextContent(NOTHING_TO_UNDO);
  });
});

/* ───────────────────────────── 5. Cmd/Ctrl+K + Esc stack ───────────────────────────── */

describe('LauncherShell — secondary actions + the Esc stack (R-3.2/R-3.3)', () => {
  it('Cmd/Ctrl+K opens the row actions and toggles back to the palette', () => {
    makeHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();
    type('>delete');

    keyDown('k', { ctrlKey: true });

    const panel = screen.getByTestId(LAUNCHER_PALETTE_SECONDARY_TESTID);
    expect(panel).toHaveAttribute('role', 'listbox');
    const items = screen.getAllByTestId(LAUNCHER_PALETTE_SECONDARY_ITEM_TESTID);
    expect(items.map((item) => item.getAttribute(LAUNCHER_ACTION_KIND_ATTR))).toEqual([
      'run',
      'map',
    ]);
    expect(screen.queryByTestId(LAUNCHER_PALETTE_LIST_TESTID)).toBeNull();
    // The secondary panel is level 2 — no third level exists.
    expect(items[0]).toHaveTextContent('Run Delete');

    keyDown('k', { metaKey: true });

    expect(screen.queryByTestId(LAUNCHER_PALETTE_SECONDARY_TESTID)).toBeNull();
    expect(screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID)).toBeInTheDocument();
  });

  it('runs the secondary `undo` action as a row-targeted journal.undo', async () => {
    const journal = createJournalStore();
    journal.commit(seedEntries(1), []);
    const { host } = makeHost({ journal });
    const runSpy = vi.spyOn(host, 'runIntent');
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();
    type('>rect');

    keyDown('k', { ctrlKey: true });
    const items = screen.getAllByTestId(LAUNCHER_PALETTE_SECONDARY_ITEM_TESTID);
    expect(items.map((item) => item.getAttribute(LAUNCHER_ACTION_KIND_ATTR))).toEqual([
      'run',
      'undo',
      'map',
    ]);

    keyDown('ArrowDown'); // run → undo
    await pressEnter();

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toMatchObject({
      verbId: 'journal.undo',
      args: { verbId: 'test.rect' },
      channel: 'launcher',
      actor: 'human',
    });
    await waitFor(() => expect(journal.entries()).toHaveLength(2));
    expect(journal.entries()[1].label).toBe('Undo Rectangle 1');
  });

  it('Esc pops exactly one level (secondary → palette) before closing + restoring focus', async () => {
    makeHost();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    focusWindow(FIXTURE_APP_ID);
    renderShell();

    ctrlSpace();
    type('>delete');
    keyDown('k', { ctrlKey: true });
    expect(screen.getByTestId(LAUNCHER_PALETTE_SECONDARY_TESTID)).toBeInTheDocument();

    keyDown('Escape');
    expect(screen.queryByTestId(LAUNCHER_PALETTE_SECONDARY_TESTID)).toBeNull();
    expect(screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(LAUNCHER_CONTEXT_TESTID)).toBeInTheDocument();

    keyDown('Escape');
    await waitFor(() => expect(screen.queryByTestId(LAUNCHER_CONTEXT_TESTID)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(outside));
  });
});

/* ───────────────────────────── 6. confirmation host ───────────────────────────── */

describe('LauncherShell — confirmation host (R-5.2/R-5.3)', () => {
  const destructiveHost = () =>
    makeHost({ confirm: (request, intent) => requestLauncherConfirmation(request, intent) });

  it('Cancel resolves false and journals nothing', async () => {
    const { journal } = destructiveHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();
    type('>delete');
    await pressEnter();

    await waitFor(() =>
      expect(screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeInTheDocument(),
    );
    expect(journal.entries()).toHaveLength(0);

    act(() => {
      fireEvent.click(screen.getByTestId(LAUNCHER_CONFIRMATION_CANCEL_TESTID));
    });

    await waitFor(() =>
      expect(screen.queryByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeNull(),
    );
    expect(journal.entries()).toHaveLength(0);
    expect(responseLine()).toBeNull();
    expect(screen.getByTestId(LAUNCHER_CONTEXT_TESTID)).toBeInTheDocument();
  });

  it('a real outside pointerdown on the positioner dismisses the dialog and journals nothing', async () => {
    const { journal } = destructiveHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();
    type('>delete');
    await pressEnter();

    const dialog = await screen.findByTestId(LAUNCHER_CONFIRMATION_TESTID);

    // Ark defers twice (dismissable layer on one animation frame, its interact-outside
    // tracker on the next) and only then installs the document capture listener on a
    // macrotask. Wait for the whole chain before firing the real outside event.
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // The real outside hit lands on the positioner (the backdrop computes `pointer-events:
    // none`), so the outside event must originate here — never on the unreachable backdrop.
    const positioner = document.querySelector('[data-part="positioner"]');
    expect(positioner).not.toBeNull();
    // The confirmation content is a CHILD of the positioner, so the pointerdown target (the
    // positioner itself) is OUTSIDE the content node — exactly zag's `isEventOutside` test.
    expect(dialog.contains(positioner)).toBe(false);

    fireEvent.pointerDown(positioner as Element);

    await waitFor(() =>
      expect(screen.queryByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeNull(),
    );
    expect(journal.entries()).toHaveLength(0);
    expect(responseLine()).toBeNull();
    expect(screen.getByTestId(LAUNCHER_CONTEXT_TESTID)).toBeInTheDocument();
  });

  it('Esc dismisses the dialog and journals nothing', async () => {
    const { journal } = destructiveHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();
    type('>delete');
    await pressEnter();

    const dialog = await screen.findByTestId(LAUNCHER_CONFIRMATION_TESTID);
    act(() => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    await waitFor(() =>
      expect(screen.queryByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeNull(),
    );
    expect(journal.entries()).toHaveLength(0);
  });

  it('Accept applies exactly one mutation and closes', async () => {
    const { journal } = destructiveHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();
    type('>delete');
    await pressEnter();

    await waitFor(() =>
      expect(screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId(LAUNCHER_CONFIRMATION_ACCEPT_TESTID));
      await Promise.resolve();
    });

    await waitFor(() => expect(journal.entries()).toHaveLength(1));
    expect(journal.entries()[0]).toMatchObject({
      verbId: 'test.delete',
      effect: 'mutation',
      channel: 'launcher',
      actor: 'human',
    });
    await waitFor(() => expect(screen.queryByTestId(LAUNCHER_CONTEXT_TESTID)).toBeNull());
  });
});

/* ──────────────────── 11. reduced motion is live (R-9.2) ──────────────────── */

describe('LauncherShell — the reduced-motion preference is live (R-9.2)', () => {
  it('honours a matchMedia stub installed AFTER the shell mounted (palette list)', () => {
    makeHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();

    // The plan's live lever: the stub is installed after app start, before Ctrl+Space.
    stubMatchMedia(true);

    ctrlSpace();
    type('>');

    expect(screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID).style.animation).toBe('none');
  });

  it('honours a post-mount matchMedia stub for the confirmation content and scrim', async () => {
    makeHost({ confirm: (request, intent) => requestLauncherConfirmation(request, intent) });
    focusWindow(FIXTURE_APP_ID);
    renderShell();

    stubMatchMedia(true);

    ctrlSpace();
    type('>delete');
    await pressEnter();

    await waitFor(() =>
      expect(screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeInTheDocument(),
    );

    const content = screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID);
    const backdrop = document.querySelector('[data-part="backdrop"]') as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    expect(content.style.animation).toBe('none');
    expect(backdrop?.style.animation).toBe('none');
  });
});

/* ───────────────────────────── 7. undo by description ───────────────────────────── */

describe('LauncherShell — undo by description (R-6.1/R-6.4)', () => {
  it('dispatches journal.undo with the matched args and closes to reveal the trail', async () => {
    const journal = createJournalStore();
    journal.commit(seedEntries(1), []);
    makeHost({ journal });
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();

    type('undo the last change');
    await pressEnter();

    await waitFor(() => expect(journal.entries()).toHaveLength(2));
    expect(journal.entries()[1]).toMatchObject({
      verbId: 'test.rect',
      label: 'Undo Rectangle 1',
      channel: 'launcher',
      actor: 'human',
    });
    await waitFor(() => expect(screen.queryByTestId(LAUNCHER_CONTEXT_TESTID)).toBeNull());
  });

  it('an undo-shaped miss renders the clarify line and dispatches nothing', async () => {
    const { host, journal } = makeHost();
    const runSpy = vi.spyOn(host, 'runIntent');
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();

    type('undo the red one');
    await pressEnter();

    expect(runSpy).not.toHaveBeenCalled();
    expect(journal.entries()).toHaveLength(0);
    expect(responseLine()).toHaveTextContent(UNDO_NO_MATCH_COPY);
    expect(responseLine()).toHaveAttribute(LAUNCHER_RESPONSE_ATTR, 'clarify');
    expect(announcer()).toHaveTextContent(UNDO_NO_MATCH_COPY);
  });
});

/* ───────────────────────────── 8. `/ Ask` open ───────────────────────────── */

describe('LauncherShell — / Ask open request (R-7.1/R-7.2)', () => {
  it('opens, clears the bar, focuses the input and keeps the context header', async () => {
    makeHost();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    focusWindow(FIXTURE_APP_ID);
    renderShell();

    act(() => {
      requestLauncherOpen({ source: 'rail-ask', focus: true });
    });

    await waitFor(() => expect(document.activeElement).toBe(input()));
    expect(input().value).toBe('');
    expect(screen.getByTestId(LAUNCHER_CONTEXT_TESTID)).toBeInTheDocument();
  });
});

/* ───────────────────────────── 9. empty palette announces ───────────────────────────── */

describe('LauncherShell — empty palette announcement (R-9.1)', () => {
  it('announces the empty-filter copy inside the list root', () => {
    makeHost();
    focusWindow(FIXTURE_APP_ID);
    renderShell();
    ctrlSpace();

    type('>zzz-no-match');

    expect(
      within(screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID)).getByText(
        'No places or actions match',
      ),
    ).toBeInTheDocument();
    expect(announcer()).toHaveTextContent('No places or actions match');
  });
});

/* ───────────────────────────── 10. no-surface fallback ───────────────────────────── */

describe('LauncherShell — no-surface fallback (R-1.2)', () => {
  it('renders none of the P6 surfaces and keeps the shipped `>` palette + Enter', () => {
    const hotkeyRun = vi.fn();
    registerFredoAction({
      actionId: 'fredo.test.shipped',
      title: 'Shipped action',
      description: 'the shipped palette still owns a host-less app',
      defaultSequence: 'primary+t',
      run: hotkeyRun,
    });
    focusWindow('mission-monitor'); // no registered navigation host
    renderShell();
    ctrlSpace();

    expect(screen.queryByTestId(LAUNCHER_CONTEXT_TESTID)).toBeNull();
    expect(screen.queryByTestId(LAUNCHER_PALETTE_ANNOUNCER_TESTID)).toBeNull();
    expect(screen.queryByTestId(LAUNCHER_PALETTE_LIST_TESTID)).toBeNull();

    type('>shipped');
    expect(screen.getByTestId('launcher-action-list')).toBeInTheDocument();
    keyDown('Enter');
    expect(hotkeyRun).toHaveBeenCalledTimes(1);
    expect(hotkeyRun.mock.calls[0][0]).toMatchObject({
      actionId: 'fredo.test.shipped',
      source: 'palette',
    });
  });

  it('a minimized window is not the active app', () => {
    makeHost();
    focusWindow(FIXTURE_APP_ID, true);
    renderShell();
    ctrlSpace();

    expect(screen.queryByTestId(LAUNCHER_CONTEXT_TESTID)).toBeNull();
    expect(screen.queryByTestId(LAUNCHER_PALETTE_ANNOUNCER_TESTID)).toBeNull();
  });

  it('an undo-shaped phrase takes the shipped send path (no matcher, no palette)', async () => {
    companionMock.current.state.isVisible = true;
    focusWindow('mission-monitor');
    renderShell();
    ctrlSpace();

    type('undo the last change');
    await pressEnter();

    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledTimes(1);
    expect(companionDispatchMock.askActiveCompanion.mock.calls[0][0]).toBe(
      'undo the last change',
    );
    // The no-surface send path never gains the ST-3 grounding option.
    expect(companionDispatchMock.askActiveCompanion.mock.calls[0][1]).toBeUndefined();
    expect(responseLine()).toBeNull();
    expect(screen.queryByTestId(LAUNCHER_PALETTE_LIST_TESTID)).toBeNull();
  });
});
