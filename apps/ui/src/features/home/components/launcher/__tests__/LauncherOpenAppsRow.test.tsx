/**
 * Spec #2954 ST-1 — the presentational `LauncherOpenAppsRow`.
 *
 * Pins: the DOM/aria contract (region / heading / list / listitem / entry /
 * close), the `null`-on-empty self-hide, the close-only-when-`canClose` rule,
 * the activate/close dispatch wiring (with `stopPropagation`), the status label,
 * and the G-274 clamp (title the sole ellipsizing child).
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { WindowEntry } from '@/shared/window-system/windowTypes';
import { LauncherOpenAppsRow, OPEN_APPS_HEADING } from '../LauncherOpenAppsRow';
import { openAppEntryLabel } from '../launcherOpenApps';

function win(over: Partial<WindowEntry> = {}): WindowEntry {
  return {
    id: 'mission-monitor',
    title: 'Mission Monitor',
    icon: null,
    component: null,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    isMaximized: false,
    isMinimized: false,
    focused: false,
    zIndex: 1,
    ...over,
  };
}

const noop = () => {};

afterEach(() => cleanup());

describe('LauncherOpenAppsRow — self-hide', () => {
  it('returns null when the (filtered) windows prop is empty — an absence, not an empty container', () => {
    const { container } = renderWithChakra(
      <LauncherOpenAppsRow windows={[]} onActivate={noop} onClose={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('launcher-open-apps')).toBeNull();
    expect(screen.queryByTestId('launcher-open-apps-heading')).toBeNull();
  });
});

describe('LauncherOpenAppsRow — DOM / aria contract', () => {
  it('renders the region, decorative heading, list and one listitem per window', () => {
    const windows = [
      win({ id: 'mission-monitor', title: 'Mission Monitor', focused: true, zIndex: 2 }),
      win({ id: 'query-viewer', title: 'Query Viewer', zIndex: 1 }),
      win({ id: 'terminal', title: 'Terminal', isMinimized: true, zIndex: 3 }),
    ];
    renderWithChakra(<LauncherOpenAppsRow windows={windows} onActivate={noop} onClose={noop} />);

    const region = screen.getByTestId('launcher-open-apps');
    expect(region).toHaveAttribute('role', 'region');
    expect(region).toHaveAttribute('aria-label', 'Open apps');

    const heading = screen.getByTestId('launcher-open-apps-heading');
    expect(heading).toHaveTextContent(OPEN_APPS_HEADING);
    expect(heading).toHaveTextContent('| OPEN APPS');
    expect(heading).toHaveAttribute('aria-hidden', 'true');

    const list = screen.getByRole('list');
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    const entries = screen.getAllByTestId(/^launcher-open-app-entry-/);
    expect(entries).toHaveLength(3);
    expect(screen.getByTestId('launcher-open-app-entry-mission-monitor')).toHaveAttribute(
      'aria-label',
      'Mission Monitor (active)',
    );
    expect(screen.getByTestId('launcher-open-app-entry-query-viewer')).toHaveAttribute(
      'aria-label',
      'Query Viewer (background)',
    );
    expect(screen.getByTestId('launcher-open-app-entry-terminal')).toHaveAttribute(
      'aria-label',
      'Terminal (minimized)',
    );

    // aria-current only on the focused window.
    expect(screen.getByTestId('launcher-open-app-entry-mission-monitor')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.getByTestId('launcher-open-app-entry-query-viewer')).not.toHaveAttribute(
      'aria-current',
    );
    expect(screen.getByTestId('launcher-open-app-entry-terminal')).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('renders the non-colour status label (minimized / active / background)', () => {
    const windows = [
      win({ id: 'a', title: 'A', focused: true }),
      win({ id: 'b', title: 'B' }),
      win({ id: 'c', title: 'C', isMinimized: true }),
    ];
    renderWithChakra(<LauncherOpenAppsRow windows={windows} onActivate={noop} onClose={noop} />);
    expect(screen.getByTestId('launcher-open-app-entry-a')).toHaveTextContent('active');
    expect(screen.getByTestId('launcher-open-app-entry-b')).toHaveTextContent('background');
    expect(screen.getByTestId('launcher-open-app-entry-c')).toHaveTextContent('minimized');
  });

  it('renders the host-supplied heading accessory in the heading line (ST-2 arrange slot)', () => {
    renderWithChakra(
      <LauncherOpenAppsRow
        windows={[win()]}
        onActivate={noop}
        onClose={noop}
        headingAccessory={<span data-testid="host-arrange">arrange</span>}
      />,
    );
    expect(screen.getByTestId('host-arrange')).toBeInTheDocument();
  });
});

describe('LauncherOpenAppsRow — activation / close wiring', () => {
  it('dispatches onActivate with the clicked window', () => {
    const onActivate = vi.fn();
    const target = win({ id: 'query-viewer', title: 'Query Viewer' });
    renderWithChakra(
      <LauncherOpenAppsRow windows={[target]} onActivate={onActivate} onClose={noop} />,
    );
    fireEvent.click(screen.getByTestId('launcher-open-app-entry-query-viewer'));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(target);
  });

  it('renders the close control ONLY when canClose is true', () => {
    renderWithChakra(
      <LauncherOpenAppsRow
        windows={[
          win({ id: 'closable', title: 'Closable', canClose: true }),
          win({ id: 'pinned', title: 'Pinned', canClose: false }),
        ]}
        onActivate={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByTestId('launcher-open-app-close-closable')).toBeInTheDocument();
    expect(screen.queryByTestId('launcher-open-app-close-pinned')).toBeNull();
  });

  it('close click calls onClose with the window and does NOT fire onActivate (stopPropagation)', () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const target = win({ id: 'closable', title: 'Closable' });
    renderWithChakra(
      <LauncherOpenAppsRow windows={[target]} onActivate={onActivate} onClose={onClose} />,
    );

    const close = screen.getByTestId('launcher-open-app-close-closable');
    expect(close).toHaveAttribute('aria-label', 'Close Closable');
    fireEvent.click(close);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(target);
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe('LauncherOpenAppsRow — token / clamp contract (G-274)', () => {
  it('clamps the entry button to maxWidth 200px and marks the active entry', () => {
    renderWithChakra(
      <LauncherOpenAppsRow
        windows={[
          win({ id: 'active-win', title: 'Active Win', focused: true }),
          win({ id: 'bg-win', title: 'Background Win' }),
        ]}
        onActivate={noop}
        onClose={noop}
      />,
    );

    const activeBtn = screen.getByTestId('launcher-open-app-entry-active-win');
    // G-274: the entry button is the only per-entry clamp.
    expect(getComputedStyle(activeBtn).maxWidth).toBe('200px');
    // Active entry carries the bottom accent underline.
    expect(getComputedStyle(activeBtn).boxShadow).toBe('inset 0 -3px 0 0 var(--accent-primary)');
    // Background entry has no accent underline (jsdom reports unset as '').
    expect(getComputedStyle(screen.getByTestId('launcher-open-app-entry-bg-win')).boxShadow).toBeFalsy();
  });

  it('uses theme CSS vars / tint() — no hex or rgba literals in the rendered entry styles', () => {
    renderWithChakra(
      <LauncherOpenAppsRow
        windows={[win({ id: 'min-win', title: 'Min Win', isMinimized: true })]}
        onActivate={noop}
        onClose={noop}
      />,
    );
    const btn = screen.getByTestId('launcher-open-app-entry-min-win');
    const color = getComputedStyle(btn).color;
    expect(color).toBe('var(--text-secondary)');
    // No hardcoded colour literal leaks into the class attribute.
    expect(btn.className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(btn.className).not.toMatch(/rgba?\(/);
  });
});
