/**
 * Spec #2960 ST-4 — the persisted first-run intro dismissal (`introDismissal.ts`).
 *
 * Pins the binding key + literal storage unit and the read/write semantics
 * against the REAL `settingsService` (localStorage fallback in jsdom):
 *  - `fredo.hotkeys.introSeen` === `'true'` when seen, key absent otherwise;
 *  - `readIntroSeen` is true ONLY for the literal string `'true'` (the default
 *    settings deserializer JSON-parses, so the identity read is load-bearing);
 *  - `persistIntroSeen` writes the literal `'true'` and never throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsService } from '../../../features/settings';
import {
  INTRO_SEEN_STORAGE_KEY,
  INTRO_SEEN_STORAGE_VALUE,
  persistIntroSeen,
  readIntroSeen,
} from '../introDismissal';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('introDismissal — binding constants', () => {
  it('declares the exact key + literal storage unit', () => {
    expect(INTRO_SEEN_STORAGE_KEY).toBe('fredo.hotkeys.introSeen');
    expect(INTRO_SEEN_STORAGE_VALUE).toBe('true');
  });
});

describe('readIntroSeen', () => {
  it('is false when the key is absent (never seen)', async () => {
    expect(await readIntroSeen()).toBe(false);
  });

  it('is true for the literal stored string "true"', async () => {
    localStorage.setItem(INTRO_SEEN_STORAGE_KEY, 'true');
    expect(await readIntroSeen()).toBe(true);
  });

  it('is false for any other stored value (only the literal unit counts)', async () => {
    localStorage.setItem(INTRO_SEEN_STORAGE_KEY, 'yes');
    expect(await readIntroSeen()).toBe(false);

    localStorage.setItem(INTRO_SEEN_STORAGE_KEY, '1');
    expect(await readIntroSeen()).toBe(false);
  });
});

describe('persistIntroSeen', () => {
  it('writes the literal "true" under the key and reads back as seen', async () => {
    await persistIntroSeen();

    expect(localStorage.getItem(INTRO_SEEN_STORAGE_KEY)).toBe('true');
    expect(await readIntroSeen()).toBe(true);
  });

  it('never throws when the settings write fails (dismissal stays unblocked)', async () => {
    vi.spyOn(settingsService, 'set').mockRejectedValueOnce(new Error('write failed'));

    await expect(persistIntroSeen()).resolves.toBeUndefined();
  });
});
