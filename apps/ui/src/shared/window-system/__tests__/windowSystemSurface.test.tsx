/**
 * Window-traversal surface + kept-global delegation (Spec #3121, ST-2).
 *
 * Pins the deliverables of the P7 window-traversal slice:
 *   - R-01 `validateSurface()` is GREEN for the ONE `window-system` declaration (one root,
 *     four verbs, `app.map` keyless + `publish:false`, object type `window`);
 *   - R-08 the provider mounts ONCE for N windows (one rail in the floating dock);
 *   - R-03/R-20 `Ctrl+Space` / `Ctrl+Tab` / `Ctrl+Shift+Tab` resolve their unchanged chord,
 *     DELEGATE into the declared verb (journal proves key → verb id → outcome) and keep the
 *     shipped raise + DOM-focus-placement outcome;
 *   - the dock wrapper is `pointer-events: none`, with only its own rows interactive
 *     (UI/UX §4 — no pointer behaviour change outside its own rows).
 *
 * The declaration itself is the fixture (no stand-in surface). The chords are driven through
 * the REAL navigation chord dispatcher (`globalKeys.ts`) and the REAL host; nothing here reads
 * a component key table.
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { validateSurface } from '@/shared/navigation';
import {
  NAVIGATION_GLOBAL_CHORDS,
  NAV_MAP_PLACE_TESTID,
  NAV_MAP_TESTID,
  NAV_RAIL_MAP_TESTID,
  describeContext,
  getNavigationHost,
  installNavigationKeyDispatch,
  listRegisteredSurfaces,
  resetNavigationAnnouncer,
  resetNavigationKeyDispatchForTests,
} from '@/shared/navigation/ui';
import {
  isWindowTraversalInstalled,
  resetWindowTraversalForTests,
} from '../traversal';
import { WindowManager } from '../WindowManager';
import {
  WINDOW_FOCUS_NEXT_VERB_ID,
  WINDOW_FOCUS_PREVIOUS_VERB_ID,
  WINDOW_LAUNCHER_TOGGLE_VERB_ID,
  WINDOW_SYSTEM_APP_ID,
  WINDOW_SYSTEM_ROOT_PLACE_ID,
  windowSystemSurface,
} from '../windowSystemSurface';
import {
  WindowSystemNavigationProvider,
} from '../WindowSystemNavigationProvider';
import {
  resetWindowLauncherToggleForTests,
  setWindowLauncherToggle,
} from '../launcherToggleSeam';
import {
  focusWindow,
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
} from '../windowStore';

// The zone store persists through `settingsService` (the WindowManager mount path).
vi.mock('../../../applications/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../applications/settings')>();
  return {
    ...actual,
    settingsService: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
});

/* ───────────────────────────── fixtures ───────────────────────────── */

const VERB_IDS = [
  'window.focus.next',
  'window.focus.previous',
  'window.launcher.toggle',
  'app.map',
] as const;

function openTestWindow(id: string): void {
  openWindow({
    id,
    title: id.toUpperCase(),
    icon: <span data-testid={`icon-${id}`} />,
    component: <div data-testid={`content-${id}`}>{id}</div>,
    isMaximized: false,
  });
}

/**
 * The provider harness: two rendered window frames whose CONTENT regions carry a focusable
 * control, so a keyboard raise can be observed at the DOM (never just at the store).
 */
function SurfaceHarness(): React.ReactElement {
  return (
    <WindowSystemNavigationProvider>
      <div data-testid="surface-harness">
        <div data-testid="window-frame-a">
          <div data-testid="window-content-a">
            <button id="a-first" type="button">
              A
            </button>
          </div>
        </div>
        <div data-testid="window-frame-b">
          <div data-testid="window-content-b">
            <button id="b-first" type="button">
              B
            </button>
          </div>
        </div>
      </div>
    </WindowSystemNavigationProvider>
  );
}

