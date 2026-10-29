/**
 * Hidden `g+*` hotkey carrier (Spec #3098 ST-3).
 *
 * Pins the carrier contract:
 *   - exactly the 12 two-step `WIREFRAME_ACTIONS` bindings, derived from the
 *     table (every one starts with `g+` — no bare single-letter binding);
 *   - hidden + non-focusable + out of the accessibility tree;
 *   - a `hotkey-activate` (the CU-1 engine's fallback) dispatches the SAME
 *     command id through the ONE executor exactly once.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WIREFRAME_ACTIONS } from '../actions/wireframeActions';

const executeCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/hotkeys/commandSurfaceStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../shared/hotkeys/commandSurfaceStore')>();
  return { ...actual, executeCommand: executeCommandMock };
});

import {
  WIREFRAME_CARRIER_BINDINGS,
  WireframeHotkeyCarrier,
} from '../components/WireframeHotkeyCarrier';

beforeEach(() => {
  executeCommandMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WireframeHotkeyCarrier', () => {
  it('carries exactly the 12 two-step g+* table bindings', () => {
    const twoStepRows = WIREFRAME_ACTIONS.filter(
      (action) =>
        action.toolbar &&
        typeof action.hotkey === 'string' &&
        action.hotkey.includes('+'),
    );

    expect(twoStepRows).toHaveLength(12);
    expect(WIREFRAME_CARRIER_BINDINGS).toHaveLength(12);
    expect([...WIREFRAME_CARRIER_BINDINGS.map((binding) => binding.commandId)].sort()).toEqual(
      [...twoStepRows.map((row) => row.id)].sort(),
    );
    expect([...WIREFRAME_CARRIER_BINDINGS.map((binding) => binding.hotkey)].sort()).toEqual(
      [...twoStepRows.map((row) => row.hotkey as string)].sort(),
    );
    for (const binding of WIREFRAME_CARRIER_BINDINGS) {
      expect(binding.hotkey.startsWith('g+'), binding.hotkey).toBe(true);
    }
  });

  it('is hidden, non-focusable and out of the accessibility tree', () => {
    const { getByTestId } = render(<WireframeHotkeyCarrier />);
    const carrier = getByTestId('wireframe-hotkey-carrier');

    expect(carrier).toHaveAttribute('hidden');
    expect(carrier).toHaveAttribute('aria-hidden', 'true');
    expect((carrier as HTMLElement).style.display).toBe('none');

    const bindings = carrier.querySelectorAll<HTMLElement>('[data-hotkey]');
    expect(bindings).toHaveLength(12);
    for (const element of Array.from(bindings)) {
      const hotkey = element.getAttribute('data-hotkey') ?? '';
      // No bare single-letter binding on the carrier.
      expect(hotkey, hotkey).toMatch(/^g\+./);
      expect(element).toHaveAttribute('hidden');
      expect(element).toHaveAttribute('aria-hidden', 'true');
      expect(element.hasAttribute('tabindex')).toBe(false);
      expect(element.tabIndex).toBe(-1);
    }
  });

  it('activating a binding executes its command id exactly once', () => {
    const { getByTestId } = render(<WireframeHotkeyCarrier />);
    const carrier = getByTestId('wireframe-hotkey-carrier');

    const binding = carrier.querySelector<HTMLElement>('[data-hotkey="g+i"]');
    expect(binding).not.toBeNull();

    binding?.dispatchEvent(new CustomEvent('hotkey-activate', { bubbles: true }));

    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    expect(executeCommandMock).toHaveBeenCalledWith('wireframe', 'wireframe.zoom.in');

    // A second activation is a second (and only one more) invocation.
    binding?.dispatchEvent(new CustomEvent('hotkey-activate', { bubbles: true }));
    expect(executeCommandMock).toHaveBeenCalledTimes(2);
  });

  it('maps every binding to its own command id exactly once per activation', () => {
    const { getByTestId } = render(<WireframeHotkeyCarrier />);
    const carrier = getByTestId('wireframe-hotkey-carrier');

    for (const expected of WIREFRAME_CARRIER_BINDINGS) {
      executeCommandMock.mockClear();
      const element = carrier.querySelector<HTMLElement>(
        `[data-hotkey="${expected.hotkey}"]`,
      );
      expect(element, expected.hotkey).not.toBeNull();
      element?.dispatchEvent(new CustomEvent('hotkey-activate', { bubbles: true }));
      expect(executeCommandMock).toHaveBeenCalledTimes(1);
      expect(executeCommandMock).toHaveBeenCalledWith('wireframe', expected.commandId);
    }
  });
});
