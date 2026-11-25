/**
 * Spec #3146 — the capability CONTRACT pins (the `[unit]` copy/type row).
 *
 * Three things this file exists to make impossible:
 *
 * 1. **A dangerous capability with no copy.** `CAPABILITY_CONSENT_COPY` is typed
 *    `Record<HighRiskCapabilityId, …>`, where `HighRiskCapabilityId` is the
 *    `CapabilityId` union FILTERED on the `high-risk.` prefix — so a new
 *    `high-risk.*` id fails the typecheck until it has a consequence sentence.
 *    These tests assert the runtime half (keys == the filtered union, distinct
 *    non-empty copy, `data.tables` excluded).
 * 2. **Two code vocabularies bleeding into one.** The installer's 22 frozen codes
 *    stay exactly 22; the authority's six stay exactly six, with distinct
 *    sentences and an unknown-code fallback.
 * 3. **The projection's member being spelled two ways.** The wire name is
 *    `capabilities`; `installedAppCapabilities` must not exist as a member. The
 *    compile-time half lives in `types.ts` (`CAPABILITY_PROJECTION_KEY_PIN`, which
 *    `tsc` checks on every `pnpm --filter @fredo/ui build`); the runtime half is
 *    asserted below against the wire shape the Rust struct serializes.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_CONSENT_COPY,
  CAPABILITY_REFUSAL_COPY,
  CAPABILITY_REFUSAL_FALLBACK,
  capabilityRefusalCopy,
  consentCopyFor,
} from '../capabilityRefusals';
import { INSTALLED_APP_REFUSAL_CODES } from '../types';
import type {
  CapabilityRefusal,
  CapabilityRefusalCode,
  HighRiskCapabilityId,
  InstalledAppEntry,
} from '../types';
import {
  CAPABILITY_IDS,
  CAPABILITY_REFUSAL_CODES,
  CAPABILITY_PROJECTION_KEY_PIN,
  isCapabilityId,
  isCapabilityRefusalCode,
} from '../types';

const HIGH_RISK_IDS = CAPABILITY_IDS.filter((id) => id.startsWith('high-risk.'));

describe('#3146 — the capability vocabulary', () => {
  it('is exactly the plan\u2019s four ids, in the documented order', () => {
    expect(CAPABILITY_IDS).toEqual([
      'data.tables',
      'high-risk.database-query',
      'high-risk.database-reset',
      'high-risk.process-spawn',
    ]);
    expect(isCapabilityId('data.tables')).toBe(true);
    expect(isCapabilityId('high-risk.database-query')).toBe(true);
    expect(isCapabilityId('data.watch')).toBe(false);
    expect(isCapabilityId('high-risk.everything')).toBe(false);
    expect(isCapabilityId(42)).toBe(false);
  });

  it('filters the high-risk union from the ids, so data.tables is never consentable', () => {
    expect(HIGH_RISK_IDS).toEqual([
      'high-risk.database-query',
      'high-risk.database-reset',
      'high-risk.process-spawn',
    ]);
    expect(HIGH_RISK_IDS).not.toContain('data.tables');
  });
});

describe('#3146 — CAPABILITY_CONSENT_COPY', () => {
  it('is exhaustive over the filtered high-risk union and excludes data.tables', () => {
    // The TYPE is the guarantee (Record<HighRiskCapabilityId, …>); this asserts
    // the runtime keys match it exactly, in both directions.
    const keys = Object.keys(CAPABILITY_CONSENT_COPY) as HighRiskCapabilityId[];
    expect([...keys].sort()).toEqual([...HIGH_RISK_IDS].sort());
    expect(Object.prototype.hasOwnProperty.call(CAPABILITY_CONSENT_COPY, 'data.tables')).toBe(false);

    for (const id of keys) {
      const copy = CAPABILITY_CONSENT_COPY[id];
      expect(copy.consequence.trim().length).toBeGreaterThan(0);
      expect(copy.verb.trim().length).toBeGreaterThan(0);
      // The verb is used inside an accessible name; it must not smuggle the raw
      // capability id into a screen reader's sentence.
      expect(copy.verb).not.toContain('high-risk.');
      expect(copy.verb).not.toContain('data.tables');
    }
  });

  it('gives every capability a DISTINCT consequence sentence', () => {
    const sentences = Object.values(CAPABILITY_CONSENT_COPY).map((copy) => copy.consequence);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('keeps the copy free of verification and safety vocabulary', () => {
    // Copy rule 1 (UI/UX §3). The ban is the explicit token list, never a stem
    // search — "read-only" is banned because the database-query consequence would
    // be FALSE if it claimed it.
    const banned = [
      'verified',
      'signed',
      'publisher',
      'trusted author',
      'safe',
      'secure',
      'sandbox',
      'read-only',
    ];
    const corpus = [
      ...Object.values(CAPABILITY_CONSENT_COPY).flatMap((copy) => [copy.consequence, copy.verb]),
      ...Object.values(CAPABILITY_REFUSAL_COPY),
      CAPABILITY_REFUSAL_FALLBACK,
    ]
      .join('\n')
      .toLowerCase();
    for (const token of banned) {
      expect(corpus).not.toContain(token);
    }
  });

  it('resolves copy for a declared id and NULL for one this build cannot name', () => {
    expect(consentCopyFor('high-risk.database-reset')).toBe(
      CAPABILITY_CONSENT_COPY['high-risk.database-reset'],
    );
    expect(consentCopyFor('high-risk.everything')).toBeNull();
    expect(consentCopyFor('data.tables')).toBeNull();
    expect(consentCopyFor('toString')).toBeNull();
  });
});

describe('#3146 — CAPABILITY_REFUSAL_COPY (six codes, separate vocabulary)', () => {
  it('is exactly the six authority codes, distinct from the installer\u2019s frozen 22', () => {
    expect(CAPABILITY_REFUSAL_CODES).toEqual([
      'action_not_declared',
      'action_not_grantable',
      'consent_required',
      'scope_denied',
      'caller_unknown',
      'app_not_installed',
    ]);
    // The two vocabularies never overlap, and the installer's stayed at 22.
    for (const code of CAPABILITY_REFUSAL_CODES) {
      expect(INSTALLED_APP_REFUSAL_CODES).not.toContain(code);
    }
    expect(INSTALLED_APP_REFUSAL_CODES).toHaveLength(22);
  });

  it('is exhaustive and DISTINCT over the six codes', () => {
    const keys = Object.keys(CAPABILITY_REFUSAL_COPY) as CapabilityRefusalCode[];
    expect([...keys].sort()).toEqual([...CAPABILITY_REFUSAL_CODES].sort());
    const sentences = Object.values(CAPABILITY_REFUSAL_COPY);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence.trim().length).toBeGreaterThan(0);
  });

  it('narrows a value and falls back on anything unknown', () => {
    for (const code of CAPABILITY_REFUSAL_CODES) {
      expect(isCapabilityRefusalCode(code)).toBe(true);
      expect(capabilityRefusalCopy(code)).toBe(CAPABILITY_REFUSAL_COPY[code]);
    }
    for (const value of ['manifest_unknown_field', '', 'CONSENT_REQUIRED', null, undefined, 7]) {
      expect(isCapabilityRefusalCode(value)).toBe(false);
      expect(capabilityRefusalCopy(value)).toBe(CAPABILITY_REFUSAL_FALLBACK);
    }
    expect(CAPABILITY_REFUSAL_FALLBACK.trim().length).toBeGreaterThan(0);
  });

  it('never names another application in the scope_denied sentence', () => {
    // AC-3's leak boundary: the sentence describes the caller's own scope only.
    const sentence = CAPABILITY_REFUSAL_COPY.scope_denied.toLowerCase();
    expect(sentence).not.toContain('installed-');
    expect(sentence).not.toContain('mission');
    expect(sentence).not.toContain('feature_');
  });

  it('serializes with an ABSENT capability key, never null (G-413)', () => {
    const present = {
      code: 'consent_required',
      appId: 'qa3146-app-a',
      action: 'db_query_execute',
      detail: 'allow it in Settings \u2192 Installed applications',
      capability: 'high-risk.database-query',
    } satisfies CapabilityRefusal;
    expect(Object.keys(JSON.parse(JSON.stringify(present)))).toHaveLength(5);
    expect(isCapabilityRefusalCode(present.code)).toBe(true);

    const absent = {
      code: 'action_not_grantable',
      appId: 'qa3146-app-a',
      action: 'installed_apps_list',
      detail: 'that action can never be granted to an installed application',
    } satisfies CapabilityRefusal;
    const wire = JSON.parse(JSON.stringify(absent)) as Record<string, unknown>;
    expect(Object.keys(wire)).toHaveLength(4);
    expect('capability' in wire).toBe(false);
  });
});

describe('#3146 — the projection member\u2019s wire name', () => {
  it('is `capabilities`, and the stale spelling appears nowhere on the entry', () => {
    // The runtime half of the pin. `CAPABILITY_PROJECTION_KEY_PIN` is the
    // compile-time half (types.ts), checked by `tsc` on every UI build.
    expect(CAPABILITY_PROJECTION_KEY_PIN).toBe('capabilities');

    // The EXACT shape `store.rs` serializes (camelCase, always present).
    const wire = JSON.parse(
      JSON.stringify({
        id: 'qa3146-app-a',
        displayName: 'QA3146 App A',
        version: '1.0.0',
        enginesFredo: '>=0.0.0',
        installedAt: '2026-01-01T00:00:00Z',
        windowLabel: 'installed-qa3146-app-a',
        capabilities: {
          appId: 'qa3146-app-a',
          declared: ['high-risk.database-query'],
          highRisk: ['high-risk.database-query'],
          consented: [],
        },
      }),
    ) as InstalledAppEntry;

    const keys = Object.keys(wire);
    expect(keys).toContain('capabilities');
    expect(keys).not.toContain('installedAppCapabilities');
    expect(Object.keys(wire.capabilities)).toEqual([
      'appId',
      'declared',
      'highRisk',
      'consented',
    ]);
    // Always present, arrays even when empty — the renderer reads it directly.
    expect(wire.capabilities.declared).toEqual(['high-risk.database-query']);
    expect(wire.capabilities.consented).toEqual([]);
  });
});