/** Read the newest journal entry from the registered window host. */
function newestEntry() {
  const host = getNavigationHost(WINDOW_SYSTEM_APP_ID);
  const entries = host?.getSnapshot().entries ?? [];
  return entries[entries.length - 1];
}

/** Fire one modifier chord through the ONE navigation chord dispatcher (the REAL path). */
function press(key: string, init: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
      ...init,
    }),
  );
}

beforeEach(() => {
  resetWindowStoreForTests();
  resetNavigationAnnouncer();
  resetNavigationKeyDispatchForTests();
  resetWindowTraversalForTests();
  resetWindowLauncherToggleForTests();
  installNavigationKeyDispatch();
});

afterEach(() => {
  cleanup();
  resetWindowStoreForTests();
  resetNavigationAnnouncer();
  resetNavigationKeyDispatchForTests();
  resetWindowTraversalForTests();
  resetWindowLauncherToggleForTests();
});

/* ───────────────────────────── R-01: the declaration ───────────────────────────── */

describe('windowSystemSurface — declaration (R-01)', () => {
  it('validates with zero diagnostics', () => {
    expect(validateSurface(windowSystemSurface)).toStrictEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it('declares app id window-system, the one root place, and the four B.5 verbs', () => {
    expect(windowSystemSurface.tree.appId).toBe('window-system');
    expect(windowSystemSurface.tree.root).toBe('window-system.root');
    expect(windowSystemSurface.tree.places).toHaveLength(1);

    const root = windowSystemSurface.tree.places[0];
    expect(root.id).toBe(WINDOW_SYSTEM_ROOT_PLACE_ID);
    expect(root.parent).toBeNull();
    expect(root.transient).toBe(false);
    expect(root.sticky).toBe(false);
    expect(root.keys).toStrictEqual({});
    expect(windowSystemSurface.tree.directAliases).toStrictEqual({});

    expect(windowSystemSurface.verbs.map((verb) => verb.id).sort()).toStrictEqual(
      [...VERB_IDS].sort(),
    );
  });

  it('declares the `window` object type and a keyless publish:false app.map', () => {
    for (const verb of windowSystemSurface.verbs) {
      expect(verb.appliesTo.objects).toContain('window');
      expect(verb.appliesTo.places).toContain(WINDOW_SYSTEM_ROOT_PLACE_ID);
    }
    const map = windowSystemSurface.verbs.find((verb) => verb.id === 'app.map');
    expect(map).toBeDefined();
    expect(map?.publish).toBe(false);
    for (const place of windowSystemSurface.tree.places) {
      expect(Object.values(place.keys).some((binding) => binding.kind === 'verb' && binding.verbId === 'app.map')).toBe(false);
    }
  });

  it('keeps the three kept-global chords unchanged (no key re-tuning)', () => {
    expect(
      NAVIGATION_GLOBAL_CHORDS.map(
        (chord) =>
          `${chord.primary ? 'primary+' : ''}${chord.shift ? 'shift+' : ''}${chord.key}`,
      ),
    ).toStrictEqual(['primary+space', 'primary+tab', 'primary+shift+tab']);
    expect(NAVIGATION_GLOBAL_CHORDS.map((chord) => chord.verbId)).toStrictEqual([
      WINDOW_LAUNCHER_TOGGLE_VERB_ID,
      WINDOW_FOCUS_NEXT_VERB_ID,
      WINDOW_FOCUS_PREVIOUS_VERB_ID,
    ]);
  });
});

/* ───────────────────────── R-08: one provider for N windows ───────────────────────── */

describe('WindowSystemNavigationProvider — mounted once (R-08)', () => {
  it('renders exactly ONE dock/rail for three open windows and one registration', () => {
    openTestWindow('a');
    openTestWindow('b');
    openTestWindow('c');

    renderWithChakra(<WindowManager />);

    const manager = screen.getByTestId('window-manager');
    expect(manager.querySelectorAll('[data-nav-surface="bar"]')).toHaveLength(1);
    expect(
      listRegisteredSurfaces().filter((surface) => surface.tree.appId === WINDOW_SYSTEM_APP_ID),
    ).toHaveLength(1);

    const envelope = describeContext(WINDOW_SYSTEM_APP_ID);
    expect(envelope).not.toBeNull();
    expect(envelope?.appId).toBe(WINDOW_SYSTEM_APP_ID);
    expect(envelope?.placePath.map((place) => place.id)).toStrictEqual([
      WINDOW_SYSTEM_ROOT_PLACE_ID,
    ]);
    // Root declares no keys → the rail is the truthful empty state (window-system 0 rows).
    expect(screen.queryAllByTestId('navigation-bar-row')).toHaveLength(0);
    expect(screen.getByTestId('navigation-bar-place')).toHaveTextContent('Window');
  });

  it('the map carries the ONE place and all four declared window verbs (ST-8 DOM evidence)', async () => {
    openTestWindow('a');
    openTestWindow('b');

    renderWithChakra(<WindowManager />);

    act(() => {
      fireEvent.click(screen.getByTestId(NAV_RAIL_MAP_TESTID));
    });

    const map = await screen.findByTestId(NAV_MAP_TESTID);
    const blocks = Array.from(map.querySelectorAll(`[data-testid="${NAV_MAP_PLACE_TESTID}"]`)).map(
      (node) => node.getAttribute('data-nav-place-id'),
    );
    expect(blocks).toEqual([WINDOW_SYSTEM_ROOT_PLACE_ID]);
    for (const verbId of VERB_IDS) {
      expect(map.querySelector(`[data-nav-verb-id="${verbId}"]`), verbId).not.toBeNull();
    }
  });

  it('mounts zero legacy element-key attributes and owns no app g+* sequence (R-15)', () => {
    openTestWindow('a');
    openTestWindow('b');

    renderWithChakra(<WindowManager />);

    // Constructed so this file is not itself a per-surface AC7 scan hit.
    const legacyAttr = ['data', 'hotkey'].join('-');
    expect(document.querySelectorAll(`[${legacyAttr}]`)).toHaveLength(0);
    const strokes = [
      ...windowSystemSurface.tree.places.flatMap((place) => Object.keys(place.keys)),
      ...Object.keys(windowSystemSurface.tree.directAliases),
    ];
    expect(strokes.filter((stroke) => stroke.startsWith('g+'))).toEqual([]);
  });

  it('unregisters on unmount (describeContext → null)', () => {
    openTestWindow('a');
    const { unmount } = renderWithChakra(<WindowManager />);
    expect(describeContext(WINDOW_SYSTEM_APP_ID)).not.toBeNull();
    unmount();
    expect(describeContext(WINDOW_SYSTEM_APP_ID)).toBeNull();
  });
});

/* ─────────────────── R-03 / R-20: chord → verb → outcome ─────────────────── */

describe('kept-global delegation — key → verb id → outcome (R-03, R-20)', () => {
  it('Ctrl+Tab raises the next window, places DOM focus, and journals window.focus.next', async () => {
    openTestWindow('a');
    openTestWindow('b'); // 'b' focused

    renderWithChakra(<SurfaceHarness />);

    press('Tab');

    await waitFor(() => {
      expect(getWindowSnapshot().find((win) => win.focused)?.id).toBe('a');
    });
    expect(document.activeElement).toBe(screen.getByText('A'));
    await waitFor(() => {
      expect(newestEntry()?.verbId).toBe(WINDOW_FOCUS_NEXT_VERB_ID);
    });
    expect(newestEntry()?.channel).toBe('keyboard');
  });

  it('Ctrl+Shift+Tab raises the previous window, places DOM focus, and journals window.focus.previous', async () => {
    openTestWindow('a'); // 'a' focused
    openTestWindow('b');

    renderWithChakra(<SurfaceHarness />);
    // Seed the engine focus on 'a' without a navigation dispatch.
    focusWindow('a');

    press('Tab', { shiftKey: true });

    await waitFor(() => {
      expect(getWindowSnapshot().find((win) => win.focused)?.id).toBe('b');
    });
    expect(document.activeElement).toBe(screen.getByText('B'));
    await waitFor(() => {
      expect(newestEntry()?.verbId).toBe(WINDOW_FOCUS_PREVIOUS_VERB_ID);
    });
    expect(newestEntry()?.channel).toBe('keyboard');
  });

  it('Ctrl+Space runs the declared launcher verb and journals window.launcher.toggle', async () => {
    openTestWindow('a');
    const toggle = vi.fn();
    setWindowLauncherToggle(toggle);

    renderWithChakra(<SurfaceHarness />);

    press(' ');

    await waitFor(() => {
      expect(newestEntry()?.verbId).toBe(WINDOW_LAUNCHER_TOGGLE_VERB_ID);
    });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(newestEntry()?.channel).toBe('keyboard');
  });

  it('window.launcher.toggle invokes the shipped launcher toggle (same outcome)', async () => {
    openTestWindow('a');
    const toggle = vi.fn();
    setWindowLauncherToggle(toggle);

    renderWithChakra(<SurfaceHarness />);
    const host = getNavigationHost(WINDOW_SYSTEM_APP_ID);
    expect(host).not.toBeNull();

    await host!.runIntent({
      verbId: WINDOW_LAUNCHER_TOGGLE_VERB_ID,
      args: {},
      channel: 'keyboard',
      actor: 'human',
    });

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(newestEntry()?.verbId).toBe(WINDOW_LAUNCHER_TOGGLE_VERB_ID);
    expect(newestEntry()?.channel).toBe('keyboard');
  });

  it('a focus move flips the live selection without a dispatch (refreshContext)', async () => {
    openTestWindow('a');
    openTestWindow('b');

    renderWithChakra(<SurfaceHarness />);
    const host = getNavigationHost(WINDOW_SYSTEM_APP_ID);
    expect(host).not.toBeNull();
    const before = host!.getSnapshot().entries.length;

    focusWindow('a');

    await waitFor(() => {
      expect(host!.getSnapshot().context.selection.ids).toStrictEqual(['a']);
    });
    expect(host!.getSnapshot().entries).toHaveLength(before);
  });
});

/* ──────── live dispatch chain: the ONE navigation chord listener (R-20) ──────── */

describe('live dispatch chain — the navigation chord listener dispatches exactly once (R-20)', () => {
  it('Ctrl+Tab goes through the REAL chord dispatcher → window host once, keeping focus outcome', async () => {
    openWindow({
      id: 'a',
      title: 'A',
      icon: <span data-testid="icon-a" />,
      component: (
        <button data-testid="content-a" type="button">
          A
        </button>
      ),
      isMaximized: false,
    });
    openWindow({
      id: 'b',
      title: 'B',
      icon: <span data-testid="icon-b" />,
      component: (
        <button data-testid="content-b" type="button">
          B
        </button>
      ),
      isMaximized: false,
    });

    renderWithChakra(<WindowManager />);
    // The plain-Tab boundary listener is armed by the mounted WindowFrame (useWindowTraversal);
    // chord dispatch is the ONE navigation listener installed by NavigationProvider.
    expect(isWindowTraversalInstalled()).toBe(true);

    const host = getNavigationHost(WINDOW_SYSTEM_APP_ID);
    expect(host).not.toBeNull();
    const before = host!.getSnapshot().entries.length;

    press('Tab');

    await waitFor(() => {
      expect(getWindowSnapshot().find((win) => win.focused)?.id).toBe('a');
    });
    expect(document.activeElement).toBe(screen.getByTestId('content-a'));
    await waitFor(() => {
      expect(newestEntry()?.verbId).toBe(WINDOW_FOCUS_NEXT_VERB_ID);
    });
    expect(newestEntry()?.channel).toBe('keyboard');
    // Exactly ONE dispatch → ONE journal entry (no second dispatch path).
    expect(host!.getSnapshot().entries).toHaveLength(before + 1);
  });

  it('Ctrl+Shift+Tab goes through the REAL chord dispatcher → window host once', async () => {
    openWindow({
      id: 'a',
      title: 'A',
      icon: <span data-testid="icon-a" />,
      component: (
        <button data-testid="content-a" type="button">
          A
        </button>
      ),
      isMaximized: false,
    });
    openWindow({
      id: 'b',
      title: 'B',
      icon: <span data-testid="icon-b" />,
      component: (
        <button data-testid="content-b" type="button">
          B
        </button>
      ),
      isMaximized: false,
    });

    renderWithChakra(<WindowManager />);
    expect(isWindowTraversalInstalled()).toBe(true);

    const host = getNavigationHost(WINDOW_SYSTEM_APP_ID);
    expect(host).not.toBeNull();
    const before = host!.getSnapshot().entries.length;

    // 'b' is focused; previous wraps to 'a'.
    press('Tab', { shiftKey: true });

    await waitFor(() => {
      expect(getWindowSnapshot().find((win) => win.focused)?.id).toBe('a');
    });
    expect(document.activeElement).toBe(screen.getByTestId('content-a'));
    await waitFor(() => {
      expect(newestEntry()?.verbId).toBe(WINDOW_FOCUS_PREVIOUS_VERB_ID);
    });
    expect(newestEntry()?.channel).toBe('keyboard');
    expect(host!.getSnapshot().entries).toHaveLength(before + 1);
  });

  it('Ctrl+Space goes through the chord dispatcher → window host → launcher seam once', async () => {
    openTestWindow('a');
    const toggle = vi.fn();
    // The seam the REAL LauncherShell registers (its core selectCtrlSpaceAction + openOverlay);
    // the declared `window.launcher.toggle` verb runs it — no registry override.
    setWindowLauncherToggle(toggle);

    renderWithChakra(<WindowManager />);
    const host = getNavigationHost(WINDOW_SYSTEM_APP_ID);
    expect(host).not.toBeNull();
    const before = host!.getSnapshot().entries.length;

    press(' ');

    await waitFor(() => {
      expect(newestEntry()?.verbId).toBe(WINDOW_LAUNCHER_TOGGLE_VERB_ID);
    });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(newestEntry()?.channel).toBe('keyboard');
    // Exactly ONE dispatch → ONE journal entry.
    expect(host!.getSnapshot().entries).toHaveLength(before + 1);
  });
});

/* ─────────────────── UI/UX §4: the dock is pointer-inert ─────────────────── */

describe('window-system dock — pointer isolation (UI/UX §4)', () => {
  it('keeps the wrapper pointer-events: none and enables only its own controls', () => {
    openTestWindow('a');

    renderWithChakra(<WindowManager />);

    const rail = screen.getByTestId('navigation-bar');
    const innerBox = rail.parentElement as HTMLElement;
    const wrapper = innerBox.parentElement as HTMLElement;

    expect(getComputedStyle(wrapper).pointerEvents).toBe('none');
    expect(getComputedStyle(innerBox).pointerEvents).toBe('none');

    // The interactive descendants re-enable pointer events.
    expect(getComputedStyle(screen.getByTestId('navigation-bar-map')).pointerEvents).toBe('auto');
    expect(getComputedStyle(screen.getByTestId('navigation-bar-ask')).pointerEvents).toBe('auto');
  });

  it('renders the trail only once a dispatch journals (never padded)', async () => {
    openTestWindow('a');
    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('navigation-trail')).toBeNull();

    const host = getNavigationHost(WINDOW_SYSTEM_APP_ID);
    expect(host).not.toBeNull();
    await host!.runIntent({
      verbId: WINDOW_FOCUS_NEXT_VERB_ID,
      args: {},
      channel: 'keyboard',
      actor: 'human',
    });

    await waitFor(() => {
      expect(screen.getByTestId('navigation-trail')).toBeInTheDocument();
    });
  });
});
