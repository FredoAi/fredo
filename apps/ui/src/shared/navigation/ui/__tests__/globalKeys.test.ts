/**
 * Spec #3122 (P8), ST-1 — the ONE navigation global chord dispatcher.
 *
 * Pins the binding semantics of `shared/navigation/ui/globalKeys.ts`:
 *   - exactly three chords, exact sequences, no re-tuning;
 *   - ONE capture-phase document keydown listener, idempotent / reference counted;
 *   - suppression in terminal / modal / text-entry focus;
 *   - dispatch through the declared window-system host with `channel:'keyboard'`,
 *     `actor:'human'`, and preventDefault + stopPropagation on match;
 *   - the shipped outcome functions as the no-host fallback;
 *   - no app key is touched (non-chord strokes stay native).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runIntent: vi.fn(),
  getNavigationHost: vi.fn(),
  focusNextWindow: vi.fn(),
  focusPreviousWindow: vi.fn(),
  runWindowLauncherToggle: vi.fn(),
}));

vi.mock('../hostRegistry', () => ({
  getNavigationHost: mocks.getNavigationHost,
}));

vi.mock('@/shared/window-system/traversal', () => ({
  focusNextWindow: mocks.focusNextWindow,
  focusPreviousWindow: mocks.focusPreviousWindow,
}));

vi.mock('@/shared/window-system/launcherToggleSeam', () => ({
  runWindowLauncherToggle: mocks.runWindowLauncherToggle,
}));

import {
  NAVIGATION_GLOBAL_CHORDS,
  installNavigationKeyDispatch,
  isNavigationKeyDispatchInstalled,
  resetNavigationKeyDispatchForTests,
  uninstallNavigationKeyDispatch,
} from '../globalKeys';

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

function mountHost(): void {
  mocks.getNavigationHost.mockReturnValue({ runIntent: mocks.runIntent } as never);
}

beforeEach(() => {
  resetNavigationKeyDispatchForTests();
  mocks.runIntent.mockReset();
  mocks.getNavigationHost.mockReset();
  mocks.getNavigationHost.mockReturnValue(null);
  mocks.focusNextWindow.mockReset();
  mocks.focusPreviousWindow.mockReset();
  mocks.runWindowLauncherToggle.mockReset();
  document.body.innerHTML = '';
});

afterEach(() => {
  resetNavigationKeyDispatchForTests();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('NAVIGATION_GLOBAL_CHORDS — exact three chords, no re-tuning', () => {
  it('declares the shipped sequences and verb ids in order', () => {
    expect(
      NAVIGATION_GLOBAL_CHORDS.map(
        (chord) => `${chord.primary ? 'primary+' : ''}${chord.shift ? 'shift+' : ''}${chord.key}`,
      ),
    ).toEqual(['primary+space', 'primary+tab', 'primary+shift+tab']);
    expect(NAVIGATION_GLOBAL_CHORDS.map((chord) => chord.verbId)).toEqual([
      'window.launcher.toggle',
      'window.focus.next',
      'window.focus.previous',
    ]);
  });
});

describe('install / uninstall — ONE listener per webview', () => {
  it('is reference counted: two installs arm exactly ONE keydown listener', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const releaseFirst = installNavigationKeyDispatch();
    const releaseSecond = installNavigationKeyDispatch();

    const keydownAdds = () =>
      addSpy.mock.calls.filter(([type]) => type === 'keydown').length;
    expect(keydownAdds()).toBe(1);
    expect(isNavigationKeyDispatchInstalled()).toBe(true);

    releaseFirst();
    expect(isNavigationKeyDispatchInstalled()).toBe(true);
    releaseSecond();
    expect(isNavigationKeyDispatchInstalled()).toBe(false);
    expect(keydownAdds()).toBe(1);
  });

  it('uninstall force-removes the listener', () => {
    installNavigationKeyDispatch();
    uninstallNavigationKeyDispatch();
    expect(isNavigationKeyDispatchInstalled()).toBe(false);
    const event = press({ key: ' ', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('chord → declared verb → outcome', () => {
  beforeEach(() => {
    mountHost();
    installNavigationKeyDispatch();
  });

  it('Ctrl+Space dispatches window.launcher.toggle once and swallows the event', () => {
    const event = press({ key: ' ', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.runIntent).toHaveBeenCalledTimes(1);
    expect(mocks.runIntent).toHaveBeenCalledWith({
      verbId: 'window.launcher.toggle',
      args: {},
      channel: 'keyboard',
      actor: 'human',
    });
    expect(mocks.runWindowLauncherToggle).not.toHaveBeenCalled();
  });

  it('Ctrl+Tab dispatches window.focus.next', () => {
    const event = press({ key: 'Tab', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.runIntent).toHaveBeenCalledWith({
      verbId: 'window.focus.next',
      args: {},
      channel: 'keyboard',
      actor: 'human',
    });
  });

  it('Ctrl+Shift+Tab dispatches window.focus.previous', () => {
    const event = press({ key: 'Tab', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.runIntent).toHaveBeenCalledWith({
      verbId: 'window.focus.previous',
      args: {},
      channel: 'keyboard',
      actor: 'human',
    });
  });

  it('leaves every non-chord stroke native (no second dispatch path)', () => {
    for (const init of [
      { key: 'g', ctrlKey: true },
      { key: 'Tab' },
      { key: ' ', ctrlKey: true, altKey: true },
      { key: 'Tab', ctrlKey: true, altKey: true },
    ]) {
      const event = press(init);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(mocks.runIntent).not.toHaveBeenCalled();
  });
});

describe('focus-context suppression', () => {
  beforeEach(() => {
    mountHost();
    installNavigationKeyDispatch();
  });

  it('suppresses while a text control has focus (typing never fires a chord)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const event = press({ key: ' ', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(mocks.runIntent).not.toHaveBeenCalled();
  });

  it('suppresses inside a terminal root (the PTY owns every keystroke)', () => {
    const root = document.createElement('div');
    root.setAttribute('data-fredo-terminal-root', 'true');
    const input = document.createElement('input');
    root.appendChild(input);
    document.body.appendChild(root);
    input.focus();

    const event = press({ key: 'Tab', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(mocks.runIntent).not.toHaveBeenCalled();
  });

  it('suppresses under an open modal dialog', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);

    const event = press({ key: 'Tab', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(mocks.runIntent).not.toHaveBeenCalled();
  });
});

describe('no host mounted — shipped outcome fallback', () => {
  beforeEach(() => {
    mocks.getNavigationHost.mockReturnValue(null);
    installNavigationKeyDispatch();
  });

  it('falls back to runWindowLauncherToggle for primary+space', () => {
    const event = press({ key: ' ', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.runWindowLauncherToggle).toHaveBeenCalledTimes(1);
  });

  it('falls back to focusNextWindow / focusPreviousWindow for the tab chords', () => {
    press({ key: 'Tab', ctrlKey: true });
    press({ key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(mocks.focusNextWindow).toHaveBeenCalledTimes(1);
    expect(mocks.focusPreviousWindow).toHaveBeenCalledTimes(1);
  });
});
