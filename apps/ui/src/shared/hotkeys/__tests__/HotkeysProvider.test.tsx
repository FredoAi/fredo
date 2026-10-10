/**
 * Spec #3009 ST-3 — the app-shell mount point (`HotkeysProvider`).
 *
 * Mounting the provider must install the ONE engine + the ONE element discovery
 * and render the ONE shared announcer + the always-on element bar; unmounting
 * must remove the engine listener + discovery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { registerHotkeyHandler, resetRegistryForTests } from '@/shared/hotkeys/registry';
import { resetHotkeyStatusForTests } from '@/shared/hotkeys/store';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import {
  LAUNCHER_TOGGLE_ACTION_ID,
  resetHotkeyEngineForTests,
} from '@/shared/hotkeys/engine';
import {
  resetHotkeyElementDiscoveryForTests,
  BODY_HOTKEY_DUPLICATE_ATTR,
  DuplicateHotkeyError,
} from '@/shared/hotkeys/hotkeyElements';
import {
  HOTKEY_BAR_TESTID,
  HOTKEY_DUPLICATE_ERROR_TESTID,
} from '@/shared/hotkeys/HotkeyBar';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetHotkeyStatusForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetHotkeyElementDiscoveryForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  resetHotkeyElementDiscoveryForTests();
  resetHotkeyEngineForTests();
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
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

  it('renders the always-on bar once a data-hotkey element is mounted, hidden at zero', async () => {
    const { container, queryByTestId, rerender } = renderWithChakra(
      <HotkeysProvider>
        <span />
      </HotkeysProvider>,
    );

    // Zero element hotkeys ⇒ the bar renders null.
    expect(queryByTestId(HOTKEY_BAR_TESTID)).toBeNull();

    rerender(
      <HotkeysProvider>
        <button data-hotkey="a">Alpha</button>
      </HotkeysProvider>,
    );

    await waitFor(() => expect(queryByTestId(HOTKEY_BAR_TESTID)).not.toBeNull());
    expect(
      container.querySelectorAll(`[data-testid="hotkeys-keybar-row"]`).length,
    ).toBeGreaterThan(0);
  });

  it('does not fire an element hotkey while focus is in a text-entry control', () => {
    const run = vi.fn();
    registerHotkeyHandler(LAUNCHER_TOGGLE_ACTION_ID, run);

    renderWithChakra(
      <HotkeysProvider>
        <button data-hotkey="a">Alpha</button>
        <input data-testid="field" />
      </HotkeysProvider>,
    );

    const field = document.querySelector<HTMLInputElement>('[data-testid="field"]');
    field?.focus();
    fireEvent.keyDown(field as HTMLInputElement, { key: 'a' });

    // Ctrl+Space remains global in text-entry.
    fireEvent.keyDown(field as HTMLInputElement, { key: ' ', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('renders the DEV duplicate banner for two mounted same-key elements', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // ST-1's duplicate path re-throws its DuplicateHotkeyError from a microtask
    // BY DESIGN (the developer sees it). Contain that specific re-throw for the
    // duration of this test so it does not surface as an unhandled error; every
    // other microtask runs unchanged and any non-duplicate error still escapes.
    const realQueueMicrotask = globalThis.queueMicrotask;
    const contained: unknown[] = [];
    globalThis.queueMicrotask = ((callback: () => void) => {
      realQueueMicrotask(() => {
        try {
          callback();
        } catch (error) {
          if (error instanceof DuplicateHotkeyError) {
            contained.push(error);
            return;
          }
          throw error;
        }
      });
    }) as typeof globalThis.queueMicrotask;

    try {
      const { queryByTestId, rerender } = renderWithChakra(
        <HotkeysProvider>
          <span />
        </HotkeysProvider>,
      );

      // No duplicate yet ⇒ no banner.
      expect(queryByTestId(HOTKEY_DUPLICATE_ERROR_TESTID)).toBeNull();

      rerender(
        <HotkeysProvider>
          <button data-hotkey="a">Alpha</button>
          <button data-hotkey="a">Alpha again</button>
        </HotkeysProvider>,
      );

      await waitFor(() =>
        expect(queryByTestId(HOTKEY_DUPLICATE_ERROR_TESTID)).not.toBeNull(),
      );
      expect(document.body.getAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe('true');
      expect(consoleError).toHaveBeenCalled();

      // Recovery: removing the duplicate unmounts the banner + clears the hook.
      rerender(
        <HotkeysProvider>
          <button data-hotkey="a">Alpha</button>
        </HotkeysProvider>,
      );
      await waitFor(() =>
        expect(queryByTestId(HOTKEY_DUPLICATE_ERROR_TESTID)).toBeNull(),
      );
      expect(document.body.hasAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe(false);
      expect(contained.length).toBeGreaterThan(0);
    } finally {
      globalThis.queueMicrotask = realQueueMicrotask;
    }
  });
});
