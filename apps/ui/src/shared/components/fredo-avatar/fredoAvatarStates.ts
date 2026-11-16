/**
 * #2917 ST-3 — the SINGLE closed source of the FREDO avatar status vocabulary.
 *
 * The `FredoAvatarState` union is DERIVED from this runtime array, so adding a
 * state is a one-line change and every consumer shares one list. `idle` is the
 * only state that renders no expression overlay; each other member MUST have its
 * own distinct conditional frame in `FredoAvatar.tsx`.
 *
 * The vocabulary is FROZEN at 12 members (converged #2917):
 *   idle | talk | teleport-out | teleport-in | thinking | happy | playful |
 *   joking | listening | working | error | greeting
 *
 * `success` is the audited `happy`; `reasoning` aliases `thinking`; `waiting` is
 * deliberately NOT a member (the #2892 queue indicator already owns that datum).
 * #2918 consumes this list — it selects among the frozen states and MUST NOT add
 * free-form states (unknown values are dropped by `isFredoAvatarState`).
 */
export const FREDO_AVATAR_STATES = [
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

/** The derived status-union — one member per `FREDO_AVATAR_STATES` entry. */
export type FredoAvatarState = (typeof FREDO_AVATAR_STATES)[number];

/**
 * Boundary guard: narrows an arbitrary string to a known avatar state. Any value
 * not in the frozen vocabulary is rejected, so a malformed external (model)
 * status can never reach the DOM as a stray `data-state`.
 */
export function isFredoAvatarState(value: string): value is FredoAvatarState {
  return (FREDO_AVATAR_STATES as readonly string[]).includes(value);
}
