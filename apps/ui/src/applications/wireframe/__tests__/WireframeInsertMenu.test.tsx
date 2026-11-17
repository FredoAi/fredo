/**
 * Wireframe insert menu (Spec #3119, ST-6 — UI/UX §9; store-direct since
 * Spec #3151, ST-5).
 *
 * The pill is the ONE pointer affordance left after the toolbar retirement. It
 * calls the retained action handlers directly (`addWireframeElement`) and never
 * changes a place — it is a shortcut to the capability, not a mode. The
 * engine-only `data-nav-verb-id` / `data-nav-args` hooks are dropped with the
 * navigation engine, so the rows are asserted by their accessible names.
 */

import React from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WireframeInsertMenu } from '../components/WireframeInsertMenu';
import { getSnapshot, resetWireframeStoreForTests } from '../store/wireframeDocumentStore';

function renderInsertMenu() {
  return renderWithChakra(<WireframeInsertMenu />);
}

/** The open popup (rows do not exist until the menu is opened). */
async function openMenu(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId('wireframe-insert'));
  await waitFor(() => {
    expect(screen.getAllByTestId('wireframe-insert-item').length).toBeGreaterThan(0);
  });
  const item = screen.getAllByTestId('wireframe-insert-item')[0];
  const popup = item.closest('[role="menu"]');
  if (popup === null) throw new Error('insert popup not mounted');
  return popup as HTMLElement;
}

beforeEach(() => {
  resetWireframeStoreForTests();
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
});

describe('wireframe insert menu (Spec #3151, ST-5)', () => {
  it('renders the pointer pill with aria-haspopup=menu and no closed rows', () => {
    renderInsertMenu();
    const trigger = screen.getByTestId('wireframe-insert');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAccessibleName('Insert');
    expect(screen.queryAllByTestId('wireframe-insert-item')).toHaveLength(0);
  });

  it('lists the seven element verbs, four presets, three kinds and twelve icons', async () => {
    renderInsertMenu();
    const popup = await openMenu();

    const items = within(popup).getAllByTestId('wireframe-insert-item');
    // 7 element verbs + 4 section presets + 3 shape kinds + 12 icon ids.
    expect(items).toHaveLength(26);
    // The engine-only navigation hooks are gone.
    for (const item of items) {
      expect(item).not.toHaveAttribute('data-nav-verb-id');
      expect(item).not.toHaveAttribute('data-nav-args');
    }
  });

  it('runs the section preset handler and never changes a place', async () => {
    renderInsertMenu();
    const popup = await openMenu();
    const user = userEvent.setup();

    await user.click(within(popup).getByRole('menuitem', { name: 'Footer' }));

    await waitFor(() => {
      expect(getSnapshot().document.elements).toHaveLength(1);
    });
    expect(getSnapshot().document.elements[0]).toMatchObject({
      type: 'section',
      preset: 'footer',
    });
    // One document mutation, one app-local history entry.
    expect(getSnapshot().canUndo).toBe(true);
  });

  it('runs the icon handler with the chosen icon id', async () => {
    renderInsertMenu();
    const popup = await openMenu();
    const user = userEvent.setup();

    await user.click(within(popup).getByRole('menuitem', { name: 'User' }));

    await waitFor(() => {
      expect(getSnapshot().document.elements).toHaveLength(1);
    });
    expect(getSnapshot().document.elements[0]).toMatchObject({
      type: 'icon',
      iconId: 'user',
    });
  });

  it('runs the shape handler with the chosen kind', async () => {
    renderInsertMenu();
    const popup = await openMenu();
    const user = userEvent.setup();

    await user.click(within(popup).getByRole('menuitem', { name: 'Triangle' }));

    await waitFor(() => {
      expect(getSnapshot().document.elements).toHaveLength(1);
    });
    expect(getSnapshot().document.elements[0]).toMatchObject({
      type: 'shape',
      shape: 'triangle',
    });
  });
});
