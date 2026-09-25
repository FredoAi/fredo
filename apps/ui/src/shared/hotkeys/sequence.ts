/**
 * Spec #2946 ST-1 — the pure pending-sequence matcher + dispatch decision
 * (plan contract block 4, R-3.1/R-3.5/R-5.3/R-5.5/R-5.7/R-5.9).
 *
 * PURE by design: no DOM/Tauri/React/clock. Given a normalized stroke, a focus
 * context, the pending prefix and the resolved bindings, it returns the ONE
 * `DispatchDecision` the engine acts on. The keydown path performs no IPC, no
 * store write and no React re-render.
 *
 * Precedence (binding):
 *   1. raw macro recording — only the recording-stop binding + Escape get through
 *   2. terminal passthrough — everything reaches the PTY except the exit chord
 *   3. modal — Escape belongs to the modal; modifier chords stay global; bare
 *      keys and multi-key sequences are suspended
 *   4. text-entry — typed characters pass verbatim; only modifier chords are global
 *   5. native consumer — a focused control acting on a bare key wins; never arm
 *   6. pending sequence continuation (exact / pending / invalid)
 *   7. fresh key — leader arming, single-chord match, sequence arming
 */

import { keyStrokeEquals, isModifierChord } from './keys';
import {
  MACRO_RECORD_TOGGLE_ACTION_ID,
  TERMINAL_EXIT_ACTION_ID,
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
  readonly leader: KeyStroke | null;
  readonly macroRecording: boolean;
  /** The focused control would itself act on this bare key (tile/button/separator). */
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

/** Find a single-stroke binding for `stroke`, optionally scoped to one action. */
function findSingleBinding(
  stroke: KeyStroke,
  bindings: readonly ResolvedBinding[],
  platform: Platform | undefined,
  actionId?: string,
): ResolvedBinding | null {
  for (const binding of bindings) {
    if (actionId !== undefined && binding.actionId !== actionId) continue;
    if (binding.sequence.length === 1 && keyStrokeEquals(binding.sequence[0], stroke, platform)) {
      return binding;
    }
  }
  return null;
}

/** True when any binding is a `@leader …` sequence. */
function hasLeaderPrefix(bindings: readonly ResolvedBinding[]): boolean {
  return bindings.some(
    (binding) => binding.sequence.length > 1 && binding.sequence[0]?.key === '@leader',
  );
}

/**
 * The ONE pure dispatch decision (contract block 4). See the module header for
 * the binding precedence.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  const { stroke, context, pending, bindings, leader, macroRecording, nativeConsumes, platform } =
    input;

  // 1. Raw macro recording: R-3.9 — suspend all dispatch except the
  //    recording-stop binding and Escape.
  if (macroRecording) {
    if (stroke.key === 'escape') return suppress('macro-recording-escape');
    const stop = findSingleBinding(stroke, bindings, platform, MACRO_RECORD_TOGGLE_ACTION_ID);
    if (stop) return matchDecision(stop);
    return suppress('macro-recording');
  }

  // 2. Terminal passthrough (R-5.7): every keystroke reaches the PTY; only the
  //    designated exit binding leaves passthrough and is consumed.
  if (context === 'terminal') {
    const exit = findSingleBinding(stroke, bindings, platform, TERMINAL_EXIT_ACTION_ID);
    if (exit) return matchDecision(exit);
    return passthrough('terminal-passthrough');
  }

  // 3. Modal (R-5.6): the modal owns the keyboard. Escape is left to the modal;
  //    modifier chords remain global; bare keys and sequences are suspended.
  if (context === 'modal') {
    if (pending !== null && pending.length > 0) return passthrough('sequence-focus-change');
    if (stroke.key === 'escape') return passthrough('modal-escape');
    if (!isModifierChord(stroke)) return passthrough('modal-suspend');
    const chord = matchSequence([stroke], bindings, platform);
    if (chord.kind === 'exact') return matchDecision(chord.binding);
    return passthrough('modal-chord-unbound');
  }

  // 4. Text entry (R-5.5): typed characters pass through verbatim; bare-key and
  //    sequence bindings are suppressed; modifier chords remain global.
  if (context === 'text-entry') {
    if (pending !== null && pending.length > 0) return passthrough('sequence-focus-change');
    if (!isModifierChord(stroke)) return passthrough('text-entry-passthrough');
    const chord = matchSequence([stroke], bindings, platform);
    if (chord.kind === 'exact') return matchDecision(chord.binding);
    return passthrough('text-entry-chord-unbound');
  }

  // 5. Native consumer (R-5.5/R-3.10): a focused control acting on a bare key
  //    wins and the engine never arms a sequence from it.
  if (nativeConsumes && !isModifierChord(stroke) && pending === null) {
    return passthrough('native-consumes');
  }

  // 6. Pending-sequence continuation.
  if (pending !== null && pending.length > 0) {
    const next = [...pending, stroke];
    const result = matchSequence(next, bindings, platform);
    if (result.kind === 'exact') return matchDecision(result.binding);
    if (result.kind === 'prefix') {
      return { outcome: 'pending', consumed: true, reason: 'sequence-pending' };
    }
    // R-3.6/R-3.5: an abandoning key is consumed but never re-dispatched.
    if (stroke.key === 'escape') return suppress('sequence-escape');
    return suppress('sequence-invalid');
  }

  // 7. Fresh key: leader arming, then exact single-chord, then sequence arming.
  if (leader && keyStrokeEquals(stroke, leader, platform) && hasLeaderPrefix(bindings)) {
    return arm('leader-armed');
  }
  const single = matchSequence([stroke], bindings, platform);
  if (single.kind === 'exact') return matchDecision(single.binding);
  if (single.kind === 'prefix') return arm('sequence-armed');
  return passthrough('unbound');
}
