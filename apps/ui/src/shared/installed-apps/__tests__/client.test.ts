/**
 * Spec #3147 ST-6 — the five command wrappers, and a malformed rejection that
 * cannot crash a pane.
 *
 * The Rust commands return `Result<T, InstalledAppError>`, so a rejection
 * carries the error object. These tests pin:
 *   - the exact command names and argument shapes (they mirror the Rust
 *     signatures — a field-name drift shows up here);
 *   - every wrapper re-throws as a TYPED `InstalledAppsCommandError` carrying one
 *     of the 22 frozen codes;
 *   - `installedAppErrorFrom` narrows ANY caught value (raw wire object, a
 *     string, `null`, an absent-key `field`) into a usable `InstalledAppError`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeInstalledApp,
  disableInstalledApp,
  enableInstalledApp,
  installPackage,
  installedAppErrorFrom,
  InstalledAppsCommandError,
  listInstalledApps,
  openInstalledApp,
  pushTheme,
  removeInstalledApp,
} from '@/shared/installed-apps/client';

const invokeMock = vi.hoisted(() => ({ current: vi.fn() }));

vi.mock('@/shared/utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: (...args: unknown[]) => invokeMock.current(...args),
  },
}));

const ENTRY = {
  id: 'dev.example.tools',
  displayName: 'Example Tools',
  version: '1.2.0',
  enginesFredo: '^0.1.0',
  installedAt: '2026-01-01T00:00:00Z',
  windowLabel: 'installed-dev.example.tools',
  state: 'working',
};

beforeEach(() => {
  invokeMock.current = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('#3147 ST-6 — client command wrappers', () => {
  it('installPackage invokes installed_app_install with no args when the path is absent', async () => {
    invokeMock.current.mockResolvedValue(ENTRY);
    await expect(installPackage()).resolves.toEqual(ENTRY);
    expect(invokeMock.current).toHaveBeenCalledWith('installed_app_install', {});
  });

  it('installPackage forwards a non-blank archivePath, and treats blank as absent', async () => {
    invokeMock.current.mockResolvedValue(ENTRY);
    await installPackage('C:/tmp/pkg.zip');
    expect(invokeMock.current).toHaveBeenCalledWith('installed_app_install', {
      archivePath: 'C:/tmp/pkg.zip',
    });

    invokeMock.current.mockClear();
    await installPackage('   ');
    expect(invokeMock.current).toHaveBeenCalledWith('installed_app_install', {});
  });

  it('listInstalledApps invokes installed_apps_list', async () => {
    invokeMock.current.mockResolvedValue([ENTRY]);
    await expect(listInstalledApps()).resolves.toEqual([ENTRY]);
    expect(invokeMock.current).toHaveBeenCalledWith('installed_apps_list');
  });

  it('listInstalledApps rejects a non-list payload as a typed error (never as "empty")', async () => {
    invokeMock.current.mockResolvedValue({ not: 'a list' });
    await expect(listInstalledApps()).rejects.toBeInstanceOf(InstalledAppsCommandError);
  });

  it('openInstalledApp invokes installed_app_open with appId', async () => {
    invokeMock.current.mockResolvedValue(undefined);
    await openInstalledApp('dev.example.tools');
    expect(invokeMock.current).toHaveBeenCalledWith('installed_app_open', {
      appId: 'dev.example.tools',
    });
  });

  it('closeInstalledApp invokes installed_app_close and coerces the boolean', async () => {
    invokeMock.current.mockResolvedValue(true);
    await expect(closeInstalledApp('x')).resolves.toBe(true);

    invokeMock.current.mockResolvedValue(undefined);
    await expect(closeInstalledApp('x')).resolves.toBe(false);
    expect(invokeMock.current).toHaveBeenCalledWith('installed_app_close', { appId: 'x' });
  });

  it('pushTheme invokes installed_apps_push_theme with the payload', async () => {
    invokeMock.current.mockResolvedValue(undefined);
    const payload = { tokens: [{ name: '--body-bg', value: '#fff' }], colorScheme: 'light' as const };
    await pushTheme(payload);
    expect(invokeMock.current).toHaveBeenCalledWith('installed_apps_push_theme', { payload });
  });

  // ── Spec #3144 — the three management wrappers ─────────────────────────────

  it('disableInstalledApp invokes installed_app_disable with appId and returns the entry', async () => {
    const disabled = { ...ENTRY, state: 'disabled' };
    invokeMock.current.mockResolvedValue(disabled);
    await expect(disableInstalledApp('dev.example.tools')).resolves.toEqual(disabled);
    expect(invokeMock.current).toHaveBeenCalledWith('installed_app_disable', {
      appId: 'dev.example.tools',
    });
  });

  it('enableInstalledApp invokes installed_app_enable with appId and returns the entry', async () => {
    invokeMock.current.mockResolvedValue(ENTRY);
    await expect(enableInstalledApp('dev.example.tools')).resolves.toEqual(ENTRY);
    expect(invokeMock.current).toHaveBeenCalledWith('installed_app_enable', {
      appId: 'dev.example.tools',
    });
  });

  it('removeInstalledApp invokes installed_app_remove with appId and returns the outcome', async () => {
    const outcome = { appId: 'dev.example.tools', removed: true, dataKept: true, dataTables: [] };
    invokeMock.current.mockResolvedValue(outcome);
    await expect(removeInstalledApp('dev.example.tools')).resolves.toEqual(outcome);
    expect(invokeMock.current).toHaveBeenCalledWith('installed_app_remove', {
      appId: 'dev.example.tools',
    });
  });

  it('a management command re-throws a wire refusal as a typed error carrying the frozen code', async () => {
    invokeMock.current.mockRejectedValue({ code: 'io_error', detail: 'the write failed' });
    await expect(disableInstalledApp('x')).rejects.toMatchObject({ code: 'io_error' });
  });

  it('an undefined management result becomes a typed io_error, never a crash', async () => {
    invokeMock.current.mockResolvedValue(undefined);
    await expect(enableInstalledApp('x')).rejects.toMatchObject({ code: 'io_error' });
    await expect(removeInstalledApp('x')).rejects.toMatchObject({ code: 'io_error' });
  });

  it('re-throws a wire refusal as a typed error carrying the frozen code', async () => {
    invokeMock.current.mockRejectedValue({
      code: 'no_manifest',
      detail: 'no fredo-app.json at the archive root',
      field: 'fredo-app.json',
    });

    await expect(installPackage()).rejects.toMatchObject({
      code: 'no_manifest',
      detail: 'no fredo-app.json at the archive root',
      field: 'fredo-app.json',
    });
  });

  it('an undefined adapter result becomes a typed io_error, never a crash', async () => {
    invokeMock.current.mockResolvedValue(undefined);
    await expect(installPackage()).rejects.toMatchObject({ code: 'io_error' });
  });
});

describe('#3147 ST-6 — installedAppErrorFrom narrows any caught value', () => {
  it('narrows a raw wire object with an absent-key field (never sets field)', () => {
    const error = installedAppErrorFrom({ code: 'host_incompatible', detail: 'needs ^0.2' });
    expect(error).toEqual({ code: 'host_incompatible', detail: 'needs ^0.2' });
    expect('field' in error).toBe(false);
  });

  it('keeps a present field string', () => {
    const error = installedAppErrorFrom({
      code: 'manifest_invalid_field',
      detail: 'bad version',
      field: 'version',
    });
    expect(error.field).toBe('version');
  });

  it('falls back to io_error for an unrecognised code, a string, and null', () => {
    expect(installedAppErrorFrom({ code: 'not_a_real_code', detail: 'x' }).code).toBe('io_error');
    expect(installedAppErrorFrom('boom').code).toBe('io_error');
    expect(installedAppErrorFrom(null).code).toBe('io_error');
    expect(installedAppErrorFrom(undefined).code).toBe('io_error');
  });

  it('narrows a typed command error back to its wire shape', () => {
    const typed = new InstalledAppsCommandError({ code: 'already_installed', detail: 'dup' });
    expect(installedAppErrorFrom(typed)).toEqual({ code: 'already_installed', detail: 'dup' });
  });
});
