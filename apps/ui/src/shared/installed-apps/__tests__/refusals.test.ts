/**
 * Spec #3147 ST-6 — the refusal copy map is complete and every sentence is
 * distinct.
 *
 * The contract (Architect §API Contracts, UI/UX §1): `INSTALL_REFUSAL_COPY` keys
 * on exactly the frozen 22 codes, every code maps to a NON-EMPTY sentence, and
 * no two codes share a sentence (a shared sentence would let two different
 * failures read as the same fact).
 *
 * The set is enumerated from the SHIPPED source — `INSTALLED_APP_REFUSAL_CODES`
 * — and the count is asserted to be 22, so the test fails the day the enum and
 * the map disagree in either direction (`Record<…, string>` catches a missing
 * key at compile time; this catches a stray/duplicated one at runtime).
 */

import { describe, expect, it } from 'vitest';

import {
  INSTALL_REFUSAL_COPY,
  INSTALL_REFUSAL_FAMILY,
  REFUSAL_FAMILY_STYLE,
  refusalCopy,
  refusalSeverity,
  refusalStyle,
} from '@/shared/installed-apps/refusals';
import {
  INSTALLED_APP_REFUSAL_CODES,
  isInstalledAppRefusalCode,
} from '@/shared/installed-apps/types';

describe('#3147 ST-6 — INSTALL_REFUSAL_COPY completeness', () => {
  it('maps all 22 frozen codes to a distinct non-empty sentence', () => {
    // Count first: the test itself enumerates the codes and asserts 22.
    expect(INSTALLED_APP_REFUSAL_CODES).toHaveLength(22);

    const sentences = INSTALLED_APP_REFUSAL_CODES.map((code) => {
      const sentence = INSTALL_REFUSAL_COPY[code];
      expect(typeof sentence, `${code} must map to a string`).toBe('string');
      expect(sentence.trim().length, `${code} must be non-empty`).toBeGreaterThan(0);
      return sentence;
    });

    // Distinctness — one sentence per code, never a shared verdict.
    expect(new Set(sentences).size).toBe(22);

    // And the map carries exactly those keys — no extra, no missing.
    expect(Object.keys(INSTALL_REFUSAL_COPY).sort()).toEqual(
      [...INSTALLED_APP_REFUSAL_CODES].sort(),
    );
  });

  it('names every frozen code in the union that the guard accepts', () => {
    for (const code of INSTALLED_APP_REFUSAL_CODES) {
      expect(isInstalledAppRefusalCode(code), code).toBe(true);
      expect(refusalCopy(code)).toBe(INSTALL_REFUSAL_COPY[code]);
    }
    expect(isInstalledAppRefusalCode('not_a_real_code')).toBe(false);
    expect(isInstalledAppRefusalCode(undefined)).toBe(false);
    expect(isInstalledAppRefusalCode(42)).toBe(false);
  });

  it('gives every code a family and that family a treatment', () => {
    for (const code of INSTALLED_APP_REFUSAL_CODES) {
      const family = INSTALL_REFUSAL_FAMILY[code];
      expect(family, code).toBeDefined();
      const style = REFUSAL_FAMILY_STYLE[family];
      expect(style, `${code}/${family}`).toBeDefined();
      expect(refusalStyle(code)).toBe(style);
      expect(refusalSeverity(code)).toBe(style.severity);
    }
  });

  it('places the 20 install-time codes and the 2 load-time codes in their families', () => {
    // F7 + F8 are the load-time families (rendered by the launcher, never the pane).
    const loadTime = INSTALLED_APP_REFUSAL_CODES.filter((code) =>
      ['damaged-after-install', 'nothing-to-open'].includes(INSTALL_REFUSAL_FAMILY[code]),
    );
    expect(loadTime.sort()).toEqual(
      ['id_is_installed_app', 'id_not_installed', 'integrity_mismatch', 'integrity_record_corrupt'].sort(),
    );
  });

  it('keeps io_error read-vs-write neutral (the one permitted wording change)', () => {
    // Risk #9: the same code serves the install write path and the listing read
    // path, so the sentence must not claim it was writing. A 23rd code is forbidden.
    const sentence = INSTALL_REFUSAL_COPY.io_error.toLowerCase();
    expect(sentence).not.toContain('writing');
    expect(sentence).not.toContain('to disk');
    expect(INSTALLED_APP_REFUSAL_CODES).toHaveLength(22);
  });
});
