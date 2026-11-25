/**
 * The ONE state ⇄ clip contract for the avatar's shipped character (spec 3210 ST-1).
 *
 * The asset ships 32 authored clips, but this BASE renders exactly one clip per
 * member of the frozen 12-state vocabulary, sharing its name — so an
 * `AvatarClipName` is a `FredoAvatarState`, and a name with no matching clip is a
 * build-time type error rather than a silent runtime fall back to `idle`.
 *
 * Everything beyond the 12 (the emotion clips and the Doom performance clips the
 * asset also carries) is deliberately absent: those vocabularies are owned by the
 * vocabulary and Doom cut-over slices, and pre-creating their names here would be
 * a second, dead render path. The asset-contract pin
 * (`__tests__/avatarAssetContract.test.ts`) still asserts the shipped GLB carries
 * ALL 32 clips, so those slices cannot find the asset drifted.
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
 * A clip name IS a state name. Kept as an alias (not a widened union) so the 12
 * members are the single source and a clip table entry cannot drift from the
 * vocabulary.
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
 * The 12 state clips, each looping except the two teleport one-shots. Frozen so a
 * consumer cannot mutate the table it renders from.
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
});

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
