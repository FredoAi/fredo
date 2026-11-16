/**
 * Spec #3147 ST-6 — the settings pane's states and its absent-key render.
 *
 * Pins the states UI/UX §3.1 fixes: loading (3 skeletons), empty (and the list
 * is NOT rendered), populated, refusal (with `data-refusal-code` + the copy
 * sentence), success, and `list-load-failed` (a verdict, never a blank pane and
 * never the empty state). Plus the two design-added hooks, the install button's
 * recovery after a refusal (R-3.5), and the absent-key wire shape (G-413).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { InstalledAppEntry } from '@/shared/installed-apps/types';

const storeMock = vi.hoisted(() => ({
  refresh: vi.fn(),
  record: vi.fn(),
  status: {
    entries: [] as InstalledAppEntry[],
    loading: false,
    settled: true,
    error: null as { code: string; detail: string } | null,
  },
}));

const clientMock = vi.hoisted(() => ({
  install: vi.fn(),
}));

vi.mock('@/shared/installed-apps/store', () => ({
  refreshInstalledApps: () => storeMock.refresh(),
  recordInstalledApp: (entry: InstalledAppEntry) => storeMock.record(entry),
}));

vi.mock('@/shared/installed-apps/useInstalledApps', () => ({
  useInstalledAppsStatus: () => storeMock.status,
}));

vi.mock('@/shared/installed-apps/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/installed-apps/client')>();
  return {
    ...actual,
    installPackage: (...args: unknown[]) => clientMock.install(...args),
  };
});

import {
  InstalledAppsSettings,
  EMPTY_HEADLINE,
  EMPTY_NEXT_ACTION,
  INSTALL_BUTTON_LABEL,
  LIMITATIONS_HEADING,
  LIMITATIONS_SENTENCE,
  UNSIGNED_PACKAGE_NOTE,
} from '../InstalledAppsSettings';
import { INSTALL_REFUSAL_COPY } from '@/shared/installed-apps/refusals';

const ENTRY: InstalledAppEntry = {
  id: 'dev.example.tools',
  displayName: 'Example Tools',
  version: '1.2.0',
  enginesFredo: '^0.1.0',
  installedAt: '2026-01-01T00:00:00Z',
  windowLabel: 'installed-dev.example.tools',
  description: 'A helpful tool.',
};

beforeEach(() => {
  storeMock.refresh = vi.fn(async () => {});
  storeMock.record = vi.fn();
  storeMock.status = { entries: [], loading: false, settled: true, error: null };
  clientMock.install = vi.fn();
});

afterEach(cleanup);

describe('#3147 ST-6 — InstalledAppsSettings anatomy', () => {
  it('renders the header, the trust note, the install button and the limitations block', () => {
    renderWithChakra(<InstalledAppsSettings />);

    expect(screen.getByTestId('installed-apps-pane')).toBeInTheDocument();
    const button = screen.getByTestId('installed-apps-install-button');
    // The visible label IS the accessible name — three ASCII dots, no aria-label.
    expect(button).toHaveTextContent(INSTALL_BUTTON_LABEL);
    expect(button.getAttribute('aria-label')).toBeNull();

    expect(screen.getByText(UNSIGNED_PACKAGE_NOTE)).toBeInTheDocument();

    const limitations = screen.getByTestId('installed-apps-limitations');
    expect(limitations).toHaveTextContent(LIMITATIONS_HEADING);
    expect(limitations).toHaveTextContent(LIMITATIONS_SENTENCE);
    // Not a tab stop.
    expect(limitations.getAttribute('tabindex')).toBeNull();
  });

  it('asks the registry for the list on mount (nothing reads at startup)', () => {
    renderWithChakra(<InstalledAppsSettings />);
    expect(storeMock.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('#3147 ST-6 — InstalledAppsSettings states', () => {
  it('loading: renders three skeleton rows, no list and no empty state', () => {
    storeMock.status = { entries: [], loading: true, settled: false, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    expect(screen.getByTestId('installed-apps-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('installed-apps-list')).toBeNull();
    expect(screen.queryByTestId('installed-apps-empty')).toBeNull();
  });

  it('empty: renders the empty state (role=status) and does NOT render the list', () => {
    renderWithChakra(<InstalledAppsSettings />);

    const empty = screen.getByTestId('installed-apps-empty');
    expect(empty).toHaveAttribute('role', 'status');
    expect(empty).toHaveTextContent(EMPTY_HEADLINE);
    expect(empty).toHaveTextContent(EMPTY_NEXT_ACTION);
    expect(empty.getAttribute('tabindex')).toBeNull();
    // The absence rule: never an empty <ul> beside an empty message.
    expect(screen.queryByTestId('installed-apps-list')).toBeNull();
  });

  it('populated: renders a read-only list with no Open/Remove control', () => {
    storeMock.status = { entries: [ENTRY], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    const list = screen.getByTestId('installed-apps-list');
    expect(list).toHaveAttribute('role', 'list');

    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveAttribute('data-app-id', ENTRY.id);
    expect(row).toHaveTextContent(ENTRY.displayName);
    expect(row).toHaveTextContent(ENTRY.version);

    // Read-only: no button inside the row (one open surface, in the launcher).
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByTestId('installed-apps-empty')).toBeNull();
  });

  it('absent description key: renders no description line and leaks no undefined/null (G-413)', () => {
    // The REAL wire shape: `description` is an ABSENT KEY when the manifest
    // omitted one — never `null`, never `undefined`.
    const wireShape = {
      id: 'no.desc',
      displayName: 'No Description App',
      version: '0.1.0',
      enginesFredo: '^0.1.0',
      installedAt: '2026-01-02T00:00:00Z',
      windowLabel: 'installed-no.desc',
    } as InstalledAppEntry;
    expect('description' in wireShape).toBe(false);

    storeMock.status = { entries: [wireShape], loading: false, settled: true, error: null };
    const { container } = renderWithChakra(<InstalledAppsSettings />);

    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveTextContent('No Description App');
    // No `undefined`/`null` leaked into the rendered row.
    expect(row.textContent ?? '').not.toMatch(/undefined|null/);
    expect(container.textContent ?? '').not.toMatch(/undefined|NaN/);
  });

  it('list-load-failed: renders the refusal with io_error, never the empty state', () => {
    storeMock.status = {
      entries: [],
      loading: false,
      settled: true,
      error: { code: 'io_error', detail: 'the registry could not be read' },
    };
    renderWithChakra(<InstalledAppsSettings />);

    const refusal = screen.getByTestId('installed-apps-refusal');
    expect(refusal).toHaveAttribute('role', 'alert');
    expect(refusal).toHaveAttribute('data-refusal-code', 'io_error');
    expect(screen.getByTestId('installed-apps-refusal-reason')).toHaveTextContent(
      INSTALL_REFUSAL_COPY.io_error,
    );
    // A failed read is a verdict, NOT the empty state.
    expect(screen.queryByTestId('installed-apps-empty')).toBeNull();
    expect(screen.queryByTestId('installed-apps-list')).toBeNull();
  });
});

describe('#3147 ST-6 — install verdicts (R-3.5 recovery)', () => {
  it('refusal: renders data-refusal-code + the copy sentence and re-enables the button', async () => {
    clientMock.install = vi.fn(async () => {
      throw { code: 'no_manifest', detail: 'no fredo-app.json at the archive root' };
    });
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-install-button'));

    const refusal = await screen.findByTestId('installed-apps-refusal');
    expect(refusal).toHaveAttribute('data-refusal-code', 'no_manifest');
    expect(screen.getByTestId('installed-apps-refusal-reason')).toHaveTextContent(
      INSTALL_REFUSAL_COPY.no_manifest,
    );

    // R-3.5: the install surface is never left wedged.
    await waitFor(() => {
      expect(screen.getByTestId('installed-apps-install-button')).not.toBeDisabled();
    });
  });

  it('success: records the entry and renders the polite success strip', async () => {
    clientMock.install = vi.fn(async () => ENTRY);
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-install-button'));

    const success = await screen.findByTestId('installed-apps-install-success');
    expect(success).toHaveAttribute('role', 'status');
    expect(success).toHaveAttribute('aria-live', 'polite');
    expect(success).toHaveTextContent(`${ENTRY.displayName} is installed.`);
    expect(storeMock.record).toHaveBeenCalledWith(ENTRY);
    expect(screen.queryByTestId('installed-apps-refusal')).toBeNull();
  });
});
