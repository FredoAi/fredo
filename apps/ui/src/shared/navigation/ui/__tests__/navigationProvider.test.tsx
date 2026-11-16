/**
 * Spec #3122 (P8), ST-1 — `NavigationProvider`, the ONE webview shell provider.
 *
 * Proves the two responsibilities the P8 shell mount depends on:
 *   1. it installs the ONE navigation chord dispatcher on mount and releases it on unmount,
 *      adding exactly one document keydown listener while mounted;
 *   2. it renders exactly ONE navigation announcer (the single polite live region) and never
 *      a legacy `hotkeys-announcer` region.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { NAV_ANNOUNCER_LABEL, NAV_ANNOUNCER_TESTID } from '../constants';
import { resetNavigationAnnouncer } from '../announce';
import {
  isNavigationKeyDispatchInstalled,
  resetNavigationKeyDispatchForTests,
} from '../globalKeys';
import { NavigationProvider } from '../NavigationProvider';

beforeEach(() => {
  resetNavigationKeyDispatchForTests();
  resetNavigationAnnouncer();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  resetNavigationKeyDispatchForTests();
  resetNavigationAnnouncer();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('NavigationProvider', () => {
  it('renders children and exactly ONE navigation announcer', () => {
    renderWithChakra(
      <NavigationProvider>
        <div data-testid="shell-content">shell</div>
      </NavigationProvider>,
    );

    expect(screen.getByTestId('shell-content')).toBeInTheDocument();
    const announcers = screen.getAllByTestId(NAV_ANNOUNCER_TESTID);
    expect(announcers).toHaveLength(1);
    expect(announcers[0]).toHaveAttribute('role', 'status');
    expect(announcers[0]).toHaveAttribute('aria-live', 'polite');
    expect(announcers[0]).toHaveAttribute('aria-label', NAV_ANNOUNCER_LABEL);
    expect(document.querySelector('[data-testid="hotkeys-announcer"]')).toBeNull();
  });

  it('installs the ONE chord dispatcher on mount and releases it on unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount } = renderWithChakra(<NavigationProvider>content</NavigationProvider>);

    expect(isNavigationKeyDispatchInstalled()).toBe(true);
    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

    unmount();

    expect(isNavigationKeyDispatchInstalled()).toBe(false);
    expect(removeSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
  });
});
