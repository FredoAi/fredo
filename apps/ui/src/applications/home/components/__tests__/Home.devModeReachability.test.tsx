/**
 * Spec #3122 ST-4 — Dev Mode stays hidden yet reachable after the eight
 * deprecated hidden apps are deleted.
 *
 * The page-router branches are gone (see `Router.tsx`), so the Konami Easter egg
 * is the ONLY user-facing route to Dev Mode. This pin drives the REAL
 * `useKonamiCode` hook through the REAL `Home` orchestration and proves:
 *
 *   (a) the ten-stroke Konami sequence still opens the Dev Mode feature window
 *       through `openFeatureWindow(devModeFeature)` (id + title + component);
 *   (b) Dev Mode is still hidden (`showable === false`);
 *   (c) its four bound verbs are still declared and still dispatch through the
 *       ONE navigation funnel (clear / filter / states / Application Data).
 *
 * The heavy window-system / feature seams are mocked following the
 * `Home.noAutoSetup.test.tsx` harness pattern; the Dev Mode feature, its surface
 * and `useKonamiCode` are deliberately NOT mocked.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

const spies = vi.hoisted(() => ({
  openWindow: vi.fn(),
  closeWindow: vi.fn(),
  updateWindow: vi.fn(),
  openApp: vi.fn(),
  showMessage: vi.fn(),
  enterDoomMode: vi.fn(),
}));

// ── Window-system seams ───────────────────────────────────────────────────────
vi.mock('@/shared/window-system/useWindowActions', () => ({
  useWindowActions: () => ({
    openWindow: spies.openWindow,
    closeWindow: spies.closeWindow,
    updateWindow: spies.updateWindow,
  }),
}));
vi.mock('@/shared/window-system/WindowSystemProvider', () => ({
  WindowSystemProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock('@/shared/window-system/WindowManager', () => ({ WindowManager: () => null }));
vi.mock('@/shared/window-system/zoneLayoutStore', () => ({
  hydrateZoneLayout: vi.fn().mockResolvedValue(undefined),
  reopenZonedWindows: vi.fn(),
}));
vi.mock('@/shared/window-system/windowStore', () => ({ updateWindow: spies.updateWindow }));
vi.mock('@/shared/window-system/appPresentationStore', () => ({
  hydrateAppPresentation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/window-system/appWindows', () => ({ createAppOpener: () => spies.openApp }));

// ── Presentational / feature seams (out of scope for this pin) ────────────────
vi.mock('@/applications/home/components/launcher/LauncherShell', () => ({
  LauncherShell: () => null,
}));
vi.mock('@/applications/home/components/background/DesktopBackdrop', () => ({
  DesktopBackdrop: () => null,
}));
vi.mock('@/applications/home/hooks/useAppOpenRequests', () => ({
  useAppOpenRequests: vi.fn(),
}));
vi.mock('@/applications/allApplications', () => ({}));
vi.mock('@/shared/application-data/registry', () => ({
  declareAllRegisteredApplicationData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/applications/applicationRegistry', () => ({
  getApplications: () => [],
  dedupeByApplicationId: (features: unknown[]) => features,
  registerApplication: vi.fn(),
}));

vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => ({ showMessage: spies.showMessage }),
}));
// `useKonamiCode` is REAL — this pin exists to prove the Easter egg still fires.
vi.mock('@/shared/hooks/useSecretCode', () => ({ useSecretCode: vi.fn() }));
vi.mock('@/shared/doom-mode', () => ({
  DOOM_SECRET_CODE: 'iddqd',
  useDoomMode: () => ({ enter: spies.enterDoomMode }),
  useDoomModeSkill: vi.fn(),
}));

import { Home } from '@/applications/home/components/Home';
import { devModeFeature } from '@/applications/dev-mode';
import {
  DEV_MODE_EVENTS_CLEAR_VERB_ID,
  DEV_MODE_EVENTS_PLACE_ID,
  DEV_MODE_SEARCH_FOCUS_VERB_ID,
  DEV_MODE_STATES_ALL_VERB_ID,
  DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
  devModeSurface,
} from '@/applications/dev-mode/devModeSurface';
import {
  createJournalStore,
  dispatch,
  validateSurface,
  type ContextSnapshot,
  type EngineDeps,
} from '@/shared/navigation';

/** The exact ten-stroke sequence from `useKonamiCode.ts:3-14`. */
const KONAMI_SEQUENCE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
] as const;

