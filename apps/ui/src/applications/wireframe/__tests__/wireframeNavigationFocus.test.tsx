/**
 * Wireframe shell — place-row focus retention (Spec #3119 retry, ST-F3 — R-9/AC9).
 *
 * The exact tester repro: focus a `navigation-rail-place-row` in the REAL shell and press
 * `c`. `buildPlaceRows` returns the current place's children, so entering the leaf `Create`
 * place unmounts the focused row; without a re-home, `document.activeElement` becomes
 * `BODY` and the shell's ONE element-scoped key adapter stops receiving strokes.
 *
 * The shell is the REAL `WireframeEditor` over the REAL navigation host; only the Konva
 * canvas is replaced by a static host element (the canvas is another surface).
 *
 * Titles are authored to the Fix Plan's literal manifest (G-419).
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  NAV_RAIL_ASK_TESTID,
  NAV_RAIL_PLACE_ROW_TESTID,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_TESTID,
  getNavigationHost,
  resolveLauncherConfirmation,
  resetNavigationAnnouncer,
  subscribeLauncherConfirmation,
  subscribeLauncherOpenRequests,
  type NavigationHost,
  type PendingLauncherConfirmation,
} from '@/shared/navigation/ui';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import {
  WireframeNavigationProvider,
  useWireframeNavigation,
} from '../components/WireframeNavigationProvider';
import { WIREFRAME_SURFACE_APP_ID } from '../wireframeSurface';
import { WireframeEditor } from '../components/WireframeEditor';
import { getSnapshot, resetWireframeStoreForTests, select } from '../store/wireframeDocumentStore';
import { resetWireframeSurfaceForTests } from '../wireframeSurface';

// The Konva canvas is another surface; a static host element keeps the shell real.
vi.mock('../components/WireframeCanvas', async () => {
  const ReactModule = await import('react');
  return {
    WireframeCanvas: () =>
      ReactModule.createElement('div', { 'data-testid': 'wireframe-canvas' }),
  };
});

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';
const EDIT = 'wireframe.edit';

function root(): HTMLElement {
  return screen.getByTestId('wireframe-root');
}

function rail(): HTMLElement {
  return screen.getByTestId(NAV_RAIL_TESTID);
}

/** The currently rendered place row for `placeId` (never cached — the row unmounts). */
function placeRow(placeId: string): HTMLElement {
  const row = screen
    .getAllByTestId(NAV_RAIL_PLACE_ROW_TESTID)
    .find((candidate) => candidate.getAttribute('data-nav-place-id') === placeId);
  if (row === undefined) {
    throw new Error(`place row ${placeId} is not rendered`);
  }
  return row;
}

function heading(): HTMLElement {
  return screen.getByTestId(NAV_RAIL_PLACE_TESTID);
}

async function press(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, { key });
  });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
  vi.restoreAllMocks();
});

describe('wireframe place-row focus retention (R-9 / AC9)', () => {
  it('keeps focus in the rail when a place row is entered from the keyboard', async () => {
    renderWithChakra(React.createElement(WireframeEditor));

    const row = placeRow(CREATE);
    row.focus();
    expect(row).toHaveFocus();

    await press(row, 'c');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CREATE));

    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active instanceof HTMLElement && rail().contains(active)).toBe(true);
    expect(active).toBe(heading());
    expect(heading().textContent).toBe('Create');
  });

  it('restores the triggering place row when the place is exited from the keyboard', async () => {
    renderWithChakra(React.createElement(WireframeEditor));

    const row = placeRow(CREATE);
    row.focus();
    await press(row, 'c');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CREATE));
    await waitFor(() => expect(heading()).toHaveFocus());

    await press(heading(), 'Escape');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CANVAS));

    await waitFor(() => expect(placeRow(CREATE)).toHaveFocus());
    expect(placeRow(CREATE).getAttribute('data-nav-place-id')).toBe(CREATE);
  });

  it('keeps focus in the rail when a place row is entered with the pointer', async () => {
    const user = userEvent.setup();
    renderWithChakra(React.createElement(WireframeEditor));

    await user.click(placeRow(EDIT));
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(EDIT));

    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active instanceof HTMLElement && rail().contains(active)).toBe(true);
  });

  it('keeps keyboard dispatch alive after a place-row entry', async () => {
    renderWithChakra(React.createElement(WireframeEditor));

    const row = placeRow(CREATE);
    row.focus();
    await press(row, 'c');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CREATE));
    await waitFor(() => expect(heading()).toHaveFocus());

    // The next stroke must still reach the shell's element-scoped adapter from the re-homed
    // focus: Escape pops exactly one level back to the Canvas place.
    await press(heading(), 'Escape');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CANVAS));
  });
});

/* ──────────────── P6 launcher bridge + confirmation policy (ST-4) ──────────────── */

/** Captures the provider's ONE host without rendering any UI. */
function HostProbe({
  onReady,
}: {
  readonly onReady: (host: NavigationHost) => void;
}): null {
  const { host } = useWireframeNavigation();
  React.useEffect(() => {
    onReady(host);
  }, [host, onReady]);
  return null;
}

