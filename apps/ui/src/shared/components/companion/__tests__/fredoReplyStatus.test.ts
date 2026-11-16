import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FREDO_STATUS,
  FREDO_REPLY_STATUSES,
  resolveReplyStatus,
} from '../fredoReplyStatus';
import { FREDO_AVATAR_STATES, isFredoAvatarState } from '../../fredo-avatar/fredoAvatarStates';

/**
 * #2918 ST-4 (R-8, R-2) — the closed reply-status vocabulary + lenient resolver.
 *
 * Product-unit pins for the ONE boundary between the model's structured `status`
 * and the frozen 12-member avatar vocabulary:
 *
 *   - the emittable set is the closed 7, the default is `happy`;
 *   - the converged alias table maps with trim/case-folding;
 *   - everything else (flow/motion-owned names, non-members, non-strings, absent)
 *     heals to the default;
 *   - the result is ALWAYS a `FREDO_AVATAR_STATES` member — a non-member can never
 *     be returned (R-8 boundary drop).
 *
 * Pure + synchronous — no render, no timers.
 */

/** The model-FORBIDDEN states: frozen-union members that the model must never select. */
const MODEL_FORBIDDEN = ['talk', 'teleport-out', 'teleport-in', 'error', 'greeting'] as const;

describe('#2918 ST-4 — the closed reply-status vocabulary (R-8)', () => {
  it('exports exactly the converged 7 model-emittable statuses', () => {
    expect([...FREDO_REPLY_STATUSES]).toEqual([
      'happy',
      'playful',
      'joking',
      'thinking',
      'working',
      'listening',
      'idle',
    ]);
    expect(new Set(FREDO_REPLY_STATUSES).size).toBe(FREDO_REPLY_STATUSES.length);
  });

  it('defaults to `happy` and the default is itself emittable', () => {
    expect(DEFAULT_FREDO_STATUS).toBe('happy');
    expect([...FREDO_REPLY_STATUSES]).toContain(DEFAULT_FREDO_STATUS);
  });

  it('every emittable status is a member of the frozen 12 (no new states)', () => {
    for (const status of FREDO_REPLY_STATUSES) {
      expect(isFredoAvatarState(status)).toBe(true);
      expect([...FREDO_AVATAR_STATES]).toContain(status);
    }
  });

  it('never lists a model-forbidden frozen state', () => {
    for (const forbidden of MODEL_FORBIDDEN) {
      expect([...FREDO_REPLY_STATUSES]).not.toContain(forbidden);
    }
  });
});

describe('#2918 ST-4 — resolveReplyStatus passes the emittable set through (R-2)', () => {
  it('maps every one of the 7 to itself', () => {
    expect(resolveReplyStatus('happy')).toBe('happy');
    expect(resolveReplyStatus('playful')).toBe('playful');
    expect(resolveReplyStatus('joking')).toBe('joking');
    expect(resolveReplyStatus('thinking')).toBe('thinking');
    expect(resolveReplyStatus('working')).toBe('working');
    expect(resolveReplyStatus('listening')).toBe('listening');
    expect(resolveReplyStatus('idle')).toBe('idle');
  });

  it('accepts an emittable status case-insensitively and through surrounding whitespace', () => {
    expect(resolveReplyStatus('HAPPY')).toBe('happy');
    expect(resolveReplyStatus('Playful')).toBe('playful');
    expect(resolveReplyStatus('  joking  ')).toBe('joking');
    expect(resolveReplyStatus('\tTHINKING\n')).toBe('thinking');
    expect(resolveReplyStatus('WoRkInG')).toBe('working');
    expect(resolveReplyStatus(' listening ')).toBe('listening');
    expect(resolveReplyStatus('IdLe')).toBe('idle');
  });
});

