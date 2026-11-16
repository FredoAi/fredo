/**
 * Spec #3122 (P8), ST-1 — the relocated terminal passthrough.
 *
 * The dedicated exit chord + release button stay retired; passthrough is derived from the ONE
 * navigation focus classifier, published on `document.body`, and announced exactly once per
 * entry through the ONE navigation announcer channel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNavigationAnnouncement, resetNavigationAnnouncer } from '../announce';
import {
  BODY_PASSTHROUGH_ATTR,
  PASSTHROUGH_ANNOUNCEMENT_PREFIX,
  installTerminalPassthrough,
  isPassthroughActive,
  isTerminalFocused,
  isTerminalPassthroughInstalled,
  resetTerminalModeForTests,
  syncTerminalPassthrough,
} from '../terminalPassthrough';

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
  resetNavigationAnnouncer();
  document.body.innerHTML = '';
});

afterEach(() => {
  resetTerminalModeForTests();
  resetNavigationAnnouncer();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('terminalPassthrough — focus-derived passthrough', () => {
  it('detects a focused terminal and mirrors the body hook', () => {
    installTerminalPassthrough();
    expect(isTerminalFocused()).toBe(false);
    expect(isPassthroughActive()).toBe(false);

    mountTerminal();
    expect(syncTerminalPassthrough()).toBe(true);
    expect(isPassthroughActive()).toBe(true);
    expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true');
    expect(getNavigationAnnouncement()).toBe(PASSTHROUGH_ANNOUNCEMENT_PREFIX);

    mountNeutral();
    expect(syncTerminalPassthrough()).toBe(false);
    expect(isPassthroughActive()).toBe(false);
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });

  it('never re-announces while focus stays inside the terminal root', () => {
    installTerminalPassthrough();
    mountTerminal();
    expect(syncTerminalPassthrough()).toBe(true);

    resetNavigationAnnouncer();
    syncTerminalPassthrough();
    expect(getNavigationAnnouncement()).toBe('');
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
