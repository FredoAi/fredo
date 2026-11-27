/**
 * Spec #3243 ST-7 — the spoken reply seam (AC-1's "shown **and** spoken" clause).
 *
 * There is no audio-output surface anywhere in this tree (Domain Model §0), so
 * this module is NEW capability, not wiring: it is the ONE place a companion
 * reply is handed to a platform speaker, and the ONE place its receipt is read.
 *
 * ── Why a seam and not a direct `speechSynthesis` call ──────────────────────
 * The webview's platform speech may have NO installed voice (WebView2 makes no
 * promise). A speaker called directly from product code would then fail
 * silently, and a machine with no voice would report a **silent PASS** on AC-1.
 * So the product speaks through this seam, the seam records what it handed over
 * *and* whether the platform claimed it, and a live probe reads the platform's
 * own `speechSynthesis.speaking` as the **independent second observable**
 * (F-3). Neither reading alone can tell a working voice from a missing one:
 *
 *   - the seam's receipt alone cannot prove the platform spoke;
 *   - the platform's `speaking` alone cannot prove WHICH sentence was spoken.
 *
 * `speakCompanionReply` therefore records `claimed` — the sink's synchronous
 * assertion that the platform accepted the utterance with a usable voice — and
 * NEVER infers it. A sink that cannot claim (no voice, or output suppressed by
 * Doom Mode) returns `false`, the receipt says `claimed: false`, and the caller
 * routes the sentence to the ONE polite live region instead (the one-channel
 * rule, UI/UX §7). The seam never asserts speech it did not obtain.
 *
 * ── What this module deliberately does NOT do ──────────────────────────────
 *   - No `window.speechSynthesis`, no `SpeechSynthesisUtterance`, no platform
 *     branch: the platform sink is registered by the caller (ST-8) through
 *     `registerCompanionSpeechSink`. That keeps this module unit-testable with
 *     a stub sink and keeps the platform's quirks in one place.
 *   - No Doom Mode check: the gate is read BY THE SINK (`isPerformanceGateActive`
 *     from `../doom-mode/performanceGate`), which is what keeps
 *     `docs/SECURITY.md`'s "no audio is emitted" claim true while the mode is
 *     active. A gate read here would let a registered sink outlive the gate.
 *   - No queue: exactly one utterance is live at a time (R-1d). A queue would
 *     play a backlog of stale outcomes at a fast user.
 *   - No network: the seam is local-only (NFR-1).
 *
 * Module-scoped by design (engineering rule): React refs reset across
 * mount/unmount and the receipt must survive the composer card closing.
 */

/** The platform speaker the caller registers. */
export interface CompanionSpeechSink {
  /**
   * Hand `text` to the platform. Returns `true` IFF the platform CLAIMED the
   * utterance — a usable voice exists and it accepted the request. `false`
   * means "handed over, but not spoken here" (no voice, or output suppressed).
   * A sink must never return `true` it cannot stand behind: that is the silent
   * PASS this seam exists to prevent.
   */
  speak(text: string): boolean;
  /** Stop the live utterance, if any. Must be idempotent and must never throw. */
  cancel(): void;
}

/**
 * What the seam handed to the platform — derived from the run, never authored.
 * `claimed` is the seam's record of the sink's assertion, not an observation of
 * audio; the platform's own `speechSynthesis.speaking` is the second reading.
 */
export interface CompanionSpeechReceipt {
  /** The EXACT text handed to the sink (byte-identical to the rendered reply). */
  readonly text: string;
  /** Monotonic per handed utterance — advances exactly once per settle. */
  readonly seq: number;
  /** True IFF the platform claimed the utterance. Never inferred, never defaulted. */
  readonly claimed: boolean;
}

/**
 * The DOM mirrors of the receipt, stamped by the reply surface (ST-8) so a live
 * DOM probe can read the seam without a second channel. Exported as constants
 * so the surface and the probe cannot drift on the attribute spelling.
 */
export const COMPANION_SPOKEN_ATTR = 'data-companion-spoken';
export const COMPANION_SPEECH_SEQ_ATTR = 'data-companion-speech-seq';

let activeSink: CompanionSpeechSink | null = null;
let currentReceipt: CompanionSpeechReceipt | null = null;
let seq = 0;

/**
 * Register the platform sink. Returns the unregister function (idempotent; a
 * stale unregister never clears a newer sink — the `skillBridge` shape).
 * Passing `null` detaches the current sink.
 */
export function registerCompanionSpeechSink(sink: CompanionSpeechSink | null): () => void {
  activeSink = sink;
  return () => {
    if (activeSink === sink) activeSink = null;
  };
}

/**
 * Speak ONE reply (R-1c). The previous utterance is cancelled first, so exactly
 * one outcome is ever live (R-1d).
 *
 * A blank/whitespace-only `text` is NOT spoken and leaves NO receipt: nothing
 * was handed to the platform, so the seam must not keep pointing at an earlier
 * sentence — a stale receipt would read as "the current outcome was spoken",
 * which is the silent-PASS shape in another medium.
 */
export function speakCompanionReply(text: string): void {
  // Supersede FIRST: a new outcome always replaces the previous one, whether or
  // not this call ends up claiming speech.
  cancelCompanionSpeech();

  if (text.trim() === '') {
    currentReceipt = null;
    return;
  }

  seq += 1;
  const sink = activeSink;
  let claimed = false;
  if (sink !== null) {
    try {
      claimed = sink.speak(text) === true;
    } catch {
      // A speaker that throws must never abort the caller's settle path: the
      // sentence is simply not spoken, the receipt says so, and the visible leg
      // carries it (the `skillBridge` never-throw contract).
      claimed = false;
    }
  }

  currentReceipt = { text, seq, claimed };
}

/**
 * Stop the live utterance. Called on every supersede (above) and by the caller
 * on unmount, so no two utterances overlap and none outlives its surface.
 *
 * The RECEIPT is deliberately left intact: it records what was handed over at
 * speak time, and F-4 reads its `seq` progression. Cancelling does not unsay
 * the sentence, so it must not rewrite the record of it.
 */
export function cancelCompanionSpeech(): void {
  const sink = activeSink;
  if (sink === null) return;
  try {
    sink.cancel();
  } catch {
    // Never throw on teardown/supersede.
  }
}

/** The current receipt, or `null` when nothing has been handed over. */
export function readCompanionSpeechReceipt(): CompanionSpeechReceipt | null {
  return currentReceipt;
}

/** Test-only: drop the sink, the receipt and the seq counter. */
export function resetCompanionSpeechForTests(): void {
  activeSink = null;
  currentReceipt = null;
  seq = 0;
}
