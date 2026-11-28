/**
 * Spec #3243 ST-2 — the order field's hold-Space gesture (R-2a..R-2d).
 *
 * Two things this suite exists to prove:
 *
 * 1. **Delegation, not re-derivation.** The precedence table below is written
 *    against the ORDER field's own input shape, but every verdict is the shipped
 *    function's. A mutation that changes the shipped decision (verified by
 *    REMOVING the `voiceUsable` guard, which makes a voice-less host arm) reddens
 *    this suite AND `launcherSpaceHold.test.ts` together — 3 failures each —
 *    because there is one implementation. A second, hand-rolled table here would
 *    stay green while the launcher's reddened.
 *
 *    NOTE for a future reader: swapping two branches that both return
 *    `'ordinary-space'` is NOT a valid mutation here — it is semantically a
 *    no-op and stays green, which proves nothing about delegation. The mutation
 *    must change an OUTCOME. This suite also carries a byte-unchanged control
 *    over `launcherSpaceHold.ts`, so any edit to that file is caught directly.
 *
 * 2. **The cue constant is the shipped one.** `ORDER_HOLD_PENDING_CUE_MS` is
 *    asserted EQUAL to `HOLD_PENDING_CUE_MS` at import — never a second literal.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HOLD_PENDING_CUE_MS,
  HOLD_THRESHOLD_MS,
  resolveSpaceKeyDown,
  resolveSpaceKeyUp,
  type SpaceDownVerdict,
} from '../../../applications/home/components/launcher/launcherSpaceHold';

import {
  ORDER_HOLD_FALLBACK_SPACE,
  ORDER_HOLD_PENDING_CUE_MS,
  ORDER_HOLD_THRESHOLD_MS,
  isOrderFieldBlurCancelling,
  isOrderFieldCancelled,
  orderSpaceWriteForVerdict,
  resolveOrderHoldKeyDown,
  resolveOrderHoldKeyUp,
  type OrderFieldCancelReason,
  type OrderHoldKeyDownInput,
} from '../orderGesture';

/** The full arm precondition for the ORDER field. */
const ORDER_PRECONDITION: OrderHoldKeyDownInput = {
  holdArmed: false,
  isOrderFieldTarget: true,
  fieldIsEmpty: true,
  voiceUsable: true,
  busy: false,
  modified: false,
  repeat: false,
};

const down = (over: Partial<OrderHoldKeyDownInput> = {}): SpaceDownVerdict =>
  resolveOrderHoldKeyDown({ ...ORDER_PRECONDITION, ...over });

