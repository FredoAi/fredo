/**
 * The ONE state ⇄ clip contract for the avatar's shipped character (spec 3210 ST-1,
 * widened by #3224 ST-1 from 12 to 23).
 *
 * This BASE renders exactly one clip per member of the 23-state vocabulary, sharing
 * its name — so an `AvatarClipName` is a `FredoAvatarState`, and a vocabulary member
 * with no matching clip entry is a build-time type error
 * (`Readonly<Record<AvatarClipName, …>>`) rather than a silent runtime fall back to
 * `idle`.
 *
 * Everything beyond the 23 (the six Doom performance clips the asset also carries)
 * is deliberately absent: that vocabulary is owned by the Doom cut-over slice and
 * lives in its own parallel table (`doomClips.ts`). The asset-contract pin
 * (`__tests__/avatarAssetContract.test.ts`) still asserts the shipped GLB carries
 * ALL 32 clips, so no slice can find the asset drifted.
 *
 * The camera-fit baseline is PINNED to the 12 status states
 * (`AVATAR_FRAMING_CLIPS`): the renderer measures the body silhouette over that set
 * only, so the 11 emotion poses can never re-frame the shipped figure.
 *
 * No wall-clock animation state lives here: clip switching is event-driven in the
 * renderer (mixer `finished` plus the applied-clip readout), so a hidden window
 * can never strand a one-shot.
 */

import type { FredoAvatarState } from './fredoAvatarStates';

/** One authored clip's shipped shape — the two facts the runtime has to honour. */
export interface AvatarClipSpec {
  /** `false` only for the one-shots, which must clamp and resolve, never repeat. */
  readonly loop: boolean;
  /** Authored clip length in seconds (every shipped clip is 1.333 s). */
  readonly durationSeconds: number;
}

/**
 * A clip name IS a state name. Kept as an alias (not a widened union) so the 23
 * vocabulary members are the single source and a clip table entry cannot drift
 * from the vocabulary — 23 states ⇄ 23 clips is compile-enforced.
 */
export type AvatarClipName = FredoAvatarState;

/** Every authored clip is 1.333 s long. */
const CLIP_SECONDS = 1.333;

/**
 * The one-shots' shipped state window, in seconds — `ANIM_DURATION['teleport-out']`
 * and `ANIM_DURATION['teleport-in']` are 400 ms in the companion's own timing table
 * (`shared/components/companion/CompanionEntity.tsx`). This module does NOT import
 * that table: the companion imports the avatar, so importing back would create a
 * cycle. The two values are pinned together by the companion's teleport-timing row.
 */
const ONE_SHOT_WINDOW_SECONDS = 0.4;

/**
 * The 23 state clips, each looping except the two teleport one-shots, sharing its
 * state's name. Frozen so a consumer cannot mutate the table it renders from. A
 * missing entry is a compile error (the `Record<AvatarClipName, …>` key set IS the
 * vocabulary).
 */
export const AVATAR_CLIPS: Readonly<Record<AvatarClipName, AvatarClipSpec>> = Object.freeze({
  idle: { loop: true, durationSeconds: CLIP_SECONDS },
  talk: { loop: true, durationSeconds: CLIP_SECONDS },
  'teleport-out': { loop: false, durationSeconds: CLIP_SECONDS },
  'teleport-in': { loop: false, durationSeconds: CLIP_SECONDS },
  thinking: { loop: true, durationSeconds: CLIP_SECONDS },
  happy: { loop: true, durationSeconds: CLIP_SECONDS },
  playful: { loop: true, durationSeconds: CLIP_SECONDS },
  joking: { loop: true, durationSeconds: CLIP_SECONDS },
  listening: { loop: true, durationSeconds: CLIP_SECONDS },
  working: { loop: true, durationSeconds: CLIP_SECONDS },
  error: { loop: true, durationSeconds: CLIP_SECONDS },
  greeting: { loop: true, durationSeconds: CLIP_SECONDS },
  // The 11 authored emotion performances (#3224). Same named clip, same authored
  // 1.333 s loop — the clip IS the state, never an alias of another performance.
  uwu: { loop: true, durationSeconds: CLIP_SECONDS },
  love: { loop: true, durationSeconds: CLIP_SECONDS },
  sad: { loop: true, durationSeconds: CLIP_SECONDS },
  surprised: { loop: true, durationSeconds: CLIP_SECONDS },
  sleepy: { loop: true, durationSeconds: CLIP_SECONDS },
  skeptical: { loop: true, durationSeconds: CLIP_SECONDS },
  confused: { loop: true, durationSeconds: CLIP_SECONDS },
  silly: { loop: true, durationSeconds: CLIP_SECONDS },
  squint: { loop: true, durationSeconds: CLIP_SECONDS },
  angry: { loop: true, durationSeconds: CLIP_SECONDS },
  funny: { loop: true, durationSeconds: CLIP_SECONDS },
});

