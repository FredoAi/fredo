/**
 * Spec #3009 ST-4 — terminal passthrough (focus-derived).
 *
 * The dedicated exit chord + release button are retired; passthrough is derived
 * from the ONE focus classifier and published on `document.body`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetHotkeyAnnouncer, getAnnouncement } from '../announcer';
import {
  BODY_PASSTHROUGH_ATTR,
  PASSTHROUGH_ANNOUNCEMENT_PREFIX,
  installTerminalPassthrough,
  isPassthroughActive,
  isTerminalFocused,
  isTerminalPassthroughInstalled,
  resetTerminalModeForTests,
  syncTerminalPassthrough,
} from '../terminalMode';

function mountTerminal(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-fredo-terminal-root', 'true');
  const inner = document.createElement('div');
  inner.tabIndex = -1;
  root.appendChild(inner);
  document.body.appendChild(root);
  inner.focus();
  return inner;
}

function mountNeutral(): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

beforeEach(() => {
  resetTerminalModeForTests();
  resetHotkeyAnnouncer();
  document.body.innerHTML = '';
});

afterEach(() => {
  resetTerminalModeForTests();
  resetHotkeyAnnouncer();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('terminalMode — focus-derived passthrough', () => {
  it('detects a focused terminal and mirrors the body hook', () => {
    installTerminalPassthrough();
    expect(isTerminalFocused()).toBe(false);
    expect(isPassthroughActive()).toBe(false);

    mountTerminal();
    expect(syncTerminalPassthrough()).toBe(true);
    expect(isPassthroughActive()).toBe(true);
    expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true');
    expect(getAnnouncement()).toBe(PASSTHROUGH_ANNOUNCEMENT_PREFIX);

    mountNeutral();
    expect(syncTerminalPassthrough()).toBe(false);
    expect(isPassthroughActive()).toBe(false);
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });

  it('never re-announces while focus stays inside the terminal root', () => {
    installTerminalPassthrough();
    mountTerminal();
    expect(syncTerminalPassthrough()).toBe(true);

    resetHotkeyAnnouncer();
    syncTerminalPassthrough();
    expect(getAnnouncement()).toBe('');
  });

  it('install is idempotent and uninstall clears the state', () => {
    const uninstallA = installTerminalPassthrough();
    installTerminalPassthrough();
    expect(isTerminalPassthroughInstalled()).toBe(true);

    mountTerminal();
    syncTerminalPassthrough();
    uninstallA();
    expect(isTerminalPassthroughInstalled()).toBe(false);
    expect(isPassthroughActive()).toBe(false);
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });
});
