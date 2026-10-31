/**
 * Spec #3120 (P6), ST-7 — launcher simplification (R-2 / R-8).
 *
 * Pins the reworked launcher contracts over the REAL shell + the ONE shared hotkey
 * engine:
 *   (a) typing `>` renders the SHIPPED app grid (no action palette, no app-scoped
 *       navigation palette, no action-list node) and `>` stays literal query text;
 *   (b) app search and open-apps filtering still work for prefixed and unprefixed
 *       queries, and a typed app name still launches through `resolveEnterAction`;
 *   (c) Ctrl+Space still toggles, the confirmation host mounts for a pending request
 *       even with the launcher CLOSED (QA-6 / F-172), and no
 *       `fredo.palette.openActions` handler is registered;
 *   (d) a source sweep over `apps/ui/src` finds ZERO retired palette/bridge tokens.
 *
 * Titles are authored to the QA Expert's literal manifest (G-419).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  LAUNCHER_CONFIRMATION_CANCEL_TESTID,
  LAUNCHER_CONFIRMATION_TESTID,
} from '@/applications/home/components/launcher/launcherConstants';
import type { ConfirmationRequest, Intent } from '@/shared/navigation';
import {
  NAVIGATION_GLOBAL_CHORDS,
  NavigationProvider,
  requestLauncherConfirmation,
  resetNavigationAnnouncer,
  resetNavigationKeyDispatchForTests,
} from '@/shared/navigation/ui';
import type { WindowEntry } from '@/shared/window-system/windowTypes';
import type { FredoApplicationClass } from '@/shared/classes/FredoApplicationClass';
import { LauncherShell } from '../LauncherShell';

type BarField = HTMLInputElement | HTMLTextAreaElement;

// LauncherShell reads the live connection flag via useConnectionStatus (no
// StreamProvider in this isolated harness) — stub the one consumer.
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

vi.mock('@/shared/components/companion', () => ({
  CompanionEntity: () => null,
  askActiveCompanion: vi.fn(() => ({ outcome: 'dispatched' as const })),
  askActiveCompanionWithAudio: vi.fn(() => ({ outcome: 'dispatched' as const })),
}));

const windowsMock = vi.hoisted(() => ({ current: [] as WindowEntry[] }));
vi.mock('@/shared/window-system/useWindows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/window-system/useWindows')>();
  return { ...actual, useWindows: () => windowsMock.current };
});

const actionsMock = vi.hoisted(() => ({
  current: { focusWindow: vi.fn(), closeWindow: vi.fn() },
}));
vi.mock('@/shared/window-system/useWindowActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/window-system/useWindowActions')>();
  return { ...actual, useWindowActions: () => actionsMock.current };
});

function win(over: Partial<WindowEntry> = {}): WindowEntry {
  return {
    id: 'mission-monitor',
    title: 'Mission Monitor',
    icon: null,
    component: null,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    isMaximized: false,
    isMinimized: false,
    focused: false,
    zIndex: 1,
    ...over,
  };
}

const APP = { id: 'settings', name: 'Settings', icon: () => null } as unknown as FredoApplicationClass;
const APP_TWO = {
  id: 'mission-monitor',
  name: 'Mission Monitor',
  icon: () => null,
} as unknown as FredoApplicationClass;

const PALETTE_ACTION_ID = 'fredo.palette.openActions';

const searchbox = () => screen.getByRole('searchbox') as BarField;

const renderShell = (features: FredoApplicationClass[] = [APP, APP_TWO]) => {
  const onOpenFeature = vi.fn();
  const view = renderWithChakra(
    <NavigationProvider>
      <LauncherShell showableFeatures={features} onOpenFeature={onOpenFeature} />
    </NavigationProvider>,
  );
  return { onOpenFeature, view };
};

const type = (value: string) => {
  act(() => {
    fireEvent.change(searchbox(), { target: { value } });
  });
};

const keyDown = (key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    fireEvent.keyDown(searchbox(), { key, ...init });
  });
};

const grid = (container: HTMLElement) => container.querySelector('#fredo-launcher-grid');

beforeEach(() => {
  windowsMock.current = [];
  actionsMock.current = { focusWindow: vi.fn(), closeWindow: vi.fn() };
  companionMock.current = {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    replyInFlight: false,
    queuedSendCount: 0,
  };
  resetNavigationAnnouncer();
  resetNavigationKeyDispatchForTests();
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
  resetNavigationAnnouncer();
  resetNavigationKeyDispatchForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ───────────────────────── (a) `>` is ordinary search text ───────────────────────── */

describe('LauncherShell — `>` is ordinary search text (R-2.1 / R-8)', () => {
  it('renders the shipped app grid for a `>` query and NO palette/action-list node', () => {
    const { view } = renderShell();

    type('>');

    // The literal `>` is the query text, and the results region stays the app grid.
    expect(searchbox().value).toBe('>');
    expect(grid(view.container)).not.toBeNull();
    expect(screen.getByRole('grid', { name: 'Applications' })).toBeInTheDocument();

    // No action palette, no app-scoped navigation palette, no action-list node.
    expect(document.querySelector('[data-testid^="launcher-palette-"]')).toBeNull();
    expect(document.querySelector('[data-testid="launcher-action-list"]')).toBeNull();
    expect(document.querySelector('[data-testid="launcher-context"]')).toBeNull();

    // `>` matches no app name (it is NOT stripped) — the shipped empty grid renders.
    expect(screen.getByText('No apps available')).toBeInTheDocument();

    // Non-vacuity: the SAME grid resolves an app for an unprefixed query.
    type('set');
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(document.querySelector('[data-testid^="launcher-palette-"]')).toBeNull();
  });
});