/**
 * The camera-fit baseline — the 12 STATUS states, frozen as a literal.
 *
 * The renderer measures the body silhouette over this set ONLY (never over every
 * clip in its action map), so the 11 emotion poses added by #3224 can never move
 * the shipped framing of the 12. This is the same discipline the Doom channel
 * already follows ("the Doom poses/props never size the camera").
 *
 * Deliberately a literal rather than a spread of `FREDO_AVATAR_STATUS_STATES`: the
 * asset-contract pin asserts the two agree exactly, which a derivation would make
 * tautological. A new status state must therefore be added here by hand — and a
 * failing pin is the signal to do it.
 */
export const AVATAR_FRAMING_CLIPS = Object.freeze([
  'idle',
  'talk',
  'teleport-out',
  'teleport-in',
  'thinking',
  'happy',
  'playful',
  'joking',
  'listening',
  'working',
  'error',
  'greeting',
] as const);

/** True for a clip in the camera-fit baseline (the 12 status states). */
export function isAvatarFramingClip(name: string): boolean {
  return (AVATAR_FRAMING_CLIPS as readonly string[]).includes(name);
}

/** The clips the mixer must play ONCE (`LoopOnce` + clamp) and then resolve. */
export const AVATAR_ONE_SHOT_CLIPS = Object.freeze(['teleport-out', 'teleport-in'] as const);

/** A member of `AVATAR_ONE_SHOT_CLIPS`. */
export type AvatarOneShotClip = (typeof AVATAR_ONE_SHOT_CLIPS)[number];

/**
 * Playback-rate normalisation for the one-shots: the authored clip is 1.333 s but
 * the shipped teleport window is 400 ms, so the clip must be played ~3.33x faster
 * to complete inside the window the state machine already waits for.
 */
export const AVATAR_CLIP_TIME_SCALE: Readonly<Record<AvatarOneShotClip, number>> = Object.freeze({
  'teleport-out': AVATAR_CLIPS['teleport-out'].durationSeconds / ONE_SHOT_WINDOW_SECONDS,
  'teleport-in': AVATAR_CLIPS['teleport-in'].durationSeconds / ONE_SHOT_WINDOW_SECONDS,
});

/** Whether the resolved clip animates (`play`) or holds its first frame (`still`). */
export type AvatarMotion = 'play' | 'still';

/**
 * Motion resolution — the ONE rule for "is this a still frame?".
 *
 * Reduced motion always wins (one frame of the resolved clip, never the poster:
 * the poster only depicts `idle` and would erase state legibility). `talk` outside
 * a stream holds its closed-mouth first frame, which is exactly what the shipped
 * flat avatar showed — the mouth only ever animated while streaming.
 */
export function resolveAvatarMotion(
  state: FredoAvatarState,
  streaming: boolean,
  reducedMotion: boolean,
): AvatarMotion {
  if (reducedMotion) return 'still';
  if (state === 'talk' && !streaming) return 'still';
  return 'play';
}
