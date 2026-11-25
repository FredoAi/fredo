import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FREDO_AVATAR_STATE_PRIORITY,
  resolveCompanionAvatarState,
} from '../fredoAvatarResolver';
import type { AvatarSignals } from '../fredoAvatarResolver';
import {
  FREDO_AVATAR_EMOTION_STATES,
  FREDO_AVATAR_STATES,
  FREDO_AVATAR_STATUS_STATES,
  isFredoAvatarState,
} from '../fredoAvatarStates';
import {
  QA_AVATAR_FLOW_GLOBAL,
  clearQaAvatarFlowOverrideForTests,
  readQaAvatarFlowOverride,
} from '../qaAvatarFlowLever';

/**
 * #2917 ST-4 / ST-5 / #3224 ST-2 — the ONE avatar-state resolver.
 *
 * Pins the conflict order as DATA (`FREDO_AVATAR_STATE_PRIORITY`, 20 ranked members
 * with the 11 emotions in one contiguous band), the teleport-always-wins rule, the
 * base-state pass-through (`talk`), the modelStatus boundary validation (#2918
 * handoff) and the DEV-only QA flow lever (#3224).
 *
 * Pure + synchronous — no render, no timers.
 */

/** A signals record with every optional flag OFF, overridable per case. */
const signals = (overrides: Partial<AvatarSignals> = {}): AvatarSignals => ({
  flow: 'idle',
  resting: 'idle',
  ...overrides,
});

/** Write the DEV-only lever global (the shipped key, never a duplicated literal). */
const setLever = (value: unknown): void => {
  (globalThis as Record<string, unknown>)[QA_AVATAR_FLOW_GLOBAL] = value;
};

afterEach(() => {
  clearQaAvatarFlowOverrideForTests();
  vi.unstubAllEnvs();
});

describe('#2917 ST-4 / #3224 ST-2 — FREDO_AVATAR_STATE_PRIORITY (the conflict order is data)', () => {
  it('exports the 20 ranked members: the 9 status ranks, the 11-emotion band, then playful/idle', () => {
    expect([...FREDO_AVATAR_STATE_PRIORITY]).toEqual([
      // the shipped status ranks, unchanged and in their shipped relative order
      'working',
      'error',
      'happy',
      'joking',
      'listening',
      'greeting',
      'thinking',
      // #3224: the model-expression band (authored order)
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
      'playful',
      'idle',
    ]);
    expect(FREDO_AVATAR_STATE_PRIORITY).toHaveLength(20);
  });

  it('keeps the shipped status states as a subsequence in the SAME relative order', () => {
    // The 12-state order is NOT deleted: the 9 ranked status states must still read
    // working > error > happy > joking > listening > greeting > thinking > playful > idle.
    const emotions = new Set<string>(FREDO_AVATAR_EMOTION_STATES);
    const statusOnly = FREDO_AVATAR_STATE_PRIORITY.filter((state) => !emotions.has(state));
    expect(statusOnly).toEqual([
      'working',
      'error',
      'happy',
      'joking',
      'listening',
      'greeting',
      'thinking',
      'playful',
      'idle',
    ]);
    for (const state of statusOnly) {
      expect(FREDO_AVATAR_STATUS_STATES as readonly string[]).toContain(state);
    }
  });

  it('places the 11 emotions in ONE contiguous band between `thinking` and `playful`, in authored order', () => {
    const thinkingIndex = FREDO_AVATAR_STATE_PRIORITY.indexOf('thinking');
    const playfulIndex = FREDO_AVATAR_STATE_PRIORITY.indexOf('playful');
    expect(thinkingIndex).toBeGreaterThan(-1);
    expect(playfulIndex).toBeGreaterThan(thinkingIndex);

    const band = FREDO_AVATAR_STATE_PRIORITY.slice(thinkingIndex + 1, playfulIndex);
    expect([...band]).toEqual([...FREDO_AVATAR_EMOTION_STATES]);
    expect(band).toHaveLength(11);
  });

  it('contains only vocabulary members, with no duplicates', () => {
    for (const state of FREDO_AVATAR_STATE_PRIORITY) {
      expect(isFredoAvatarState(state)).toBe(true);
    }
    expect(new Set(FREDO_AVATAR_STATE_PRIORITY).size).toBe(FREDO_AVATAR_STATE_PRIORITY.length);
  });

  it('deliberately excludes the base states (talk) and the teleport states', () => {
    expect([...FREDO_AVATAR_STATE_PRIORITY]).not.toContain('talk');
    expect([...FREDO_AVATAR_STATE_PRIORITY]).not.toContain('teleport-out');
    expect([...FREDO_AVATAR_STATE_PRIORITY]).not.toContain('teleport-in');
  });
});

