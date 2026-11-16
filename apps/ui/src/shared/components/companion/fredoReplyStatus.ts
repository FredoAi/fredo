import { isFredoAvatarState } from '../fredo-avatar/fredoAvatarStates';
import type { FredoAvatarState } from '../fredo-avatar/fredoAvatarStates';

/**
 * #2918 ST-4 — the closed REPLY-STATUS vocabulary and its lenient resolver.
 *
 * The companion's structured reply contract (`{ reply, status }`, JSON-Schema
 * constrained) lets the model declare how Fredo should present himself for that
 * turn. This module is the SINGLE boundary between that untrusted model string
 * and the frozen #2917 avatar vocabulary (`fredoAvatarStates.ts`):
 *
 *   model `status` string --> `resolveReplyStatus` --> `FredoAvatarState`
 *
 * It is a pure leaf module — no React, no timers, no DOM, no entity imports — so
 * ST-5 can consume it from `CompanionEntity.tsx` without widening the resolver's
 * priority order (#2917) or adding states/colours/layers/timings.
 *
 * The model-emittable set is a CLOSED 7 of the frozen 12:
 *   happy | playful | joking | thinking | working | listening | idle
 *
 * `talk`, `teleport-out`, `teleport-in`, `error`, and `greeting` are deliberately
 * NOT model-emittable — they are flow/motion/error-owned, so the model can never
 * become the sole candidate for their triggers (G-220). Any non-member (or absent,
 * or non-string) value heals to {@link DEFAULT_FREDO_STATUS}.
 */
export const FREDO_REPLY_STATUSES = [
  'happy',
  'playful',
  'joking',
  'thinking',
  'working',
  'listening',
  'idle',
] as const;

/** The derived reply-status union — one member per `FREDO_REPLY_STATUSES` entry. */
export type FredoReplyStatus = (typeof FREDO_REPLY_STATUSES)[number];

/**
 * The safe default (also the shipped success settle) — an absent/unknown status
 * heals here for zero visual regression.
 */
export const DEFAULT_FREDO_STATUS: FredoReplyStatus = 'happy';

/**
 * Lenient alias table (applied case-insensitively on a trimmed input). These are
 * common model synonyms; every value is itself a model-emittable member.
 */
const REPLY_STATUS_ALIASES: Readonly<Record<string, FredoReplyStatus>> = {
  success: 'happy',
  funny: 'joking',
  reasoning: 'thinking',
  busy: 'working',
  focused: 'working',
  neutral: 'idle',
  calm: 'idle',
};

const isFredoReplyStatus = (value: string): value is FredoReplyStatus =>
  (FREDO_REPLY_STATUSES as readonly string[]).includes(value);

/**
 * Lenient: trims/case-folds, applies the alias table, heals unknown/absent to the
 * default.
 *
 * Guarantees the return is ALWAYS a member of the frozen `FREDO_AVATAR_STATES`
 * (the 7 reply statuses are a subset of the 12), so a malformed external value can
 * never reach the DOM as a stray `data-state`.
 */
export function resolveReplyStatus(raw: unknown): FredoAvatarState {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  const resolved: FredoReplyStatus = isFredoReplyStatus(normalized)
    ? normalized
    : REPLY_STATUS_ALIASES[normalized] ?? DEFAULT_FREDO_STATUS;

  // Boundary belt-and-suspenders: the closed 7 are frozen-union members, so this
  // is a compile-time fact — the guard makes the invariant explicit at runtime.
  return isFredoAvatarState(resolved) ? resolved : DEFAULT_FREDO_STATUS;
}
