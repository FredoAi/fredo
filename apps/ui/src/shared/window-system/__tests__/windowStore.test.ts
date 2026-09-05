/**
 * Own window-kernel store tests (Spec #2807 ST-1).
 *
 * Pins the store-level invariants the slice is built on:
 *  1. Close is idempotent + re-entrancy-guarded — `closeWindow(id)` removes the
 *     entry BEFORE invoking the registered close callback, so a re-entrant
 *     `closeWindow(id)` (as Home's close callback does, Home.tsx:86-90) is a
 *     guaranteed no-op and cannot loop.
 *  2. `updateWindow` spread-merges a partial patch (R-4) — init-time fields
 *     survive, control state is never reset, and a patch never full-replaces.
 *  3. `openWindow` on a fresh id spawns one focused entry; on an existing id it
 *     re-focuses (no duplicates, restore-from-minimize).
 *  4. `focusWindow` raises z-order and clears minimize (R-6).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';

import {
  openWindow,
  closeWindow,
  updateWindow,
  focusWindow,
  registerWindowCloseCallback,
  unregisterWindowCloseCallback,
  resetWindowStoreForTests,
  getWindowSnapshot,
} from '../windowStore';
import type { OpenWindowParams } from '../windowTypes';

const icon: ReactNode = createElement('svg');
const content: ReactNode = createElement('div');
const updatedContent: ReactNode = createElement('b', null, 'updated');

function params(overrides: Partial<OpenWindowParams> = {}): OpenWindowParams {
  return {
    id: 'mission-monitor',
    title: 'Mission Monitor',
    icon,
    component: content,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    isMaximized: true,
    ...overrides,
  };
}

/** Snapshot the store as a plain array so mutations during the test are isolated. */
function snap(): ReturnType<typeof getWindowSnapshot> {
  return [...getWindowSnapshot()];
}

describe('windowStore — close re-entrancy + idempotency guard (R-5)', () => {
  beforeEach(() => resetWindowStoreForTests());

  it('removes the entry BEFORE invoking the registered close callback', () => {
    openWindow(params());
    const callback = vi.fn();
    registerWindowCloseCallback('mission-monitor', callback);

    closeWindow('mission-monitor');

    // Entry is gone from the list.
    expect(snap()).toHaveLength(0);
    // The close callback ran exactly once.
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('a re-entrant closeWindow(id) from inside the close callback DOES NOT loop (Home.tsx:86-90 pattern)', () => {
    openWindow(params());
    let calls = 0;
    // Home's registered close callback calls `closeWindow(id)` itself — an
    // unguarded re-entry would recurse forever. The guard removes the entry
    // first, so the nested call is a no-op.
    registerWindowCloseCallback('mission-monitor', () => {
      calls += 1;
      closeWindow('mission-monitor');
    });

    closeWindow('mission-monitor');

    expect(calls).toBe(1, 'registerClose callback runs exactly once (no re-entry loop)');
    expect(snap()).toHaveLength(0);
  });

  it('close is idempotent — a second close of the same/absent id is a no-op and fires no callback', () => {
    openWindow(params());
    const callback = vi.fn();
    registerWindowCloseCallback('mission-monitor', callback);

    closeWindow('mission-monitor');
    closeWindow('mission-monitor'); // re-entrant/idempotent second close
    closeWindow('never-opened'); // absent id

    expect(callback).toHaveBeenCalledTimes(1);
    expect(snap()).toHaveLength(0);
  });

  it('closing an absent id does not throw and notifies no change', () => {
    expect(() => closeWindow('ghost')).not.toThrow();
    expect(snap()).toHaveLength(0);
  });

  it('unregistering close callback means close removes the entry without invoking anything', () => {
    openWindow(params());
    const callback = vi.fn();
    registerWindowCloseCallback('mission-monitor', callback);
    unregisterWindowCloseCallback('mission-monitor');

    closeWindow('mission-monitor');

    expect(callback).not.toHaveBeenCalled();
    expect(snap()).toHaveLength(0);
  });
});

describe('windowStore — updateWindow spread-merge (R-4)', () => {
  beforeEach(() => resetWindowStoreForTests());

  it('spread-merges a partial patch, preserving init-time + control state', () => {
    openWindow(params());
    openWindow(params({ id: 'run-cli', title: 'Run CLI' }));

    const before = snap().find((w) => w.id === 'mission-monitor')!;
    const zBefore = before.zIndex;

    // Patch only the component + title; the entry must keep every other field.
    updateWindow('mission-monitor', { component: updatedContent });

    const after = snap().find((w) => w.id === 'mission-monitor')!;
    expect(after.title).toBe('Mission Monitor', 'unchanged field survives the merge');
    expect(after.component).toBe(updatedContent);
    expect(after.isMaximized).toBe(true, 'control state survives');
    expect(after.focused).toBe(before.focused, 'focused state survives');
    expect(after.zIndex).toBe(zBefore, 'z-index survives a content-only patch');

    // Only one window remains for this id (no duplicate).
    expect(snap().filter((w) => w.id === 'mission-monitor')).toHaveLength(1);
  });

  it('never full-replaces — control state (minimize) survives a content-only patch', () => {
    openWindow(params());
    // Mark the window minimized via focus-with-minimize.
    focusWindow('mission-monitor', { minimize: true });
    const minimized = snap().find((w) => w.id === 'mission-monitor')!;
    expect(minimized.isMinimized).toBe(true);

    updateWindow('mission-monitor', { title: 'Sessions' });

    const after = snap().find((w) => w.id === 'mission-monitor')!;
    expect(after.title).toBe('Sessions');
    expect(after.isMinimized).toBe(true, 'a content-only patch must not reset minimize');
  });

  it('updating an absent window id is a no-op', () => {
    expect(() => updateWindow('ghost', { title: 'x' })).not.toThrow();
    expect(snap()).toHaveLength(0);
  });
});

describe('windowStore — open / focus (R-3, R-6)', () => {
  beforeEach(() => resetWindowStoreForTests());

  it('opening a fresh id spawns exactly ONE focused entry', () => {
    openWindow(params());
    openWindow(params()); // same id re-open — re-focus, no duplicate

    const all = snap();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('mission-monitor');
    expect(all[0].focused).toBe(true);
    expect(all[0].isMinimized).toBe(false, 're-open restores a minimized window');
  });

  it('focusing a background window raises its z-order above the other windows', () => {
    openWindow(params());
    openWindow(params({ id: 'run-cli', title: 'Run CLI' }));
    // 'run-cli' is on top (most recently opened).
    expect(snap().find((w) => w.id === 'run-cli')!.focused).toBe(true);

    focusWindow('mission-monitor');

    const after = snap();
    const mm = after.find((w) => w.id === 'mission-monitor')!;
    const rc = after.find((w) => w.id === 'run-cli')!;
    expect(mm.focused).toBe(true);
    expect(rc.focused).toBe(false);
    expect(mm.zIndex).toBeGreaterThan(rc.zIndex);
  });

  it('focus clears minimize by default and toggles isMaximized on request', () => {
    openWindow(params());
    focusWindow('mission-monitor', { minimize: true });
    expect(snap().find((w) => w.id === 'mission-monitor')!.isMinimized).toBe(true);

    focusWindow('mission-monitor');
    expect(snap().find((w) => w.id === 'mission-monitor')!.isMinimized).toBe(false);
    expect(snap().find((w) => w.id === 'mission-monitor')!.isMaximized).toBe(true);

    focusWindow('mission-monitor', { maximize: false });
    expect(snap().find((w) => w.id === 'mission-monitor')!.isMaximized).toBe(false);
  });
});