describe('#2917 ST-4 — resolveCompanionAvatarState priority conflicts', () => {
  it('a teleport base state always wins over a higher-priority status signal', () => {
    expect(resolveCompanionAvatarState(signals({ flow: 'teleport-out', captureActive: true, skillPending: true }))).toBe('teleport-out');
    expect(resolveCompanionAvatarState(signals({ flow: 'teleport-in', errored: true }))).toBe('teleport-in');
  });

  it('the teleporting signal forces the flow through untouched', () => {
    expect(
      resolveCompanionAvatarState(signals({ flow: 'teleport-in', teleporting: true, captureActive: true })),
    ).toBe('teleport-in');
    // Even a non-teleport flow is passed through while the teleport flag owns it.
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', teleporting: true }))).toBe('idle');
  });

  it('the flow outranks the resting beat and the bare idle', () => {
    expect(resolveCompanionAvatarState(signals({ flow: 'thinking', resting: 'playful' }))).toBe('thinking');
    expect(resolveCompanionAvatarState(signals({ flow: 'happy', resting: 'playful' }))).toBe('happy');
  });

  it('resting playful tints an idle flow but never a status flow', () => {
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', resting: 'playful' }))).toBe('playful');
    expect(resolveCompanionAvatarState(signals({ flow: 'talk', resting: 'idle' }))).toBe('talk');
  });

  it('resolves every adjacent pair in the declared order to the higher-priority state', () => {
    // working > error
    expect(resolveCompanionAvatarState(signals({ flow: 'error', skillPending: true }))).toBe('working');
    // error > happy
    expect(resolveCompanionAvatarState(signals({ flow: 'happy', errored: true }))).toBe('error');
    // happy > joking
    expect(resolveCompanionAvatarState(signals({ flow: 'joking', modelStatus: 'happy' }))).toBe('happy');
    // joking > listening
    expect(resolveCompanionAvatarState(signals({ flow: 'joking', captureActive: true }))).toBe('joking');
    // listening > greeting
    expect(
      resolveCompanionAvatarState(signals({ flow: 'idle', captureActive: true, ambientMessage: true })),
    ).toBe('listening');
    // greeting > thinking
    expect(
      resolveCompanionAvatarState(signals({ flow: 'thinking', ambientMessage: true })),
    ).toBe('greeting');
    // thinking > playful
    expect(resolveCompanionAvatarState(signals({ flow: 'thinking', resting: 'playful' }))).toBe('thinking');
    // playful > idle
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', resting: 'playful' }))).toBe('playful');
  });

  it('lets the flow declare its own status directly (working/error are flow-owned)', () => {
    expect(resolveCompanionAvatarState(signals({ flow: 'working' }))).toBe('working');
    expect(resolveCompanionAvatarState(signals({ flow: 'error' }))).toBe('error');
  });

  it('#3224 — resolves EVERY adjacent pair of the 20 ranked members to the higher one', () => {
    for (let index = 0; index < FREDO_AVATAR_STATE_PRIORITY.length - 1; index += 1) {
      const higher = FREDO_AVATAR_STATE_PRIORITY[index];
      const lower = FREDO_AVATAR_STATE_PRIORITY[index + 1];
      expect(
        resolveCompanionAvatarState(signals({ flow: lower, modelStatus: higher })),
        `${higher} must outrank ${lower}`,
      ).toBe(higher);
    }
  });

  it('#3224 — the band sits between `thinking` and the ambient floor in both directions', () => {
    for (const emotion of FREDO_AVATAR_EMOTION_STATES) {
      // thinking outranks every emotion (an emotion never steals its sole trigger)
      expect(
        resolveCompanionAvatarState(signals({ flow: 'thinking', modelStatus: emotion })),
        `thinking must outrank ${emotion}`,
      ).toBe('thinking');
      // every emotion outranks the resting `playful` floor (the beat never masks it)
      expect(
        resolveCompanionAvatarState(signals({ flow: 'idle', resting: 'playful', modelStatus: emotion })),
        `${emotion} must outrank the resting beat`,
      ).toBe(emotion);
    }
  });
});

