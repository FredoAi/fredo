/**
 * StandaloneAppWindow tests (Spec #2955 ST-5 — generic standalone app-window route).
 *
 * Pins the route contract the Rust `open_app_window` host loads at
 * `index.html?view=app&id=<appId>`:
 *   - resolves a registered, showable feature by the `id` query param;
 *   - renders it under the binding `app-window-root` testid;
 *   - wraps it in `WindowSystemProvider` (so `useWindowActions` never throws
 *     outside the main window's kernel);
 *   - calls the feature's `onMount` / `onUnmount` lifecycle hooks;
 *   - renders `app-window-unknown` for an absent / unregistered / non-showable
 *     id (never blank/crash);
 *   - mounts NO `WindowManager` (a standalone window is not a nested kernel).
 *
 * `allFeatures` (the eager registration glob) and `featureRegistry` are mocked
 * at the seam so the suite is deterministic and does not load every feature.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { useWindowActions } from '@/shared/window-system/useWindowActions';
import type { FredoFeatureClass } from '@/shared/classes/FredoFeatureClass';

vi.mock('../../allFeatures', () => ({}));

vi.mock('../../featureRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../featureRegistry')>();
  return { ...actual, getFeatures: vi.fn(() => []) };
});

import {
  StandaloneAppWindow,
  STANDALONE_APP_WINDOW_ROOT_TESTID,
  STANDALONE_APP_WINDOW_UNKNOWN_TESTID,
  readStandaloneAppId,
  resolveStandaloneFeature,
} from '../StandaloneAppWindow';
import { getFeatures } from '../../featureRegistry';

const getFeaturesMock = getFeatures as unknown as ReturnType<typeof vi.fn>;

interface FakeFeatureOptions {
  showable?: boolean;
  render?: () => React.ReactElement;
  onMount?: () => void | Promise<void>;
  onUnmount?: () => void | Promise<void>;
}

/** Minimal duck-typed feature — the route only reads id/showable/render/hooks. */
function fakeFeature(id: string, opts: FakeFeatureOptions = {}): FredoFeatureClass {
  return {
    id,
    name: id,
    showable: opts.showable ?? true,
    render: opts.render ?? (() => <div data-testid={`feature-${id}`}>{id}</div>),
    onMount: opts.onMount,
    onUnmount: opts.onUnmount,
  } as unknown as FredoFeatureClass;
}

/** Point jsdom's URL at a given query string (the route reads location.search). */
function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

beforeEach(() => {
  getFeaturesMock.mockReturnValue([]);
  setSearch('');
});

afterEach(() => {
  cleanup();
  setSearch('');
});

describe('readStandaloneAppId', () => {
  it('reads the `id` query param and trims it, else null', () => {
    expect(readStandaloneAppId('?view=app&id=mission-monitor')).toBe('mission-monitor');
    expect(readStandaloneAppId('?view=app&id=%20terminal%20')).toBe('terminal');
    expect(readStandaloneAppId('?view=app')).toBeNull();
    expect(readStandaloneAppId('?view=app&id=')).toBeNull();
    expect(readStandaloneAppId('?view=app&id=%20%20')).toBeNull();
    expect(readStandaloneAppId('')).toBeNull();
  });
});

describe('resolveStandaloneFeature', () => {
  it('returns the feature only when the id is registered AND showable', () => {
    const probe = fakeFeature('probe');
    expect(resolveStandaloneFeature('probe', [probe])).toBe(probe);
    expect(resolveStandaloneFeature(null, [probe])).toBeNull();
    expect(resolveStandaloneFeature('missing', [probe])).toBeNull();
    expect(resolveStandaloneFeature('hidden', [fakeFeature('hidden', { showable: false })])).toBeNull();
  });
});

describe('StandaloneAppWindow (Spec #2955 ST-5)', () => {
  it('resolves a registered showable app from the id query param and renders it', () => {
    getFeaturesMock.mockReturnValue([fakeFeature('probe')]);
    setSearch('?view=app&id=probe');

    renderWithChakra(<StandaloneAppWindow />);

    expect(screen.getByTestId(STANDALONE_APP_WINDOW_ROOT_TESTID)).toBeTruthy();
    expect(screen.getByTestId('feature-probe')).toBeTruthy();
  });

  it('calls onMount on mount and onUnmount on unmount (kernel parity)', () => {
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    getFeaturesMock.mockReturnValue([fakeFeature('probe', { onMount, onUnmount })]);
    setSearch('?view=app&id=probe');

    const { unmount } = renderWithChakra(<StandaloneAppWindow />);

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();

    unmount();

    expect(onUnmount).toHaveBeenCalledTimes(1);
  });

  it('renders `app-window-unknown` for an unregistered id (never blank/crash)', () => {
    getFeaturesMock.mockReturnValue([fakeFeature('other')]);
    setSearch('?view=app&id=missing');

    renderWithChakra(<StandaloneAppWindow />);

    expect(screen.getByTestId(STANDALONE_APP_WINDOW_UNKNOWN_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(STANDALONE_APP_WINDOW_ROOT_TESTID)).toBeNull();
  });

  it('renders `app-window-unknown` for a non-showable feature', () => {
    getFeaturesMock.mockReturnValue([fakeFeature('hidden', { showable: false })]);
    setSearch('?view=app&id=hidden');

    renderWithChakra(<StandaloneAppWindow />);

    expect(screen.getByTestId(STANDALONE_APP_WINDOW_UNKNOWN_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(STANDALONE_APP_WINDOW_ROOT_TESTID)).toBeNull();
  });

  it('renders `app-window-unknown` when no id is present', () => {
    setSearch('?view=app');

    renderWithChakra(<StandaloneAppWindow />);

    expect(screen.getByTestId(STANDALONE_APP_WINDOW_UNKNOWN_TESTID)).toBeTruthy();
  });

  it('wraps the app in WindowSystemProvider so `useWindowActions` never throws', () => {
    function Probe(): React.ReactElement {
      const { openWindow } = useWindowActions();
      return <div data-testid="probe-actions">{typeof openWindow}</div>;
    }
    getFeaturesMock.mockReturnValue([fakeFeature('probe', { render: () => <Probe /> })]);
    setSearch('?view=app&id=probe');

    renderWithChakra(<StandaloneAppWindow />);

    expect(screen.getByTestId('probe-actions').textContent).toBe('function');
  });

  it('mounts NO nested in-window kernel (no WindowManager, no window frame)', () => {
    getFeaturesMock.mockReturnValue([fakeFeature('probe')]);
    setSearch('?view=app&id=probe');

    renderWithChakra(<StandaloneAppWindow />);

    expect(screen.queryByTestId('window-manager')).toBeNull();
    expect(screen.queryByTestId('window-frame-probe')).toBeNull();
    expect(screen.queryByTestId('workspace-layout')).toBeNull();
  });

  it('honors the appId prop override (test seam)', () => {
    getFeaturesMock.mockReturnValue([fakeFeature('probe')]);
    setSearch(''); // no URL id

    renderWithChakra(<StandaloneAppWindow appId="probe" />);

    expect(screen.getByTestId('feature-probe')).toBeTruthy();
  });
});
