/**
 * Spec #2946 ST-12 — terminal passthrough mode (EARS R-5.7, R-5.8).
 *
 * Pins the continuous-state contract:
 *  1. install adds NO `document` keydown listener (the ONE engine listener is
 *     the only key path);
 *  2. focus inside a terminal root → passthrough active + the
 *     `data-fredo-passthrough` body hook + a one-time announcement;
 *  3. every keystroke including a modifier chord is left native (no
 *     `preventDefault`), EXCEPT the designated exit chord, which is consumed and
 *     never reaches the PTY (a bubble-phase listener sees every other key but
 *     not the exit chord);
 *  4. the exit chord leaves passthrough (focus moves to the real release
 *     button) and dispatch resumes immediately;
 *  5. staying inside the terminal never re-announces; re-entering does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsService } from '../../../features/settings';
import { getAnnouncement, resetHotkeyAnnouncer } from '../announcer';
import {
  BODY_PASSTHROUGH_ATTR as ENGINE_PASSTHROUGH_ATTR,
  LAUNCHER_TOGGLE_ACTION_ID,
  installHotkeyEngine,
  isHotkeyEngineInstalled,
  resetHotkeyEngineForTests,
} from '../engine';
import { registerHotkeyHandler, resetRegistryForTests } from '../registry';
import {
  getBinding,
  isPassthroughActive,
  resetKeymapStoreForTests,
  setBinding,
} from '../store';
import {
  BODY_PASSTHROUGH_ATTR,
  PASSTHROUGH_ANNOUNCEMENT_PREFIX,
  TERMINAL_RELEASE_TESTID,
  exitTerminalPassthrough,
  getTerminalExitChord,
  installTerminalPassthrough,
  isTerminalFocused,
  isTerminalPassthroughInstalled,
  passthroughAnnouncementText,
  resetTerminalModeForTests,
  syncTerminalPassthrough,
  useTerminalPassthrough,
} from '../terminalMode';
import { TERMINAL_EXIT_ACTION_ID } from '../types';

// ── Harness ──────────────────────────────────────────────────────────────────

/** A terminal session root (the anchor the classifier keys on). */
function mountTerminalRoot(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-fredo-terminal-root', 'true');
  const inner = document.createElement('div');
  inner.tabIndex = -1;
  root.appendChild(inner);
  document.body.appendChild(root);
  return inner;
}

/** A second focusable surface inside the SAME terminal root. */
function mountTerminalInner(root?: HTMLElement): HTMLElement {
  const container = root ?? document.querySelector('[data-fredo-terminal-root="true"]');
  const inner = document.createElement('div');
  inner.tabIndex = -1;
  container?.appendChild(inner);
  return inner;
}

/** The real release button the indicator renders (outside the session root). */
function mountReleaseButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.setAttribute('data-testid', TERMINAL_RELEASE_TESTID);
  document.body.appendChild(button);
  return button;
}

function mountNeutral(): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

/** Dispatch a cancelable keydown and report whether it was consumed. */
function keydown(target: EventTarget, init: KeyboardEventInit): { prevented: boolean } {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  const notCancelled = target.dispatchEvent(event);
  return { prevented: !notCancelled };
}

/** Flush the microtask that coalesces a focus-driven passthrough recompute. */
async function flushFocusSync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetHotkeyEngineForTests();
  resetTerminalModeForTests();
  resetHotkeyAnnouncer();
  document.body.innerHTML = '';
  document.body.removeAttribute(BODY_PASSTHROUGH_ATTR);
  document.body.removeAttribute(ENGINE_PASSTHROUGH_ATTR);
});

