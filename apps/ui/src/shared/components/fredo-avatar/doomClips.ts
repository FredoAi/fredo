/**
 * The Doom PERFORMANCE clip contract (Spec #3223 ST-1).
 *
 * The character asset ships six authored armour clips (`doom-in`, `doom-idle`,
 * `doom-mg`, `doom-sword`, `doom-shoot`, `doom-out`). They are NOT a twenty-fourth
 * avatar state: `AVATAR_CLIPS` / `AvatarClipName` / `resolveAvatarMotion` carry the
 * 23 vocabulary states only, and Doom travels through this PARALLEL table plus its
 * own renderer request channel (`AvatarRenderer.setDoomPerformance`). Doom is an
 * overlay performance layered over the consumer's resolved state clip, so a
 * release hands straight back to whatever the live resolver says.
 *
 * The weapon identity IS the clip: `doom-idle` holds the shotgun, `doom-mg` the
 * machine gun and `doom-sword` the energy sword. `doom-shoot` is the authored
 * flourish and is authored ON the shotgun — there is no per-weapon fire clip, so
 * the flourish is deliberately weapon-independent (see `doomPerformance.ts`).
 *
 * The module also owns the ONE weapon cursor (`advanceDoomWeapon` /
 * `getDoomWeapon`). It is MODULE scope on purpose: consecutive engagements cycle
 * shotgun → machine-gun → energy-sword across component mount/unmount within one
 * app session (a `useRef` would reset on every remount — ENGINEERING_RULES).
 */

import type { AvatarClipSpec, AvatarClipName } from './avatarClips';

/** The six authored armour clips the Doom performance can request. */
export type DoomClipName =
  | 'doom-in'
  | 'doom-out'
  | 'doom-idle'
  | 'doom-mg'
  | 'doom-sword'
  | 'doom-shoot';

/** The three weapons the fixed engagement order cycles through. */
export type DoomWeapon = 'shotgun' | 'machine-gun' | 'energy-sword';

/**
 * A clip the renderer can ACTUALLY apply — the 23 vocabulary states plus the six
 * Doom clips. Widened here (never in `avatarClips.ts`) so `AvatarClipName` stays
 * exactly the state vocabulary.
 */
export type AvatarRenderedClip = AvatarClipName | DoomClipName;

/** The one request payload the Doom channel pushes into the renderer. */
export interface DoomPerformance {
  readonly clip: DoomClipName;
}

/** Every authored armour clip is 1.333 s long (the manifest's `duration`). */
const DOOM_CLIP_SECONDS = 1.333;

/**
 * The six armour clips, authored shape only — loops/durations straight from
 * `.opencode/wireframes/blender/fredo-character.manifest.json`. Only `doom-in`
 * and `doom-out` are one-shots; `doom-shoot` is a LOOP and therefore emits no
 * mixer `finished` (the flourish is ended by its own timer).
 */
export const DOOM_CLIPS: Readonly<Record<DoomClipName, AvatarClipSpec>> = Object.freeze({
  'doom-in': { loop: false, durationSeconds: DOOM_CLIP_SECONDS },
  'doom-out': { loop: false, durationSeconds: DOOM_CLIP_SECONDS },
  'doom-idle': { loop: true, durationSeconds: DOOM_CLIP_SECONDS },
  'doom-mg': { loop: true, durationSeconds: DOOM_CLIP_SECONDS },
  'doom-sword': { loop: true, durationSeconds: DOOM_CLIP_SECONDS },
  'doom-shoot': { loop: true, durationSeconds: DOOM_CLIP_SECONDS },
});

/** The clips the mixer must play ONCE and whose `finished` ends the phase. */
export const DOOM_ONE_SHOT_CLIPS = Object.freeze(['doom-in', 'doom-out'] as const);

/** A member of `DOOM_ONE_SHOT_CLIPS`. */
export type DoomOneShotClip = (typeof DOOM_ONE_SHOT_CLIPS)[number];

/**
 * The FIXED engagement order. The cursor below wraps after the third member, so
 * engagement 4 holds the shotgun again.
 */
export const DOOM_WEAPON_ORDER = Object.freeze([
  'shotgun',
  'machine-gun',
  'energy-sword',
] as const);

/** The holding clip for each weapon — the weapon identity IS its clip. */
export const DOOM_WEAPON_CLIP: Readonly<Record<DoomWeapon, DoomClipName>> = Object.freeze({
  shotgun: 'doom-idle',
  'machine-gun': 'doom-mg',
  'energy-sword': 'doom-sword',
});

/**
 * The vocabulary clips that OUTRANK the Doom overlay: a teleport is the consumer's
 * own one-shot pair, so it plays in place of the armour and the overlay is
 * suspended until the pair resolves (never stuck mid-teleport).
 */
export const DOOM_SUPPRESSING_STATES = Object.freeze(['teleport-out', 'teleport-in'] as const);

/** True for a Doom performance clip name (and only those). */
export function isDoomClipName(name: string): name is DoomClipName {
  return Object.prototype.hasOwnProperty.call(DOOM_CLIPS, name);
}

/** True for a Doom one-shot (the members of `DOOM_ONE_SHOT_CLIPS`). */
export function isDoomOneShotClip(name: DoomClipName): name is DoomOneShotClip {
  return (DOOM_ONE_SHOT_CLIPS as readonly DoomClipName[]).includes(name);
}

/**
 * True when the state MUST be applied even while the Doom overlay owns the mixer
 * (a teleport always wins). Every other state is only recorded, so releasing the
 * overlay hands back to the LATEST resolved state rather than a stale snapshot.
 */
export function isDoomSuppressingClip(name: AvatarClipName): boolean {
  return (DOOM_SUPPRESSING_STATES as readonly AvatarClipName[]).includes(name);
}

/**
 * The module-scoped weapon cursor (index into `DOOM_WEAPON_ORDER`). `selected`
 * distinguishes "nothing engaged yet" from "shotgun holds the cursor", which is
 * what makes the FIRST advance select the shotgun and the fourth wrap back to it.
 */
let cursor = 0;
let selected = false;

/**
 * Select the NEXT engagement's weapon and advance the cursor. The first call
 * returns `shotgun`, the second `machine-gun`, the third `energy-sword`, the
 * fourth `shotgun` again.
 */
export function advanceDoomWeapon(): DoomWeapon {
  if (selected) {
    cursor = (cursor + 1) % DOOM_WEAPON_ORDER.length;
  } else {
    selected = true;
    cursor = 0;
  }
  return DOOM_WEAPON_ORDER[cursor];
}

/** The weapon the cursor currently points at (`shotgun` before any engagement). */
export function getDoomWeapon(): DoomWeapon {
  return DOOM_WEAPON_ORDER[cursor];
}

/**
 * Reset the cursor to its pre-session position. TEST-ONLY: the module cursor
 * surviving a consumer unmount is a shipped behaviour (the weapon cycle), so the
 * production path never resets it.
 */
export function resetDoomWeaponForTests(): void {
  cursor = 0;
  selected = false;
}
