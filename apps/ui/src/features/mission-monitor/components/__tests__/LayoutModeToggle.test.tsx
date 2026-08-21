/**
 * Component tests for LayoutModeToggle — the Chain/Force layout segmented
 * control (#2752 ST-5).
 *
 * Covers QA Plan T12 (accessible label + aria-pressed) and T13 (full keyboard
 * operability) for EARS-7:
 *  - the group carries role="group" with the accessible name "Layout mode";
 *  - each option is a real <button> with boolean aria-pressed — true for the
 *    active mode ONLY — and the pressed state follows BOTH mouse and keyboard
 *    switching;
 *  - roving tabindex: Tab enters at the active option (tabIndex 0), the
 *    inactive option is tabIndex -1;
 *  - ArrowRight/ArrowDown move to the next option AND select it (optimistic,
 *    selection follows focus, no wrap); ArrowLeft/ArrowUp move back; Home/End
 *    jump to first/last;
 *  - focus follows selection (moves to the newly-active option) — focus is
 *    never lost while arrow-keying;
 *  - Space/Enter select natively (button default — the component does not
 *    intercept them);
 *  - re-click on the active option is a no-op (no "none" state).
 *
 * The component is pure-prop (mode + onChange), so it is rendered directly —
 * no panel/hook mocks. The stateful ToggleHarness mirrors the panel's
 * usePersistedSetting ownership (MissionMonitorPanel.tsx:625-629).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { LayoutModeToggle } from '../LayoutModeToggle';
import type { LayoutMode } from '../../lib/layout';

afterEach(() => cleanup());

/** Stateful harness — simulates the panel's persisted-mode ownership. */
function ToggleHarness({ initialMode = 'chain' }: { initialMode?: LayoutMode }) {
  const [mode, setMode] = useState<LayoutMode>(initialMode);
  return <LayoutModeToggle mode={mode} onChange={setMode} />;
}

describe('LayoutModeToggle (#2752 ST-5 / EARS-7)', () => {
  it('exposes an accessible group named "Layout mode" with two real option buttons (T12)', () => {
    renderWithChakra(<LayoutModeToggle mode="chain" onChange={vi.fn()} />);

    // The control is reachable through the a11y tree as a labeled group.
    const group = screen.getByRole('group', { name: 'Layout mode' });
    expect(group).toHaveAttribute('data-testid', 'mm-layout-toggle');
    // ReactFlow noWheelClassName: wheel over the toggle must not zoom the canvas.
    expect(group).toHaveClass('nowheel');

    // Each option is a real <button> (never a radio/checkbox) with the
    // visible label as its accessible name.
    expect(screen.getByRole('button', { name: 'Chain' }).tagName).toBe('BUTTON');
    expect(screen.getByRole('button', { name: 'Force' }).tagName).toBe('BUTTON');
  });

  it('aria-pressed is true for the active mode ONLY and follows mouse switching (T12)', () => {
    renderWithChakra(<ToggleHarness initialMode="chain" />);

    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'false');

    // Mouse switch: Chain → Force → back to Chain. The pressed state always
    // tracks exactly one option.
    fireEvent.click(screen.getByRole('button', { name: 'Force' }));
    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Chain' }));
    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('uses roving tabindex — the active option is the single tab stop (EARS-7)', () => {
    renderWithChakra(<LayoutModeToggle mode="chain" onChange={vi.fn()} />);

    // Tab enters the group at the ACTIVE option; the inactive option is
    // tabIndex -1 so Tab can never land on it.
    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('tabindex', '-1');
  });

  it('roving tabindex follows the mode — switching via mouse moves the tab stop (EARS-7)', () => {
    renderWithChakra(<ToggleHarness initialMode="chain" />);

    fireEvent.click(screen.getByRole('button', { name: 'Force' }));

    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight selects the next option and moves DOM focus to it (T13)', () => {
    renderWithChakra(<ToggleHarness initialMode="chain" />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Chain' }), { key: 'ArrowRight' });

    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'false');
    // Selection follows focus — focus never gets lost (moves to the active
    // option, which is now the single tab stop).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Force' }));
  });

  it('ArrowDown also selects the next option (T13)', () => {
    renderWithChakra(<ToggleHarness initialMode="chain" />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Chain' }), { key: 'ArrowDown' });

    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Force' }));
  });

  it('ArrowLeft selects the previous option and moves focus back (T13)', () => {
    renderWithChakra(<ToggleHarness initialMode="force" />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Force' }), { key: 'ArrowLeft' });

    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'false');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chain' }));
  });

  it('ArrowUp selects the previous option (T13)', () => {
    renderWithChakra(<ToggleHarness initialMode="force" />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Force' }), { key: 'ArrowUp' });

    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chain' }));
  });

  it('Home / End jump to the first / last option (T13)', () => {
    renderWithChakra(<ToggleHarness initialMode="force" />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Force' }), { key: 'Home' });
    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chain' }));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Chain' }), { key: 'End' });
    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Force' }));
  });

  it('ArrowRight past the last option does NOT wrap — a no-op on the boundary (EARS-7)', () => {
    const onChange = vi.fn();
    renderWithChakra(<LayoutModeToggle mode="force" onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Force' }), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ArrowLeft before the first option does NOT wrap — a no-op on the boundary (EARS-7)', () => {
    const onChange = vi.fn();
    renderWithChakra(<LayoutModeToggle mode="chain" onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Chain' }), { key: 'ArrowLeft' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Enter activates the focused option natively — no interception (T13)', async () => {
    const user = userEvent.setup();
    renderWithChakra(<ToggleHarness initialMode="chain" />);

    // Focus the (inactive, tabIndex -1) Force option directly, then press
    // Enter: the native button default action selects it.
    const forceBtn = screen.getByRole('button', { name: 'Force' });
    forceBtn.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Space activates the focused option natively — no interception (T13)', async () => {
    const user = userEvent.setup();
    renderWithChakra(<ToggleHarness initialMode="chain" />);

    const forceBtn = screen.getByRole('button', { name: 'Force' });
    forceBtn.focus();
    await user.keyboard(' ');

    expect(screen.getByRole('button', { name: 'Force' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('re-clicking the active option is a no-op — there is no "none" state (UI/UX §4)', () => {
    const onChange = vi.fn();
    renderWithChakra(<LayoutModeToggle mode="chain" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chain' }));
    expect(onChange).not.toHaveBeenCalled();

    // The inactive option still switches.
    fireEvent.click(screen.getByRole('button', { name: 'Force' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('force');
  });
});