afterEach(() => {
  resetTerminalModeForTests();
  resetHotkeyEngineForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── 1. No second keydown listener ────────────────────────────────────────────

describe('terminalMode — the key path stays with the ONE engine listener', () => {
  it('adds NO document keydown listener on install', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const uninstall = installTerminalPassthrough();

    const keydownAdds = addSpy.mock.calls.filter(([type]) => type === 'keydown').length;
    expect(keydownAdds).toBe(0);
    expect(isTerminalPassthroughInstalled()).toBe(true);

    uninstall();
    expect(isTerminalPassthroughInstalled()).toBe(false);
  });

  it('engine + terminalMode together add EXACTLY ONE keydown listener', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    installTerminalPassthrough();
    installHotkeyEngine();

    const keydownAdds = addSpy.mock.calls.filter(([type]) => type === 'keydown').length;
    expect(keydownAdds).toBe(1);
    expect(isHotkeyEngineInstalled()).toBe(true);
  });
});

// ── 2. Passthrough state + body hook + announcement (R-5.7/R-5.8) ────────────

describe('terminalMode — focus inside the terminal root (R-5.7/R-5.8)', () => {
  it('activates passthrough, mirrors the body hook and announces once on entry', async () => {
    installTerminalPassthrough();
    const inner = mountTerminalRoot();
    expect(isTerminalFocused()).toBe(false);
    expect(isPassthroughActive()).toBe(false);

    inner.focus();
    await flushFocusSync();

    expect(isTerminalFocused()).toBe(true);
    expect(isPassthroughActive()).toBe(true);
    expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true');
    expect(getAnnouncement()).toBe(passthroughAnnouncementText(getTerminalExitChord()));
    expect(getAnnouncement()).toContain(PASSTHROUGH_ANNOUNCEMENT_PREFIX);
  });

  it('never re-announces while focus stays inside the terminal root', async () => {
    installTerminalPassthrough();
    const inner = mountTerminalRoot();
    inner.focus();
    await flushFocusSync();
    expect(getAnnouncement()).toContain(PASSTHROUGH_ANNOUNCEMENT_PREFIX);

    // Clear the channel, then move focus to another surface INSIDE the root:
    // the state is unchanged, so nothing is announced again.
    resetHotkeyAnnouncer();
    const second = mountTerminalInner();
    second.focus();
    await flushFocusSync();

    expect(isPassthroughActive()).toBe(true);
    expect(getAnnouncement()).toBe('');
  });

  it('announces again on a fresh entry after leaving the terminal', async () => {
    installTerminalPassthrough();
    const inner = mountTerminalRoot();
    inner.focus();
    await flushFocusSync();
    expect(isPassthroughActive()).toBe(true);

    // Leave passthrough by focusing a neutral surface (context no longer terminal).
    mountNeutral();
    await flushFocusSync();
    expect(isPassthroughActive()).toBe(false);
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);

    resetHotkeyAnnouncer();
    inner.focus();
    await flushFocusSync();

    expect(isPassthroughActive()).toBe(true);
    expect(getAnnouncement()).toContain(PASSTHROUGH_ANNOUNCEMENT_PREFIX);
  });

  it('names the rebound exit chord in the announcement', async () => {
    vi.spyOn(settingsService, 'set').mockResolvedValue(undefined);
    await setBinding(TERMINAL_EXIT_ACTION_ID, ['ctrl+shift+f9']);
    installTerminalPassthrough();
    const inner = mountTerminalRoot();
    inner.focus();
    await flushFocusSync();

    expect(getTerminalExitChord()).toBe('ctrl+shift+f9');
    expect(getAnnouncement()).toContain('F 9');
  });

  it('exposes the default exit chord when the keymap has none configured', () => {
    expect(getTerminalExitChord()).toBe('ctrl+shift+f10');
    expect(getBinding(TERMINAL_EXIT_ACTION_ID)).toEqual(['ctrl+shift+f10']);
  });
});

// ── 3. Every key reaches the PTY except the exit chord (R-5.7) ───────────────

