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
  NAV_RAIL_PLACE_ROW_TESTID,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_TESTID,
  resetNavigationAnnouncer,
} from '@/shared/navigation/ui';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { WireframeEditor } from '../components/WireframeEditor';
import { resetWireframeStoreForTests } from '../store/wireframeDocumentStore';
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
