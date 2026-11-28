/**
 * Spec #3243 ST-8 — the platform sink for the companion speech seam.
 *
 * `companionSpeech.ts` (ST-7) is deliberately free of the platform: it records
 * what it handed over and whether the speaker CLAIMED it, and nothing else. This
 * module is the other half — the ONE place `window.speechSynthesis` is touched,
 * and the ONE place the Doom Mode gate is read.
 *
 * # Why the gate is read HERE and not in the seam
 *
 * `docs/SECURITY.md` claims that **no audio is emitted while Doom Mode is
 * active**. Before this slice that was true because there was no output surface
 * at all; now the claim is carried by suppression, which means the suppression
 * must sit on the only path that can emit. Reading the gate in the seam would
 * leave a registered sink able to outlive the gate; reading it per `speak` call
 * means a sink that outlives a mode change still cannot emit.
 *
 * # Why `speak` returns a claim rather than assuming one
 *
 * WebView2 makes no promise that a platform voice is installed. A sink that
 * returned `true` unconditionally would make every voice-less host read as a
 * spoken turn — the silent PASS the seam's `claimed` flag exists to prevent. So
 * the sink reports `true` ONLY when it genuinely handed the utterance over with a
 * voice present, and `false` for "suppressed" and for "no voice on this host"
 * alike. The two are the same to the caller (route the sentence to the visible
 * leg), and `describeCompanionVoiceAvailability()` is how a round NAMES which one
 * it hit.
 */

import { isPerformanceGateActive } from '../doom-mode/performanceGate';
import type { CompanionSpeechSink } from './companionSpeech';

/** The subset of `SpeechSynthesisVoice` this module reads. */
export interface CompanionPlatformVoice {
  readonly voiceURI?: string;
  readonly name?: string;
  readonly lang?: string;
}

/** The subset of `SpeechSynthesis` / `SpeechSynthesisUtterance` this module uses. */
export interface CompanionSpeechPlatform {
  readonly speaking?: boolean;
  getVoices?(): ReadonlyArray<CompanionPlatformVoice>;
  speak?(utterance: unknown): void;
  cancel?(): void;
}

/** What this host can actually do — the probe a round records as a named blocker. */
export interface CompanionVoiceAvailability {
  /** Does the platform expose a speech synthesizer at all? */
  readonly synthesisAvailable: boolean;
  /** How many installed voices it reports. `0` ⇒ nothing can be spoken. */
  readonly voiceCount: number;
  /** True while Doom Mode suppresses output (the gate is a live read). */
  readonly suppressed: boolean;
}

/** The platform, read from the current global without statically touching Tauri. */
function readPlatform(): CompanionSpeechPlatform | null {
  if (typeof window === 'undefined') return null;
  const synth = (window as unknown as { speechSynthesis?: CompanionSpeechPlatform }).speechSynthesis;
  return synth ?? null;
}

/**
 * Probe this host's voice availability.
 *
 * `voiceCount: 0` is the reading that turns AC-1's spoken leg into a **named
 * blocker** on a voice-less host — never a silent PASS. It is a live read, so a
 * round can paste it.
 */
export function describeCompanionVoiceAvailability(): CompanionVoiceAvailability {
  const platform = readPlatform();
  const voices = platform?.getVoices?.() ?? [];
  return {
    synthesisAvailable: platform !== null && typeof platform.speak === 'function',
    voiceCount: voices.length,
    suppressed: isPerformanceGateActive(),
  };
}

/**
 * Build the platform sink. Registered once per webview by the hosting entity.
 *
 * `speak` claims the utterance ONLY when a synthesizer exists, a voice is
 * installed, and Doom Mode is not suppressing output. Each of those is a
 * separate refusal so a probe can tell them apart, and none of them throws: a
 * platform that fires an error asynchronously must not abort a settle path.
 */
export function createCompanionSpeechSink(): CompanionSpeechSink {
  let lastUtterance: unknown = null;

  return {
    speak(text: string): boolean {
      const platform = readPlatform();
      if (platform === null || typeof platform.speak !== 'function') return false;
      // Doom Mode suppresses the OUTPUT exactly as it suppresses the input
      // pipeline — this is what keeps SECURITY.md's claim true.
      if (isPerformanceGateActive()) return false;
      // No installed voice means nothing can be spoken. Claiming it would be the
      // silent PASS this whole seam exists to prevent.
      const voices = platform.getVoices?.() ?? [];
      if (voices.length === 0) return false;

      try {
        const Ctor = (window as unknown as {
          SpeechSynthesisUtterance?: new (value: string) => unknown;
        }).SpeechSynthesisUtterance;
        if (typeof Ctor !== 'function') return false;
        const utterance = new Ctor(text);
        lastUtterance = utterance;
        platform.speak(utterance);
        return true;
      } catch {
        // A platform that throws never aborts the caller's settle.
        return false;
      }
    },

    cancel(): void {
      lastUtterance = null;
      const platform = readPlatform();
      if (platform === null || typeof platform.cancel !== 'function') return;
      try {
        platform.cancel();
      } catch {
        // Cancel is best-effort by contract.
      }
    },
  };
}

/**
 * The platform's OWN speaking fact — the SECOND, independent observable AC-1
 * binds (the seam's receipt cannot prove the platform spoke; this cannot prove
 * WHICH sentence).
 */
export function readCompanionPlatformSpeaking(): boolean {
  return readPlatform()?.speaking === true;
}
