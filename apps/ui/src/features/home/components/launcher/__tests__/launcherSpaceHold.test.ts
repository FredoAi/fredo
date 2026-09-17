/**
 * Spec #2882 ST-2 — pure hold-Space gesture contract (R-2.1, R-2.2, R-2.6, R-2.7,
 * R-3.1, R-3.2, R-3.3).
 *
 * Product-unit pin only: this suite drives the PURE module, not the wired shell
 * (ST-5 owns the timer/listeners/mic; ST-9/QA own the live legs). It pins the
 * headline typing-safety property — a Space may only be consumed under the FULL
 * R-2.1 precondition, and every no-capture release writes EXACTLY one ordinary
 * space — so a lost-space regression cannot be introduced silently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HOLD_FALLBACK_SPACE,
  HOLD_PENDING_CUE_MS,
  HOLD_THRESHOLD_MS,
  resolveSpaceKeyDown,
  resolveSpaceKeyUp,
  spaceWriteForVerdict,
  type SpaceDownVerdict,
  type SpaceKeyDownInput,
  type SpaceKeyUpInput,
  type SpaceUpVerdict,
} from '../launcherSpaceHold';

/** The FULL R-2.1 precondition: the bar's search input focused, an empty query,
 *  voice enabled with a ready model, no generation in flight, unmodified,
 *  non-repeat, and no hold armed yet. Every negative case below flips exactly one
 *  flag off this baseline. */
const PRECONDITION: SpaceKeyDownInput = {
  holdArmed: false,
  isBarInputTarget: true,
  queryIsEmpty: true,
  voiceUsable: true,
  busy: false,
  modified: false,
  repeat: false,
};

const down = (over: Partial<SpaceKeyDownInput> = {}): SpaceDownVerdict =>
  resolveSpaceKeyDown({ ...PRECONDITION, ...over });

const up = (over: Partial<SpaceKeyUpInput> = {}): SpaceUpVerdict =>
  resolveSpaceKeyUp({ holdArmed: false, captureLive: false, thresholdCrossed: false, ...over });

