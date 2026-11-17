/**
 * #3151 ST-6 (AC3 / R-3.5, Q-23) — Dev Mode switches view by POINTER alone.
 *
 * The navigation engine is gone: no command rail, no activity trail, no place
 * cursor, no `data-nav-*` verb hooks and no `x`/`i`/`b`/`v` strokes remain.
 * The view toggle is still the app's primary control: click `Application Data`
 * and the rows view's `dev-mode-filter-input` disappears; click `Rows` and it
 * comes back.
 *
 * No `shared/navigation` import may appear in this file (AC1's literal
 * predicate).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';

// The 3-D manifold needs WebGL (jsdom has none); stub ONLY the canvas so the
// REAL Dev Mode tree + pointer controls render.
vi.mock('../components/SpatiotemporalManifold', () => ({
  SpatiotemporalManifold: () => null,
}));

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  StreamProvider,
  applyRowDelivery,
  resetRowStoreForTests,
} from '@/shared/contexts/StreamContext';
import { DevMode } from '../components/DevMode';

function renderDevMode() {
  return renderWithChakra(
    <StreamProvider>
      <DevMode />
    </StreamProvider>,
  );
}

/** Seed one Chat row so the rows view is non-empty (and the filter input mounts). */
function seedEvent(): void {
  act(() => {
    applyRowDelivery({
      queryId: 'q-devmode-view-switch',
      eventType: 'Chat',
      kind: 'insert',
      seq: 1,
      key: { sessionId: 'ses_view', correlationId: 'ses_view_1' },
      patch: {
        sessionId: 'ses_view',
        correlationId: 'ses_view_1',
        seq: 1,
        startedAtNs: 1_000,
        updatedAtNs: 2_000,
      },
    } as never);
  });
}

const toggle = () => screen.getByTestId('dev-mode-view-toggle');

beforeEach(() => {
  resetRowStoreForTests();
  seedEvent();
});

afterEach(() => {
  cleanup();
  resetRowStoreForTests();
  vi.clearAllMocks();
});

describe('#3151 R-3.5 — Dev Mode view switch, pointer only', () => {
  it('switches Rows ↔ Application Data with the view toggle and no navigation surface', () => {
    renderDevMode();

    // Rows is the default view: the filter input is mounted.
    expect(screen.getByTestId('dev-mode-filter-input')).toBeInTheDocument();

    // Click the Application Data segment — a pointer switch, not a verb.
    fireEvent.click(within(toggle()).getByText('Application Data'));
    expect(screen.queryByTestId('dev-mode-filter-input')).toBeNull();

    // Click the Rows segment — the filter input returns.
    fireEvent.click(within(toggle()).getByText('Rows'));
    expect(screen.getByTestId('dev-mode-filter-input')).toBeInTheDocument();

    // Re-selecting the active view is a no-op (no crash, no state flip).
    fireEvent.click(within(toggle()).getByText('Rows'));
    expect(screen.getByTestId('dev-mode-filter-input')).toBeInTheDocument();
  });
});
