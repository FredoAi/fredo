/**
 * CommandRail — place-transition focus retention (Spec #3119 retry, ST-F2; reworked for the
 * bottom command bar by Spec #3120 ST-5 — F-N30 / R-1.6).
 *
 * The shipped pin in `commandRail.test.tsx` proves the bar never steals focus on MOUNT. This
 * suite proves the other half of the contract with a REAL unmount: a place transition replaces
 * the bar's VERB cluster (a different place declares a different set of verbs), so a focused
 * verb row can be removed. The bar must re-home the focus it dropped — to the same control when
 * it renders again, else to the current-place breadcrumb segment (`navigation-bar-place`,
 * `tabIndex={-1}`) — and must NEVER touch focus the user moved outside the bar.
 *
 * Every model comes from the real `buildCommandRailModel` over the shared D1 fixture. Place
 * rows no longer render (R-1.4), so verbs are the transition-sensitive controls.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  NAV_RAIL_MAP_TESTID,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_ROW_TESTID,
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

function barProps(model: CommandRailModel): {
  model: CommandRailModel;
  onRunVerb: () => void;
  onOpenMap: () => void;
  onAsk: () => void;
} {
  return { model, onRunVerb: vi.fn(), onOpenMap: vi.fn(), onAsk: vi.fn() };
}

function renderAt(model: CommandRailModel) {
  return renderWithChakra(<CommandRail {...barProps(model)} />);
}

function bar(): HTMLElement {
  return screen.getByTestId(NAV_RAIL_TESTID);
}

/** The currently rendered verb row for `verbId` (never cached — rows unmount). */
function verbRow(verbId: string): HTMLElement {
  const row = screen
    .getAllByTestId(NAV_RAIL_ROW_TESTID)
    .find((candidate) => candidate.getAttribute('data-nav-verb-id') === verbId);
  if (row === undefined) {
    throw new Error(`verb row ${verbId} is not rendered`);
  }
  return row;
}

/** The current-place breadcrumb segment (the focus anchor). */
function anchor(): HTMLElement {
  return screen.getByTestId(NAV_RAIL_PLACE_TESTID);
}

afterEach(() => {
  cleanup();
});

describe('CommandRail — place-transition focus retention on the command bar (F-N30 / R-1.6)', () => {
  it('re-homes focus to the current-place breadcrumb segment when a place transition unmounts the focused verb row', () => {
    const view = renderAt(modelAt(ROOT_PATH));
    const row = verbRow('test.edit');
    row.focus();
    expect(row).toHaveFocus();

    // The real unmount: Create declares a different verb set, so the row disappears.
    view.rerender(<CommandRail {...barProps(modelAt(CREATE_PATH))} />);

    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active instanceof HTMLElement && bar().contains(active)).toBe(true);

    const place = anchor();
    expect(active).toBe(place);
    expect(place).toHaveAttribute('tabindex', '-1');
    expect(place).toHaveAttribute('aria-current', 'page');
    expect(place.textContent).toBe('Create');
  });

  it('returns focus to the SAME verb row when the place that renders it comes back', () => {
    const view = renderAt(modelAt(ROOT_PATH));
    const row = verbRow('test.edit');
    row.focus();
    expect(row).toHaveFocus();

    view.rerender(<CommandRail {...barProps(modelAt(CREATE_PATH))} />);
    expect(anchor()).toHaveFocus();

    // `Escape`-style round trip: Canvas declares the verb again.
    view.rerender(<CommandRail {...barProps(modelAt(ROOT_PATH))} />);

    const restored = verbRow('test.edit');
    expect(restored).toHaveFocus();
    expect(restored.getAttribute('data-nav-verb-id')).toBe('test.edit');
  });

  it('never moves focus on mount, on a surviving control, or when focus was moved outside the bar', () => {
    // (a) Mount while an unrelated control is focused — no focus move on mount.
    const external = renderWithChakra(
      <button type="button">outside the bar</button>,
    );
    const outside = external.getByRole('button', { name: 'outside the bar' });
    outside.focus();
    expect(outside).toHaveFocus();

    const view = renderAt(modelAt(ROOT_PATH));
    expect(outside).toHaveFocus();

    // (b) A transition whose focused control survives (the always-rendered `? Map` global).
    const stable = screen.getByTestId(NAV_RAIL_MAP_TESTID);
    stable.focus();
    expect(stable).toHaveFocus();
    view.rerender(<CommandRail {...barProps(modelAt(CREATE_PATH))} />);
    expect(stable).toHaveFocus();

    // (c) A transition while the user moved focus OUTSIDE the bar — never stolen.
    view.rerender(<CommandRail {...barProps(modelAt(ROOT_PATH))} />);
    const row = verbRow('test.create');
    row.focus();
    expect(row).toHaveFocus();
    outside.focus();
    expect(outside).toHaveFocus();

    view.rerender(<CommandRail {...barProps(modelAt(CREATE_PATH))} />);
    expect(outside).toHaveFocus();
    expect(document.activeElement).not.toBe(anchor());
    expect(document.activeElement).not.toBe(document.body);
  });
});