describe('terminalMode — terminal passthrough key handling (R-5.7)', () => {
  it('leaves modifier chords native but consumes the exit chord (never reaches the PTY)', () => {
    installTerminalPassthrough();
    installHotkeyEngine();
    const inner = mountTerminalRoot();
    mountReleaseButton();
    inner.focus();

    // A bubble-phase listener on the session stands in for the PTY data path:
    // capture-phase consumption of the exit chord must stop the event reaching it.
    const reachedPty: string[] = [];
    inner.addEventListener('keydown', (event) => {
      reachedPty.push((event as KeyboardEvent).key);
    });

    // A modifier chord is NOT consumed in the terminal (R-5.7) — it reaches the PTY.
    const chord = keydown(inner, { key: 'g', ctrlKey: true, shiftKey: true });
    expect(chord.prevented).toBe(false);
    expect(reachedPty).toEqual(['g']);

    // A bare key is never consumed either (zero-latency PTY path).
    const bare = keydown(inner, { key: 'a' });
    expect(bare.prevented).toBe(false);
    expect(reachedPty).toEqual(['g', 'a']);

    // The ONE designated exit chord IS consumed and never reaches the PTY.
    const exit = keydown(inner, { key: 'F10', ctrlKey: true, shiftKey: true });
    expect(exit.prevented).toBe(true);
    expect(reachedPty).toEqual(['g', 'a']);
  });
});

// ── 4. Exit leaves passthrough + resumes dispatch (R-5.7/R-5.8) ──────────────

describe('terminalMode — exiting passthrough', () => {
  it('routes the exit chord through a handler that moves focus off the session', async () => {
    installTerminalPassthrough();
    installHotkeyEngine();
    const inner = mountTerminalRoot();
    const release = mountReleaseButton();
    inner.focus();
    await flushFocusSync();
    expect(isPassthroughActive()).toBe(true);

    keydown(inner, { key: 'F10', ctrlKey: true, shiftKey: true });

    expect(document.activeElement).toBe(release);
    expect(isTerminalFocused()).toBe(false);
    expect(isPassthroughActive()).toBe(false);
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });

  it('resumes hotkey dispatch immediately after the exit (R-5.7)', async () => {
    const launcherRun = vi.fn();
    registerHotkeyHandler(LAUNCHER_TOGGLE_ACTION_ID, launcherRun);
    installTerminalPassthrough();
    installHotkeyEngine();
    const inner = mountTerminalRoot();
    const release = mountReleaseButton();
    inner.focus();
    await flushFocusSync();
    expect(isPassthroughActive()).toBe(true);

    // While passthrough is active, a bound chord does NOT run (terminal owns the keys).
    keydown(inner, { key: ' ', ctrlKey: true });
    expect(launcherRun).not.toHaveBeenCalled();

    keydown(inner, { key: 'F10', ctrlKey: true, shiftKey: true });
    expect(isPassthroughActive()).toBe(false);

    // Dispatch resumes from the release button's focus context.
    const resumed = keydown(release, { key: ' ', ctrlKey: true });
    expect(resumed.prevented).toBe(true);
    expect(launcherRun).toHaveBeenCalledTimes(1);
  });

  it('syncTerminalPassthrough is idempotent while no terminal is focused', () => {
    installTerminalPassthrough();
    mountNeutral();
    expect(syncTerminalPassthrough()).toBe(false);
    expect(syncTerminalPassthrough()).toBe(false);
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });

  it('exitTerminalPassthrough blurs the terminal when no indicator is mounted', async () => {
    installTerminalPassthrough();
    const inner = mountTerminalRoot();
    inner.focus();
    await flushFocusSync();
    expect(isPassthroughActive()).toBe(true);

    exitTerminalPassthrough();

    expect(isPassthroughActive()).toBe(false);
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });
});

// ── 5. React binding for the indicator ───────────────────────────────────────

describe('terminalMode — useTerminalPassthrough', () => {
  it('is exported and reports the exit chord for the indicator', () => {
    expect(typeof useTerminalPassthrough).toBe('function');
  });
});
