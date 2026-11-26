/**
 * Spec #3244 ST-5 — the companion's target-ref list spans BOTH registries.
 *
 * Pins the capsule's contract:
 *   1. A BUILT-IN application is projected unchanged (`id`/`name`/`showable`).
 *   2. An INSTALLED application is projected (`id`, `displayName` as `name`) and
 *      is targetable — the AC-2 gap this capsule closes; `disabled` is not.
 *   3. The SEPARATE-store invariant holds: projecting installed apps never
 *      touches `getApplications()` (R-2a, the pinned 8-id set).
 *   4. The ONE pure matcher resolves an installed app by id AND by whole-word
 *      display name over this list — with no per-app branch anywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import {
  getApplications,
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes/FredoApplicationClass';
import type { InstalledAppEntry } from '@/shared/installed-apps/types';
import {
  readCompanionAppRefs,
  isInstalledAppTargetable,
} from '@/shared/installed-apps/companionTargetRefs';
import { recordInstalledApp, resetInstalledAppsStoreForTests } from '@/shared/installed-apps/store';
import { resolveNamedAppMention } from '@/shared/companion/composerTarget';

// `readCompanionAppRefs` only reads the module-scoped registry, so the client
// (the backend seam) is never touched; the store is driven directly.
vi.mock('@/shared/installed-apps/client', () => ({
  listInstalledApps: vi.fn(async () => []),
  installedAppErrorFrom: vi.fn(() => ({ code: 'io_error', detail: 'unknown' })),
}));

/** Minimal concrete built-in feature (mirrors the dedupe-test stub). */
class FakeFeature extends FredoApplicationClass {
  constructor(readonly id: string, readonly name: string) {
    super();
  }
  readonly description = 'A test application.';
  readonly icon = (() => null) as unknown as FredoApplicationClass['icon'];
  render(): ReactElement {
    return null as unknown as ReactElement;
  }
}

function installedEntry(over: Partial<InstalledAppEntry> = {}): InstalledAppEntry {
  return {
    id: 'dev.example.tools',
    displayName: 'Example Tools',
    version: '1.0.0',
    enginesFredo: '^0.1.0',
    installedAt: '2026-01-01T00:00:00Z',
    windowLabel: 'installed-dev.example.tools',
    state: 'working',
    capabilities: {
      appId: 'dev.example.tools',
      declared: [],
      highRisk: [],
      consented: [],
    },
    ...over,
  };
}

beforeEach(() => {
  resetApplicationRegistryForTests();
  resetInstalledAppsStoreForTests();
});

afterEach(() => {
  resetApplicationRegistryForTests();
  resetInstalledAppsStoreForTests();
});

describe('readCompanionAppRefs — built-in + installed in ONE narrow view', () => {
  it('projects a built-in feature unchanged', () => {
    registerApplication(new FakeFeature('wireframe', 'Wireframe'));

    const refs = readCompanionAppRefs();
    expect(refs).toEqual([
      { id: 'wireframe', name: 'Wireframe', showable: expect.any(Boolean) },
    ]);
  });

  it('projects an installed application (id + displayName) with no per-app work', () => {
    recordInstalledApp(installedEntry());

    const refs = readCompanionAppRefs();
    expect(refs).toEqual([
      { id: 'dev.example.tools', name: 'Example Tools', showable: true },
    ]);
  });

  it('keeps a disabled installed application out of the targetable set', () => {
    recordInstalledApp(installedEntry({ state: 'disabled' }));

    const refs = readCompanionAppRefs();
    expect(refs[0]?.showable).toBe(false);
    expect(isInstalledAppTargetable(installedEntry({ state: 'disabled' }))).toBe(false);
    // A `failing` record is a claim about the host's record, not a usable-app
    // claim (G-475), so it stays targetable.
    expect(isInstalledAppTargetable(installedEntry({ state: 'failing' }))).toBe(true);
  });

  it('does NOT let an installed app join the built-in registry (separate store)', () => {
    registerApplication(new FakeFeature('wireframe', 'Wireframe'));
    recordInstalledApp(installedEntry());

    // The pinned built-in set is untouched by an installed record.
    expect(getApplications().map((app) => app.id)).toEqual(['wireframe']);
    // But the companion target list sees BOTH.
    expect(readCompanionAppRefs().map((ref) => ref.id)).toEqual([
      'wireframe',
      'dev.example.tools',
    ]);
  });
});

describe('the ONE pure matcher resolves an installed app with no per-app branch', () => {
  it('matches an installed app by id and by whole-word display name', () => {
    registerApplication(new FakeFeature('wireframe', 'Wireframe'));
    recordInstalledApp(installedEntry({ id: 'qa3244-untaught', displayName: 'Sample Reader' }));

    const refs = readCompanionAppRefs();
    expect(resolveNamedAppMention('open qa3244-untaught please', refs)).toBe('qa3244-untaught');
    expect(resolveNamedAppMention('use Sample Reader now', refs)).toBe('qa3244-untaught');
    // A built-in still resolves through the SAME list.
    expect(resolveNamedAppMention('change the wireframe', refs)).toBe('wireframe');
  });

  it('still returns null for an unknown name over the combined list', () => {
    recordInstalledApp(installedEntry());
    expect(resolveNamedAppMention('open Narnia', readCompanionAppRefs())).toBeNull();
  });
});