describe('#2917 ST-4 — ambient greeting gating and base-state pass-through', () => {
  it('renders greeting for an ambient message with NO generation in flight', () => {
    expect(resolveCompanionAvatarState(signals({ flow: 'talk', ambientMessage: true }))).toBe('greeting');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', ambientMessage: true }))).toBe('greeting');
  });

  it('suppresses greeting while a generation streams or a skill is pending', () => {
    expect(
      resolveCompanionAvatarState(signals({ flow: 'talk', ambientMessage: true, streaming: true })),
    ).toBe('talk');
    // A pending skill owns the expression — greeting must not mask `working`.
    expect(
      resolveCompanionAvatarState(signals({ flow: 'working', ambientMessage: true, skillPending: true })),
    ).toBe('working');
    expect(
      resolveCompanionAvatarState(signals({ flow: 'idle', ambientMessage: true, streaming: true })),
    ).toBe('idle');
  });

  it('passes a bare talk flow through unchanged (talk is not a conflict candidate)', () => {
    expect(resolveCompanionAvatarState(signals({ flow: 'talk' }))).toBe('talk');
  });

  it('defaults to idle when every signal is off', () => {
    expect(resolveCompanionAvatarState(signals())).toBe('idle');
    for (const state of FREDO_AVATAR_STATES) {
      // Every vocabulary state is reachable as a flow with no competing signal.
      expect(resolveCompanionAvatarState(signals({ flow: state }))).toBe(state);
    }
  });
});

describe('#2917 ST-4 / #3224 ST-2 — modelStatus boundary validation (#2918 handoff)', () => {
  it('drops an unknown model status (never rendered as a stray state)', () => {
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: 'bogus' }))).toBe('idle');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: 'success' }))).toBe('idle');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: '' }))).toBe('idle');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: 'IDLE' }))).toBe('idle');
  });

  it('applies a known model status subject to the same priority order', () => {
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: 'working' }))).toBe('working');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: 'greeting' }))).toBe('greeting');
    // A higher-priority flow status still outranks the model status.
    expect(resolveCompanionAvatarState(signals({ flow: 'happy', modelStatus: 'idle' }))).toBe('happy');
    // A live teleport outranks the model status outright.
    expect(resolveCompanionAvatarState(signals({ flow: 'teleport-out', modelStatus: 'happy' }))).toBe('teleport-out');
  });

  it('#3224 — every RANKED model status (all 20, the 11 emotions included) resolves to itself', () => {
    for (const state of FREDO_AVATAR_STATE_PRIORITY) {
      expect(
        resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: state })),
        `model status "${state}" must render itself`,
      ).toBe(state);
    }
  });

  it('#3224 — the three unranked states stay base states (never model-status candidates)', () => {
    // `talk` / the teleport pair are not conflict candidates by design: a model
    // status naming one is dropped and the flow holds (R-2d keeps them
    // non-emittable; the lever below is what drives them for the QA matrix).
    for (const base of ['talk', 'teleport-out', 'teleport-in'] as const) {
      expect(resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: base }))).toBe('idle');
    }
  });

  it('#3224 — drops every out-of-vocabulary model status, and the FLOW holds (not idle)', () => {
    const rejected = [
      'explode',
      'hyper',
      'dancing',
      'waiting',
      'success',
      'reasoning',
      'busy',
      'focused',
      'neutral',
      'calm',
      'doom-in',
      '  uwu  ',
      'IDLE',
      '',
    ];
    for (const value of rejected) {
      expect(resolveCompanionAvatarState(signals({ flow: 'idle', modelStatus: value }))).toBe('idle');
      // The flow-owned state holds — an unknown status never resets the state to idle.
      expect(resolveCompanionAvatarState(signals({ flow: 'working', modelStatus: value }))).toBe('working');
    }
  });
});

