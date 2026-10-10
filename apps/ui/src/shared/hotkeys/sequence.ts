/**
 * Spec #3009 — the pure pending-sequence matcher + dispatch decision.
 *
 * PURE by design: no DOM/Tauri/React/clock. Given a normalized stroke, a focus
 * context, the pending prefix and the resolved bindings, it returns the ONE
 * `DispatchDecision` the engine acts on. The keydown path performs no IPC, no
 * store write and no React re-render.
 *
 * Precedence (binding — the SHIPPED order, minus the retired branches):
 *   1. terminal passthrough — every key reaches the PTY (no exit chord any more)
 *   2. modal — Escape belongs to the modal; modifier chords stay global; bare
 *      keys and multi-key sequences are suspended
 *   3. text-entry — typed characters pass verbatim; only modifier chords are global
 *   4. native consumer — a focused control acting on a bare key wins; never arm
 *   5. pending sequence continuation (exact / pending / invalid)
 *   6. fresh key — single-chord match / sequence arming
 *
 * The retired branches (raw macro recording, interaction-context unwind, leader
 * arming) are deleted: their owning modules are gone.
 */

import { keyStrokeEquals, isModifierChord } from './keys';
import {
  type DispatchDecision,
  type FocusContext,
  type HotkeyResetReason,
  type KeySequence,
  type KeyStroke,
  type Platform,
  type ResolvedBinding,
} from './types';

/** The result of matching a candidate step list against the resolved bindings. */
export type SequenceMatch =
  | { readonly kind: 'exact'; readonly binding: ResolvedBinding }
  | { readonly kind: 'prefix'; readonly bindings: readonly ResolvedBinding[] }
  | { readonly kind: 'none' };

/** The matcher's input (the pure core of `decideDispatch`). */
export interface DispatchInput {
  readonly stroke: KeyStroke;
  readonly context: FocusContext;
  readonly pending: KeySequence | null;
  readonly bindings: readonly ResolvedBinding[];
  /** The focused control would itself act on this bare key (tile/button/input). */
  readonly nativeConsumes: boolean;
  readonly platform?: Platform;
}

/**
 * Match a candidate step list against the bindings. EXACT beats PREFIX; a prefix
 * result lists every binding the candidate could still grow into.
 */
export function matchSequence(
  steps: KeySequence,
  bindings: readonly ResolvedBinding[],
  platform?: Platform,
): SequenceMatch {
  if (steps.length === 0) return { kind: 'none' };
  const prefix: ResolvedBinding[] = [];
  for (const binding of bindings) {
    const candidate = binding.sequence;
    if (candidate.length < steps.length) continue;
    let matches = true;
    for (let i = 0; i < steps.length; i += 1) {
      if (!keyStrokeEquals(steps[i], candidate[i], platform)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (candidate.length === steps.length) return { kind: 'exact', binding };
    prefix.push(binding);
  }
  if (prefix.length > 0) return { kind: 'prefix', bindings: prefix };
  return { kind: 'none' };
}

/** The pure decision for a timer/abandon reset (no keystroke is present). */
export function sequenceResetDecision(reason: HotkeyResetReason): DispatchDecision {
  return {
    outcome: 'suppress',
    consumed: reason === 'escape' || reason === 'invalid',
    reason: `sequence-${reason}`,
  };
}

function matchDecision(binding: ResolvedBinding): DispatchDecision {
  return {
    outcome: 'match',
    action: binding.action,
    consumed: true,
    reason: `match:${binding.actionId}`,
  };
}

function suppress(reason: string): DispatchDecision {
  return { outcome: 'suppress', consumed: true, reason };
}

function passthrough(reason: string): DispatchDecision {
  return { outcome: 'passthrough', consumed: false, reason };
}

function arm(reason: string): DispatchDecision {
  return { outcome: 'arm-sequence', consumed: true, reason };
}

/**
 * The ONE pure dispatch decision. See the module header for the binding
 * precedence.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  const { stroke, context, pending, bindings, nativeConsumes, platform } = input;

  // 1. Terminal passthrough (R-2.4): every keystroke reaches the PTY. The
  //    retired exit chord no longer exists — the keyboard is released by
  //    click-away / focus change.
  if (context === 'terminal') {
    return passthrough('terminal-passthrough');
  }

  // 2. Modal: the modal owns the keyboard. Escape is left to the modal;
  //    modifier chords remain global; bare keys and sequences are suspended.
  if (context === 'modal') {
    if (pending !== null && pending.length > 0) return passthrough('sequence-focus-change');
    if (stroke.key === 'escape') return passthrough('modal-escape');
    if (!isModifierChord(stroke)) return passthrough('modal-suspend');
    const chord = matchSequence([stroke], bindings, platform);
    if (chord.kind === 'exact') return matchDecision(chord.binding);
    return passthrough('modal-chord-unbound');
  }

  // 3. Text entry (R-2.3): typed characters pass through verbatim; bare-key and
  //    sequence bindings are suppressed; modifier chords remain global.
  if (context === 'text-entry') {
    if (pending !== null && pending.length > 0) return passthrough('sequence-focus-change');
    if (!isModifierChord(stroke)) return passthrough('text-entry-passthrough');
    const chord = matchSequence([stroke], bindings, platform);
    if (chord.kind === 'exact') return matchDecision(chord.binding);
    return passthrough('text-entry-chord-unbound');
  }

  // 4. Native consumer: a focused control acting on a bare key wins and the
  //    engine never arms a sequence from it.
  if (nativeConsumes && !isModifierChord(stroke) && pending === null) {
    return passthrough('native-consumes');
  }

  // 5. Pending-sequence continuation.
  if (pending !== null && pending.length > 0) {
    const next = [...pending, stroke];
    const result = matchSequence(next, bindings, platform);
    if (result.kind === 'exact') return matchDecision(result.binding);
    if (result.kind === 'prefix') {
      return { outcome: 'pending', consumed: true, reason: 'sequence-pending' };
    }
    // An abandoning key is consumed but never re-dispatched.
    if (stroke.key === 'escape') return suppress('sequence-escape');
    return suppress('sequence-invalid');
  }

  // 6. Fresh key: exact single-chord match, then sequence arming.
  const single = matchSequence([stroke], bindings, platform);
  if (single.kind === 'exact') return matchDecision(single.binding);
  if (single.kind === 'prefix') return arm('sequence-armed');
  return passthrough('unbound');
}
