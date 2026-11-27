/**
 * Spec #3244 ST-3 — the frontend capture call (R-2b / R-3a).
 *
 * Pins the ONE capture seam's contract:
 *   - a built-in target's rect is derived from the DOM with the shipped recipe;
 *   - an installed target's rect comes from the HOST (`installed_app_screen_rect`);
 *   - both converge on `capture_target_region`, FRESH on every call; and
 *   - an unknown id / a not-open installed app is a typed `null`, never a wrong
 *     capture and never a throw.
 *
 * The branch is on the app's ORIGIN, never its id — a per-app branch would make
 * AC-2's "no per-app enablement" false.
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
import { adapterBridge } from '@/shared/utils/adapterBridge';

import { captureTargetRegion } from '../captureTarget';

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

function installedEntry(id: string, displayName: string, description: string): InstalledAppEntry {
  return {
    id,
    displayName,
    description,
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    installedAt: '2026-01-01T00:00:00Z',
    windowLabel: `installed-${id}`,
    state: 'working',
    capabilities: { appId: id, declared: [], highRisk: [], consented: [] },
  };
}

interface Call {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

/** Register an invoke stub that records calls and answers per-command. */
function stubInvoke(answers: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  adapterBridge.setInvoke(async (command, args) => {
    calls.push({ command, args });
    return answers[command];
  });
  return calls;
}

/** Mount an in-window app root whose rect is `left/top/width/height` CSS px. */
function mountInWindowRoot(
  appId: string,
  geometry: { left: number; top: number; width: number; height: number },
): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-fredo-app-id', appId);
  root.getBoundingClientRect = () =>
    ({
      left: geometry.left,
      top: geometry.top,
      width: geometry.width,
      height: geometry.height,
      right: geometry.left + geometry.width,
      bottom: geometry.top + geometry.height,
      x: geometry.left,
      y: geometry.top,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(root);
  return root;
}

/** The shipped CSS→physical recipe, re-applied here as the expected value. */
function physical(left: number, top: number, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round((window.screenX + left) * dpr),
    y: Math.round((window.screenY + top) * dpr),
    width: Math.round(width * dpr),
    height: Math.round(height * dpr),
  };
}

beforeEach(() => {
  resetApplicationRegistryForTests();
  resetInstalledAppsStoreForTests();
});

afterEach(() => {
  resetApplicationRegistryForTests();
  resetInstalledAppsStoreForTests();
  document.body.innerHTML = '';
});

describe('captureTargetRegion — target rect resolution (R-2b)', () => {
  it('derives an in-window built-in rect from the DOM and captures it', async () => {
    registerApplication(new StubFeature('terminal', 'Terminal', 'Run shell commands.'));
    mountInWindowRoot('terminal', { left: 10, top: 20, width: 200, height: 100 });
    const calls = stubInvoke({ capture_target_region: 'BASE64' });

    const result = await captureTargetRegion('terminal');

    expect(calls).toEqual([
      { command: 'capture_target_region', args: { rect: physical(10, 20, 200, 100) } },
    ]);
    expect(result).toEqual({ screenshotPngBase64: 'BASE64' });
  });

  it('resolves an installed-app rect from the HOST, then captures it', async () => {
    replaceInstalledApp(installedEntry('dev-example-tools', 'Example Tools', 'A helpful tool.'));
    const calls = stubInvoke({
      installed_app_screen_rect: { x: 100, y: 200, width: 900, height: 600 },
      capture_target_region: 'SHOT',
    });

    const result = await captureTargetRegion('dev-example-tools');

    expect(calls.map((call) => call.command)).toEqual([
      'installed_app_screen_rect',
      'capture_target_region',
    ]);
    expect(calls[0]!.args).toEqual({ appId: 'dev-example-tools' });
    expect(calls[1]!.args).toEqual({ rect: { x: 100, y: 200, width: 900, height: 600 } });
    expect(result).toEqual({ screenshotPngBase64: 'SHOT' });
  });
});

describe('captureTargetRegion — typed "nothing to capture" (R-2c)', () => {
  it('returns null for an unknown app id and never invokes a command', async () => {
    const calls = stubInvoke({});
    expect(await captureTargetRegion('ghost')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when an installed app is not open (the host reports no rect)', async () => {
    replaceInstalledApp(installedEntry('dev-example-tools', 'Example Tools', 'A helpful tool.'));
    const calls = stubInvoke({ installed_app_screen_rect: null });

    expect(await captureTargetRegion('dev-example-tools')).toBeNull();
    expect(calls.map((call) => call.command)).toEqual(['installed_app_screen_rect']);
  });

  it('returns null when the in-window root is not mounted (e.g. own-window built-in)', async () => {
    registerApplication(new StubFeature('terminal', 'Terminal', 'Run shell commands.'));
    const calls = stubInvoke({ capture_target_region: 'BASE64' });

    expect(await captureTargetRegion('terminal')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('captureTargetRegion — freshness (R-3a)', () => {
  it('captures FRESH on every call, reflecting the current rect — never a cache', async () => {
    registerApplication(new StubFeature('terminal', 'Terminal', 'Run shell commands.'));
    const root = mountInWindowRoot('terminal', { left: 0, top: 0, width: 100, height: 50 });

    const rects: unknown[] = [];
    let shot = 0;
    adapterBridge.setInvoke(async (command, args) => {
      if (command === 'capture_target_region') {
        rects.push(args?.rect);
        return `SHOT${++shot}`;
      }
      return undefined;
    });

    const first = await captureTargetRegion('terminal');
    // A visible screen change moves the target between the two turns.
    root.getBoundingClientRect = () =>
      ({
        left: 40,
        top: 0,
        width: 100,
        height: 50,
        right: 140,
        bottom: 50,
        x: 40,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const second = await captureTargetRegion('terminal');

    expect(rects).toEqual([physical(0, 0, 100, 50), physical(40, 0, 100, 50)]);
    expect(first).toEqual({ screenshotPngBase64: 'SHOT1' });
    expect(second).toEqual({ screenshotPngBase64: 'SHOT2' });
  });
});
