/**
 * Zone chord modifier parity pin (Spec #3151 ST-1).
 *
 * The zone chord-drag feature SURVIVES the navigation-engine removal; only its
 * imports moved (`resolvePrimaryModifier`/`Platform` → `shared/window-system/
 * platformModifier`). This suite proves the swap is behaviour-preserving: the
 * `matchesZoneChord` truth table is EXACTLY the shipped engine rule for every
 * chord, every platform and every one of the 16 modifier combinations.
 *
 * The reference is an independent restatement of the documented rule (primary =
 * Ctrl on win32/linux, Meta on darwin; matching is EXACT — a chord matches only
 * when every modifier it names is held and no other ctrl/meta/alt/shift is), so
 * a drift in either the matcher or the re-homed platform rule is caught.
 */

import { describe, expect, it } from 'vitest';

import {
  ZONE_ACTIVATION_CHORDS,
  matchesZoneChord,
  type ZoneActivationChord,
} from '../zoneLayout';
import type { PrimaryPlatform } from '../platformModifier';

interface Mods {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

const PLATFORMS: readonly PrimaryPlatform[] = ['win32', 'linux', 'darwin'];

/** Every one of the 16 modifier combinations, in a stable order. */
function allModifierStates(): Mods[] {
  const states: Mods[] = [];
  for (let mask = 0; mask < 16; mask += 1) {
    states.push({
      alt: (mask & 1) !== 0,
      ctrl: (mask & 2) !== 0,
      meta: (mask & 4) !== 0,
      shift: (mask & 8) !== 0,
    });
  }
  return states;
}

/**
 * The SHIPPED engine rule, restated independently (the pre-swap
 * `matchesZoneChord` body). Used as the parity oracle.
 */
function referenceMatch(chord: ZoneActivationChord, mods: Mods, platform: PrimaryPlatform): boolean {
  const primaryMod = platform === 'darwin' ? 'meta' : 'ctrl';
  const primary = primaryMod === 'ctrl' ? mods.ctrl : mods.meta;
  const other = primaryMod === 'ctrl' ? mods.meta : mods.ctrl;
  switch (chord) {
    case 'alt':
      return mods.alt && !primary && !other && !mods.shift;
    case 'primary':
      return primary && !other && !mods.alt && !mods.shift;
    case 'primary+alt':
      return primary && !other && mods.alt && !mods.shift;
    case 'primary+shift':
      return primary && !other && !mods.alt && mods.shift;
    case 'alt+shift':
      return !primary && !other && mods.alt && mods.shift;
    default:
      return false;
  }
}

describe('matchesZoneChord — modifier parity after the re-home', () => {
  it('matches the shipped rule for every chord × platform × modifier state', () => {
    const states = allModifierStates();
    // Non-vacuity: the sweep really is 5 chords × 3 platforms × 16 states.
    expect(ZONE_ACTIVATION_CHORDS.length * PLATFORMS.length * states.length).toBe(240);
    let matchedSomewhere = 0;
    for (const chord of ZONE_ACTIVATION_CHORDS) {
      for (const platform of PLATFORMS) {
        for (const mods of states) {
          const actual = matchesZoneChord(chord, mods, platform);
          expect(actual, `${chord} on ${platform} with ${JSON.stringify(mods)}`).toBe(
            referenceMatch(chord, mods, platform),
          );
          if (actual) matchedSomewhere += 1;
        }
      }
    }
    // Non-vacuity: the table is not all-false.
    expect(matchedSomewhere).toBeGreaterThan(0);
  });

  it('resolves primary as Ctrl on win32/linux and Meta on darwin', () => {
    const ctrlOnly: Mods = { alt: false, ctrl: true, meta: false, shift: false };
    const metaOnly: Mods = { alt: false, ctrl: false, meta: true, shift: false };

    expect(matchesZoneChord('primary', ctrlOnly, 'win32')).toBe(true);
    expect(matchesZoneChord('primary', ctrlOnly, 'linux')).toBe(true);
    expect(matchesZoneChord('primary', metaOnly, 'win32')).toBe(false);

    expect(matchesZoneChord('primary', metaOnly, 'darwin')).toBe(true);
    expect(matchesZoneChord('primary', ctrlOnly, 'darwin')).toBe(false);
  });

  it('rejects a chord when the non-primary modifier is also held', () => {
    expect(
      matchesZoneChord('primary', { alt: false, ctrl: true, meta: true, shift: false }, 'win32'),
    ).toBe(false);
    expect(
      matchesZoneChord('primary', { alt: false, ctrl: true, meta: true, shift: false }, 'darwin'),
    ).toBe(false);
  });

  it('keeps alt-only and alt+shift exact (no primary modifier held)', () => {
    expect(
      matchesZoneChord('alt', { alt: true, ctrl: false, meta: false, shift: false }, 'win32'),
    ).toBe(true);
    expect(
      matchesZoneChord('alt', { alt: true, ctrl: false, meta: false, shift: true }, 'win32'),
    ).toBe(false);
    expect(
      matchesZoneChord('alt+shift', { alt: true, ctrl: false, meta: false, shift: true }, 'darwin'),
    ).toBe(true);
  });

  it('matches primary+alt and primary+shift with the primary modifier only', () => {
    expect(
      matchesZoneChord('primary+alt', { alt: true, ctrl: true, meta: false, shift: false }, 'win32'),
    ).toBe(true);
    expect(
      matchesZoneChord(
        'primary+shift',
        { alt: false, ctrl: false, meta: true, shift: true },
        'darwin',
      ),
    ).toBe(true);
    expect(
      matchesZoneChord('primary+shift', { alt: false, ctrl: true, meta: false, shift: false }, 'win32'),
    ).toBe(false);
  });

  it('falls back to the detected platform when none is injected', () => {
    // jsdom's default navigator reports neither mac nor linux → win32 → Ctrl.
    expect(
      matchesZoneChord('primary', { alt: false, ctrl: true, meta: false, shift: false }),
    ).toBe(true);
  });

  it('rejects an unknown chord id', () => {
    const bogus = 'primary+meta' as unknown as ZoneActivationChord;
    expect(
      matchesZoneChord(bogus, { alt: false, ctrl: true, meta: false, shift: false }, 'win32'),
    ).toBe(false);
  });
});
