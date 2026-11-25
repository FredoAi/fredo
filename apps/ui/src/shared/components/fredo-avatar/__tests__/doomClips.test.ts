/**
 * #3223 ST-1 — the Doom clip contract.
 *
 * The whole point of this table is that Doom is NOT a thirteenth avatar state:
 * `AVATAR_CLIPS` / `AvatarClipName` / `resolveAvatarMotion` stay byte-identical at
 * twelve, and the six armour clips live here in a PARALLEL vocabulary with its own
 * renderer channel. These pins are the control for that separation.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { AVATAR_CLIPS, resolveAvatarMotion } from '../avatarClips';
import {
  DOOM_CLIPS,
  DOOM_ONE_SHOT_CLIPS,
  DOOM_SUPPRESSING_STATES,
  DOOM_WEAPON_CLIP,
  DOOM_WEAPON_ORDER,
  advanceDoomWeapon,
  getDoomWeapon,
  isDoomClipName,
  isDoomOneShotClip,
  isDoomSuppressingClip,
  resetDoomWeaponForTests,
  type DoomClipName,
  type DoomWeapon,
} from '../doomClips';
import { FREDO_AVATAR_STATES } from '../fredoAvatarStates';

const DOOM_NAMES: readonly DoomClipName[] = [
  'doom-in',
  'doom-out',
  'doom-idle',
  'doom-mg',
  'doom-sword',
  'doom-shoot',
];

afterEach(() => {
  resetDoomWeaponForTests();
});

describe('#3223 Doom clip table — the six authored armour clips', () => {
  it('declares exactly the six authored clips, each 1.333 s', () => {
    expect(Object.keys(DOOM_CLIPS).sort()).toEqual([...DOOM_NAMES].sort());
    for (const name of DOOM_NAMES) {
      expect(DOOM_CLIPS[name].durationSeconds).toBeCloseTo(1.333, 3);
    }
  });

  it('marks only `doom-in` / `doom-out` as one-shots (the other four loop)', () => {
    expect([...DOOM_ONE_SHOT_CLIPS]).toEqual(['doom-in', 'doom-out']);
    for (const name of DOOM_NAMES) {
      const oneShot = name === 'doom-in' || name === 'doom-out';
      expect(DOOM_CLIPS[name].loop, `${name} loop flag`).toBe(!oneShot);
      expect(isDoomOneShotClip(name), `${name} one-shot`).toBe(oneShot);
    }
  });

  it('keeps `doom-shoot` a LOOP (it emits no mixer `finished` — the timer ends it)', () => {
    expect(DOOM_CLIPS['doom-shoot'].loop).toBe(true);
    expect(isDoomOneShotClip('doom-shoot')).toBe(false);
  });

  it('accepts every Doom name and rejects the 12 state names', () => {
    for (const name of DOOM_NAMES) expect(isDoomClipName(name)).toBe(true);
    for (const state of FREDO_AVATAR_STATES) {
      expect(isDoomClipName(state), `${state} must not be a Doom clip`).toBe(false);
    }
    expect(isDoomClipName('dance')).toBe(false);
    expect(isDoomClipName('')).toBe(false);
  });
});

describe('#3223 weapon table — the fixed cycle', () => {
  it('declares the fixed order shotgun → machine-gun → energy-sword', () => {
    expect([...DOOM_WEAPON_ORDER]).toEqual(['shotgun', 'machine-gun', 'energy-sword']);
  });

  it('maps each weapon to its holding clip (the weapon identity IS the clip)', () => {
    expect(DOOM_WEAPON_CLIP.shotgun).toBe('doom-idle');
    expect(DOOM_WEAPON_CLIP['machine-gun']).toBe('doom-mg');
    expect(DOOM_WEAPON_CLIP['energy-sword']).toBe('doom-sword');
  });

  it('walks the order and wraps after the third engagement', () => {
    const seen: DoomWeapon[] = [
      advanceDoomWeapon(),
      advanceDoomWeapon(),
      advanceDoomWeapon(),
      advanceDoomWeapon(),
    ];
    expect(seen).toEqual(['shotgun', 'machine-gun', 'energy-sword', 'shotgun']);
  });

  it('starts the cursor on the shotgun before any engagement', () => {
    expect(getDoomWeapon()).toBe('shotgun');
    expect(advanceDoomWeapon()).toBe('shotgun');
    expect(getDoomWeapon()).toBe('shotgun');
  });
});

describe('#3223 teleport suppression set — the overlay yields, never competes', () => {
  it('declares exactly the two teleport clips', () => {
    expect([...DOOM_SUPPRESSING_STATES]).toEqual(['teleport-out', 'teleport-in']);
  });

  it('suppresses on the teleport pair and on nothing else in the vocabulary', () => {
    for (const state of FREDO_AVATAR_STATES) {
      const expected = state === 'teleport-out' || state === 'teleport-in';
      expect(isDoomSuppressingClip(state), `${state} suppression`).toBe(expected);
    }
  });
});

describe('#3223 the 12-state vocabulary is untouched', () => {
  it('keeps `AVATAR_CLIPS` at exactly 12 and shares no name with the Doom table', () => {
    expect(Object.keys(AVATAR_CLIPS)).toHaveLength(12);
    expect(FREDO_AVATAR_STATES).toHaveLength(12);
    for (const name of DOOM_NAMES) {
      expect(AVATAR_CLIPS).not.toHaveProperty(name);
    }
  });

  it('keeps the motion rule resolving for the 12 states only', () => {
    for (const state of FREDO_AVATAR_STATES) {
      expect(['play', 'still']).toContain(resolveAvatarMotion(state, true, false));
    }
    // No Doom name is a motion-resolvable state.
    for (const name of DOOM_NAMES) {
      expect(FREDO_AVATAR_STATES).not.toContain(name);
    }
  });
});