describe('#2882 ST-2 — launcherSpaceHold (pure hold-Space gesture)', () => {
  describe('the exported constants are pinned', () => {
    it('HOLD_THRESHOLD_MS is the binding 200 ms hold threshold (contract 4b)', () => {
      expect(HOLD_THRESHOLD_MS).toBe(200);
    });

    it('HOLD_PENDING_CUE_MS is 150 and strictly BELOW the hold threshold', () => {
      expect(HOLD_PENDING_CUE_MS).toBe(150);
      // The `starting voice input…` cue can never be reached by a gesture that has
      // not even crossed the hold threshold.
      expect(HOLD_PENDING_CUE_MS).toBeLessThan(HOLD_THRESHOLD_MS);
    });

    it('HOLD_FALLBACK_SPACE is EXACTLY one ordinary space character', () => {
      expect(HOLD_FALLBACK_SPACE).toBe(' ');
      expect(HOLD_FALLBACK_SPACE).toHaveLength(1);
    });
  });

  describe('resolveSpaceKeyDown — arming (R-2.1)', () => {
    it('arms ONLY under the full precondition (focused bar input + empty + usable + unmodified + non-repeat + not armed)', () => {
      expect(resolveSpaceKeyDown(PRECONDITION)).toBe('hold-arm');
    });
  });

  describe('resolveSpaceKeyDown — every unmet condition stays a native space (R-3.1/R-3.2/R-3.3)', () => {
    const ORDINARY_SPACE_CASES: Array<{
      name: string;
      over: Partial<SpaceKeyDownInput>;
      why: string;
    }> = [
      {
        name: 'the keydown target is not the bar search input',
        over: { isBarInputTarget: false },
        why: "the grid's focused-tile Space-opens-the-tile behaviour must stay untouched",
      },
      {
        name: 'the chord is modified',
        over: { modified: true },
        why: 'Ctrl+Space is the launcher toggle; Shift+Space belongs to #2883',
      },
      {
        name: 'the keydown is an OS auto-repeat',
        over: { repeat: true },
        why: 'a repeat whose first keydown was unarmed is an ordinary repeated space',
      },
      {
        name: 'the query is not empty (R-3.1)',
        over: { queryIsEmpty: false },
        why: 'Space typed into a non-empty input inserts a space and never listens',
      },
      {
        name: 'voice input is disabled (R-3.2)',
        over: { voiceUsable: false },
        why: 'no capture, no error — the space is ordinary',
      },
      {
        name: 'the voice model is not ready (R-3.3)',
        over: { voiceUsable: false },
        why: 'the ST-3 probe is fail-closed, so nothing is attempted and no error is surfaced',
      },
      {
        name: 'a companion generation is in flight',
        over: { busy: true },
        why: 'nothing is promised while Fredo is replying',
      },
    ];

    it.each(ORDINARY_SPACE_CASES)('$name -> ordinary-space ($why)', ({ over }) => {
      expect(down(over)).toBe('ordinary-space');
    });

    it('yields ordinary-space — never hold-arm — for all 2^7-1 non-qualifying combinations', () => {
      const flags = [
        'holdArmed',
        'isBarInputTarget',
        'queryIsEmpty',
        'voiceUsable',
        'busy',
        'modified',
        'repeat',
      ] as const;
      const arms: SpaceKeyDownInput[] = [];

      for (let mask = 0; mask < 1 << flags.length; mask += 1) {
        const input: SpaceKeyDownInput = { ...PRECONDITION };
        flags.forEach((flag, index) => {
          input[flag] = ((mask >> index) & 1) === 1;
        });

        const verdict = resolveSpaceKeyDown(input);
        if (input.holdArmed) {
          // Precedence 1 (R-2.2): armed swallows EVERY keydown.
          expect(verdict).toBe('hold-suppress');
        } else if (verdict === 'hold-arm') {
          arms.push(input);
        } else {
          expect(verdict).toBe('ordinary-space');
        }
      }

      // Exactly ONE combination in the whole input space may arm a hold — the
      // full precondition itself (an already-armed hold resolves to `hold-suppress`).
      expect(arms).toHaveLength(1);
      expect(arms[0]).toEqual(PRECONDITION);
    });
  });

  describe('resolveSpaceKeyDown — armed swallows everything (R-2.2)', () => {
    it('suppresses every subsequent keydown, including the auto-repeat', () => {
      expect(down({ holdArmed: true, repeat: true })).toBe('hold-suppress');
    });

    it('hold-suppress outranks every other condition (precedence 1 is absolute)', () => {
      const hostile: Array<Partial<SpaceKeyDownInput>> = [
        {},
        { repeat: true },
        { modified: true },
        { isBarInputTarget: false },
        { queryIsEmpty: false },
        { voiceUsable: false },
        { busy: true },
        {
          isBarInputTarget: false,
          queryIsEmpty: false,
          voiceUsable: false,
          busy: true,
          modified: true,
          repeat: true,
        },
      ];

      const verdicts = hostile.map((over) => down({ ...over, holdArmed: true }));

      // Exactly one member of the union ever comes back while armed.
      expect(new Set(verdicts)).toEqual(new Set(['hold-suppress']));
    });
  });

  describe('resolveSpaceKeyDown — the precedence order is binding', () => {
    it('a repeat is suppressed (never ordinary-space) while armed — precedence 1 over 3', () => {
      expect(down({ holdArmed: true, repeat: true })).toBe('hold-suppress');
      expect(down({ holdArmed: false, repeat: true })).toBe('ordinary-space');
    });

    it('a modified or non-target Space is native — precedence 2 over the repeat/precondition rows', () => {
      // Even with the query non-empty, voice unusable and a repeat — but a
      // non-target or modified chord — the native path still wins (never arm).
      const saturated: Partial<SpaceKeyDownInput> = {
        queryIsEmpty: false,
        voiceUsable: false,
        busy: true,
        repeat: true,
      };
      expect(down({ ...saturated, modified: true })).toBe('ordinary-space');
      expect(down({ ...saturated, isBarInputTarget: false })).toBe('ordinary-space');
    });

    it('a repeat of an unarmed precondition-qualifying Space is still just a repeat', () => {
      expect(down({ repeat: true })).toBe('ordinary-space');
    });
  });

  describe('resolveSpaceKeyUp — the four release verdicts', () => {
    it("finalize: the capture went live -> the release is the FINALIZE control (R-2.3)", () => {
      expect(up({ holdArmed: true, captureLive: true, thresholdCrossed: true })).toBe('finalize');
    });

    it('finalize is decided by the live capture alone (the live flag is authoritative)', () => {
      // A launcher-origin capture can only have gone live past the threshold, but
      // the live flag — not the timer flag — owns the release resolution.
      expect(up({ holdArmed: true, captureLive: true, thresholdCrossed: false })).toBe('finalize');
      expect(up({ holdArmed: false, captureLive: true, thresholdCrossed: true })).toBe('finalize');
    });

    it('cancel-pending: threshold crossed but the engine never went live (R-2.6)', () => {
      expect(up({ holdArmed: true, captureLive: false, thresholdCrossed: true })).toBe(
        'cancel-pending',
      );
    });

    it('tap-space: the release beat the threshold (R-2.7)', () => {
      expect(up({ holdArmed: true, captureLive: false, thresholdCrossed: false })).toBe('tap-space');
    });

    it('none: a keyup that does not belong to this gesture', () => {
      expect(up({ holdArmed: false, captureLive: false, thresholdCrossed: false })).toBe('none');
      // A disarmed gesture (Escape / the visible ×) clears `holdArmed`, so the
      // trailing keyup resolves to none — no space lands (D5).
      expect(up({ holdArmed: false, captureLive: false, thresholdCrossed: true })).toBe('none');
    });

    it('is total and mutually exclusive over the whole 2^3 input space', () => {
      const keys = ['holdArmed', 'captureLive', 'thresholdCrossed'] as const;
      const seen = new Set<SpaceUpVerdict>();

      for (let mask = 0; mask < 1 << keys.length; mask += 1) {
        const input: SpaceKeyUpInput = {
          holdArmed: false,
          captureLive: false,
          thresholdCrossed: false,
        };
        keys.forEach((key, index) => {
          input[key] = ((mask >> index) & 1) === 1;
        });

        const verdict = resolveSpaceKeyUp(input);
        seen.add(verdict);

        if (input.captureLive) {
          expect(verdict).toBe('finalize');
        } else if (!input.holdArmed) {
          expect(verdict).toBe('none');
        } else if (input.thresholdCrossed) {
          expect(verdict).toBe('cancel-pending');
        } else {
          expect(verdict).toBe('tap-space');
        }
      }

      // All four verdicts are reachable — none is dead code.
      expect(seen).toEqual(new Set<SpaceUpVerdict>(['finalize', 'cancel-pending', 'tap-space', 'none']));
    });
  });

  describe('exactly ONE ordinary space on every no-capture release (R-2.6/R-2.7)', () => {
    it('a tap writes exactly one space (R-2.7) — never zero, never two', () => {
      expect(spaceWriteForVerdict('tap-space')).toBe(' ');
      expect(spaceWriteForVerdict('tap-space')).toHaveLength(1);
    });

    it('a never-live hold writes exactly one space on release (R-2.6)', () => {
      expect(spaceWriteForVerdict('cancel-pending')).toBe(' ');
      expect(spaceWriteForVerdict('cancel-pending')).toHaveLength(1);
    });

    it('finalize writes NO space (R-2.3 — the utterance replaced the text)', () => {
      expect(spaceWriteForVerdict('finalize')).toBe('');
    });

    it('none writes NO space (the keyup is not ours)', () => {
      expect(spaceWriteForVerdict('none')).toBe('');
    });

    it('the write table is total: only the two no-capture verdicts write text', () => {
      const verdicts: SpaceUpVerdict[] = ['tap-space', 'cancel-pending', 'finalize', 'none'];
      const writers = verdicts.filter((verdict) => spaceWriteForVerdict(verdict) !== '');

      expect(writers).toEqual(['tap-space', 'cancel-pending']);
      for (const verdict of writers) {
        expect(spaceWriteForVerdict(verdict)).toHaveLength(1);
      }
    });
  });

  describe('non-goals — the module stays PURE (static/product-unit pin)', () => {
    const MODULE_PATH = 'src/features/home/components/launcher/launcherSpaceHold.ts';

    /** Strip block + line comments so the doc prose (which names `document`,
     *  `window` and the timers) is not mistaken for executable code. */
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const code = (): string => stripComments(readFileSync(resolve(process.cwd(), MODULE_PATH), 'utf8'));

    it('imports nothing at all (no React, no Tauri, no shared helper)', () => {
      const source = code();
      expect(source).not.toMatch(/^\s*import\b/m);
      expect(source).not.toMatch(/\brequire\s*\(/);
      expect(source).not.toMatch(/@tauri-apps/);
      expect(source).not.toMatch(/\binvoke\s*\(/);
    });

    it('touches no DOM, no global listener and no clock/timer', () => {
      const source = code();
      expect(source).not.toMatch(/\bdocument\b/);
      expect(source).not.toMatch(/\bwindow\b/);
      expect(source).not.toMatch(/\baddEventListener\b/);
      expect(source).not.toMatch(/\bremoveEventListener\b/);
      expect(source).not.toMatch(/\bsetTimeout\b/);
      expect(source).not.toMatch(/\bsetInterval\b/);
      expect(source).not.toMatch(/\bDate\b/);
      expect(source).not.toMatch(/\bperformance\b/);
    });
  });
});
