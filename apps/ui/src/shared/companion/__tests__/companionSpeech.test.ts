/**
 * Spec #3243 ST-7 — the spoken reply seam (`companionSpeech.ts`).
 *
 * Pins the two halves AC-1's "spoken" clause actually needs, and the defects
 * the seam exists to make visible:
 *
 *   1. the sink always receives the EXACT reply text (visual == spoken);
 *   2. `claimed` records the SINK'S assertion and is never inferred — a host
 *      with no voice gets `claimed: false` and the sentence un-spoken, which is
 *      what stops a silent PASS;
 *   3. a new reply cancels the previous one FIRST (no overlapping utterances),
 *      and `seq` advances exactly once per handed utterance;
 *   4. nothing here throws on a hostile sink, and a blank reply leaves NO
 *      receipt (a stale receipt would claim an old sentence was the outcome).
 *
 * The G-520 control for (2) is the `false` half: a seam that ignored the sink's
 * return value would report `claimed: true` for a voice-less host and pass an
 * assertion written only as "a receipt exists".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPANION_SPEECH_SEQ_ATTR,
  COMPANION_SPOKEN_ATTR,
  cancelCompanionSpeech,
  readCompanionSpeechReceipt,
  registerCompanionSpeechSink,
  resetCompanionSpeechForTests,
  speakCompanionReply,
} from '../companionSpeech';
import type { CompanionSpeechSink } from '../companionSpeech';

function makeSink(claims = true): CompanionSpeechSink & {
  speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    speak: vi.fn(() => claims),
    cancel: vi.fn(),
  };
}

afterEach(() => {
  resetCompanionSpeechForTests();
});

describe('companionSpeech — the exact text reaches the platform', () => {
  it('hands the reply text verbatim to the sink and records it under a new seq', () => {
    const sink = makeSink(true);
    registerCompanionSpeechSink(sink);

    speakCompanionReply('Filled Rectangle in Wireframe');

    expect(sink.speak).toHaveBeenCalledTimes(1);
    expect(sink.speak).toHaveBeenCalledWith('Filled Rectangle in Wireframe');
    expect(readCompanionSpeechReceipt()).toEqual({
      text: 'Filled Rectangle in Wireframe',
      seq: 1,
      claimed: true,
    });
  });

  it('advances seq exactly once per handed utterance', () => {
    const sink = makeSink(true);
    registerCompanionSpeechSink(sink);

    speakCompanionReply('one');
    speakCompanionReply('two');
    speakCompanionReply('three');

    expect(readCompanionSpeechReceipt()?.seq).toBe(3);
    expect(readCompanionSpeechReceipt()?.text).toBe('three');
  });

  it('publishes the DOM mirror attribute names the reply surface stamps', () => {
    // The surface (ST-8) and any live probe must not drift on the spelling.
    expect(COMPANION_SPOKEN_ATTR).toBe('data-companion-spoken');
    expect(COMPANION_SPEECH_SEQ_ATTR).toBe('data-companion-speech-seq');
  });
});

describe('companionSpeech — no voice is never a silent PASS', () => {
  it('records claimed:false when the sink refuses to claim, and still hands the exact text', () => {
    // The defect world this rejects: a seam that reports speech it did not get.
    const sink = makeSink(false);
    registerCompanionSpeechSink(sink);

    speakCompanionReply('Deleted Rectangle in Wireframe');

    expect(sink.speak).toHaveBeenCalledWith('Deleted Rectangle in Wireframe');
    const receipt = readCompanionSpeechReceipt();
    expect(receipt?.text).toBe('Deleted Rectangle in Wireframe');
    expect(receipt?.claimed).toBe(false);
  });

  it('records claimed:false and speaks nothing when NO sink is registered', () => {
    speakCompanionReply('Done');

    const receipt = readCompanionSpeechReceipt();
    expect(receipt?.text).toBe('Done');
    expect(receipt?.claimed).toBe(false);
  });

  it('treats a sink that throws as un-claimed rather than propagating', () => {
    const throwing: CompanionSpeechSink = {
      speak: () => {
        throw new Error('platform exploded');
      },
      cancel: () => undefined,
    };
    registerCompanionSpeechSink(throwing);

    expect(() => speakCompanionReply('Done')).not.toThrow();
    expect(readCompanionSpeechReceipt()?.claimed).toBe(false);
  });
});

describe('companionSpeech — exactly one utterance at a time (R-1d)', () => {
  it('cancels the previous utterance BEFORE speaking the next', () => {
    const sink = makeSink(true);
    // Order matters: a sink that is spoken to before being cancelled overlaps.
    const callOrder: string[] = [];
    sink.cancel.mockImplementation(() => {
      callOrder.push('cancel');
    });
    sink.speak.mockImplementation(() => {
      callOrder.push('speak');
      return true;
    });
    registerCompanionSpeechSink(sink);

    speakCompanionReply('one');
    speakCompanionReply('two');

    expect(sink.cancel.mock.calls.length).toBeGreaterThanOrEqual(1);
    // The second utterance is preceded by a cancel; never two speaks in a row.
    expect(callOrder).toEqual(['cancel', 'speak', 'cancel', 'speak']);
  });

  it('cancelCompanionSpeech stops the platform utterance but keeps the receipt readable', () => {
    const sink = makeSink(true);
    registerCompanionSpeechSink(sink);

    speakCompanionReply('Done - Filled Rectangle in Wireframe');
    // Speaking already cancelled any PREVIOUS utterance; start counting from here
    // so this row measures the explicit cancel alone.
    sink.cancel.mockClear();

    cancelCompanionSpeech();

    expect(sink.cancel).toHaveBeenCalledTimes(1);
    // Cancelling must not rewrite the record of what was handed over.
    expect(readCompanionSpeechReceipt()?.text).toBe('Done - Filled Rectangle in Wireframe');
  });

  it('never throws when cancelling without a sink', () => {
    expect(() => cancelCompanionSpeech()).not.toThrow();
  });
});

describe('companionSpeech — the receipt cannot outlive its sentence', () => {
  it('leaves NO receipt for a blank reply (a stale receipt would claim an old outcome)', () => {
    const sink = makeSink(true);
    registerCompanionSpeechSink(sink);

    speakCompanionReply('one');
    speakCompanionReply('   ');

    expect(sink.speak).toHaveBeenCalledTimes(1);
    expect(readCompanionSpeechReceipt()).toBeNull();
  });

  it('reads null before anything is spoken', () => {
    expect(readCompanionSpeechReceipt()).toBeNull();
  });
});

describe('companionSpeech — the sink registry', () => {
  it('an unregistered sink receives nothing further', () => {
    const sink = makeSink(true);
    const unregister = registerCompanionSpeechSink(sink);

    speakCompanionReply('one');
    unregister();
    speakCompanionReply('two');

    expect(sink.speak).toHaveBeenCalledTimes(1);
    // The second call still mints a receipt: it was handed over (to nobody) and
    // did NOT claim speech, so the caller routes it to the visible leg.
    expect(readCompanionSpeechReceipt()).toEqual({ text: 'two', seq: 2, claimed: false });
  });

  it('a stale unregister never detaches a newer sink', () => {
    const first = makeSink(true);
    const second = makeSink(true);
    const unregisterFirst = registerCompanionSpeechSink(first);
    registerCompanionSpeechSink(second);

    unregisterFirst();
    speakCompanionReply('one');

    expect(second.speak).toHaveBeenCalledWith('one');
    expect(first.speak).not.toHaveBeenCalled();
  });
});
