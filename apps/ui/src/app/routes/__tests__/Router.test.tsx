/**
 * Router standalone-window route tests (Spec #2955 ST-5).
 *
 * Pins the route-branch selection the native windows load:
 *   - `?view=app&id=<appId>` → the generic `StandaloneAppWindow` (the route the
 *     Rust `open_app_window` host builds at `index.html?view=app&id=<appId>`);
 *   - `?view=terminal` and `?view=doom` are UNCHANGED (regression invariant);
 *   - the default (no `view`) still routes to `Home`.
 *
 * Every route component is mocked so the suite proves branch selection only.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/features/home', () => ({ Home: () => <div data-testid="route-home" /> }));
vi.mock('@/features/diagram/components/ArchitectureDiagram', () => ({
  ArchitectureDiagram: () => <div data-testid="route-diagram" />,
}));
vi.mock('@/features/dev-mode', () => ({ DevMode: () => <div data-testid="route-dev-mode" /> }));
vi.mock('@/features/terminal', () => ({
  TerminalWindow: () => <div data-testid="route-terminal" />,
}));
vi.mock('@/features/doom', () => ({ DoomWindow: () => <div data-testid="route-doom" /> }));
vi.mock('@/features/app-window', () => ({
  StandaloneAppWindow: () => <div data-testid="route-app-window" />,
}));
vi.mock('@/app/providers/ExtensionProvider', () => ({
  useExtension: () => ({ currentPage: 'main', showDiagram: false }),
}));

import { Router } from '../Router';

function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

afterEach(() => {
  cleanup();
  setSearch('');
});

describe('Router — standalone window routes (Spec #2955 ST-5)', () => {
  it('routes `?view=app` to the generic StandaloneAppWindow', () => {
    setSearch('?view=app&id=mission-monitor');

    render(<Router />);

    expect(screen.getByTestId('route-app-window')).toBeTruthy();
    expect(screen.queryByTestId('route-terminal')).toBeNull();
    expect(screen.queryByTestId('route-doom')).toBeNull();
  });

  it('still routes `?view=terminal` to the Terminal window (regression invariant)', () => {
    setSearch('?view=terminal');

    render(<Router />);

    expect(screen.getByTestId('route-terminal')).toBeTruthy();
    expect(screen.queryByTestId('route-app-window')).toBeNull();
  });

  it('still routes `?view=doom` to the Doom window (regression invariant)', () => {
    setSearch('?view=doom');

    render(<Router />);

    expect(screen.getByTestId('route-doom')).toBeTruthy();
    expect(screen.queryByTestId('route-app-window')).toBeNull();
  });

  it('routes the default (no `view`) to Home', () => {
    setSearch('');

    render(<Router />);

    expect(screen.getByTestId('route-home')).toBeTruthy();
  });
});
