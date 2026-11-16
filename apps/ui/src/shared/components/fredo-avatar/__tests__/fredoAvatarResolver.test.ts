import { describe, expect, it } from 'vitest';

import {
  FREDO_AVATAR_STATE_PRIORITY,
  resolveCompanionAvatarState,
} from '../fredoAvatarResolver';
import type { AvatarSignals } from '../fredoAvatarResolver';
import { FREDO_AVATAR_STATES, isFredoAvatarState } from '../fredoAvatarStates';

/**
 * #2917 ST-4 / ST-5 — the ONE avatar-state resolver.
 *
 * Pins the UI/UX §1 conflict order as DATA (`FREDO_AVATAR_STATE_PRIORITY`), the
 * teleport-always-wins rule, the base-state pass-through (`talk`), the ambient
 * `greeting` gating, and the `modelStatus` boundary validation (#2918 handoff).
 *
 * Pure + synchronous — no render, no timers.
 */

/** A signals record with every optional flag OFF, overridable per case. */
const signals = (overrides: Partial<AvatarSignals> = {}): AvatarSignals => ({
  flow: 'idle',
  resting: 'idle',
  ...overrides,
});

describe('#2917 ST-4 — FREDO_AVATAR_STATE_PRIORITY (the conflict order is data)', () => {
  it('exports the exact UI/UX §1 order: working > error > happy > joking > listening > greeting > thinking > playful > idle', () => {
    expect([...FREDO_AVATAR_STATE_PRIORITY]).toEqual([
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
  });

  it('contains only frozen vocabulary members, with no duplicates', () => {
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
      // Every frozen state is reachable as a flow with no competing signal.
      expect(resolveCompanionAvatarState(signals({ flow: state }))).toBe(state);
    }
  });
});

describe('#2917 ST-4 — modelStatus boundary validation (#2918 handoff)', () => {
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
});
