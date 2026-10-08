/**
 * Spec #2955 C-1 — `settingsService.get` must treat a successful DB read as
 * authoritative.
 *
 * Regression gap: the DB read used to fall through to the localStorage shadow
 * both when it genuinely failed AND when it succeeded but returned `null`/`""`,
 * so a stale localStorage value could override an authoritative "absent"
 * (AC4: absent → default).
 *
 * Contract pinned here:
 *  - a successful `get_setting` that returns a value is parsed from the DB;
 *  - a successful `get_setting` that returns `null`/`""` is authoritative
 *    "absent" → `defaultValue`, and the localStorage shadow is NEVER consulted;
 *  - a corrupt DB value is likewise authoritative → `defaultValue`, no shadow;
 *  - the shadow fallback remains ONLY for the no-Tauri-host paths: a thrown
 *    transport error, or an unregistered bridge that resolves `undefined`
 *    (Vite dev server / jsdom).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsService } from '../index';
import { adapterBridge } from '../../../shared/utils/adapterBridge';

const KEY = 'c1.settings.key';

function setInvoke(fn: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  adapterBridge.setInvoke(fn as never);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  adapterBridge.setInvoke(undefined as never);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('settingsService.get — DB is authoritative (Spec #2955 C-1)', () => {
  it('returns the DB value when the read succeeds', async () => {
    localStorage.setItem(KEY, 'stale-shadow');
    setInvoke(async (command) => (command === 'get_setting' ? 'db-value' : undefined));

    await expect(settingsService.get(KEY, 'fallback')).resolves.toBe('db-value');
  });

  it('returns defaultValue for an authoritative null DB answer and does NOT consult localStorage', async () => {
    localStorage.setItem(KEY, 'stale-shadow');
    setInvoke(async (command) => (command === 'get_setting' ? null : undefined));

    await expect(settingsService.get(KEY, 'fallback')).resolves.toBe('fallback');
    // The shadow is left untouched — it was never read as an answer.
    expect(localStorage.getItem(KEY)).toBe('stale-shadow');
  });

  it('returns defaultValue for an authoritative empty-string DB answer and does NOT consult localStorage', async () => {
    localStorage.setItem(KEY, 'stale-shadow');
    setInvoke(async (command) => (command === 'get_setting' ? '' : undefined));

    await expect(settingsService.get(KEY, 'fallback')).resolves.toBe('fallback');
    expect(localStorage.getItem(KEY)).toBe('stale-shadow');
  });

  it('returns defaultValue for a corrupt DB value without consulting the shadow', async () => {
    localStorage.setItem(KEY, 'stale-shadow');
    setInvoke(async (command) => (command === 'get_setting' ? 'not-parsable' : undefined));
    const deserialize = () => {
      throw new Error('corrupt');
    };

    await expect(settingsService.get(KEY, 'fallback', deserialize)).resolves.toBe('fallback');
    expect(localStorage.getItem(KEY)).toBe('stale-shadow');
  });

  it('falls back to localStorage when the bridge is unavailable (resolves undefined)', async () => {
    localStorage.setItem(KEY, 'shadow-value');
    setInvoke(async () => undefined);

    await expect(settingsService.get(KEY, 'fallback')).resolves.toBe('shadow-value');
  });

  it('falls back to localStorage on a thrown transport error', async () => {
    localStorage.setItem(KEY, 'shadow-value');
    setInvoke(async () => {
      throw new Error('no Tauri host');
    });

    await expect(settingsService.get(KEY, 'fallback')).resolves.toBe('shadow-value');
  });

  it('returns defaultValue when the host is unavailable and no shadow exists', async () => {
    setInvoke(async () => {
      throw new Error('no Tauri host');
    });

    await expect(settingsService.get(KEY, 'fallback')).resolves.toBe('fallback');
  });
});