describe('#3224 ST-2 — the DEV-only QA flow lever', () => {
  it('is inert while the page global is unset', () => {
    expect(readQaAvatarFlowOverride()).toBeUndefined();
    expect(resolveCompanionAvatarState(signals({ flow: 'idle' }))).toBe('idle');
    expect(resolveCompanionAvatarState(signals({ flow: 'talk' }))).toBe('talk');
  });

  it('drives every one of the 23 states through the resolver', () => {
    for (const state of FREDO_AVATAR_STATES) {
      setLever(state);
      expect(resolveCompanionAvatarState(signals({ flow: 'idle' })), `lever "${state}"`).toBe(state);
    }
  });

  it('enters at NORMAL rank — a higher-priority signal still wins', () => {
    setLever('uwu');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle' }))).toBe('uwu');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', skillPending: true }))).toBe('working');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', errored: true }))).toBe('error');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', captureActive: true }))).toBe('listening');
    // Above the ambient floor: the resting beat never masks a levered emotion.
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', resting: 'playful' }))).toBe('uwu');
  });

  it('never defeats a teleport (the read sits BELOW the teleport branch)', () => {
    setLever('angry');
    expect(resolveCompanionAvatarState(signals({ flow: 'teleport-out' }))).toBe('teleport-out');
    expect(resolveCompanionAvatarState(signals({ flow: 'teleport-in', teleporting: true }))).toBe('teleport-in');
    expect(resolveCompanionAvatarState(signals({ flow: 'idle', teleporting: true }))).toBe('idle');
    expect(resolveCompanionAvatarState(signals({ flow: 'talk', teleporting: true }))).toBe('talk');
  });

  it('ignores a non-member exactly (no trim, no case fold) and the flow holds', () => {
    for (const value of ['explode', 'hyper', 'IDLE', '  uwu  ', 'uwu ', '', 'doom-in', 'Funny']) {
      setLever(value);
      expect(readQaAvatarFlowOverride(), `"${value}" must be rejected`).toBeUndefined();
      expect(resolveCompanionAvatarState(signals({ flow: 'idle' }))).toBe('idle');
      expect(resolveCompanionAvatarState(signals({ flow: 'working' }))).toBe('working');
    }
  });

  it('ignores a non-string value without throwing', () => {
    for (const value of [null, undefined, 42, true, {}, ['uwu'], { state: 'uwu' }]) {
      setLever(value);
      expect(readQaAvatarFlowOverride()).toBeUndefined();
      expect(resolveCompanionAvatarState(signals({ flow: 'idle' }))).toBe('idle');
    }
  });

  it('returns `undefined` when the build is not a DEV build', () => {
    setLever('uwu');
    expect(readQaAvatarFlowOverride()).toBe('uwu');
    vi.stubEnv('DEV', false);
    expect(readQaAvatarFlowOverride()).toBeUndefined();
    expect(resolveCompanionAvatarState(signals({ flow: 'idle' }))).toBe('idle');
    vi.unstubAllEnvs();
  });

  it('clears through the test helper (a reload-equivalent reset)', () => {
    setLever('sad');
    expect(readQaAvatarFlowOverride()).toBe('sad');
    clearQaAvatarFlowOverrideForTests();
    expect(readQaAvatarFlowOverride()).toBeUndefined();
    expect(resolveCompanionAvatarState(signals({ flow: 'idle' }))).toBe('idle');
  });
});
