/**
 * #2868 ST-4 (G-123) — the continuous window dedup / focus / restore contract
 * for the Settings feature app.
 *
 * ST-1 established the `SettingsFeature` singleton and the store-level
 * invariants are covered by `shared/window-system/__tests__/windowStore.test.ts`.
 * This suite owns the *feature-level* contract the plan freezes:
 *
 *  - R-1a/R-1b: `settingsFeature` is the stable, launcher-visible app identity
 *    the launcher grid and the window kernel key on (`id='settings'`,
 *    `name='Settings'`, `icon=LuSettings`, `showable`, singleton, the default
 *    `gridConfig` = closable + maximizable).
 *  - R-2b: WHILE the Settings window is open, re-invoking through the launcher
 *    tile path (`openWindow` with the feature's own params) RAISES and FOCUSES
 *    the existing `'settings'` entry and never appends a second one.
 *  - R-2c: a minimized Settings window is restored (un-minimized) and focused
 *    when re-invoked.
 *
 * It imports and drives the REAL module-scoped `windowStore` (no mock) so the
 * assertion spans the feature contract and the integration expectation exactly
 * as `Home.tsx`/`LauncherShell` drive them. It does NOT modify or re-test the
 * store's own internals.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LuSettings } from 'react-icons/lu';

// The section barrels are stubbed so importing the feature (which transitively
// pulls `SettingsSurface`) does not evaluate the host `Home.tsx` module at
// import time. This suite asserts the feature identity + the real windowStore
// contract and never renders a section — the section contracts are owned by
// their own suites (the ST-1 zero-section suite mocks the same barrels).
vi.mock('@/features/theming', () => ({ ThemingSettings: () => null }));
vi.mock('@/features/setup', () => ({ SetupWizard: () => null }));
vi.mock('@/features/home', () => ({
  TelemetrySettings: () => null,
  DockPositionSettings: () => null,
}));
vi.mock('@/shared/components/companion/CompanionSettingsPanel', () => ({
  CompanionSettingsPanel: () => null,
}));

import { settingsFeature } from '../SettingsFeature';
import {
  focusWindow,
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';
import type { OpenWindowParams } from '@/shared/window-system/windowTypes';

/**
 * The exact `OpenWindowParams` `Home.openFeatureWindow` builds for a feature
 * (`Home.tsx:88-97`): id/title/icon from the singleton, control flags from
 * `gridConfig`, opened maximized like Mission Monitor.
 */
function settingsWindowParams(overrides: Partial<OpenWindowParams> = {}): OpenWindowParams {
  return {
    id: settingsFeature.id,
    title: settingsFeature.name,
    icon: settingsFeature.icon,
    component: settingsFeature.render(),
    canClose: settingsFeature.gridConfig.closable,
    canMaximize: settingsFeature.gridConfig.maximizable,
    canMinimize: true,
    isMaximized: true,
    ...overrides,
  };
}

/** Snapshot as a plain array so the module-scoped store never leaks between tests. */
function snap(): ReturnType<typeof getWindowSnapshot> {
  return [...getWindowSnapshot()];
}

beforeEach(() => resetWindowStoreForTests());

describe('#2868 ST-4 — SettingsFeature app identity (R-1a / R-1b)', () => {
  it('exposes the stable id/name/icon the launcher tile + window kernel key on', () => {
    expect(settingsFeature.id).toBe('settings');
    expect(settingsFeature.name).toBe('Settings');
    expect(settingsFeature.icon).toBe(LuSettings);
  });

  it('is a showable singleton with no nested settings panel', () => {
    expect(settingsFeature.showable).toBe(true);
    expect(settingsFeature.isMultiWindow).toBe(false);
    expect(settingsFeature.hasSettings).toBe(false);
  });

  it('inherits the default gridConfig (closable + maximizable)', () => {
    expect(settingsFeature.gridConfig).toEqual({ closable: true, maximizable: true });
  });
});

describe('#2868 ST-4 — re-invoke focuses without duplication (R-2b)', () => {
  it('opening the Settings window twice yields ONE focused, un-minimized entry', () => {
    openWindow(settingsWindowParams());
    openWindow(settingsWindowParams()); // re-invoke while the window is open

    const all = snap();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('settings');
    expect(all[0].focused).toBe(true);
    expect(all[0].isMinimized).toBe(false);
  });

  it('raises the existing Settings entry to the top on re-invoke (no second entry)', () => {
    openWindow(settingsWindowParams());
    openWindow(
      settingsWindowParams({
        id: 'mission-monitor',
        title: 'Mission Monitor',
        icon: settingsFeature.icon,
      }),
    );
    // 'mission-monitor' is on top now — re-invoking Settings must raise Settings.
    expect(snap().find((w) => w.id === 'mission-monitor')!.focused).toBe(true);

    openWindow(settingsWindowParams());

    const all = snap();
    const settingsEntries = all.filter((w) => w.id === 'settings');
    const settings = settingsEntries[0];
    const other = all.find((w) => w.id === 'mission-monitor')!;
    expect(settingsEntries).toHaveLength(1);
    expect(settings.focused).toBe(true);
    expect(other.focused).toBe(false);
    expect(settings.zIndex).toBeGreaterThan(other.zIndex);
  });
});

describe('#2868 ST-4 — minimized Settings restores on re-invoke (R-2c)', () => {
  it('re-opening a minimized Settings window restores + focuses the single entry', () => {
    openWindow(settingsWindowParams());
    focusWindow('settings', { minimize: true });
    expect(snap().find((w) => w.id === 'settings')!.isMinimized).toBe(true);

    openWindow(settingsWindowParams()); // re-invoke via the launcher tile

    const all = snap();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('settings');
    expect(all[0].isMinimized).toBe(false, 're-invoke restores the minimized window');
    expect(all[0].focused).toBe(true);
  });

  it('focus-based restore clears minimize and raises the same single entry', () => {
    openWindow(settingsWindowParams());
    focusWindow('settings', { minimize: true });

    focusWindow('settings'); // the window-frame restore control path

    const all = snap();
    expect(all).toHaveLength(1);
    expect(all[0].isMinimized).toBe(false);
    expect(all[0].focused).toBe(true);
  });
});
