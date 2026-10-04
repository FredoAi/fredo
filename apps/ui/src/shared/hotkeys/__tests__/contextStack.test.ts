/**
 * Spec #2958 ST-2 — the module-scoped interaction-context navigation stack
 * (EARS R-2.1, R-2.2, R-3.1, R-3.2, R-4.2, R-4.3, R-5.2).
 *
 * Pins: enter/exit mechanics + refusals, the 8-frame cap, focus-derived base +
 * descent-clear-on-feature-change, the body DOM hooks, the announcement copy,
 * snapshot identity stability, and that tracking adds NO keydown listener.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { getAnnouncement, resetHotkeyAnnouncer } from '../announcer';
import {
  registerFeatureHotkeyContexts,
  registerHotkeyContext,
  resetContextRegistryForTests,
} from '../contexts';
import { ROOT_CONTEXT_ID, type HotkeyContextSnapshot } from '../types';
import {
  BODY_HOTKEY_CONTEXT_ATTR,
  BODY_HOTKEY_CONTEXT_DEPTH_ATTR,
  contextAnnouncement,
  enterHotkeyContext,
  exitHotkeyContext,
  getActiveHotkeyContext,
  getHotkeyContextDepth,
  getHotkeyContextPath,
  getHotkeyContextSnapshot,
  installHotkeyContextTracking,
  resetHotkeyContextForTests,
  subscribeHotkeyContext,
  syncHotkeyContextFromFocus,
  useActiveHotkeyContext,
} from '../contextStack';
import {
  closeWindow,
  focusWindow,
  openWindow,
  resetWindowStoreForTests,
} from '../../window-system/windowStore';

function openFeature(id: string): void {
  openWindow({ id, title: id, icon: null, component: null });
}

function registerDemoContexts(): void {
  registerFeatureHotkeyContexts('demo', [
    { contextId: 'demo.canvas', parentId: 'demo', title: 'Canvas' },
    { contextId: 'demo.canvas.node', parentId: 'demo.canvas', title: 'Node' },
  ]);
}

beforeEach(() => {
  resetContextRegistryForTests();
  resetWindowStoreForTests();
  resetHotkeyAnnouncer();
  resetHotkeyContextForTests();
  registerDemoContexts();
  registerHotkeyContext({
    contextId: 'fredo.root.reference',
    parentId: ROOT_CONTEXT_ID,
    title: 'Reference',
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHotkeyContextForTests();
});

describe('initial state + snapshot identity', () => {
  it('starts at the platform ROOT with a base-only path', () => {
    expect(getActiveHotkeyContext()).toBe(ROOT_CONTEXT_ID);
    expect(getHotkeyContextDepth()).toBe(1);
    expect(getHotkeyContextPath()).toEqual([ROOT_CONTEXT_ID]);
    expect(getHotkeyContextSnapshot()).toEqual({
      contextId: ROOT_CONTEXT_ID,
      depth: 1,
      reason: 'focus',
    });
  });

  it('returns the SAME frozen snapshot object between real changes', () => {
    const first = getHotkeyContextSnapshot();
    expect(getHotkeyContextSnapshot()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);

    // A refused enter is not a real change — identity must survive.
    expect(enterHotkeyContext('nope.missing')).toBe(false);
    expect(getHotkeyContextSnapshot()).toBe(first);
  });
});

describe('focus-derived base', () => {
  it('derives the base from the focused feature id', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();

    expect(getActiveHotkeyContext()).toBe('demo');
    expect(getHotkeyContextDepth()).toBe(1);
    expect(getHotkeyContextPath()).toEqual(['demo']);
    expect(getHotkeyContextSnapshot().reason).toBe('focus');
  });

  it('clears explicit descents when the focused feature changes', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(enterHotkeyContext('demo.canvas')).toBe(true);
    expect(getHotkeyContextPath()).toEqual(['demo', 'demo.canvas']);

    openFeature('other');
    syncHotkeyContextFromFocus();

    expect(getActiveHotkeyContext()).toBe('other');
    expect(getHotkeyContextDepth()).toBe(1);
    expect(getHotkeyContextPath()).toEqual(['other']);
  });

  it('preserves the active descent when focus does not change the base', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(enterHotkeyContext('demo.canvas')).toBe(true);

    syncHotkeyContextFromFocus();

    expect(getActiveHotkeyContext()).toBe('demo.canvas');
    expect(getHotkeyContextDepth()).toBe(2);
  });

  it('returns to ROOT when the focused feature is cleared', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(enterHotkeyContext('demo.canvas')).toBe(true);

    closeWindow('demo');
    syncHotkeyContextFromFocus();

    expect(getActiveHotkeyContext()).toBe(ROOT_CONTEXT_ID);
    expect(getHotkeyContextDepth()).toBe(1);
  });
});

describe('enter / exit mechanics (R-2.1, R-3.1, R-3.2)', () => {
  beforeEach(() => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
  });

  it('descends into a direct child and increases depth by one', () => {
    expect(enterHotkeyContext('demo.canvas')).toBe(true);
    expect(getActiveHotkeyContext()).toBe('demo.canvas');
    expect(getHotkeyContextDepth()).toBe(2);
    expect(getHotkeyContextPath()).toEqual(['demo', 'demo.canvas']);
    expect(getHotkeyContextSnapshot().reason).toBe('enter');

    expect(enterHotkeyContext('demo.canvas.node')).toBe(true);
    expect(getActiveHotkeyContext()).toBe('demo.canvas.node');
    expect(getHotkeyContextDepth()).toBe(3);
  });

  it('refuses an unknown context', () => {
    expect(enterHotkeyContext('nope.missing')).toBe(false);
    expect(getActiveHotkeyContext()).toBe('demo');
  });

  it('refuses an invalid context', () => {
    registerFeatureHotkeyContexts('bad', [
      { contextId: 'other.foreign', parentId: 'bad', title: 'Foreign' },
    ]);
    expect(enterHotkeyContext('other.foreign')).toBe(false);
    expect(getActiveHotkeyContext()).toBe('demo');
  });

  it('refuses the already-active context (idempotent)', () => {
    expect(enterHotkeyContext('demo')).toBe(false);
    expect(getHotkeyContextDepth()).toBe(1);
  });

  it('refuses a feature context that is not a direct child of the active context', () => {
    // demo.canvas.node's parent is demo.canvas, not the active demo.
    expect(enterHotkeyContext('demo.canvas.node')).toBe(false);
    expect(getActiveHotkeyContext()).toBe('demo');
  });

  it('allows a platform context from any active context', () => {
    expect(enterHotkeyContext('fredo.root.reference')).toBe(true);
    expect(getActiveHotkeyContext()).toBe('fredo.root.reference');
    expect(getHotkeyContextDepth()).toBe(2);
  });

  it('pops exactly one explicit descent per exit and refuses at the base', () => {
    expect(enterHotkeyContext('demo.canvas')).toBe(true);
    expect(enterHotkeyContext('demo.canvas.node')).toBe(true);
    expect(getHotkeyContextDepth()).toBe(3);

    expect(exitHotkeyContext()).toBe(true);
    expect(getActiveHotkeyContext()).toBe('demo.canvas');
    expect(getHotkeyContextDepth()).toBe(2);
    expect(getHotkeyContextSnapshot().reason).toBe('back');

    expect(exitHotkeyContext()).toBe(true);
    expect(getActiveHotkeyContext()).toBe('demo');
    expect(getHotkeyContextDepth()).toBe(1);

    expect(exitHotkeyContext()).toBe(false);
    expect(getActiveHotkeyContext()).toBe('demo');
  });

  it('caps the stack at 8 frames (base included)', () => {
    for (let i = 1; i <= 7; i += 1) {
      registerHotkeyContext({
        contextId: `fredo.p${i}`,
        parentId: ROOT_CONTEXT_ID,
        title: `P${i}`,
      });
    }
    for (let i = 1; i <= 7; i += 1) {
      expect(enterHotkeyContext(`fredo.p${i}`)).toBe(true);
    }
    expect(getHotkeyContextDepth()).toBe(8);

    registerHotkeyContext({ contextId: 'fredo.p8', parentId: ROOT_CONTEXT_ID, title: 'P8' });
    expect(enterHotkeyContext('fredo.p8')).toBe(false);
    expect(getHotkeyContextDepth()).toBe(8);
  });
});

describe('body DOM hooks (R-4.3)', () => {
  function contextAttr(): string | null {
    return document.body.getAttribute(BODY_HOTKEY_CONTEXT_ATTR);
  }
  function depthAttr(): string | null {
    return document.body.getAttribute(BODY_HOTKEY_CONTEXT_DEPTH_ATTR);
  }

  it('is absent while the active context is the platform ROOT', () => {
    expect(contextAttr()).toBeNull();
    expect(depthAttr()).toBeNull();
  });

  it('publishes the active id + path length (base = 1) below ROOT', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(contextAttr()).toBe('demo');
    expect(depthAttr()).toBe('1');

    enterHotkeyContext('demo.canvas');
    expect(contextAttr()).toBe('demo.canvas');
    expect(depthAttr()).toBe('2');

    exitHotkeyContext();
    expect(contextAttr()).toBe('demo');
    expect(depthAttr()).toBe('1');
  });

  it('removes both hooks when focus returns to the ROOT', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(contextAttr()).toBe('demo');

    closeWindow('demo');
    syncHotkeyContextFromFocus();
    expect(contextAttr()).toBeNull();
    expect(depthAttr()).toBeNull();
  });
});

describe('announcement (R-4.2)', () => {
  it('announces a descent and a return through the shared channel', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(getAnnouncement()).toBe('Entered demo. Level 1.');

    enterHotkeyContext('demo.canvas');
    expect(getAnnouncement()).toBe('Entered Canvas. Level 2.');

    exitHotkeyContext();
    expect(getAnnouncement()).toBe('Back to demo. Top level.');
  });

  it('does not re-announce a no-op focus sync', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    const announced = getAnnouncement();
    syncHotkeyContextFromFocus();
    expect(getAnnouncement()).toBe(announced);
  });

  it('renders the pure copy for every reason + level', () => {
    const at = (overrides: Partial<HotkeyContextSnapshot>): HotkeyContextSnapshot => ({
      contextId: 'demo.canvas',
      depth: 2,
      reason: 'enter',
      ...overrides,
    });

    expect(contextAnnouncement(at({ reason: 'enter' }))).toBe('Entered Canvas. Level 2.');
    expect(contextAnnouncement(at({ reason: 'back' }))).toBe('Back to Canvas. Level 2.');
    expect(contextAnnouncement(at({ reason: 'focus' }))).toBe('Entered Canvas. Level 2.');
    expect(contextAnnouncement(at({ contextId: 'demo', depth: 1, reason: 'back' }))).toBe(
      'Back to demo. Top level.',
    );
    expect(contextAnnouncement(at({ contextId: 'ghost', depth: 1, reason: 'enter' }))).toBe(
      'Entered ghost. Level 1.',
    );
  });
});

describe('subscription', () => {
  it('notifies only on a real change and unsubscribes cleanly', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();

    const seen: number[] = [];
    const unsubscribe = subscribeHotkeyContext(() => seen.push(getHotkeyContextDepth()));

    enterHotkeyContext('demo.canvas'); // real change → 2
    enterHotkeyContext('demo.canvas'); // refused → no notify
    syncHotkeyContextFromFocus(); // same base → no notify
    exitHotkeyContext(); // real change → 1

    expect(seen).toEqual([2, 1]);

    unsubscribe();
    enterHotkeyContext('demo.canvas');
    expect(seen).toEqual([2, 1]);
  });
});

describe('installHotkeyContextTracking', () => {
  it('adds NO keydown listener', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const uninstall = installHotkeyContextTracking();

    const keydownCalls = addSpy.mock.calls.filter((call) => call[0] === 'keydown');
    expect(keydownCalls).toHaveLength(0);

    uninstall();
  });

  it('re-derives the base when the focused feature changes after install', () => {
    const uninstall = installHotkeyContextTracking();
    expect(getActiveHotkeyContext()).toBe(ROOT_CONTEXT_ID);

    openFeature('demo');
    expect(getActiveHotkeyContext()).toBe('demo');
    expect(getAnnouncement()).toBe('Entered demo. Level 1.');

    uninstall();
  });

  it('is idempotent and stops tracking once unsubscribed', () => {
    const first = installHotkeyContextTracking();
    expect(installHotkeyContextTracking()).toBe(first);

    openFeature('demo');
    expect(getActiveHotkeyContext()).toBe('demo');

    first();
    openFeature('other');
    expect(getActiveHotkeyContext()).toBe('demo');
  });
});

describe('useActiveHotkeyContext', () => {
  it('re-renders on a real context change', () => {
    const { result } = renderHook(() => useActiveHotkeyContext());
    expect(result.current.contextId).toBe(ROOT_CONTEXT_ID);

    act(() => {
      openFeature('demo');
      syncHotkeyContextFromFocus();
    });
    expect(result.current.contextId).toBe('demo');
    expect(result.current.depth).toBe(1);

    act(() => {
      enterHotkeyContext('demo.canvas');
    });
    expect(result.current.contextId).toBe('demo.canvas');
    expect(result.current.depth).toBe(2);
  });
});

// ── Continuous nested-state invariant (Spec #2962 ST-4, G-123) ───────────────
//
// ST-4 owns the invariant that must hold for the WHOLE descended lifetime — not
// only at the enter/unwind call-sites. These pins read the module-scoped stack
// directly (the same path every keydown resolves against) across repeated reads,
// a mid-lifetime same-focus sync, a base change, a window close and the cap.

describe('continuous nested-state invariant (Spec #2962 ST-4)', () => {
  /** Focus `demo`, derive the base, then descend the full demo chain (3 levels). */
  function descendDemoChain(): void {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(enterHotkeyContext('demo.canvas')).toBe(true);
    expect(enterHotkeyContext('demo.canvas.node')).toBe(true);
  }

  it('holds the full active path for the whole descended lifetime, not just at enter', () => {
    descendDemoChain();
    expect(getHotkeyContextPath()).toEqual(['demo', 'demo.canvas', 'demo.canvas.node']);
    expect(getActiveHotkeyContext()).toBe('demo.canvas.node');
    expect(getHotkeyContextDepth()).toBe(3);

    // Repeated reads (what every keydown's resolve performs) never mutate the path.
    expect(getHotkeyContextPath()).toEqual(['demo', 'demo.canvas', 'demo.canvas.node']);
    expect(getHotkeyContextDepth()).toBe(3);

    // A same-focus sync mid-lifetime preserves the active descent (R-5.3).
    syncHotkeyContextFromFocus();
    expect(getHotkeyContextPath()).toEqual(['demo', 'demo.canvas', 'demo.canvas.node']);
    expect(getHotkeyContextDepth()).toBe(3);
    expect(getActiveHotkeyContext()).toBe('demo.canvas.node');
  });

  it('R-3.1/R-3.2: each Escape pops EXACTLY one level and at the base it is native', () => {
    descendDemoChain();

    expect(exitHotkeyContext()).toBe(true);
    expect(getActiveHotkeyContext()).toBe('demo.canvas');
    expect(getHotkeyContextDepth()).toBe(2);

    expect(exitHotkeyContext()).toBe(true);
    expect(getActiveHotkeyContext()).toBe('demo');
    expect(getHotkeyContextDepth()).toBe(1);

    // At the base the model must not consume Escape (R-3.2).
    expect(exitHotkeyContext()).toBe(false);
    expect(getActiveHotkeyContext()).toBe('demo');
    expect(getHotkeyContextDepth()).toBe(1);
  });

  it('R-5.1/R-5.2: a focused-feature change discards every descent; re-entry starts at the top level', () => {
    descendDemoChain();

    openFeature('other');
    syncHotkeyContextFromFocus();
    expect(getActiveHotkeyContext()).toBe('other');
    expect(getHotkeyContextDepth()).toBe(1);

    // Re-entering the original feature starts at its TOP level — never stale.
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(getActiveHotkeyContext()).toBe('demo');
    expect(getHotkeyContextPath()).toEqual(['demo']);
    expect(getHotkeyContextDepth()).toBe(1);
  });

  it('R-5.1: the window-close subscription (no manual sync) re-derives the base and clears descents', () => {
    const uninstall = installHotkeyContextTracking();
    try {
      openFeature('demo');
      expect(getActiveHotkeyContext()).toBe('demo');
      expect(enterHotkeyContext('demo.canvas')).toBe(true);
      expect(enterHotkeyContext('demo.canvas.node')).toBe(true);
      expect(getHotkeyContextDepth()).toBe(3);

      // The window-store notification ALONE must discard the descents (R-5.1).
      closeWindow('demo');
      expect(getActiveHotkeyContext()).toBe(ROOT_CONTEXT_ID);
      expect(getHotkeyContextDepth()).toBe(1);

      // Re-opening the feature starts at the top level (R-5.2).
      openFeature('demo');
      expect(getActiveHotkeyContext()).toBe('demo');
      expect(getHotkeyContextDepth()).toBe(1);
    } finally {
      uninstall();
    }
  });

  it('R-5.3: a same-base sync preserves the descent while a base change clears it', () => {
    descendDemoChain();

    // Re-focusing the SAME feature keeps the base → the descent is preserved.
    openFeature('demo');
    syncHotkeyContextFromFocus();
    expect(getActiveHotkeyContext()).toBe('demo.canvas.node');
    expect(getHotkeyContextDepth()).toBe(3);

    // A base change → every descent is discarded.
    openFeature('other');
    syncHotkeyContextFromFocus();
    expect(getActiveHotkeyContext()).toBe('other');
    expect(getHotkeyContextDepth()).toBe(1);
  });

  it('bounds the stack at 8 frames and unwinds exactly one level per press from the cap', () => {
    openFeature('demo');
    syncHotkeyContextFromFocus();
    for (let i = 1; i <= 7; i += 1) {
      registerHotkeyContext({
        contextId: `fredo.p${i}`,
        parentId: ROOT_CONTEXT_ID,
        title: `P${i}`,
      });
    }
    for (let i = 1; i <= 7; i += 1) {
      expect(enterHotkeyContext(`fredo.p${i}`)).toBe(true);
    }
    expect(getHotkeyContextDepth()).toBe(8);

    // One more descent is refused and the active path is unchanged (bounded).
    registerHotkeyContext({ contextId: 'fredo.p8', parentId: ROOT_CONTEXT_ID, title: 'P8' });
    expect(enterHotkeyContext('fredo.p8')).toBe(false);
    expect(getHotkeyContextDepth()).toBe(8);

    // Unwind from the cap: exactly one level per press, no trap.
    for (let depth = 7; depth >= 1; depth -= 1) {
      expect(exitHotkeyContext()).toBe(true);
      expect(getHotkeyContextDepth()).toBe(depth);
    }
    expect(exitHotkeyContext()).toBe(false);
    expect(getHotkeyContextDepth()).toBe(1);
  });
});