describe('#2918 ST-4 — the converged alias table (R-8 lenient healing)', () => {
  it('maps success -> happy', () => {
    expect(resolveReplyStatus('success')).toBe('happy');
    expect(resolveReplyStatus('  SUCCESS  ')).toBe('happy');
  });

  it('maps funny -> joking', () => {
    expect(resolveReplyStatus('funny')).toBe('joking');
    expect(resolveReplyStatus('Funny')).toBe('joking');
  });

  it('maps reasoning -> thinking', () => {
    expect(resolveReplyStatus('reasoning')).toBe('thinking');
    expect(resolveReplyStatus(' REASONING ')).toBe('thinking');
  });

  it('maps busy/focused -> working', () => {
    expect(resolveReplyStatus('busy')).toBe('working');
    expect(resolveReplyStatus('BUSY')).toBe('working');
    expect(resolveReplyStatus('focused')).toBe('working');
    expect(resolveReplyStatus('\tFocused\n')).toBe('working');
  });

  it('maps neutral/calm -> idle', () => {
    expect(resolveReplyStatus('neutral')).toBe('idle');
    expect(resolveReplyStatus('Neutral')).toBe('idle');
    expect(resolveReplyStatus('calm')).toBe('idle');
    expect(resolveReplyStatus(' CALM ')).toBe('idle');
  });

  it('every alias resolves to an emittable member of the frozen 12', () => {
    for (const alias of ['success', 'funny', 'reasoning', 'busy', 'focused', 'neutral', 'calm']) {
      const resolved = resolveReplyStatus(alias);
      expect([...FREDO_REPLY_STATUSES]).toContain(resolved);
      expect(isFredoAvatarState(resolved)).toBe(true);
    }
  });
});

describe('#2918 ST-4 — boundary drop + lenient healing to the default (R-8)', () => {
  it('drops the model-forbidden flow/motion/error states to `happy`', () => {
    expect(resolveReplyStatus('talk')).toBe('happy');
    expect(resolveReplyStatus('teleport-out')).toBe('happy');
    expect(resolveReplyStatus('teleport-in')).toBe('happy');
    expect(resolveReplyStatus('error')).toBe('happy');
    expect(resolveReplyStatus('greeting')).toBe('happy');
  });

  it('heals absent / non-string values to `happy`', () => {
    expect(resolveReplyStatus(undefined)).toBe('happy');
    expect(resolveReplyStatus(null)).toBe('happy');
    expect(resolveReplyStatus(123)).toBe('happy');
    expect(resolveReplyStatus(0)).toBe('happy');
    expect(resolveReplyStatus(true)).toBe('happy');
    expect(resolveReplyStatus(false)).toBe('happy');
    expect(resolveReplyStatus(NaN)).toBe('happy');
    expect(resolveReplyStatus({})).toBe('happy');
    expect(resolveReplyStatus([])).toBe('happy');
    expect(resolveReplyStatus(['happy'])).toBe('happy');
    expect(resolveReplyStatus(() => 'happy')).toBe('happy');
    expect(resolveReplyStatus(Symbol('happy'))).toBe('happy');
  });

  it('heals empty / whitespace-only / unknown strings to `happy`', () => {
    expect(resolveReplyStatus('')).toBe('happy');
    expect(resolveReplyStatus('   ')).toBe('happy');
    expect(resolveReplyStatus('\t\n')).toBe('happy');
    expect(resolveReplyStatus('dancing')).toBe('happy');
    expect(resolveReplyStatus('happyish')).toBe('happy');
    expect(resolveReplyStatus('talk ')).toBe('happy');
    expect(resolveReplyStatus(' status ')).toBe('happy');
  });

  it('never treats a substring as a member (exact match only)', () => {
    expect(resolveReplyStatus('hap')).toBe('happy');
    expect(resolveReplyStatus('id')).toBe('happy');
    expect(resolveReplyStatus('work')).toBe('happy');
  });
});

describe('#2918 ST-4 — the result is ALWAYS a frozen-union member (R-8 hard invariant)', () => {
  const adversarial: unknown[] = [
    ...FREDO_REPLY_STATUSES,
    ...MODEL_FORBIDDEN,
    'success',
    'funny',
    'reasoning',
    'busy',
    'focused',
    'neutral',
    'calm',
    'dancing',
    'waiting',
    'status',
    '',
    '   ',
    null,
    undefined,
    0,
    1,
    -1,
    123,
    true,
    false,
    NaN,
    Infinity,
    {},
    { status: 'happy' },
    [],
    ['happy'],
    Symbol('happy'),
  ];

  it('every adversarial input resolves to a member of FREDO_AVATAR_STATES', () => {
    for (const raw of adversarial) {
      const resolved = resolveReplyStatus(raw);
      expect(isFredoAvatarState(resolved)).toBe(true);
      expect([...FREDO_AVATAR_STATES]).toContain(resolved);
    }
  });

  it('never returns the model-forbidden lifecycle states', () => {
    for (const raw of adversarial) {
      expect([...MODEL_FORBIDDEN]).not.toContain(resolveReplyStatus(raw));
    }
  });
});
