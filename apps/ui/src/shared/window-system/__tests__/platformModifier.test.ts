/**
 * Platform modifier pin (Spec #3151 ST-1) — the re-homed
 * `detectPrimaryPlatform` / `resolvePrimaryModifier` / `splitPrimaryModifiers`
 * (`shared/window-system/platformModifier.ts`).
 *
 * Pins the SURVIVING behaviour that the zone chord-drag feature and the settings
 * chord labels depend on: the mac/linux/win32 probe order, the unconditional
 * win32 (Ctrl-primary) fallback when `navigator` cannot answer, and the
 * primary/other split the chord matcher reads. These assertions are the
 * byte-for-byte behaviour the retired engine implementation had
 * (`shared/navigation/keys.ts:148-159`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectPrimaryPlatform,
  resolvePrimaryModifier,
  splitPrimaryModifiers,
} from '../platformModifier';

/** Replace the navigator's platform + userAgent for one probe. */
function stubNavigator(platform: string, userAgent = ''): void {
  vi.stubGlobal('navigator', { platform, userAgent });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectPrimaryPlatform', () => {
  it('detects darwin from a mac platform string', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(detectPrimaryPlatform()).toBe('darwin');
  });

  it('detects darwin from a darwin/iphone userAgent even when platform is empty', () => {
    stubNavigator('', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)');
    expect(detectPrimaryPlatform()).toBe('darwin');
  });

  it('detects linux', () => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)');
    expect(detectPrimaryPlatform()).toBe('linux');
  });

  it('defaults to win32 for a Windows platform and for an unrecognised value', () => {
    stubNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0)');
    expect(detectPrimaryPlatform()).toBe('win32');
    stubNavigator('', '');
    expect(detectPrimaryPlatform()).toBe('win32');
  });

  it('falls back to win32 when navigator is unavailable', () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectPrimaryPlatform()).toBe('win32');
  });

  it('prefers the mac branch over a linux-looking string (order preserved)', () => {
    stubNavigator('Linux arm', 'Mozilla/5.0 (Macintosh)');
    expect(detectPrimaryPlatform()).toBe('darwin');
  });
});

describe('resolvePrimaryModifier', () => {
  it('maps win32 and linux to ctrl and darwin to meta', () => {
    expect(resolvePrimaryModifier('win32')).toBe('ctrl');
    expect(resolvePrimaryModifier('linux')).toBe('ctrl');
    expect(resolvePrimaryModifier('darwin')).toBe('meta');
  });

  it('falls back to the detected platform when none is injected', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(resolvePrimaryModifier()).toBe('meta');
    stubNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0)');
    expect(resolvePrimaryModifier()).toBe('ctrl');
  });
});

describe('splitPrimaryModifiers', () => {
  const NEUTRAL = { alt: false, ctrl: false, meta: false, shift: false };

  it('reads ctrl as primary and meta as other on win32/linux', () => {
    expect(splitPrimaryModifiers({ ...NEUTRAL, ctrl: true }, 'win32')).toEqual({
      primary: true,
      other: false,
    });
    expect(splitPrimaryModifiers({ ...NEUTRAL, meta: true }, 'linux')).toEqual({
      primary: false,
      other: true,
    });
  });

  it('reads meta as primary and ctrl as other on darwin', () => {
    expect(splitPrimaryModifiers({ ...NEUTRAL, meta: true }, 'darwin')).toEqual({
      primary: true,
      other: false,
    });
    expect(splitPrimaryModifiers({ ...NEUTRAL, ctrl: true }, 'darwin')).toEqual({
      primary: false,
      other: true,
    });
  });

  it('reports both modifiers held as primary AND other (the exact-match guard)', () => {
    expect(splitPrimaryModifiers({ ...NEUTRAL, ctrl: true, meta: true }, 'win32')).toEqual({
      primary: true,
      other: true,
    });
  });

  it('reports neither held as neither, and ignores alt/shift', () => {
    expect(splitPrimaryModifiers(NEUTRAL, 'win32')).toEqual({ primary: false, other: false });
    expect(splitPrimaryModifiers({ ...NEUTRAL, alt: true, shift: true }, 'darwin')).toEqual({
      primary: false,
      other: false,
    });
  });

  it('uses the detected platform when none is injected', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(splitPrimaryModifiers({ ...NEUTRAL, meta: true })).toEqual({
      primary: true,
      other: false,
    });
  });
});
