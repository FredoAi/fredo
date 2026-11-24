/**
 * fixtures/v2-events.ts — the typed V2 event fixture model (Spec #3197 ST-1).
 *
 * WHAT THIS IS
 * A committed, typed home for REAL OpenCode 2 event payloads captured with the
 * `FREDO_CAPTURE_EVENTS=<path>` lever (one JSON line `{type, event}` per
 * received event). The fixture set is the corroboration corpus the tester's live
 * capture feeds; the AUTHORING contract remains the installed package typings
 * (see `../types.ts` → `V2EventOf`), because a shape change at a version bump
 * must break the build, not a review.
 *
 * WHY THE SET MAY BE EMPTY
 * A hand-written payload is a guess, and the plan forbids authoring handlers
 * against a guessed shape (G-028). Until a live capture lands (ST-8's external
 * session with `FREDO_CAPTURE_EVENTS` set), an empty set is HONEST; what must
 * exist now is the model and the loader, so a later sub-task/sub-agent appends
 * captured lines verbatim without designing a new shape.
 *
 * `fixtureOf` THROWS when a fixture is absent — a missing shape is a test
 * failure, never a silent skip.
 */

import type { V2EventOf, V2EventType } from "../types";

/**
 * One captured event, verbatim. `type` and `event` are tied together through the
 * `type` discriminant, so `fixtureOf("session.created").event.data.sessionID`
 * type-checks and a mismatched pair does not compile.
 */
export type V2EventFixture<T extends V2EventType = V2EventType> = {
  /** A V2 event type string, exactly as delivered by `ctx.event.subscribe`. */
  type: T;
  /** The raw captured payload, verbatim (no re-shaping, no added fields). */
  event: V2EventOf<T>;
  /** Provenance note, e.g. "opencode 2.4.1, external session, tool:read+failed". */
  capturedFrom: string;
};

/**
 * Committed fixtures. Empty until the first live capture corroborates the
 * typings; append captured `{type, event}` lines here verbatim.
 */
export const V2_EVENT_FIXTURES: readonly V2EventFixture[] = [];

/**
 * Returns the fixture for `type`, or throws. Never returns `undefined`: a
 * silently skipped fixture shape is the failure mode this loader exists to
 * prevent.
 */
export function fixtureOf<T extends V2EventType>(type: T): V2EventFixture<T> {
  const hit = V2_EVENT_FIXTURES.find((fixture) => fixture.type === type);
  if (!hit) {
    throw new Error(
      `No V2 event fixture for "${type}". Capture one with FREDO_CAPTURE_EVENTS=<path> ` +
        `(one JSON line per event), then append the line to V2_EVENT_FIXTURES verbatim.`,
    );
  }
  // The discriminant check above narrows `type`, which the type system cannot
  // carry through `Array.prototype.find` — the cast is the narrowing, not a
  // widening escape hatch.
  return hit as unknown as V2EventFixture<T>;
}