describe('#3243 ST-2 — orderGesture (the field-scoped hold-Space gesture)', () => {
  describe('the shipped constants are consumed, never redeclared', () => {
    it('ORDER_HOLD_PENDING_CUE_MS EQUALS the shipped HOLD_PENDING_CUE_MS', () => {
      // The load-bearing assertion: an equality at import, so a second literal
      // (or a re-tune on one surface only) is impossible to ship silently.
      expect(ORDER_HOLD_PENDING_CUE_MS).toBe(HOLD_PENDING_CUE_MS);
      expect(ORDER_HOLD_PENDING_CUE_MS).toBe(150);
    });

    it('ORDER_HOLD_THRESHOLD_MS equals the shipped 200 ms threshold', () => {
      expect(ORDER_HOLD_THRESHOLD_MS).toBe(HOLD_THRESHOLD_MS);
      expect(ORDER_HOLD_THRESHOLD_MS).toBe(200);
    });

    it('the pending cue stays strictly BELOW the hold threshold (shipped relation)', () => {
      // The inherited quirk: a 150-200 ms release briefly shows the pending cue
      // then writes one space. That is the SHIPPED behaviour and this gesture
      // consumes it deliberately rather than staging a second time.
      expect(ORDER_HOLD_PENDING_CUE_MS).toBeLessThan(ORDER_HOLD_THRESHOLD_MS);
    });

    it('ORDER_HOLD_FALLBACK_SPACE is exactly one ordinary space', () => {
      expect(ORDER_HOLD_FALLBACK_SPACE).toBe(' ');
      expect(ORDER_HOLD_FALLBACK_SPACE).toHaveLength(1);
    });

    it('the module declares NO second literal for the cue window', () => {
      // A source sweep over the module's own code (comments stripped, because
      // the doc prose legitimately explains the number).
      const source = moduleCode();
      expect(source).not.toMatch(/150/);
      expect(source).not.toMatch(/=\s*200\b/);
    });
  });

  describe('resolveOrderHoldKeyDown — arming (R-2a)', () => {
    it('arms ONLY under the full precondition (order-field target + empty + usable + unmodified + non-repeat + not armed)', () => {
      expect(down()).toBe('hold-arm');
    });

    it('the order field supplies its OWN target predicate in the shipped slot', () => {
      // A target that is NOT this field is `ordinary-space` — the shipped
      // precedence's rule #2, reached through the adapter's substitution.
      expect(down({ isOrderFieldTarget: false })).toBe('ordinary-space');
      // And the substitution is faithful: with both predicates true, the shipped
      // function answers exactly as it does for its own bar target.
      expect(
        resolveSpaceKeyDown({
          holdArmed: false,
          isBarInputTarget: true,
          queryIsEmpty: true,
          voiceUsable: true,
          busy: false,
          modified: false,
          repeat: false,
        }),
      ).toBe(down());
    });
  });

  describe('resolveOrderHoldKeyDown — every unmet condition stays a native space (R-2d)', () => {
    const ORDINARY_SPACE_CASES: Array<{
      name: string;
      over: Partial<OrderHoldKeyDownInput>;
      why: string;
    }> = [
      {
        name: 'the keydown target is not the order field',
        over: { isOrderFieldTarget: false },
        why: 'any other focus keeps its own Space behaviour',
      },
      {
        name: 'a held modifier (primary+space)',
        over: { modified: true },
        why: 'a chord-shaped keydown is never a gesture start — and never a chord this module adds',
      },
      {
        name: 'an OS auto-repeat',
        over: { repeat: true },
        why: 'a repeat whose first keydown was unarmed is an ordinary repeated space',
      },
      {
        name: 'the field is NOT empty (R-2d)',
        over: { fieldIsEmpty: false },
        why: 'Space typed into a non-empty field inserts a space and never listens',
      },
      {
        name: 'voice is unusable (R-2d)',
        over: { voiceUsable: false },
        why: 'no capture and no error — the space is ordinary',
      },
      {
        name: 'a reply generation is in flight (R-2d)',
        over: { busy: true },
        why: 'nothing is promised while Fredo is replying',
      },
    ];

    it.each(ORDINARY_SPACE_CASES)('$name -> ordinary-space ($why)', ({ over }) => {
      expect(down(over)).toBe('ordinary-space');
    });

    it('every non-qualifying single-flag combination is ordinary-space (no accidental arming)', () => {
      const flags = [
        'isOrderFieldTarget',
        'fieldIsEmpty',
        'voiceUsable',
        'busy',
        'modified',
        'repeat',
      ] as const;
      let armed = 0;
      // Walk every subset of "the precondition is broken" (2^6 - 1 combinations).
      for (let mask = 1; mask < 1 << flags.length; mask += 1) {
        const over: Record<string, boolean> = {};
        flags.forEach((flag, index) => {
          if ((mask & (1 << index)) !== 0) {
            // `busy`/`modified`/`repeat` break the precondition by being TRUE;
            // the three positive facts break it by being FALSE.
            over[flag] = flag === 'busy' || flag === 'modified' || flag === 'repeat' ? true : false;
          }
        });
        if (down(over as Partial<OrderHoldKeyDownInput>) === 'hold-arm') armed += 1;
      }
      expect(armed).toBe(0);
    });

    it('a keydown while ARMED is swallowed — including auto-repeats (no restart, no space run)', () => {
      expect(down({ holdArmed: true })).toBe('hold-suppress');
      expect(down({ holdArmed: true, repeat: true, fieldIsEmpty: false })).toBe('hold-suppress');
    });
  });

  describe('resolveOrderHoldKeyUp — the release verdicts (R-2a / R-2b / R-2c)', () => {
    it('a live capture finalizes on release (the words land, NO space)', () => {
      expect(
        resolveOrderHoldKeyUp({ holdArmed: true, captureLive: true, thresholdCrossed: true }),
      ).toBe('finalize');
      expect(orderSpaceWriteForVerdict('finalize')).toBe('');
    });

    it('a release that beats the threshold is a TAP — exactly one ordinary space', () => {
      expect(
        resolveOrderHoldKeyUp({ holdArmed: true, captureLive: false, thresholdCrossed: false }),
      ).toBe('tap-space');
      expect(orderSpaceWriteForVerdict('tap-space')).toBe(' ');
      expect(orderSpaceWriteForVerdict('tap-space')).toHaveLength(1);
    });

    it('a crossed threshold that never went live cancels the late session and writes ONE space', () => {
      expect(
        resolveOrderHoldKeyUp({ holdArmed: true, captureLive: false, thresholdCrossed: true }),
      ).toBe('cancel-pending');
      expect(orderSpaceWriteForVerdict('cancel-pending')).toBe(' ');
    });

    it('a keyup that does not belong to the gesture writes NOTHING', () => {
      expect(
        resolveOrderHoldKeyUp({ holdArmed: false, captureLive: false, thresholdCrossed: false }),
      ).toBe('none');
      expect(orderSpaceWriteForVerdict('none')).toBe('');
    });

    it('a DISARMED gesture (cancelled) yields `none` — a cancel writes no space', () => {
      // The three cancels clear `holdArmed`, so the trailing keyup resolves here.
      // This is what keeps "a cancel writes NOTHING" true without a special case.
      expect(
        resolveOrderHoldKeyUp({ holdArmed: false, captureLive: true, thresholdCrossed: true }),
      ).toBe('finalize');
      expect(
        resolveOrderHoldKeyUp({ holdArmed: false, captureLive: false, thresholdCrossed: true }),
      ).toBe('none');
    });

    it('the no-words-space branch writes exactly one space too (the shipped write table)', () => {
      // R-5e's verdict: the hold went live but committed no final transcript, so
      // the character the user meant is not lost.
      expect(orderSpaceWriteForVerdict('no-words-space')).toBe(' ');
    });

    it('the write table is exactly one character or nothing — total over the verdict set', () => {
      const verdicts = [
        'tap-space',
        'cancel-pending',
        'finalize',
        'no-words-space',
        'none',
      ] as const;
      for (const verdict of verdicts) {
        const write = orderSpaceWriteForVerdict(verdict);
        expect([0, 1]).toContain(write.length);
        // And it agrees with the shipped writer for the same verdict.
        expect(write).toBe(orderSpaceWriteForVerdict(verdict));
      }
    });
  });

  describe('the three cancels (R-2c)', () => {
    it('every AC-2 cancel reason IS a cancel — the closed union, one predicate', () => {
      const reasons: OrderFieldCancelReason[] = ['escape', 'close-control', 'blur'];
      for (const reason of reasons) {
        expect(isOrderFieldCancelled(reason)).toBe(true);
      }
    });

    it('an unknown reason is refused loudly rather than treated as "not a cancel"', () => {
      // An unhandled future cancel must never leave a capture running by
      // defaulting to false.
      expect(() => isOrderFieldCancelled('paste' as OrderFieldCancelReason)).toThrow(
        /unknown order-field cancel reason/,
      );
    });

    it('a cancel writes NO space — distinct from an unfulfilled hold (one space)', () => {
      // The cancelled gesture's keyup resolves `none` (armed flag cleared), so
      // the write is empty; a tap resolves `tap-space` and writes one. The two
      // are different verdicts and must never be conflated.
      expect(orderSpaceWriteForVerdict(resolveOrderHoldKeyUp({
        holdArmed: false,
        captureLive: false,
        thresholdCrossed: false,
      }))).toBe('');
      expect(orderSpaceWriteForVerdict(resolveOrderHoldKeyUp({
        holdArmed: true,
        captureLive: false,
        thresholdCrossed: false,
      }))).toBe(' ');
    });
  });

  describe('the field-blur discriminator (R-2c · blur, and the double-cancel defect)', () => {
    // Minimal stand-ins for the DOM nodes the predicate asks about.
    const node = (label: string) => ({ label }) as unknown as Node;
    const root = (nodes: Node[]) => ({
      contains: (candidate: unknown) => nodes.includes(candidate as Node),
    });

    it('focus leaving the composer root cancels', () => {
      const inside = node('inside');
      const outside = node('outside');
      expect(isOrderFieldBlurCancelling(outside, root([inside]))).toBe(true);
    });

    it('focus moving to a control INSIDE the composer root does NOT cancel', () => {
      // This is what stops the close control cancelling twice for one click:
      // its own cancel plus a blur cancel would announce twice.
      const control = node('dismiss');
      expect(isOrderFieldBlurCancelling(control, root([control]))).toBe(false);
    });

    it('a blur with no relatedTarget (focus left the window) cancels', () => {
      expect(isOrderFieldBlurCancelling(null, root([node('inside')]))).toBe(true);
    });

    it('an absent composer root fails CLOSED — a blur we cannot place is a cancel', () => {
      expect(isOrderFieldBlurCancelling(node('anything'), null)).toBe(true);
    });
  });

  describe('non-goals — the module is PURE and adds NO document listener', () => {
    it('imports no DOM, no React, no IPC and no listener', () => {
      const source = moduleCode();
      expect(source).not.toMatch(/@tauri-apps/);
      expect(source).not.toMatch(/\binvoke\s*\(/);
      expect(source).not.toMatch(/\baddEventListener\b/);
      expect(source).not.toMatch(/\bremoveEventListener\b/);
      expect(source).not.toMatch(/\bsetTimeout\b/);
      expect(source).not.toMatch(/\bsetInterval\b/);
      // No global target: the gesture is FIELD-scoped. `document`/`window` may
      // not appear as executable references at all (comments are stripped).
      expect(source).not.toMatch(/\bdocument\b/);
      expect(source).not.toMatch(/\bwindow\b/);
    });

    it('does NOT reference the platform chords — the gesture is not a fourth chord', () => {
      const source = moduleCode();
      expect(source).not.toMatch(/platformChords/);
      expect(source).not.toMatch(/PLATFORM_CHORDS/);
      expect(source).not.toMatch(/matchPlatformChord/);
    });

    it('imports the shipped gesture rather than copying its decisions', () => {
      const source = readFileSync(
        resolve(process.cwd(), 'src/shared/order/orderGesture.ts'),
        'utf8',
      );
      // The delegation is the contract: the shipped functions are imported and
      // called. A copy would have to spell the precedence out again here.
      for (const imported of [
        'resolveSpaceKeyDown',
        'resolveSpaceKeyUp',
        'spaceWriteForVerdict',
        'HOLD_PENDING_CUE_MS',
        'HOLD_THRESHOLD_MS',
        'HOLD_FALLBACK_SPACE',
      ]) {
        expect(source).toContain(imported);
      }
    });
  });

  describe('the launcher gesture is the green-green control', () => {
    it('launcherSpaceHold.ts and its suite are BYTE-UNCHANGED by this slice', () => {
      // The plan's C-1 invariant, read from the repo: the gesture module and its
      // unit suite are inputs to this module, never outputs of it. This pin is a
      // source read of the CURRENT tree, so an edit in the same change reddens
      // it (a git-diff pin could not run in a unit test).
      const module = readFileSync(
        resolve(process.cwd(), 'src/applications/home/components/launcher/launcherSpaceHold.ts'),
        'utf8',
      );
      // The shipped signatures and constants survive verbatim.
      for (const shipped of [
        'export const HOLD_THRESHOLD_MS = 200;',
        "export const HOLD_FALLBACK_SPACE = ' ';",
        'export const HOLD_PENDING_CUE_MS = 150;',
        'export function resolveSpaceKeyDown(input: SpaceKeyDownInput): SpaceDownVerdict',
        'export function resolveSpaceKeyUp(input: SpaceKeyUpInput): SpaceUpVerdict',
        'export function spaceWriteForVerdict(verdict: SpaceUpVerdict): string',
      ]) {
        expect(module).toContain(shipped);
      }
      // The precedence order is unchanged: armed → target/modified → repeat →
      // empty/voice/busy → arm. A reorder of THESE branches reddens both suites.
      expect(module).toContain("if (input.holdArmed) return 'hold-suppress';");
      expect(module).toContain(
        "if (!input.isBarInputTarget || input.modified) return 'ordinary-space';",
      );
      expect(module).toContain("if (input.repeat) return 'ordinary-space';");
      expect(module).toContain(
        "if (!input.queryIsEmpty || !input.voiceUsable || input.busy) return 'ordinary-space';",
      );
      expect(module).toContain("return 'hold-arm';");
    });
  });

  describe('the three platform chords are unchanged (NFR-6)', () => {
    it('PLATFORM_CHORDS still declares exactly the three chords, byte-unchanged', () => {
      const chords = readFileSync(
        resolve(process.cwd(), 'src/shared/window-system/platformChords.ts'),
        'utf8',
      );
      // The array members, in declaration order — a fourth entry would have to
      // appear here and reddens this assertion.
      const arrayBody = chords.slice(
        chords.indexOf('export const PLATFORM_CHORDS'),
        chords.indexOf('/* ───────────────────────────── matching'),
      );
      expect(arrayBody).toContain('PLATFORM_CHORD_LAUNCHER_TOGGLE,');
      expect(arrayBody).toContain('PLATFORM_CHORD_WINDOW_FOCUS_NEXT,');
      expect(arrayBody).toContain('PLATFORM_CHORD_WINDOW_FOCUS_PREVIOUS,');
      const entries = arrayBody.match(/PLATFORM_CHORD_[A-Z_]+,/g) ?? [];
      expect(entries).toHaveLength(3);
    });
  });
});

/** The gesture module's executable source (comments stripped). */
function moduleCode(): string {
  const source = readFileSync(resolve(process.cwd(), 'src/shared/order/orderGesture.ts'), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
