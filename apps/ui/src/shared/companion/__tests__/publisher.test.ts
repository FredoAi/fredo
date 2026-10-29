/**
 * Companion manifest publisher (Spec #3099, ST-2).
 *
 * Pins:
 *   - one invoke per task (coalesced via queueMicrotask);
 *   - SKIP while the application registry is empty;
 *   - SKIP when the serialized manifest is unchanged;
 *   - publish on registration (subscription);
 *   - a failed invoke never throws and is retried by the next registration;
 *   - idempotent install (ref-counted) so a remount cannot double publish;
 *   - `adapterBridge` only — no static `@tauri-apps/api` import.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { FredoApplicationClass } from '@/shared/classes';
import type {
  ApplicationCommandSpec,
  ApplicationCommandSurface,
} from '@/shared/hotkeys/commandSurface';
import {
  REGISTER_APP_COMMAND_SURFACES_COMMAND,
  collectCompanionManifest,
  installAppCommandSurfacePublisher,
  publishAppCommandSurfaces,
  resetAppCommandPublisherForTests,
} from '../publisher';

function command(id: string): ApplicationCommandSpec {
  return { id, title: id, description: `Do ${id}`, args: [], run: () => true };
}

function feature(id: string, suffix: string): FredoApplicationClass {
  const commandSurface: ApplicationCommandSurface = {
    modes: [],
    commands: [command(`${id}.${suffix}`)],
    companion: { description: `${id} directive.` },
  };
  return { id, name: id, commandSurface } as unknown as FredoApplicationClass;
}

/** Let the coalesced microtask + the awaited invoke settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAppCommandPublisherForTests();
  resetApplicationRegistryForTests();
  invoke = vi.fn().mockResolvedValue(undefined);
  adapterBridge.setInvoke(invoke);
});

afterEach(() => {
  resetAppCommandPublisherForTests();
  resetApplicationRegistryForTests();
  vi.restoreAllMocks();
});

describe('publishAppCommandSurfaces', () => {
  it('sends the wire shape { manifest: { surfaces } }', async () => {
    registerApplication(feature('alpha', 'one'));

    await publishAppCommandSurfaces();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(REGISTER_APP_COMMAND_SURFACES_COMMAND, {
      manifest: collectCompanionManifest(),
    });
  });

  it('does not publish while the registry is empty', async () => {
    await publishAppCommandSurfaces();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not re-send an identical manifest', async () => {
    registerApplication(feature('alpha', 'one'));

    await publishAppCommandSurfaces();
    await publishAppCommandSurfaces();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('swallows an invoke failure and retries on the next attempt', async () => {
    registerApplication(feature('alpha', 'one'));
    invoke.mockRejectedValueOnce(new Error('host offline'));

    await expect(publishAppCommandSurfaces()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);

    // The watermark was NOT advanced, so the same manifest is retried.
    await publishAppCommandSurfaces();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('installAppCommandSurfacePublisher', () => {
  it('coalesces a burst of registrations into ONE invoke per task', async () => {
    installAppCommandSurfacePublisher();

    registerApplication(feature('alpha', 'one'));
    registerApplication(feature('beta', 'one'));
    registerApplication(feature('gamma', 'one'));

    await flush();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(REGISTER_APP_COMMAND_SURFACES_COMMAND, {
      manifest: collectCompanionManifest(),
    });
  });

  it('publishes once at install when applications are already registered', async () => {
    registerApplication(feature('alpha', 'one'));

    installAppCommandSurfacePublisher();
    await flush();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not publish at install while the registry is empty', async () => {
    installAppCommandSurfacePublisher();
    await flush();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('publishes on a later registration', async () => {
    installAppCommandSurfacePublisher();
    await flush();
    expect(invoke).not.toHaveBeenCalled();

    registerApplication(feature('alpha', 'one'));
    await flush();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('skips a duplicate registration that yields an identical manifest', async () => {
    installAppCommandSurfacePublisher();
    const alpha = feature('alpha', 'one');

    registerApplication(alpha);
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);

    // Bundle mocks register twice; the builder de-dupes, so the manifest is
    // unchanged and must not be re-sent.
    registerApplication(alpha);
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('is idempotent by ref count across a remount', async () => {
    const releaseFirst = installAppCommandSurfacePublisher();
    const releaseSecond = installAppCommandSurfacePublisher();

    registerApplication(feature('alpha', 'one'));
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);

    // One install remains: still subscribed.
    releaseFirst();
    registerApplication(feature('beta', 'one'));
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);

    // Last release unsubscribes: no further publishes.
    releaseSecond();
    registerApplication(feature('gamma', 'one'));
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('publisher source', () => {
  it('uses adapterBridge — no static @tauri-apps/api import', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/shared/companion/publisher.ts'),
      'utf8',
    );

    expect(source).toMatch(/\badapterBridge\b/);
    expect(source).not.toMatch(/from\s+['"]@tauri-apps\/api/);
    expect(source).not.toMatch(/import\s*\(\s*['"]@tauri-apps\/api/);
  });
});
