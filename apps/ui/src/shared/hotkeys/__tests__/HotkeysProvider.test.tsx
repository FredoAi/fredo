/**
 * Spec #2946 ST-4 — the app-shell mount point (`HotkeysProvider`).
 *
 * Mounting the provider must install the ONE engine (idempotently) and render
 * the ONE shared announcer; unmounting must remove both. The dispatch path is
 * exercised through the real registry so the provider is proven to wire the
 * engine, not merely render it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  registerHotkeyHandler,
  resetRegistryForTests,
} from '@/shared/hotkeys/registry';
import {
  resetKeymapStoreForTests,
} from '@/shared/hotkeys/store';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import {
  LAUNCHER_TOGGLE_ACTION_ID,
  resetHotkeyEngineForTests,
} from '@/shared/hotkeys/engine';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
});

afterEach(() => {
  resetHotkeyEngineForTests();
  cleanup();
  vi.restoreAllMocks();
});

describe('HotkeysProvider', () => {
  it('mounts the ONE announcer and installs the engine; unmount removes it', () => {
    const { getByTestId, unmount } = renderWithChakra(
      <HotkeysProvider>
        <span data-testid="child" />
      </HotkeysProvider>,
    );

    expect(getByTestId('child')).toBeInTheDocument();
    expect(getByTestId('hotkeys-announcer')).toBeInTheDocument();
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(document.documentElement.getAttribute('data-fredo-hotkeys-engine')).toBe('1');

    unmount();
    expect(document.documentElement.hasAttribute('data-fredo-hotkeys-engine')).toBe(false);
  });

  it('dispatches a registered action through the engine', () => {
    const run = vi.fn();
    registerHotkeyHandler(LAUNCHER_TOGGLE_ACTION_ID, run);

    renderWithChakra(
      <HotkeysProvider>
        <span />
      </HotkeysProvider>,
    );

    const event = new KeyboardEvent('keydown', {
      key: ' ',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
