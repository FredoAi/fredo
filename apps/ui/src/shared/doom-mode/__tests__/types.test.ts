/**
 * Spec #2970 ST-5 — pins the TS wire mirror of the ST-2 Rust contract and the
 * binding trigger/skill/event vocabulary.
 */
import { describe, expect, it } from 'vitest';

import {
  DOOM_MODE_EVENT,
  DOOM_MODE_INACTIVE_STATUS,
  DOOM_MODE_SKILL,
  DOOM_SECRET_CODE,
  isDoomModeEngaged,
} from '../types';

describe('doom-mode types', () => {
  it('pins the binding vocabulary', () => {
    expect(DOOM_MODE_EVENT).toBe('doom-mode-changed');
    expect(DOOM_MODE_SKILL).toBe('doom_mode');
    expect(DOOM_SECRET_CODE).toBe('iddqd');
  });

  it('exposes the resting inactive status', () => {
    expect(DOOM_MODE_INACTIVE_STATUS).toEqual({
      phase: 'inactive',
      active: false,
      voiceSuppressed: false,
      origin: null,
      enteredAt: null,
      lastError: null,
      code: null,
    });
  });

  it('treats every non-inactive phase as engaged', () => {
    expect(isDoomModeEngaged('inactive')).toBe(false);
    expect(isDoomModeEngaged('entering')).toBe(true);
    expect(isDoomModeEngaged('active')).toBe(true);
    expect(isDoomModeEngaged('exiting')).toBe(true);
  });
});
