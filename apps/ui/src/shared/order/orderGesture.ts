/**
 * Spec #3243 ST-2 — the order field's hold-Space gesture (R-2a..R-2d).
 *
 * # What this module is, and what it deliberately is not
 *
 * The order field IS the shipped instruction composer
 * (`[data-testid="fredo-companion-composer-input"]`), so the gesture needs no
 * second input surface and no second dispatch route. What it needs is the ONE
 * precedence implementation the launcher bar already ships, applied to a
 * different field.
 *
 * So this module is an ADAPTER: every decision is DELEGATED to the shipped
 * `launcherSpaceHold.ts`
 * (`resolveSpaceKeyDown` / `resolveSpaceKeyUp` / `spaceWriteForVerdict` /
 * `HOLD_THRESHOLD_MS` / `HOLD_PENDING_CUE_MS` / `HOLD_FALLBACK_SPACE`). It adds
 * exactly the two facts the order field introduces and nothing else:
 *
 *   1. its own TARGET PREDICATE — the shipped function scopes arming to the
 *      launcher bar's `role="searchbox"`, so an order-field target has to be
 *      supplied in that slot (`isBarInputTarget`); and
 *   2. the FIELD-BLUR CANCEL — losing focus to something outside the composer
 *      root cancels (R-2c), which the launcher never modelled because a bar
 *      blur is not a bar cancel.
 *
 * Re-deriving the precedence for a second field is how the "zero lost spaces"
 * property was lost the first time: one implementation means one place to
 * change and one place to be wrong, and a reorder reddens BOTH unit suites.
 *
 * # Not a fourth platform chord
 *
 * The gesture is FIELD-SCOPED. It is reached from the textarea's own React
 * `onKeyDown` (every event it sees was already routed by the browser to the
 * focused field) and its keyup stays inside the composer tree. This module adds
 * NO `document`/`window` listener, and `platformChords.ts` is not referenced
 * here at all — the three platform chords stay exactly three (`primary+space`,
 * `primary+tab`, `primary+shift+tab`) and a focused textarea suppresses them by
 * the shipped `text-entry` rule, so `primary+space` cannot fire from this field
 * by construction.
 *
 * PURE by design, like the module it delegates to: no DOM read, no listener, no
 * clock, no timer, no React, no IPC. The capture lifecycle (the 200 ms timer,
 * the mic, the stale-hold guard) belongs to the wiring, not here.
 */

import {
  HOLD_FALLBACK_SPACE,
  HOLD_PENDING_CUE_MS,
  HOLD_THRESHOLD_MS,
  resolveSpaceKeyDown,
  resolveSpaceKeyUp,
  spaceWriteForVerdict,
  type SpaceDownVerdict,
  type SpaceUpVerdict,
} from '../../applications/home/components/launcher/launcherSpaceHold';

/**
 * The `starting voice input…` cue window for the order field.
 *
 * A RE-EXPORT of the shipped constant, never a second literal: the cue must be
 * the same bounded window on both surfaces, and a copy would let them drift the
 * moment one is re-tuned. Asserted equal at import by
 * `__tests__/orderGesture.test.ts`.
 */
export const ORDER_HOLD_PENDING_CUE_MS: number = HOLD_PENDING_CUE_MS;

/** The hold threshold the order field honours (imported, never redeclared). */
export const ORDER_HOLD_THRESHOLD_MS: number = HOLD_THRESHOLD_MS;

/** The one ordinary space a no-capture order-field release writes. */
export const ORDER_HOLD_FALLBACK_SPACE: string = HOLD_FALLBACK_SPACE;

/**
 * The order field's keydown input — the shipped input with the target predicate
 * and the emptiness fact renamed to the field they describe.
 */
export interface OrderHoldKeyDownInput {
  /** A hold is armed and stays armed until the release. */
  readonly holdArmed: boolean;
  /**
   * The keydown target is THIS order field (the composer textarea).
   *
   * The one NEW fact: the shipped predicate names the launcher's search input,
   * so the order field supplies its own answer in that slot.
   */
  readonly isOrderFieldTarget: boolean;
  /** The field holds no characters — the empty-order-field precondition. */
  readonly fieldIsEmpty: boolean;
  /** `voiceEnabled && !performanceGate && capture available` (the fail-closed probe). */
  readonly voiceUsable: boolean;
  /** A companion reply generation is in flight (nothing may be promised). */
  readonly busy: boolean;
  /** ctrl / meta / alt / shift held. */
  readonly modified: boolean;
  /** The keydown carries `event.repeat` (an OS auto-repeat). */
  readonly repeat: boolean;
}

