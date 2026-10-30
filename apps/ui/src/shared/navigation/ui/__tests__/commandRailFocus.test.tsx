/**
 * CommandRail — place-transition focus retention (Spec #3119 retry, ST-F2 — R-9/AC9).
 *
 * The shipped pin in `commandRail.test.tsx` proves the rail never steals focus on MOUNT.
 * This suite proves the other half of the contract with a REAL unmount: the rail's place
 * rows are the current place's children, so rerendering into a leaf place removes the
 * focused row. The rail must re-home the focus it dropped (the current-place heading) and
 * return to the triggering row when that row renders again (`Escape` round trip).
 *
 * Every model comes from the real `buildCommandRailModel` over the shared D1 fixture.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  NAV_RAIL_PLACE_ROW_TESTID,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_TESTID,
} from '@/shared/navigation/ui/constants';
import { CommandRail } from '@/shared/navigation/ui/CommandRail';
import { buildCommandRailModel } from '@/shared/navigation/ui/models';
import type { CommandRailModel } from '@/shared/navigation/ui/types';
import { FIXTURE_PLACES, fixtureSnapshot, navTestSurface } from './fixtures';

const ROOT_PATH = [FIXTURE_PLACES.canvas];
const CREATE_PATH = [FIXTURE_PLACES.canvas, FIXTURE_PLACES.create];

function modelAt(placePath: readonly string[]): CommandRailModel {
  return buildCommandRailModel(navTestSurface(), fixtureSnapshot(placePath));
}

function railProps(model: CommandRailModel): {
  model: CommandRailModel;
  onRunVerb: () => void;
  onOpenMap: () => void;
  onAsk: () => void;
} {
  return { model, onRunVerb: vi.fn(), onOpenMap: vi.fn(), onAsk: vi.fn() };
}

function renderAt(model: CommandRailModel) {
  return renderWithChakra(<CommandRail {...railProps(model)} />);
}

function rail(): HTMLElement {
  return screen.getByTestId(NAV_RAIL_TESTID);
}

/** The currently rendered place row for `placeId` (never cached — rows unmount). */
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

afterEach(() => {
  cleanup();
});

describe('CommandRail — place-transition focus retention (R-9 / AC9)', () => {
  it('re-homes focus to the current-place heading when a place transition unmounts the focused place row', () => {
    const view = renderAt(modelAt(ROOT_PATH));
    const row = placeRow(FIXTURE_PLACES.create);
    row.focus();
    expect(row).toHaveFocus();

    // The real unmount: entering the leaf `Create` place empties `placeRows`.
    view.rerender(<CommandRail {...railProps(modelAt(CREATE_PATH))} />);

    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active instanceof HTMLElement && rail().contains(active)).toBe(true);

    const anchor = heading();
    expect(active).toBe(anchor);
    expect(anchor).toHaveAttribute('tabindex', '-1');
    expect(anchor.textContent).toBe('Create');
  });

  it('returns focus to the same place row when the place it names reappears', () => {
    const view = renderAt(modelAt(ROOT_PATH));
    const row = placeRow(FIXTURE_PLACES.create);
    row.focus();
    expect(row).toHaveFocus();

    view.rerender(<CommandRail {...railProps(modelAt(CREATE_PATH))} />);
    expect(heading()).toHaveFocus();

    // `Escape`-style round trip: the parent place renders the row that started the trip.
    view.rerender(<CommandRail {...railProps(modelAt(ROOT_PATH))} />);

    const restored = placeRow(FIXTURE_PLACES.create);
    expect(restored).toHaveFocus();
    expect(restored.getAttribute('data-nav-place-id')).toBe(FIXTURE_PLACES.create);
  });

  it('never moves focus on mount or when the transition does not drop it', () => {
    // (a) Mount while an unrelated control is focused — no focus move on mount.
    const external = renderWithChakra(
      <button type="button">outside the rail</button>,
    );
    const outside = external.getByRole('button', { name: 'outside the rail' });
    outside.focus();
    expect(outside).toHaveFocus();

    const view = renderAt(modelAt(ROOT_PATH));
    expect(outside).toHaveFocus();

    // (b) A transition whose focused node survives (the always-rendered heading).
    const anchor = heading();
    anchor.focus();
    expect(anchor).toHaveFocus();
    view.rerender(<CommandRail {...railProps(modelAt(CREATE_PATH))} />);
    expect(anchor).toHaveFocus();

    // (c) A transition while the user moved focus OUTSIDE the rail — never stolen.
    view.rerender(<CommandRail {...railProps(modelAt(ROOT_PATH))} />);
    const row = placeRow(FIXTURE_PLACES.create);
    row.focus();
    expect(row).toHaveFocus();
    outside.focus();
    expect(outside).toHaveFocus();

    view.rerender(<CommandRail {...railProps(modelAt(CREATE_PATH))} />);
    expect(outside).toHaveFocus();
    expect(document.activeElement).not.toBe(heading());
  });
});
