/**
 * Spec #3151 ST-4 — the three surviving platform chords, re-homed as a plain listener.
 *
 * Pins the binding contract of `shared/window-system/platformChords.ts` (AC2 + NFR-1):
 *   - exactly three chords, exact sequences, declaration order, frozen;
 *   - ONE capture-phase document keydown listener, idempotent + reference counted;
 *   - each chord dispatches the RIGHT shipped seam DIRECTLY (launcher toggle / next /
 *     previous) and swallows the event (preventDefault + stopPropagation);
 *   - suppression while focus is text-entry, terminal or under an aria-modal dialog — and a
 *     chord-shaped keystroke inside a terminal is NOT prevented, so the PTY still receives
 *     it (suppression, not interception);
 *   - `matchPlatformChord` is pure (no document read, no side effect);
 *   - the dispatch path carries no `await` / `async` / promise: the seam runs synchronously
 *     in the same tick as the keydown.
 *
 * The seams are mocked, so "which seam fired" is observable without touching the real
 * window store or launcher.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  focusNextWindow: vi.fn(),
  focusPreviousWindow: vi.fn(),
  runWindowLauncherToggle: vi.fn(),
}));

vi.mock('../traversal', () => ({
  focusNextWindow: mocks.focusNextWindow,
  focusPreviousWindow: mocks.focusPreviousWindow,
}));

vi.mock('../launcherToggleSeam', () => ({
  runWindowLauncherToggle: mocks.runWindowLauncherToggle,
}));

import {
  PLATFORM_CHORDS,
  PLATFORM_CHORD_LAUNCHER_TOGGLE,
  PLATFORM_CHORD_WINDOW_FOCUS_NEXT,
  PLATFORM_CHORD_WINDOW_FOCUS_PREVIOUS,
  installPlatformChords,
  isPlatformChordsInstalled,
  matchPlatformChord,
  resetPlatformChordsForTests,
  uninstallPlatformChords,
} from '../platformChords';

const SOURCE_PATH = resolve(process.cwd(), 'src/shared/window-system/platformChords.ts');

/** Dispatch a keydown on `target` (default: document) and return the event. */
function press(init: KeyboardEventInit, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function resetSeams(): void {
  mocks.focusNextWindow.mockReset();
  mocks.focusPreviousWindow.mockReset();
  mocks.runWindowLauncherToggle.mockReset();
}

beforeEach(() => {
  resetPlatformChordsForTests();
  resetSeams();
  document.body.innerHTML = '';
});

afterEach(() => {
  resetPlatformChordsForTests();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/* ───────────────────────────── the declaration ───────────────────────────── */

describe('PLATFORM_CHORDS — exactly three chords, declaration order, frozen', () => {
  it('declares primary+space, primary+tab, primary+shift+tab in that order', () => {
    expect(
      PLATFORM_CHORDS.map(
        (chord) => `${chord.primary ? 'primary+' : ''}${chord.shift ? 'shift+' : ''}${chord.key}`,
      ),
    ).toEqual(['primary+space', 'primary+tab', 'primary+shift+tab']);
    expect(PLATFORM_CHORDS.map((chord) => chord.id)).toEqual([
      'launcher.toggle',
      'window.focus.next',
      'window.focus.previous',
    ]);
  });

  it('every chord carries primary:true (no bare key, no sequence)', () => {
    for (const chord of PLATFORM_CHORDS) {
      expect(chord.primary).toBe(true);
      expect(chord.key === 'space' || chord.key === 'tab').toBe(true);
    }
  });

  it('is frozen and the named constants ARE the array members (no copies)', () => {
    expect(Object.isFrozen(PLATFORM_CHORDS)).toBe(true);
    expect(PLATFORM_CHORDS[0]).toBe(PLATFORM_CHORD_LAUNCHER_TOGGLE);
    expect(PLATFORM_CHORDS[1]).toBe(PLATFORM_CHORD_WINDOW_FOCUS_NEXT);
    expect(PLATFORM_CHORDS[2]).toBe(PLATFORM_CHORD_WINDOW_FOCUS_PREVIOUS);
    for (const chord of PLATFORM_CHORDS) expect(Object.isFrozen(chord)).toBe(true);
  });
});

/* ───────────────────────────── matching (pure) ───────────────────────────── */

describe('matchPlatformChord — pure matcher', () => {
  it('matches the three chords on a Ctrl-primary platform', () => {
    expect(matchPlatformChord(press({ key: ' ', ctrlKey: true }), 'win32')).toBe(
      PLATFORM_CHORD_LAUNCHER_TOGGLE,
    );
    expect(matchPlatformChord(press({ key: 'Tab', ctrlKey: true }), 'win32')).toBe(
      PLATFORM_CHORD_WINDOW_FOCUS_NEXT,
    );
    expect(matchPlatformChord(press({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'win32')).toBe(
      PLATFORM_CHORD_WINDOW_FOCUS_PREVIOUS,
    );
  });

  it('matches on Meta for darwin and does NOT collapse Ctrl (darwin primary is Meta)', () => {
    expect(matchPlatformChord(press({ key: ' ', metaKey: true }), 'darwin')).toBe(
      PLATFORM_CHORD_LAUNCHER_TOGGLE,
    );
    expect(matchPlatformChord(press({ key: ' ', ctrlKey: true }), 'darwin')).toBeNull();
  });

  it('accepts the legacy Spacebar key spelling but never a bare key or a stray modifier', () => {
    expect(matchPlatformChord(press({ key: 'Spacebar', ctrlKey: true }), 'win32')).toBe(
      PLATFORM_CHORD_LAUNCHER_TOGGLE,
    );
    // No bare key, no second modifier, no alt.
    expect(matchPlatformChord(press({ key: ' ' }), 'win32')).toBeNull();
    expect(matchPlatformChord(press({ key: 'Tab' }), 'win32')).toBeNull();
    expect(matchPlatformChord(press({ key: ' ', ctrlKey: true, altKey: true }), 'win32')).toBeNull();
    expect(
      matchPlatformChord(press({ key: 'Tab', ctrlKey: true, shiftKey: true, altKey: true }), 'win32'),
    ).toBeNull();
    expect(matchPlatformChord(press({ key: 'Tab', ctrlKey: true, metaKey: true }), 'win32')).toBeNull();
    expect(matchPlatformChord(press({ key: 'g', ctrlKey: true }), 'win32')).toBeNull();
  });

  it('never matches a composing or AltGr event', () => {
    expect(matchPlatformChord(press({ key: ' ', ctrlKey: true, isComposing: true }), 'win32')).toBeNull();
  });

  it('has no side effect: it neither installs a listener nor mutates the document', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const before = document.body.innerHTML;

    matchPlatformChord(press({ key: 'Tab', ctrlKey: true }), 'win32');

    expect(addSpy).not.toHaveBeenCalled();
    expect(isPlatformChordsInstalled()).toBe(false);
    expect(document.body.innerHTML).toBe(before);
  });
});

/* ───────────────────────────── install lifecycle ───────────────────────────── */

describe('install / uninstall — ONE listener per webview', () => {
  it('is reference counted: two installs arm exactly ONE keydown listener', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const releaseFirst = installPlatformChords();
    const releaseSecond = installPlatformChords();

    const keydownAdds = () => addSpy.mock.calls.filter(([type]) => type === 'keydown').length;
    expect(keydownAdds()).toBe(1);
    expect(isPlatformChordsInstalled()).toBe(true);

    releaseFirst();
    expect(isPlatformChordsInstalled()).toBe(true);
    releaseSecond();
    expect(isPlatformChordsInstalled()).toBe(false);
    expect(keydownAdds()).toBe(1);
  });

  it('a release is idempotent (double-calling it does not over-decrement)', () => {
    const release = installPlatformChords();
    const releaseOther = installPlatformChords();

    release();
    release();
    expect(isPlatformChordsInstalled()).toBe(true);

    releaseOther();
    expect(isPlatformChordsInstalled()).toBe(false);
  });

  it('uninstall force-removes the listener', () => {
    installPlatformChords();
    uninstallPlatformChords();
    expect(isPlatformChordsInstalled()).toBe(false);

    const event = press({ key: ' ', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it('arms the listener in the CAPTURE phase', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    installPlatformChords();
    const keydown = addSpy.mock.calls.find(([type]) => type === 'keydown');
    expect(keydown?.[2]).toBe(true);
  });
});

/* ───────────────────────────── chord → seam dispatch ───────────────────────────── */

describe('chord → shipped seam (direct, synchronous)', () => {
  beforeEach(() => {
    installPlatformChords();
  });

  it('primary+space runs runWindowLauncherToggle once and swallows the event', () => {
    const event = press({ key: ' ', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.runWindowLauncherToggle).toHaveBeenCalledTimes(1);
    expect(mocks.focusNextWindow).not.toHaveBeenCalled();
    expect(mocks.focusPreviousWindow).not.toHaveBeenCalled();
  });

  it('primary+tab runs focusNextWindow once', () => {
    const event = press({ key: 'Tab', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.focusNextWindow).toHaveBeenCalledTimes(1);
    expect(mocks.runWindowLauncherToggle).not.toHaveBeenCalled();
    expect(mocks.focusPreviousWindow).not.toHaveBeenCalled();
  });

  it('primary+shift+tab runs focusPreviousWindow once', () => {
    const event = press({ key: 'Tab', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.focusPreviousWindow).toHaveBeenCalledTimes(1);
    expect(mocks.focusNextWindow).not.toHaveBeenCalled();
  });

  it('dispatches SYNCHRONOUSLY — the seam has already run when dispatchEvent returns', () => {
    let seamRanAtReturn = false;
    mocks.focusNextWindow.mockImplementation(() => {
      seamRanAtReturn = true;
      return true;
    });

    press({ key: 'Tab', ctrlKey: true });

    // No await, no microtask flush: the dispatch path is fully synchronous (NFR-1).
    expect(seamRanAtReturn).toBe(true);
    expect(mocks.focusNextWindow).toHaveBeenCalledTimes(1);
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
    expect(mocks.runWindowLauncherToggle).not.toHaveBeenCalled();
    expect(mocks.focusNextWindow).not.toHaveBeenCalled();
    expect(mocks.focusPreviousWindow).not.toHaveBeenCalled();
  });
});

/* ───────────────────────────── suppression ───────────────────────────── */

describe('suppression — the chords do not fire while the focus owner consumes keys', () => {
  beforeEach(() => {
    installPlatformChords();
  });

  it('does not fire while a text control has focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const event = press({ key: ' ', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.runWindowLauncherToggle).not.toHaveBeenCalled();
  });

  it('does not fire inside a terminal root', () => {
    const root = document.createElement('div');
    root.setAttribute('data-fredo-terminal-root', 'true');
    const input = document.createElement('input');
    root.appendChild(input);
    document.body.appendChild(root);
    input.focus();

    const event = press({ key: 'Tab', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.focusNextWindow).not.toHaveBeenCalled();
  });

  it('does not fire under an open aria-modal dialog', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);

    const event = press({ key: 'Tab', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.focusNextWindow).not.toHaveBeenCalled();
  });

  it('a chord-shaped keystroke in a terminal is NOT prevented and still propagates to the PTY', () => {
    const root = document.createElement('div');
    root.setAttribute('data-fredo-terminal-root', 'true');
    const textarea = document.createElement('textarea');
    root.appendChild(textarea);
    document.body.appendChild(root);
    textarea.focus();

    // A PTY-side bubbling handler — the terminal's real consumer.
    const pty = vi.fn();
    document.addEventListener('keydown', pty);

    const event = press({ key: ' ', ctrlKey: true }, textarea);

    expect(event.defaultPrevented).toBe(false);
    expect(pty).toHaveBeenCalledTimes(1);
    expect(mocks.runWindowLauncherToggle).not.toHaveBeenCalled();

    document.removeEventListener('keydown', pty);
  });
});

/* ───────────────────────────── structural: no async, no registry ───────────────────────────── */

describe('platformChords.ts — synchronous, registry-free structure (NFR-1)', () => {
  /** Strip comments so prose ("no `await`") cannot satisfy or defeat the scan. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  const code = stripComments(readFileSync(SOURCE_PATH, 'utf8'));

  it('never awaits, never declares async, never chains a promise', () => {
    expect(code).not.toMatch(/\bawait\b/);
    expect(code).not.toMatch(/\basync\b/);
    expect(code).not.toContain('.then(');
    expect(code).not.toMatch(/\bnew Promise\b/);
  });

  it('has no registry / verb-id / host hop on the dispatch path', () => {
    expect(code).not.toContain('getNavigationHost');
    expect(code).not.toContain('runIntent');
    expect(code).not.toContain('verbId');
    expect(code).not.toContain('registerNavigationHost');
    expect(code).not.toContain("from '../navigation");
  });

  it('calls preventDefault before the dispatch call (the swallow precedes the seam)', () => {
    expect(code.indexOf('event.preventDefault()')).toBeGreaterThan(-1);
    expect(code.indexOf('event.preventDefault()')).toBeLessThan(code.indexOf('dispatchChord(chord)'));
  });
});