/** The order field's keyup input — byte-for-byte the shipped release facts. */
export interface OrderHoldKeyUpInput {
  readonly holdArmed: boolean;
  readonly captureLive: boolean;
  readonly thresholdCrossed: boolean;
}

/**
 * Resolve a Space keydown on the order field.
 *
 * DELEGATED: `isOrderFieldTarget` is supplied in the shipped
 * `isBarInputTarget` slot and `fieldIsEmpty` in its `queryIsEmpty` slot, so the
 * precedence order (armed → not-target/modified → repeat → not-empty/voice/
 * busy → arm) is ONE implementation. Returns the shipped verdict vocabulary
 * unchanged: `hold-arm` / `hold-suppress` / `ordinary-space`.
 */
export function resolveOrderHoldKeyDown(input: OrderHoldKeyDownInput): SpaceDownVerdict {
  return resolveSpaceKeyDown({
    holdArmed: input.holdArmed,
    isBarInputTarget: input.isOrderFieldTarget,
    queryIsEmpty: input.fieldIsEmpty,
    voiceUsable: input.voiceUsable,
    busy: input.busy,
    modified: input.modified,
    repeat: input.repeat,
  });
}

/**
 * Resolve the Space release on the order field.
 *
 * DELEGATED unchanged: `finalize` / `none` / `cancel-pending` / `tap-space` are
 * the shipped verdicts and the shipped precedence governs them. A cancel that
 * disarmed the gesture before the release yields `none` here, so a cancelled
 * gesture writes nothing.
 */
export function resolveOrderHoldKeyUp(input: OrderHoldKeyUpInput): SpaceUpVerdict {
  return resolveSpaceKeyUp({
    holdArmed: input.holdArmed,
    captureLive: input.captureLive,
    thresholdCrossed: input.thresholdCrossed,
  });
}

/**
 * The exact text a release verdict writes into the order field.
 *
 * DELEGATED to the shipped write table: `' '` (exactly one character) for
 * `tap-space` / `cancel-pending` / `no-words-space`, `''` for `finalize` /
 * `none`. "Exactly one ordinary space" therefore has ONE source, and a lost
 * space cannot be introduced on this surface without reddening the launcher's
 * own suite.
 */
export function orderSpaceWriteForVerdict(verdict: SpaceUpVerdict): string {
  return spaceWriteForVerdict(verdict);
}

/**
 * Every reason the order field's gesture is cancelled (R-2c).
 *
 * The three are separate EVENTS with separate consequences (an Escape leaves
 * the box open; the close control dismisses after cancelling; a blur leaves the
 * box open) but one shared contract: no dispatch, and **no space written**.
 */
export type OrderFieldCancelReason = 'escape' | 'close-control' | 'blur';

/**
 * Is `reason` a gesture cancel?
 *
 * Total over the closed union: all three of AC-2's cancels ARE cancels, which is
 * the contract this function exists to state in one place (the wiring asks THIS
 * question rather than growing a per-reason conditional). A reason outside the
 * union is refused loudly rather than silently treated as "not a cancel" — an
 * unhandled future cancel would otherwise leave a capture running.
 */
export function isOrderFieldCancelled(reason: OrderFieldCancelReason): true {
  switch (reason) {
    case 'escape':
    case 'close-control':
    case 'blur':
      return true;
    default:
      throw new Error(
        `unknown order-field cancel reason: ${String(reason as unknown)}`,
      );
  }
}

/**
 * Does the order field losing focus to `relatedTarget` cancel the gesture?
 *
 * The field-blur half of R-2c, and the reason the shipped launcher bar's
 * `onMouseDown={(e) => e.preventDefault()}` trick exists: clicking a control
 * INSIDE the composer blurs the textarea, and treating that as a cancel would
 * cancel the gesture twice for one click (the close control's own cancel plus
 * the blur) — announcing `Dictation cancelled` twice for one gesture.
 *
 * So focus moving to anything inside the composer root is NOT a cancel; focus
 * leaving the composer root (including leaving the window, where `relatedTarget`
 * is `null`) is.
 */
export function isOrderFieldBlurCancelling(
  relatedTarget: { contains(node: unknown): boolean } | null,
  composerRoot: { contains(node: unknown): boolean } | null,
): boolean {
  if (composerRoot === null) return true;
  if (relatedTarget === null) return true;
  return !composerRoot.contains(relatedTarget);
}
