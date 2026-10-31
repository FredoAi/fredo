/**
 * Spec #3120 (P6), ST-5 — `LauncherNavigationList` DOM contract (UI/UX §2.2, QA R-2.1).
 *
 * The list renders the ONE built model: one group per place with the FULL path heading,
 * risk chips only for non-safe verbs, keycaps from the row's primary place, the `Recent`
 * micro-label, `aria-disabled` (never native `disabled`) unavailable rows, and the empty
 * state inside the list root. It adds no live region and no keydown listener.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { ContextSnapshot } from '@/shared/navigation';
import { NAV_UNAVAILABLE_REASON } from '@/shared/navigation/ui/constants';
import { wireframeSurface } from '@/applications/wireframe/wireframeSurface';
import { LauncherNavigationList } from '@/applications/home/components/launcher/LauncherNavigationList';
import {
  buildLauncherPaletteModel,
  filterLauncherPaletteModel,
} from '@/applications/home/components/launcher/launcherNavigationPalette';
import {
  LAUNCHER_PALETTE_ARIA_LABEL,
  LAUNCHER_PALETTE_EMPTY_COPY,
  LAUNCHER_PALETTE_GROUP_PATH_TESTID,
  LAUNCHER_PALETTE_GROUP_TESTID,
  LAUNCHER_PALETTE_LIST_TESTID,
  LAUNCHER_PALETTE_ROW_KEY_TESTID,
  LAUNCHER_PALETTE_ROW_RISK_TESTID,
  LAUNCHER_PALETTE_ROW_TESTID,
  LAUNCHER_RECENT_LABEL,
  LAUNCHER_SECTION_ATTR,
} from '@/applications/home/components/launcher/launcherConstants';

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    appId: 'wireframe',
    placePath: ['wireframe.canvas'],
    selection: { count: 0, kinds: [], label: null, ids: [] },
    dirty: false,
    ...overrides,
  };
}

function fullModel(recents: readonly string[] = []) {
  return buildLauncherPaletteModel(wireframeSurface, snapshot(), recents);
}

function rowFor(verbId: string): HTMLElement {
  const row = screen
    .getAllByTestId(LAUNCHER_PALETTE_ROW_TESTID)
    .find((element) => element.getAttribute('data-nav-verb-id') === verbId);
  expect(row, `row ${verbId}`).toBeDefined();
  return row!;
}

function renderList(model = fullModel(), selectedIndex = 0, onSelect = vi.fn()) {
  renderWithChakra(
    <LauncherNavigationList
      model={model}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      reducedMotion
    />,
  );
  return onSelect;
}

afterEach(() => {
  cleanup();
});

describe('LauncherNavigationList — grouped listbox (R-2.1)', () => {
  it('renders the listbox with its accessible name and one group per place', () => {
    renderList();
    const list = screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID);
    expect(list).toHaveAttribute('role', 'listbox');
    expect(list).toHaveAttribute('aria-label', LAUNCHER_PALETTE_ARIA_LABEL);

    const groups = screen.getAllByTestId(LAUNCHER_PALETTE_GROUP_TESTID);
    expect(groups).toHaveLength(7);
    const paths = screen
      .getAllByTestId(LAUNCHER_PALETTE_GROUP_PATH_TESTID)
      .map((node) => node.textContent);
    expect(paths).toEqual([
      'Canvas',
      'Canvas › Create',
      'Canvas › Edit',
      'Canvas › Arrange',
      'Canvas › Style',
      'Canvas › View',
      'Canvas › File',
    ]);
    // A group is labelled by its own full-path heading (role=group + aria-labelledby).
    expect(groups[1]).toHaveAttribute(
      'aria-labelledby',
      screen.getAllByTestId(LAUNCHER_PALETTE_GROUP_PATH_TESTID)[1].id,
    );
  });

  it('renders every projected row with its data hooks', () => {
    renderList();
    const rows = screen.getAllByTestId(LAUNCHER_PALETTE_ROW_TESTID);
    expect(rows).toHaveLength(58);
    for (const row of rows) {
      expect(row).toHaveAttribute('role', 'option');
      expect(row).toHaveAttribute('data-nav-verb-id');
      expect(row).toHaveAttribute('data-nav-risk');
      expect(row).toHaveAttribute('data-nav-availability');
      expect(row).toHaveAttribute(LAUNCHER_SECTION_ATTR);
      expect(row.id).toMatch(/^fredo-launcher-nav-row-\d+$/);
    }
    expect(rows[0]).toHaveAttribute('aria-selected', 'true');
    expect(rows[1]).toHaveAttribute('aria-selected', 'false');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    expect(rows[1]).toHaveAttribute('tabindex', '-1');
  });

  it('marks an unavailable row aria-disabled with the reason, and keeps it selectable', () => {
    const onSelect = renderList();
    const row = rowFor('wireframe.element.delete');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveAttribute('data-nav-availability', 'disabled');
    expect(row.getAttribute('aria-label')).toBe(
      `Delete — Canvas › Edit — Destructive — X — ${NAV_UNAVAILABLE_REASON}`,
    );
    expect(row).not.toHaveAttribute('disabled');

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(fullModel().rows.findIndex((r) => r.verbId === 'wireframe.element.delete'));
  });

  it('renders the risk chip (icon + word) only for non-safe rows', () => {
    renderList();
    const deleteRow = rowFor('wireframe.element.delete');
    expect(within(deleteRow).getByTestId(LAUNCHER_PALETTE_ROW_RISK_TESTID)).toHaveTextContent(
      'Destructive',
    );

    const zoomRow = rowFor('wireframe.zoom.in');
    expect(within(zoomRow).queryByTestId(LAUNCHER_PALETTE_ROW_RISK_TESTID)).toBeNull();

    const lockRow = rowFor('wireframe.element.toggleLock');
    expect(within(lockRow).getByTestId(LAUNCHER_PALETTE_ROW_RISK_TESTID)).toHaveTextContent(
      'Changes',
    );
  });

  it('renders the row keycap from the primary place and omits it when unbound', () => {
    renderList();
    expect(within(rowFor('wireframe.element.delete')).getByTestId(LAUNCHER_PALETTE_ROW_KEY_TESTID)).toHaveTextContent(
      'X',
    );
    expect(within(rowFor('wireframe.zoom.in')).getByTestId(LAUNCHER_PALETTE_ROW_KEY_TESTID)).toHaveTextContent(
      '+',
    );
  });

  it('puts a recent row first with the Recent micro-label', () => {
    renderList(fullModel(['wireframe.element.toggleLock']));
    const first = screen.getAllByTestId(LAUNCHER_PALETTE_ROW_TESTID)[0];
    expect(first).toHaveAttribute('data-nav-verb-id', 'wireframe.element.toggleLock');
    expect(first).toHaveAttribute(LAUNCHER_SECTION_ATTR, 'recent');
    expect(within(first).getByText(LAUNCHER_RECENT_LABEL)).toBeInTheDocument();
  });

  it('renders the empty copy inside the list root (no live region)', () => {
    renderList(filterLauncherPaletteModel(fullModel(), 'zzzz-no-such-verb'));
    expect(screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID)).toBeInTheDocument();
    expect(screen.queryAllByTestId(LAUNCHER_PALETTE_ROW_TESTID)).toHaveLength(0);
    expect(screen.getByText(LAUNCHER_PALETTE_EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('LauncherNavigationList — motion gate', () => {
  it('animates the list entrance only when motion is allowed', () => {
    renderWithChakra(
      <LauncherNavigationList model={fullModel()} selectedIndex={0} onSelect={vi.fn()} reducedMotion={false} />,
    );
    expect(screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID).style.animation).toBe(
      'launcher-palette-in 120ms ease',
    );
  });

  it('disables the entrance animation under reduced motion', () => {
    renderList();
    const list = screen.getByTestId(LAUNCHER_PALETTE_LIST_TESTID);
    expect(list.style.animation).toBe('none');
    expect(list.style.transition).toBe('none');
  });
});
