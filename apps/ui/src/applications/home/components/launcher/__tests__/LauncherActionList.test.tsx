/**
 * Spec #2946 ST-9 — the launcher action palette's results list (presentational).
 *
 * Pins: the row contract (label + `Keycap` binding chips + tier tag), the
 * `launcher-action-*` testids, the unbound treatment, the empty state and the
 * roving `tabIndex` the host's `aria-activedescendant` targets.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { LauncherActionList } from '../LauncherActionList';
import type { LauncherActionResult } from '../launcherActionPalette';

const entry = (over: Partial<LauncherActionResult> = {}): LauncherActionResult => ({
  kind: 'action',
  actionId: 'fredo.launcher.toggle',
  title: 'Toggle launcher',
  tier: 'fredo',
  bindings: ['primary+space'],
  bindingDisplay: 'Ctrl + Space',
  ...over,
});

afterEach(() => {
  cleanup();
});

describe('LauncherActionList', () => {
  it('renders a listbox of action rows with label, Keycap chips and tier tag', () => {
    renderWithChakra(
      <LauncherActionList
        entries={[
          entry(),
          entry({
            actionId: 'terminal.newSession',
            title: 'New terminal session',
            tier: 'feature',
            featureId: 'terminal',
            bindings: ['primary+t'],
          }),
        ]}
        selectedIndex={0}
        onSelect={() => {}}
      />,
    );

    const list = screen.getByTestId('launcher-action-list');
    expect(list).toHaveAttribute('role', 'listbox');

    const rows = screen.getAllByTestId('launcher-action-entry');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-action-id', 'fredo.launcher.toggle');
    expect(rows[0]).toHaveAttribute('data-hotkey-tier', 'fredo');
    expect(rows[1]).toHaveAttribute('data-action-id', 'terminal.newSession');

    // Binding chips render through the ONE Keycap renderer.
    const bindings = screen.getAllByTestId('launcher-action-binding');
    expect(bindings).toHaveLength(2);
    expect(bindings[0].querySelector('[data-testid="hotkeys-keycap"]')).not.toBeNull();

    // Tier tag text.
    expect(screen.getAllByTestId('launcher-action-tier')[0]).toHaveTextContent('Global');
    expect(screen.getAllByTestId('launcher-action-tier')[1]).toHaveTextContent('terminal');
  });

  it('renders an unbound action without chips', () => {
    renderWithChakra(
      <LauncherActionList
        entries={[entry({ actionId: 'fredo.window.close', title: 'Close window', bindings: [], bindingDisplay: null })]}
        selectedIndex={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByTestId('launcher-action-binding')).toBeNull();
    expect(screen.getByTestId('launcher-action-unbound')).toBeInTheDocument();
  });

  it('renders the empty state with role="status"', () => {
    renderWithChakra(
      <LauncherActionList entries={[]} selectedIndex={0} onSelect={() => {}} />,
    );
    expect(screen.getByTestId('launcher-action-empty')).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('launcher-action-entry')).toBeNull();
  });

  it('keeps the selected row as the only tab stop and reports selection', () => {
    const onSelect = vi.fn();
    renderWithChakra(
      <LauncherActionList
        entries={[entry({ actionId: 'fredo.a', title: 'A' }), entry({ actionId: 'fredo.b', title: 'B' })]}
        selectedIndex={1}
        onSelect={onSelect}
      />,
    );

    const rows = screen.getAllByTestId('launcher-action-entry');
    expect(rows[0]).toHaveAttribute('tabindex', '-1');
    expect(rows[1]).toHaveAttribute('tabindex', '0');
    expect(rows[1]).toHaveAttribute('id', 'fredo-launcher-action-1');

    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith(0);
  });
});
