/**
 * Wireframe place lifecycle (Spec #3119, ST-4 — R-9/AC9).
 *
 * Drives the REAL provider + the ONE element-scoped key adapter through the
 * declared `wireframeSurface` and reads the cached place view the shell/canvas
 * consume. No canvas, no journal subscription in the consumer — the place slice
 * (`placeId`/`cursor`/`operator`/`transient`/`armed`) is the observable.
 *
 * Titles are authored to the QA Expert's literal manifest (G-419).
 */

import React from 'react';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  HotkeyAnnouncer,
  resetHotkeyAnnouncer,
  subscribeAnnouncer,
} from '@/shared/hotkeys/announcer';
import { resetNavigationAnnouncer } from '@/shared/navigation/ui/announce';
import { resetWireframeStoreForTests } from '../store/wireframeDocumentStore';
import {
  WIREFRAME_CREATE_OPERATOR,
  resetWireframeSurfaceForTests,
} from '../wireframeSurface';
import {
  WireframeNavigationProvider,
  handleWireframeKeyDown,
  useWireframeNavigation,
  useWireframePlaceView,
} from '../components/WireframeNavigationProvider';

function Harness(): React.ReactElement {
  const { host } = useWireframeNavigation();
  const place = useWireframePlaceView(host);

  return React.createElement(
    'div',
    {
      'data-testid': 'harness-root',
      'data-place': place.placeId,
      'data-arm': place.armed ?? 'none',
      'data-cursor': place.cursor ?? 'default',
      'data-operator': place.operator ?? 'none',
      'data-transient': place.transient ? 'true' : 'false',
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) =>
        handleWireframeKeyDown(event, host, performance.now()),
    },
    React.createElement('button', { 'data-testid': 'trigger', type: 'button' }, 'Trigger'),
  );
}

function renderHarness(): void {
  renderWithChakra(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(HotkeyAnnouncer),
      React.createElement(
        WireframeNavigationProvider,
        null,
        React.createElement(Harness),
      ),
    ),
  );
}

async function press(key: string): Promise<void> {
  const trigger = screen.getByTestId('trigger');
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key });
  });
}

function root(): HTMLElement {
  return screen.getByTestId('harness-root');
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

describe('place lifecycle (R-9 / AC9)', () => {
  it('entering and exiting a place announces exactly once', async () => {
    renderHarness();

    let announcements = 0;
    const unsubscribe = subscribeAnnouncer(() => {
      announcements += 1;
    });
    const announcer = screen.getByTestId('hotkeys-announcer');

    await press('c');
    expect(root().getAttribute('data-place')).toBe('wireframe.create');
    expect(announcer.textContent).toBe('Create — 9 actions');
    expect(announcements).toBe(1);

    announcements = 0;
    await press('Escape');
    expect(root().getAttribute('data-place')).toBe('wireframe.canvas');
    expect(announcer.textContent).toBe('Left Create — Canvas — 2 actions');
    expect(announcements).toBe(1);

    unsubscribe();
  });

  it('a keyboard place transition keeps focus on the triggering control', async () => {
    renderHarness();
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      fireEvent.keyDown(trigger, { key: 'c' });
    });

    expect(root().getAttribute('data-place')).toBe('wireframe.create');
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('the create place exposes the crosshair cursor and the create operator', async () => {
    renderHarness();
    await press('c');

    expect(root().getAttribute('data-place')).toBe('wireframe.create');
    expect(root().getAttribute('data-cursor')).toBe('crosshair');
    expect(root().getAttribute('data-operator')).toBe(WIREFRAME_CREATE_OPERATOR);
    expect(root().getAttribute('data-transient')).toBe('true');
  });

  it('leaving a place restores the default cursor', async () => {
    renderHarness();
    await press('c');
    expect(root().getAttribute('data-cursor')).toBe('crosshair');

    await press('Escape');

    expect(root().getAttribute('data-place')).toBe('wireframe.canvas');
    expect(root().getAttribute('data-cursor')).toBe('default');
    expect(root().getAttribute('data-operator')).toBe('none');
  });
});