async function mountProviderHost(): Promise<NavigationHost> {
  let captured: NavigationHost | null = null;
  renderWithChakra(
    React.createElement(
      WireframeNavigationProvider,
      null,
      React.createElement(HostProbe, {
        onReady: (host: NavigationHost) => {
          captured = host;
        },
      }),
    ),
  );
  await waitFor(() => expect(captured).not.toBeNull());
  return captured as unknown as NavigationHost;
}

async function addAndSelectElement(host: NavigationHost): Promise<string> {
  await act(async () => {
    const result = await host.runIntent({
      verbId: 'wireframe.create.rect',
      args: { x: '10', y: '10', width: '40', height: '30' },
      channel: 'pointer',
      actor: 'human',
    });
    expect(result.status).toBe('performed');
  });
  const element = getSnapshot().document.elements[0];
  expect(element).toBeDefined();
  act(() => {
    select(element.id);
  });
  return element.id;
}

describe('WireframeNavigationProvider — host registry + launcher bridge (R-7.1)', () => {
  it('registers the host on mount and unregisters it on unmount', async () => {
    const view = renderWithChakra(React.createElement(WireframeEditor));
    expect(getNavigationHost(WIREFRAME_SURFACE_APP_ID)).not.toBeNull();

    view.unmount();
    expect(getNavigationHost(WIREFRAME_SURFACE_APP_ID)).toBeNull();
  });

  it('`/ Ask` activation calls the launcher-open bridge once', async () => {
    renderWithChakra(React.createElement(WireframeEditor));

    const requests: unknown[] = [];
    const unsubscribe = subscribeLauncherOpenRequests((request) => requests.push(request));
    try {
      fireEvent.click(screen.getByTestId(NAV_RAIL_ASK_TESTID));
    } finally {
      unsubscribe();
    }

    expect(requests).toEqual([{ source: 'rail-ask', focus: true }]);
  });
});

describe('WireframeNavigationProvider — confirmation policy (R-5.2 / R-5.3)', () => {
  it('gates launcher/voice/agent intents and leaves keyboard/pointer unconfirmed', async () => {
    const host = await mountProviderHost();
    await addAndSelectElement(host);

    const pending: PendingLauncherConfirmation[] = [];
    const unsubscribe = subscribeLauncherConfirmation((request) => {
      if (request !== null) pending.push(request);
    });

    try {
      for (const channel of ['launcher', 'voice', 'agent'] as const) {
        const actor = channel === 'launcher' ? 'human' : 'companion';
        const before = pending.length;
        const dispatchPromise = host.runIntent({
          verbId: 'wireframe.element.delete',
          args: {},
          channel,
          actor,
        });
        await waitFor(() => expect(pending).toHaveLength(before + 1));
        act(() => {
          resolveLauncherConfirmation(false);
        });
        await act(async () => {
          await expect(dispatchPromise).resolves.toEqual({
            status: 'rejected',
            code: 'canceled-confirmation',
          });
        });
        expect(getSnapshot().document.elements).toHaveLength(1);
      }
      expect(pending).toHaveLength(3);
      expect(pending[0]?.request.verbId).toBe('wireframe.element.delete');
      expect(pending[0]?.request.consequence?.trim().length ?? 0).toBeGreaterThan(0);
      expect(pending[0]?.intent.actor).toBe('human');

      // Keyboard performs with NO confirmation request.
      await act(async () => {
        const result = await host.runIntent({
          verbId: 'wireframe.element.delete',
          args: {},
          channel: 'keyboard',
          actor: 'human',
        });
        expect(result.status).toBe('performed');
      });
      expect(pending).toHaveLength(3);
      expect(getSnapshot().document.elements).toHaveLength(0);

      // Pointer performs too (no confirmation), on a fresh element.
      await addAndSelectElement(host);
      await act(async () => {
        const result = await host.runIntent({
          verbId: 'wireframe.element.delete',
          args: {},
          channel: 'pointer',
          actor: 'human',
        });
        expect(result.status).toBe('performed');
      });
      expect(pending).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });

  it('confirms the external export with the authored party and cancels without applying', async () => {
    const host = await mountProviderHost();

    const pending: PendingLauncherConfirmation[] = [];
    const unsubscribe = subscribeLauncherConfirmation((request) => {
      if (request !== null) pending.push(request);
    });

    try {
      const dispatchPromise = host.runIntent({
        verbId: 'place.exportPng',
        args: {},
        channel: 'launcher',
        actor: 'human',
      });
      await waitFor(() => expect(pending).toHaveLength(1));
      const request = pending[0]!.request;
      expect(request.verbId).toBe('place.exportPng');
      expect(request.externalParty).toBe('your file system');
      expect(request.consequence?.trim().length ?? 0).toBeGreaterThan(0);
      expect(request.undoAvailability).toEqual({
        undoable: false,
        reason: expect.any(String),
      });

      act(() => {
        resolveLauncherConfirmation(false);
      });
      await act(async () => {
        await expect(dispatchPromise).resolves.toEqual({
          status: 'rejected',
          code: 'canceled-confirmation',
        });
      });
      // Cancel never ran the file action.
      expect(getSnapshot().document.elements).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});
