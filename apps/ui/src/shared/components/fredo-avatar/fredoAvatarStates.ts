/**
 * #2917 ST-3 — the SINGLE closed source of the FREDO avatar state vocabulary.
 * #3224 ST-1 — widened from 12 to 23 members, composed from two named arrays.
 *
 * The `FredoAvatarState` union is DERIVED from `FREDO_AVATAR_STATES`, so adding a
 * state is a one-line change and every consumer shares one list. Each member
 * renders its OWN same-named authored clip (`avatarClips.ts`); `idle` is the only
 * state that renders the idle performance.
 *
 * The vocabulary is 23 members:
 *  - `FREDO_AVATAR_STATUS_STATES` — the 12 shipped status states, unchanged and in
 *    their shipped order:
 *      idle | talk | teleport-out | teleport-in | thinking | happy | playful |
 *      joking | listening | working | error | greeting
 *  - `FREDO_AVATAR_EMOTION_STATES` — the 11 authored emotion performances, in the
 *    asset's own authored order (`ASSET.md:103-116`):
 *      uwu | love | sad | surprised | sleepy | skeptical | confused | silly |
 *      squint | angry | funny
 *
 * `success` is the audited `happy`; `reasoning` aliases `thinking`; `waiting` is
 * deliberately NOT a member (the #2892 queue indicator already owns that datum).
 * #2918 consumes this list — it selects among the states and MUST NOT add
 * free-form states (unknown values are dropped by `isFredoAvatarState`).
 */
export const FREDO_AVATAR_STATUS_STATES = [
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
] as const;

/** The 11 authored emotion performances, in the asset's authored order. */
export const FREDO_AVATAR_EMOTION_STATES = [
  'uwu',
  'love',
  'sad',
  'surprised',
  'sleepy',
  'skeptical',
  'confused',
  'silly',
  'squint',
  'angry',
  'funny',
] as const;

/** The ONE vocabulary: the 12 status states followed by the 11 emotions (23). */
export const FREDO_AVATAR_STATES = [
  ...FREDO_AVATAR_STATUS_STATES,
  ...FREDO_AVATAR_EMOTION_STATES,
] as const;

/** The derived status-union — one member per `FREDO_AVATAR_STATES` entry. */
export type FredoAvatarState = (typeof FREDO_AVATAR_STATES)[number];

/**
 * Boundary guard: narrows an arbitrary string to a known avatar state. Any value
 * not in the closed vocabulary is rejected, so a malformed external (model)
 * status can never reach the DOM as a stray `data-state`.
 */
export function isFredoAvatarState(value: string): value is FredoAvatarState {
  return (FREDO_AVATAR_STATES as readonly string[]).includes(value);
}
