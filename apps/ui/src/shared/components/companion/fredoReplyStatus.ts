import { isFredoAvatarState } from '../fredo-avatar/fredoAvatarStates';
import type { FredoAvatarState } from '../fredo-avatar/fredoAvatarStates';

/**
 * #2918 ST-4 — the closed REPLY-STATUS vocabulary and its lenient resolver.
 * #3224 — widened to the model-emittable 18, so a model-declared status can
 * select an emotion, not just the shipped 7.
 *
 * The companion's structured reply contract (`{ reply, status }`, JSON-Schema
 * constrained) lets the model declare how Fredo should present himself for that
 * turn. This module is the SINGLE boundary between that untrusted model string
 * and the frozen #2917 avatar vocabulary (`fredoAvatarStates.ts`, now 23 members):
 *
 *   model `status` string --> `resolveReplyStatus` --> `FredoAvatarState`
 *
 * It is a pure leaf module — no React, no timers, no DOM, no entity imports — so
 * ST-5 can consume it from `CompanionEntity.tsx` without widening the resolver's
 * priority order (#2917) or adding states/colours/layers/timings.
 *
 * The model-emittable set is a CLOSED 18 of the frozen 23:
 *   happy | playful | joking | thinking | working | listening | idle
 *   | uwu | love | sad | surprised | sleepy | skeptical | confused | silly
 *   | squint | angry | funny
 *
 * The order is PINNED to the ONE shared contract fixture
 * (`apps/tauri/src-tauri/src/applications/llm_server/fredo_status_contract.json`),
 * which both sides read: the Rust reader pins `FREDO_STATUS_VALUES` to it
 * (`status.rs`) and the frontend reader pins this array to it
 * (`__tests__/fredoReplyStatus.test.ts`) — one fixture, two readers, never a
 * duplicated second copy.
 *
 * `talk`, `teleport-out`, `teleport-in`, `error`, and `greeting` are deliberately
 * NOT model-emittable — they are flow/motion/error-owned, so the model can never
 * become the sole candidate for their triggers (G-220). An emotion IS emittable
 * (#3224): the member check runs BEFORE the alias table, so an emotion resolves to
 * itself and no alias may shadow it. Any non-member (or absent, or non-string)
 * value heals to {@link DEFAULT_FREDO_STATUS}.
 */
export const FREDO_REPLY_STATUSES = [
  'happy',
  'playful',
  'joking',
  'thinking',
  'working',
  'listening',
  'idle',
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
 *
 * #3224 retired `funny: 'joking'` — `funny` is a first-class emotion and a member
 * of {@link FREDO_REPLY_STATUSES}, so the alias would be dead code at best and a
 * silent rewrite of a real state at worst.
 */
const REPLY_STATUS_ALIASES: Readonly<Record<string, FredoReplyStatus>> = {
  success: 'happy',
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
 * (the 18 reply statuses are a subset of the 23), so a malformed external value
 * can never reach the DOM as a stray `data-state`.
 */
export function resolveReplyStatus(raw: unknown): FredoAvatarState {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  const resolved: FredoReplyStatus = isFredoReplyStatus(normalized)
    ? normalized
    : REPLY_STATUS_ALIASES[normalized] ?? DEFAULT_FREDO_STATUS;

  // Boundary belt-and-suspenders: the closed 18 are frozen-union members, so this
  // is a compile-time fact — the guard makes the invariant explicit at runtime.
  return isFredoAvatarState(resolved) ? resolved : DEFAULT_FREDO_STATUS;
}