/* ───────────── (b) app search + open-apps + the shipped Enter verdict ───────────── */

describe('LauncherShell — app search, open-apps and Enter are the shipped paths (R-2.2)', () => {
  it('filters open apps and the grid with prefixed and unprefixed queries', () => {
    windowsMock.current = [win({ title: 'Mission Monitor' })];
    const { view } = renderShell();

    const input = searchbox();
    act(() => {
      input.focus();
      fireEvent.focus(input);
    });

    // Unprefixed: both the row and the grid match `Miss`.
    type('Miss');
    expect(screen.getByTestId('launcher-open-apps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mission Monitor' })).toBeInTheDocument();

    // Prefixed: `>` is LITERAL — the same title-substring predicate filters BOTH out.
    type('>Miss');
    expect(screen.queryByTestId('launcher-open-apps')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mission Monitor' })).toBeNull();
    expect(grid(view.container)).not.toBeNull();

    // Clearing restores the matches.
    type('');
    expect(screen.getByTestId('launcher-open-apps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mission Monitor' })).toBeInTheDocument();
  });

  it('a typed app name still opens the app through resolveEnterAction; `>Settings` does not', () => {
    const { onOpenFeature } = renderShell();

    type('Settings');
    keyDown('Enter');
    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature).toHaveBeenCalledWith('settings', APP);

    // The literal `>` prefix is not stripped, so it matches no app and Enter is a no-op.
    type('>Settings');
    keyDown('Enter');
    expect(onOpenFeature).toHaveBeenCalledTimes(1);
  });
});

/* ───────── (c) Ctrl+Space, the confirmation host and the retired handler ───────── */

describe('LauncherShell — global commands survive, no palette handler (R-2.3 / QA-6)', () => {
  it('Ctrl+Space still shows/focuses the bar', async () => {
    renderShell();

    act(() => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
    });

    await waitFor(() => expect(searchbox()).toHaveFocus());
  });

  it('a pending confirmation renders with the launcher CLOSED (QA-6 / F-172)', async () => {
    renderShell();

    // Resting Main: neither `open` nor `engaged` — the launcher is visually closed.
    expect(screen.queryByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeNull();

    const request: ConfirmationRequest = {
      verbId: 'wireframe.element.delete',
      title: 'Delete',
      targetLabels: ['el-1'],
      targetOverflow: 0,
      consequence: 'Deletes the selected elements.',
      undoAvailability: { undoable: true },
      externalParty: null,
    };
    const intent: Intent = {
      verbId: 'wireframe.element.delete',
      args: {},
      channel: 'agent',
      actor: 'companion',
    };

    let accepted: boolean | undefined;
    act(() => {
      void requestLauncherConfirmation(request, intent).then((value) => {
        accepted = value;
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeInTheDocument(),
    );

    // Cancel resolves the pending funnel `false` and removes the dialog.
    fireEvent.click(screen.getByTestId(LAUNCHER_CONFIRMATION_CANCEL_TESTID));
    await waitFor(() => expect(accepted).toBe(false));
    expect(screen.queryByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeNull();
  });

  it('declares no retired palette action and primary+P is inert', () => {
    renderShell();

    // The only global chords are the three navigation ones — no palette action id.
    expect(NAVIGATION_GLOBAL_CHORDS.map((chord) => chord.id)).toEqual([
      'launcher.toggle',
      'window.focus.next',
      'window.focus.previous',
    ]);
    expect(PALETTE_ACTION_ID).toBe('fredo.palette.openActions');

    // The retired `primary+P` RUN is gone: it neither opens nor prefills the bar.
    act(() => {
      fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    });
    expect(searchbox().value).toBe('');
  });
});

/* ───────────────── (d) retired-token source sweep (R-8, static) ───────────────── */

const RAW_MODULES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const NON_SOURCE = /(?:^|\/)(?:__tests__|__mocks__)(?:\/|$)|\.(?:test|spec)\.(?:ts|tsx)$/;

/** Remove block + line comments; code and string literals stay intact. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const SOURCE_TARGETS = Object.entries(RAW_MODULES)
  .filter(([path]) => !NON_SOURCE.test(path) && !path.endsWith('.d.ts'))
  .map(([path, source]) => ({ path, source: stripComments(source) }));

const RETIRED_TOKENS = [
  'ACTION_PALETTE_PREFIX',
  'fredo.palette.openActions',
  'launcherActionPalette',
  'LauncherActionList',
  'launcherNavigationPalette',
  'LauncherNavigationList',
  'launcherRoute',
  'launcherUndoQuery',
  'launcherBridge',
] as const;

describe('retired palette/bridge tokens are absent from apps/ui/src (R-8 static)', () => {
  it('the source tree has zero hits for every retired token', () => {
    // The scan is non-vacuous: it actually read modules.
    expect(SOURCE_TARGETS.length).toBeGreaterThan(100);

    for (const token of RETIRED_TOKENS) {
      const hits = SOURCE_TARGETS.filter(({ source }) => source.includes(token)).map(
        ({ path }) => path,
      );
      expect(hits, `${token} still referenced`).toEqual([]);
    }
  });

  it('the scanner detects a seeded retired token (negative control)', () => {
    const seeded = stripComments('const prefix = ACTION_PALETTE_PREFIX; // ACTION_PALETTE_PREFIX');
    expect(seeded.includes('ACTION_PALETTE_PREFIX')).toBe(true);
    // The stripped comment copy is gone, so the CONTROL proves the code occurrence is found.
    expect(seeded.split('ACTION_PALETTE_PREFIX').length - 1).toBe(1);
  });
});
