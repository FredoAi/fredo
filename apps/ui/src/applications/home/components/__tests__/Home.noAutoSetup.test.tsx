/**
 * Spec #3010 workstream A (ST-3) — the continuous no-auto-open regression pin.
 *
 * The removed #3010 ST-1 behavior: on every Home mount, an effect read the
 * never-written `plugin_installed` setting and — because that read is always
 * falsy — scheduled a 1200 ms timer that opened the standalone `setup` feature
 * window. Launching Fredo therefore interrupted the user with a Setup wizard
 * they did not request, on *every* launch.
 *
 * This pin mounts the REAL `Home` desktop in an isolated harness (the heavy
 * window-system / feature / companion seams are mocked, following the
 * `LauncherShell.openApps.test.tsx` pattern) and holds the invariant
 * CONTINUOUSLY across the former timer horizon:
 *
 *   (a) no window is opened on mount — and specifically no Setup window — even
 *       after advancing fake timers well past 1200 ms;
 *   (b) `settingsService.get` is NEVER called with `'plugin_installed'` — the
 *       setting has zero readers on the Home boot path.
 *
 * `plugin_installed` is deliberately left unset (the falsy condition that used
 * to fire): if the gate is ever reintroduced, leg (b) fails, and the 1200 ms
 * timer would call `openWindow`, failing leg (a).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

// Shared spies via vi.hoisted so the (also-hoisted) vi.mock factories can close
// over them. Kept at module scope so the test asserts on them directly.
const spies = vi.hoisted(() => ({
  openWindow: vi.fn(),
  closeWindow: vi.fn(),
  updateWindow: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  openApp: vi.fn(),
  showMessage: vi.fn(),
  enterDoomMode: vi.fn(),
  activateProvision: vi.fn(),
}));

// ── Window-system seams ───────────────────────────────────────────────────────
// Home's full-lifecycle `openFeatureWindow` calls `useWindowActions().openWindow`.
// The removed auto-open reached it after the 1200 ms timer, so this spy is the
// exact observable of "a window opened".
vi.mock('@/shared/window-system/useWindowActions', () => ({
  useWindowActions: () => ({
    openWindow: spies.openWindow,
    closeWindow: spies.closeWindow,
    updateWindow: spies.updateWindow,
  }),
}));

// Home renders <WindowSystemProvider> itself; a passthrough keeps the harness
// host-agnostic (no real window-state machinery).
vi.mock('@/shared/window-system/WindowSystemProvider', () => ({
  WindowSystemProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@/shared/window-system/WindowManager', () => ({ WindowManager: () => null }));

// Boot hydration is a no-op here (it has its own store suites).
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
vi.mock('@/applications/doom/DoomProvisionDialog', () => ({
  DoomProvisionDialog: () => null,
}));
vi.mock('@/applications/home/hooks/useAppOpenRequests', () => ({
  useAppOpenRequests: vi.fn(),
}));
vi.mock('@/applications/my-workitems', () => ({
  myWorkItemsFeature: { id: 'my-workitems' },
  createWorkItemFeature: { id: 'create-workitem' },
}));
vi.mock('@/applications/dev-mode', () => ({ devModeFeature: { id: 'dev-mode' } }));
vi.mock('@/applications/allApplications', () => ({}));
vi.mock('@/shared/application-data/registry', () => ({
  declareAllRegisteredApplicationData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/applications/applicationRegistry', () => ({
  getApplications: () => [],
  dedupeByApplicationId: (features: unknown[]) => features,
  // Present so a re-added feature import (e.g. the removed `setup` gate) loads
  // cleanly and FAILS ON THE ASSERTIONS rather than crashing at collection.
  registerApplication: vi.fn(),
}));

// The singleton settings seam. If a future edit re-introduces the auto-open gate
// (reading `plugin_installed` from Home), this mock records the read and the
// regression pin fails. `plugin_installed` is intentionally read as unset.
vi.mock('@/applications/settings', () => ({
  settingsService: { get: spies.get, set: spies.set },
}));

vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => ({ showMessage: spies.showMessage }),
}));
vi.mock('@/shared/hooks/useKonamiCode', () => ({ useKonamiCode: vi.fn() }));
vi.mock('@/shared/hooks/useSecretCode', () => ({ useSecretCode: vi.fn() }));
vi.mock('@/shared/doom-mode', () => ({
  DOOM_SECRET_CODE: 'iddqd',
  useDoomMode: () => ({ enter: spies.enterDoomMode }),
  useDoomModeSkill: vi.fn(),
  useDoomProvision: () => ({ activate: spies.activateProvision }),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted regardless) — the
// established pattern in `background.invariants.test.tsx`.
import { Home } from '@/applications/home/components/Home';

/** The former auto-open fired 1200 ms after mount; advance well past it. */
const FORMER_AUTO_OPEN_HORIZON_MS = 1200;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // `plugin_installed` is unset: any read resolves falsy — the exact condition
  // that used to trigger the auto-open.
  spies.get.mockResolvedValue('');
  spies.set.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Home boot — continuous no-auto-open (Spec #3010 ST-1 regression pin)', () => {
  it('opens NO window and never reads `plugin_installed`, even past 1200 ms', async () => {
    const { container } = renderWithChakra(<Home />);
    expect(container).toBeTruthy();

    // Flush mount effects + microtasks and run every timer well past the former
    // 1200 ms auto-open horizon (the greet timer at 800 ms also elapses).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FORMER_AUTO_OPEN_HORIZON_MS + 800);
    });

    // (a) No window opened at all — in particular no Setup window.
    expect(spies.openWindow).not.toHaveBeenCalled();
    expect(
      spies.openWindow.mock.calls.every(
        (call) => (call[0] as { id?: string } | undefined)?.id !== 'setup',
      ),
    ).toBe(true);

    // (b) `plugin_installed` has ZERO readers on the boot path.
    expect(spies.get).not.toHaveBeenCalledWith('plugin_installed', expect.anything());
    expect(spies.get.mock.calls.some((call) => call[0] === 'plugin_installed')).toBe(false);
  });
});
