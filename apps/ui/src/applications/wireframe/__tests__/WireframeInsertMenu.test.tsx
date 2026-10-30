/**
 * Wireframe insert menu (Spec #3119, ST-6 — UI/UX §9 / hooks §11 #4).
 *
 * The pill is the ONE pointer affordance left after the toolbar retirement. It
 * dispatches the DECLARED add verbs through the host (`data-nav-verb-id` /
 * `data-nav-args` describe the exact call every item makes) and never changes
 * the place — it is a shortcut, not a mode.
 */

import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { NavigationHost } from '@/shared/navigation/ui/host';
import { WireframeInsertMenu } from '../components/WireframeInsertMenu';
import {
  WireframeNavigationProvider,
  useWireframeNavigation,
} from '../components/WireframeNavigationProvider';
import {
  getNavigationJournal,
  getSnapshot,
  resetWireframeStoreForTests,
} from '../store/wireframeDocumentStore';
import { resetWireframeSurfaceForTests } from '../wireframeSurface';

let currentHost: NavigationHost | null = null;

function HostCapture(): null {
  currentHost = useWireframeNavigation().host;
  return null;
}

function host(): NavigationHost {
  if (currentHost === null) throw new Error('host not mounted');
  return currentHost;
}

function renderInsertMenu() {
  return renderWithChakra(
    <WireframeNavigationProvider>
      <HostCapture />
      <WireframeInsertMenu />
    </WireframeNavigationProvider>,
  );
}

async function openMenu(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId('wireframe-insert'));
  await waitFor(() => {
    expect(screen.getAllByTestId('wireframe-insert-item').length).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  currentHost = null;
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
});

afterEach(() => {
  cleanup();
  currentHost = null;
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
});

describe('wireframe insert menu (Spec #3119, ST-6)', () => {
  it('renders the pointer pill with aria-haspopup=menu', () => {
    renderInsertMenu();
    const trigger = screen.getByTestId('wireframe-insert');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryAllByTestId('wireframe-insert-item')).toHaveLength(0);
  });

  it('lists the seven element verbs, four presets, three kinds and twelve icons', async () => {
    renderInsertMenu();
    await openMenu();

    const items = screen.getAllByTestId('wireframe-insert-item');
    // 7 element verbs + 4 section presets + 3 shape kinds + 12 icon ids.
    expect(items).toHaveLength(26);
    for (const item of items) {
      expect(item).toHaveAttribute('data-nav-verb-id');
    }
    expect(
      screen.getAllByTestId('wireframe-insert-item').filter(
        (item) => item.getAttribute('data-nav-verb-id') === 'wireframe.add.section',
      ),
    ).toHaveLength(4);
    expect(
      screen.getAllByTestId('wireframe-insert-item').filter(
        (item) => item.getAttribute('data-nav-args')?.startsWith('iconId=') === true,
      ),
    ).toHaveLength(12);
  });

  it('carries the explicit choice as data-nav-args', async () => {
    renderInsertMenu();
    await openMenu();

    const args = screen
      .getAllByTestId('wireframe-insert-item')
      .map((item) => item.getAttribute('data-nav-args'));
    expect(args).toContain('preset=footer');
    expect(args).toContain('shape=triangle');
    expect(args).toContain('iconId=user');
    // The seven element verbs take no arguments.
    expect(args.filter((value) => value === null)).toHaveLength(7);
  });

  it('runs the declared verb with its args and never enters Create', async () => {
    renderInsertMenu();
    await openMenu();
    const user = userEvent.setup();

    const footer = screen
      .getAllByTestId('wireframe-insert-item')
      .find((item) => item.getAttribute('data-nav-args') === 'preset=footer');
    expect(footer).toBeDefined();

    await user.click(footer as HTMLElement);

    await waitFor(() => {
      expect(getSnapshot().document.elements).toHaveLength(1);
    });
    const elements = getSnapshot().document.elements;
    expect(elements[0]).toMatchObject({ type: 'section', preset: 'footer' });
    const entries = getNavigationJournal().entries();
    expect(entries[entries.length - 1].verbId).toBe('wireframe.add.section');
    expect(host().getSnapshot().context.placePath).toEqual(['wireframe.canvas']);
  });

  it('runs the icon verb with the chosen icon id', async () => {
    renderInsertMenu();
    await openMenu();
    const user = userEvent.setup();

    const userIcon = screen
      .getAllByTestId('wireframe-insert-item')
      .find((item) => item.getAttribute('data-nav-args') === 'iconId=user');
    expect(userIcon).toBeDefined();

    await user.click(userIcon as HTMLElement);

    await waitFor(() => {
      expect(getSnapshot().document.elements).toHaveLength(1);
    });
    expect(getSnapshot().document.elements[0]).toMatchObject({
      type: 'icon',
      iconId: 'user',
    });
  });
});