const BOUND_VERB_IDS = [
  DEV_MODE_EVENTS_CLEAR_VERB_ID,
  DEV_MODE_SEARCH_FOCUS_VERB_ID,
  DEV_MODE_STATES_ALL_VERB_ID,
  DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
] as const;

function dispatchHarness(): EngineDeps {
  const context: ContextSnapshot = {
    appId: 'dev-mode',
    placePath: [DEV_MODE_EVENTS_PLACE_ID],
    selection: { count: 1, kinds: ['panel'], label: 'rows', ids: ['rows'] },
    dirty: false,
  };
  return {
    surface: devModeSurface,
    getContext: () => context,
    journal: createJournalStore(),
    now: () => '2026-01-01T00:00:00.000Z',
    applyPatch: () => {},
    confirm: () => true,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('#3122 ST-4 — Konami still opens Dev Mode after the page router is removed', () => {
  it('opens the Dev Mode feature window on the Konami sequence', async () => {
    renderWithChakra(<Home />);

    // One `act` per stroke: the hook advances through a ref mirrored by an
    // effect, so each key must commit (and flush its effect) before the next.
    for (const key of KONAMI_SEQUENCE) {
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key }));
      });
    }
    await act(async () => {
      // Flush the deferred `onMount` timer scheduled by `openFeatureWindow`.
      await vi.advanceTimersByTimeAsync(1);
    });

    const opened = spies.openWindow.mock.calls.map(
      (call) => call[0] as { id?: string; title?: string; component?: unknown },
    );
    const devModeWindows = opened.filter((window) => window.id === devModeFeature.id);

    expect(devModeWindows).toHaveLength(1);
    expect(devModeWindows[0]?.title).toBe('Dev Mode');
    expect(devModeWindows[0]?.component).toBeTruthy();
    // Nothing else was opened: the Easter egg has exactly one effect.
    expect(opened).toHaveLength(1);
    // Dev Mode stays HIDDEN from the launcher while remaining reachable (R-10.4).
    expect(devModeFeature.showable).toBe(false);
  });

  it('still declares and dispatches its four bound verbs', async () => {
    expect(validateSurface(devModeSurface)).toStrictEqual({ valid: true, diagnostics: [] });

    const root = devModeSurface.tree.places.find((place) => place.id === DEV_MODE_EVENTS_PLACE_ID);
    if (root === undefined) throw new Error('the Dev Mode root place is missing');

    // The four keys still resolve to the four bound action verbs.
    expect(root.keys.x).toStrictEqual({ kind: 'verb', verbId: DEV_MODE_EVENTS_CLEAR_VERB_ID });
    expect(root.keys.i).toStrictEqual({ kind: 'verb', verbId: DEV_MODE_SEARCH_FOCUS_VERB_ID });
    expect(root.keys.b).toStrictEqual({ kind: 'verb', verbId: DEV_MODE_STATES_ALL_VERB_ID });
    expect(root.keys.v).toStrictEqual({
      kind: 'verb',
      verbId: DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
    });

    const deps = dispatchHarness();
    for (const verbId of BOUND_VERB_IDS) {
      expect(
        devModeSurface.verbs.some((verb) => verb.id === verbId),
        verbId,
      ).toBe(true);
      const result = await dispatch(deps, {
        verbId,
        args: {},
        channel: 'keyboard',
        actor: 'human',
      });
      // Every bound verb reaches its implementation (a performed navigation or a
      // documented no-op) — never a rejection (unknown/unavailable/invalid-args).
      expect(result.status, verbId).not.toBe('rejected');
    }
  });
});
