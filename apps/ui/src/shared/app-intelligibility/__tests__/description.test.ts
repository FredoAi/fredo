/**
 * Spec #3244 ST-1 — the resolved `AppDescription` + the typed `noDescription`
 * failure (R-1a/R-1b/R-2a).
 *
 * Pins the ONE resolver seam over the two declaration sites (a built-in feature
 * class OR an installed-app entry), and the failure contract: a missing OR blank
 * description yields `{kind: 'noDescription', appId}` — never a silent `undefined`
 * and never a placeholder string.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { LuAppWindow } from 'react-icons/lu';

import {
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes/FredoApplicationClass';
import {
  replaceInstalledApp,
  resetInstalledAppsStoreForTests,
} from '@/shared/installed-apps/store';
import type { InstalledAppEntry } from '@/shared/installed-apps/types';

import { resolveAppDescription } from '../description';

/** Minimal concrete built-in feature — only the fields the resolver reads. */
class StubFeature extends FredoApplicationClass {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon = LuAppWindow;

  constructor(id: string, name: string, description: string) {
    super();
    this.id = id;
    this.name = name;
    this.description = description;
  }

  render(): ReactElement {
    return null as unknown as ReactElement;
  }
}

function installedEntry(id: string, displayName: string, description?: string): InstalledAppEntry {
  const base: InstalledAppEntry = {
    id,
    displayName,
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    installedAt: '2026-01-01T00:00:00Z',
    windowLabel: `installed-${id}`,
    state: 'working',
    capabilities: { appId: id, declared: [], highRisk: [], consented: [] },
  };
  return description === undefined ? base : { ...base, description };
}

beforeEach(() => {
  resetApplicationRegistryForTests();
  resetInstalledAppsStoreForTests();
});

afterEach(() => {
  resetApplicationRegistryForTests();
  resetInstalledAppsStoreForTests();
});

describe('resolveAppDescription — the two declaration sites (R-1a/R-2a)', () => {
  it('resolves a built-in feature to a non-empty description (origin built-in)', () => {
    registerApplication(new StubFeature('terminal', 'Terminal', 'Run shell commands.'));

    const resolution = resolveAppDescription('terminal');
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(resolution.origin).toBe('built-in');
    expect(resolution.description).toEqual({
      appId: 'terminal',
      name: 'Terminal',
      description: 'Run shell commands.',
    });
  });

  it('resolves an installed app to a non-empty description (origin installed)', () => {
    replaceInstalledApp(installedEntry('dev.example.tools', 'Example Tools', 'A helpful tool.'));

    const resolution = resolveAppDescription('dev.example.tools');
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(resolution.origin).toBe('installed');
    expect(resolution.description.description).toBe('A helpful tool.');
    expect(resolution.description.name).toBe('Example Tools');
  });
});

describe('resolveAppDescription — the typed failure (R-1b / AC-1)', () => {
  it('an installed app with an ABSENT description key is noDescription', () => {
    replaceInstalledApp(installedEntry('no.desc', 'No Description App'));

    const resolution = resolveAppDescription('no.desc');
    expect(resolution).toEqual({ kind: 'noDescription', appId: 'no.desc' });
  });

  it('an installed app with a BLANK description is noDescription (blank counts as missing)', () => {
    replaceInstalledApp(installedEntry('blank', 'Blank App', '   '));

    expect(resolveAppDescription('blank')).toEqual({ kind: 'noDescription', appId: 'blank' });
  });

  it('a built-in with a blank description is noDescription', () => {
    registerApplication(new StubFeature('blanky', 'Blanky', ''));

    expect(resolveAppDescription('blanky')).toEqual({ kind: 'noDescription', appId: 'blanky' });
  });

  it('an unknown app id is noDescription (never a silent undefined)', () => {
    expect(resolveAppDescription('ghost')).toEqual({ kind: 'noDescription', appId: 'ghost' });
  });

  it('the failure kind IS the AppOpenReplyKind member `noDescription`', () => {
    const resolution = resolveAppDescription('ghost');
    // Bind the runtime value to the companion reply vocabulary (the failure is
    // surfaced as that reply kind — never a new install-refusal code).
    const kind: 'noDescription' = resolution.kind as 'noDescription';
    expect(kind).toBe('noDescription');
  });
});
