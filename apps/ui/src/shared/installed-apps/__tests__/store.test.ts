/**
 * Spec #3147 ST-6 — the installed-app registry is a SEPARATE, module-scoped store.
 *
 * Pins three contracts the plan calls out:
 *   1. `recordInstalledApp` + `refreshInstalledApps` drive a module-scoped list
 *      (survives unmount; newest-first) with a real subscription channel.
 *   2. Recording an installed app does NOT change `getApplications()` — the
 *      pinned built-in set is untouched (R-2.3 / T-2.4).
 *   3. A failed list read is a `list-load-failed` verdict, never an empty list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getApplications,
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import type { InstalledAppEntry } from '@/shared/installed-apps/types';
import {
  getInstalledApps,
  getInstalledAppsListError,
  forgetInstalledApp,
  isInstalledAppsLoading,
  isInstalledAppsSettled,
  recordInstalledApp,
  refreshInstalledApps,
  replaceInstalledApp,
  resetInstalledAppsStoreForTests,
  subscribeInstalledApps,
} from '@/shared/installed-apps/store';

const listMock = vi.hoisted(() => ({ current: vi.fn() }));

vi.mock('@/shared/installed-apps/client', () => ({
  listInstalledApps: (...args: unknown[]) => listMock.current(...args),
  installedAppErrorFrom: (rejection: unknown) => {
    if (
      rejection !== null &&
      typeof rejection === 'object' &&
      typeof (rejection as { code?: unknown }).code === 'string'
    ) {
      return rejection as { code: string; detail: string };
    }
    return { code: 'io_error', detail: 'unknown' };
  },
}));

function entry(over: Partial<InstalledAppEntry> = {}): InstalledAppEntry {
  return {
    id: 'dev.example.tools',
    displayName: 'Example Tools',
    version: '1.2.0',
    enginesFredo: '^0.1.0',
    installedAt: '2026-01-01T00:00:00Z',
    windowLabel: 'installed-dev.example.tools',
    state: 'working',
    capabilities: { appId: 'dev.example.tools', declared: [], highRisk: [], consented: [] },
    ...over,
  };
}

beforeEach(() => {
  resetInstalledAppsStoreForTests();
  resetApplicationRegistryForTests();
  listMock.current = vi.fn(async () => []);
});

afterEach(() => {
  resetInstalledAppsStoreForTests();
  resetApplicationRegistryForTests();
});

describe('#3147 ST-6 — the separate installed-app store', () => {
  it('records a new app at the top and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInstalledApps(listener);

    recordInstalledApp(entry({ id: 'older', installedAt: '2026-01-01T00:00:00Z' }));
    recordInstalledApp(entry({ id: 'newer', installedAt: '2026-02-01T00:00:00Z' }));

    expect(listener).toHaveBeenCalledTimes(2);
    expect(getInstalledApps().map((e) => e.id)).toEqual(['newer', 'older']);

    unsubscribe();
  });

  it('a re-record of the same id updates in place (never a duplicate row)', () => {
    recordInstalledApp(entry({ id: 'dup', version: '1.0.0' }));
    recordInstalledApp(entry({ id: 'dup', version: '2.0.0' }));

    const rows = getInstalledApps();
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe('2.0.0');
  });

  it('refresh reads through the client and sorts newest first', async () => {
    listMock.current = vi.fn(async () => [
      entry({ id: 'a', installedAt: '2026-01-01T00:00:00Z' }),
      entry({ id: 'b', installedAt: '2026-03-01T00:00:00Z' }),
    ]);

    await refreshInstalledApps();

    expect(getInstalledApps().map((e) => e.id)).toEqual(['b', 'a']);
    expect(getInstalledAppsListError()).toBeNull();
    expect(isInstalledAppsSettled()).toBe(true);
    expect(isInstalledAppsLoading()).toBe(false);
  });

  it('a failed list read is a list-load-failed verdict, not an empty list', async () => {
    recordInstalledApp(entry({ id: 'kept' }));
    listMock.current = vi.fn(async () => {
      throw { code: 'io_error', detail: 'the registry could not be read' };
    });

    await refreshInstalledApps();

    const error = getInstalledAppsListError();
    expect(error).not.toBeNull();
    expect(error?.code).toBe('io_error');
    // The previously-known entry survives a transient read failure.
    expect(getInstalledApps().map((e) => e.id)).toEqual(['kept']);
    expect(isInstalledAppsSettled()).toBe(true);
  });

  it('refresh sets the loading flag while the read is in flight', async () => {
    let release: (() => void) | undefined;
    listMock.current = vi.fn(
      () =>
        new Promise<InstalledAppEntry[]>((resolve) => {
          release = () => resolve([]);
        }),
    );

    const pending = refreshInstalledApps();
    expect(isInstalledAppsLoading()).toBe(true);
    release?.();
    await pending;
    expect(isInstalledAppsLoading()).toBe(false);
  });

  it('records an installed app WITHOUT touching the built-in application registry', () => {
    // Seed the built-in registry with one stand-in feature so the assertion is
    // non-vacuous (an empty registry would pass no matter what the store did).
    const builtIn = { id: 'terminal' } as unknown as Parameters<typeof registerApplication>[0];
    registerApplication(builtIn);
    const before = getApplications().map((feature) => feature.id);
    expect(before).toEqual(['terminal']);

    recordInstalledApp(entry({ id: 'third.party.app' }));
    recordInstalledApp(entry({ id: 'another.third.party' }));

    expect(getInstalledApps()).toHaveLength(2);
    // The built-in registry is untouched: an installed app is a second trust tier
    // and must never join the pinned set (`retainedApplicationSet.test.ts`).
    expect(getApplications().map((feature) => feature.id)).toEqual(before);
  });
});

describe('#3144 — replaceInstalledApp / forgetInstalledApp (the management store verbs)', () => {
  it('replaceInstalledApp upserts by id in place (never a duplicate, no reorder on state change)', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInstalledApps(listener);
    recordInstalledApp(entry({ id: 'a', installedAt: '2026-01-01T00:00:00Z' }));
    recordInstalledApp(entry({ id: 'b', installedAt: '2026-02-01T00:00:00Z' }));
    expect(getInstalledApps().map((e) => e.id)).toEqual(['b', 'a']);
    listener.mockClear();

    // A disable returns the same id with a new state — an in-place update.
    replaceInstalledApp(entry({ id: 'a', installedAt: '2026-01-01T00:00:00Z', state: 'disabled' }));

    const rows = getInstalledApps();
    expect(rows.map((e) => e.id)).toEqual(['b', 'a']);
    expect(rows.find((e) => e.id === 'a')?.state).toBe('disabled');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('replaceInstalledApp records a net-new id at the top', () => {
    recordInstalledApp(entry({ id: 'a', installedAt: '2026-01-01T00:00:00Z' }));
    replaceInstalledApp(entry({ id: 'z', installedAt: '2026-03-01T00:00:00Z' }));
    expect(getInstalledApps().map((e) => e.id)).toEqual(['z', 'a']);
  });

  it('forgetInstalledApp drops the row and notifies', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInstalledApps(listener);
    recordInstalledApp(entry({ id: 'a' }));
    recordInstalledApp(entry({ id: 'b' }));
    listener.mockClear();

    forgetInstalledApp('a');

    expect(getInstalledApps().map((e) => e.id)).toEqual(['b']);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('forgetInstalledApp is a no-op (no notify) for an id that is not present', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInstalledApps(listener);
    recordInstalledApp(entry({ id: 'a' }));
    listener.mockClear();

    forgetInstalledApp('not-there');

    expect(getInstalledApps().map((e) => e.id)).toEqual(['a']);
    // The version counter advances only on a real mutation (the store's contract).
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
