/**
 * Spec #2946 ST-4 — the app-shell mount point (`HotkeysProvider`).
 *
 * Mounting the provider must install the ONE engine (idempotently) and render
 * the ONE shared announcer; unmounting must remove both. The dispatch path is
 * exercised through the real registry so the provider is proven to wire the
 * engine, not merely render it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';

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
import { registerHotkeyContext, resetContextRegistryForTests } from '@/shared/hotkeys/contexts';
import { enterHotkeyContext, resetHotkeyContextForTests } from '@/shared/hotkeys/contextStack';
import { ROOT_CONTEXT_ID } from '@/shared/hotkeys/types';
import {
  HOTKEY_CONTEXT_INDICATOR_LABEL_TESTID,
  HOTKEY_CONTEXT_INDICATOR_TESTID,
} from '@/shared/hotkeys/ContextIndicator';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';
import { KEYBOARD_BAR_TESTID } from '@/shared/hotkeys/KeyboardBar';
import {
  enterKeyboardMode,
  exitKeyboardMode,
  resetKeyboardModeForTests,
} from '@/shared/hotkeys/keyboardMode';

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetContextRegistryForTests();
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
});

afterEach(() => {
  resetHotkeyEngineForTests();
  resetContextRegistryForTests();
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
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

  it('mounts the ONE context indicator (null while idle, shown on a change)', () => {
    registerHotkeyContext({
      contextId: 'fredo.test.child',
      parentId: ROOT_CONTEXT_ID,
      title: 'Child',
    });

    const { container, getByTestId } = renderWithChakra(
      <HotkeysProvider>
        <span />
      </HotkeysProvider>,
    );

    // Mounted once (present in the tree) but idle ⇒ renders nothing.
    expect(
      container.querySelectorAll(`[data-testid="${HOTKEY_CONTEXT_INDICATOR_TESTID}"]`),
    ).toHaveLength(0);

    act(() => {
      enterHotkeyContext('fredo.test.child');
    });

    expect(
      container.querySelectorAll(`[data-testid="${HOTKEY_CONTEXT_INDICATOR_TESTID}"]`),
    ).toHaveLength(1);
    expect(getByTestId(HOTKEY_CONTEXT_INDICATOR_LABEL_TESTID)).toHaveTextContent('Child');
    // Still exactly ONE live region (the shared announcer) — the pill is visual.
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('mounts the keyboard bar ONCE (null while off, exactly one on mode)', () => {
    const { container } = renderWithChakra(
      <HotkeysProvider>
        <span />
      </HotkeysProvider>,
    );

    // Mounted once (present in the tree) but OFF ⇒ renders nothing.
    expect(container.querySelectorAll(`[data-testid="${KEYBOARD_BAR_TESTID}"]`)).toHaveLength(0);

    act(() => {
      enterKeyboardMode();
    });
    expect(container.querySelectorAll(`[data-testid="${KEYBOARD_BAR_TESTID}"]`)).toHaveLength(1);

    act(() => {
      exitKeyboardMode();
    });
    expect(container.querySelectorAll(`[data-testid="${KEYBOARD_BAR_TESTID}"]`)).toHaveLength(0);
    // No second live region was introduced by the bar.
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });
});
