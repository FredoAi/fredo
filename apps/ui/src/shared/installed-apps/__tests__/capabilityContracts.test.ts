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
  CAPABILITY_DECLARED_COPY,
  CAPABILITY_REFUSAL_COPY,
  CAPABILITY_REFUSAL_FALLBACK,
  HIGH_RISK_CAPABILITY_IDS,
  capabilityRefusalCopy,
  consentCopyFor,
  declaredCapabilityCopy,
} from '../capabilityRefusals';
import {
  INSTALLED_APP_FAILURE_REASON,
  INSTALLED_APP_FAILURE_REASON_FALLBACK,
  installedAppFailureReason,
} from '../failureReasons';
import { INSTALL_REFUSAL_COPY } from '../refusals';
import { INSTALLED_APP_REFUSAL_CODES } from '../types';
import type {
  CapabilityRefusal,
  CapabilityRefusalCode,
  HighRiskCapabilityId,
  InstalledAppEntry,
  InstalledAppLifecycleState,
} from '../types';
import {
  CAPABILITY_IDS,
  CAPABILITY_REFUSAL_CODES,
  CAPABILITY_PROJECTION_KEY_PIN,
  DEVELOPMENT_MARKER_TOKEN,
  INSTALLED_APP_MODES,
  INSTALLED_APP_STATES,
  MODE_PROJECTION_KEY_PIN,
  isCapabilityId,
  isCapabilityRefusalCode,
  isInstalledAppLifecycleState,
  isInstalledAppMode,
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
        state: 'working',
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

// ── Spec #3144 — the lifecycle state, the widened declared copy, the inventory copy ──

describe('#3144 — the lifecycle state vocabulary', () => {
  it('is exactly the three wire values, in the documented order', () => {
    expect(INSTALLED_APP_STATES).toEqual(['working', 'failing', 'disabled']);
    expect(isInstalledAppLifecycleState('working')).toBe(true);
    expect(isInstalledAppLifecycleState('failing')).toBe(true);
    expect(isInstalledAppLifecycleState('disabled')).toBe(true);
    expect(isInstalledAppLifecycleState('Running')).toBe(false);
    expect(isInstalledAppLifecycleState('')).toBe(false);
    expect(isInstalledAppLifecycleState(null)).toBe(false);
    expect(isInstalledAppLifecycleState(3)).toBe(false);
  });
});

// ── Spec #3241 — the install mode, the painted token, and the projection member ──

describe('#3241 — the install-mode vocabulary and the ONE painted token', () => {
  it('is exactly the two wire values, in the documented order', () => {
    expect(INSTALLED_APP_MODES).toEqual(['released', 'development']);
  });

  it('the runtime guard accepts only the two members', () => {
    expect(isInstalledAppMode('released')).toBe(true);
    expect(isInstalledAppMode('development')).toBe(true);
    // Non-members, including the PAINTED word (the wire value is lowercase).
    expect(isInstalledAppMode('Development')).toBe(false);
    expect(isInstalledAppMode('dev')).toBe(false);
    expect(isInstalledAppMode('')).toBe(false);
    expect(isInstalledAppMode(null)).toBe(false);
    expect(isInstalledAppMode(undefined)).toBe(false);
    expect(isInstalledAppMode(1)).toBe(false);
  });

  it('the painted token is capitalised `Development` and is NOT the wire value', () => {
    expect(DEVELOPMENT_MARKER_TOKEN).toEqual('Development');
    // The wire value is lowercase; a "cleanup" that unified the two would break
    // either the serde contract or the uniformity rule.
    expect(DEVELOPMENT_MARKER_TOKEN).not.toEqual('development');
    expect(INSTALLED_APP_MODES).toContain('development');
    // The token is a whole word, and it leads the band sentence S2 paints.
    expect(DEVELOPMENT_MARKER_TOKEN.split(' ')).toEqual(['Development']);
    // The spoken form (S4's accessible name) is a DIFFERENT case by design.
    expect(`Alpha, development build`).toContain('development build');
  });

  it('pins the projection member name AND its type (a mode-less literal is a compile error)', () => {
    expect(MODE_PROJECTION_KEY_PIN).toEqual('mode');
    // The pin's existence is the compile-time half; this is the runtime witness.
    const entry = { mode: 'released' } as Pick<InstalledAppEntry, 'mode'>;
    expect(isInstalledAppMode(entry.mode)).toBe(true);
  });

  it('the mode is a SEPARATE axis from the lifecycle state (never folded together)', () => {
    // INV-4: the lifecycle vocabulary is untouched by this spec.
    expect(INSTALLED_APP_STATES).toEqual(['working', 'failing', 'disabled']);
    for (const state of INSTALLED_APP_STATES) {
      expect(INSTALLED_APP_MODES as readonly string[]).not.toContain(state);
    }
    for (const mode of INSTALLED_APP_MODES) {
      expect(INSTALLED_APP_STATES as readonly string[]).not.toContain(mode);
    }
  });
});

describe('#3144 — CAPABILITY_DECLARED_COPY (the widened, complete declared view)', () => {  it('is exhaustive over ALL four capability ids (incl. the ordinary data.tables)', () => {
    const keys = Object.keys(CAPABILITY_DECLARED_COPY) as CapabilityId[];
    expect([...keys].sort()).toEqual([...CAPABILITY_IDS].sort());
    expect(Object.prototype.hasOwnProperty.call(CAPABILITY_DECLARED_COPY, 'data.tables')).toBe(true);
  });

  it('keeps the three high-risk sentences IDENTICAL to CAPABILITY_CONSENT_COPY (one copy source)', () => {
    for (const id of HIGH_RISK_CAPABILITY_IDS) {
      expect(CAPABILITY_DECLARED_COPY[id]).toEqual(CAPABILITY_CONSENT_COPY[id]);
    }
  });

  it('gives every declared capability a DISTINCT, non-empty consequence sentence', () => {
    const sentences = Object.values(CAPABILITY_DECLARED_COPY).map((copy) => copy.consequence);
    expect(sentences.every((sentence) => sentence.trim().length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('derives HIGH_RISK_CAPABILITY_IDS from the prefix filter (data.tables excluded)', () => {
    expect(HIGH_RISK_CAPABILITY_IDS).toEqual([
      'high-risk.database-query',
      'high-risk.database-reset',
      'high-risk.process-spawn',
    ]);
    expect(HIGH_RISK_CAPABILITY_IDS).not.toContain('data.tables');
  });

  it('resolves copy for a declared id and NULL for one this build cannot name', () => {
    expect(declaredCapabilityCopy('data.tables')).toBe(CAPABILITY_DECLARED_COPY['data.tables']);
    expect(declaredCapabilityCopy('high-risk.database-reset')).toBe(
      CAPABILITY_DECLARED_COPY['high-risk.database-reset'],
    );
    expect(declaredCapabilityCopy('high-risk.everything')).toBeNull();
    expect(declaredCapabilityCopy('toString')).toBeNull();
  });
});

describe('#3144 — INSTALLED_APP_FAILURE_REASON (the inventory copy authority)', () => {
  it('has EXACTLY the three landable codes (id_not_installed is deliberately absent)', () => {
    expect(Object.keys(INSTALLED_APP_FAILURE_REASON).sort()).toEqual([
      'integrity_mismatch',
      'integrity_record_corrupt',
      'io_error',
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(INSTALLED_APP_FAILURE_REASON, 'id_not_installed'),
    ).toBe(false);
  });

  it('carries the binding sentences verbatim', () => {
    expect(installedAppFailureReason('integrity_record_corrupt')).toBe(
      "Its install record is unreadable, so Fredo can't check its files.",
    );
    expect(installedAppFailureReason('integrity_mismatch')).toBe(
      "Its files changed after it was installed, so Fredo won't run it.",
    );
    expect(installedAppFailureReason('io_error')).toBe(
      "Fredo couldn't read this application's files, so it can't be started.",
    );
  });

  it('never returns blank, and NEVER an install-time claim for an installed app', () => {
    expect(installedAppFailureReason(undefined)).toBe(INSTALLED_APP_FAILURE_REASON_FALLBACK);
    expect(installedAppFailureReason('id_not_installed')).toBe(
      INSTALLED_APP_FAILURE_REASON_FALLBACK,
    );
    expect(installedAppFailureReason('no_such_code')).toBe(INSTALLED_APP_FAILURE_REASON_FALLBACK);
    expect(installedAppFailureReason(7)).toBe(INSTALLED_APP_FAILURE_REASON_FALLBACK);

    // The lie this module exists to prevent: the INSTALL-time sentence for a
    // reused code must never be the inventory's answer.
    const corpus = Object.values(INSTALLED_APP_FAILURE_REASON).join('\n');
    expect(corpus).not.toContain(INSTALL_REFUSAL_COPY.id_not_installed);
    expect(corpus).not.toContain(INSTALL_REFUSAL_COPY.io_error);
    expect(INSTALLED_APP_FAILURE_REASON_FALLBACK).not.toContain(
      INSTALL_REFUSAL_COPY.id_not_installed,
    );
    expect(INSTALLED_APP_FAILURE_REASON_FALLBACK.trim().length).toBeGreaterThan(0);
  });

  it('the fallback covers id_not_installed without the phrase "not installed"', () => {
    expect(installedAppFailureReason('id_not_installed').toLowerCase()).not.toContain(
      'not installed',
    );
  });
});

describe('#3144 — the wire state/failureCode shape (G-413)', () => {
  it('carries `state` always, and omits `failureCode` unless failing', () => {
    const healthy = JSON.parse(
      JSON.stringify({
        id: 'qa3147-valid',
        displayName: 'QA3147 Valid',
        version: '1.0.0',
        enginesFredo: '>=0.0.0',
        installedAt: '2026-01-01T00:00:00Z',
        windowLabel: 'installed-qa3147-valid',
        state: 'working',
        capabilities: { appId: 'qa3147-valid', declared: [], highRisk: [], consented: [] },
      }),
    ) as InstalledAppEntry;
    expect(isInstalledAppLifecycleState(healthy.state)).toBe(true);
    expect('failureCode' in healthy).toBe(false);

    const failing = JSON.parse(
      JSON.stringify({
        ...healthy,
        state: 'failing',
        failureCode: 'integrity_record_corrupt',
      }),
    ) as InstalledAppEntry;
    expect(failing.state).toBe('failing');
    expect(failing.failureCode).toBe('integrity_record_corrupt');
    const state: InstalledAppLifecycleState = failing.state;
    expect(state).toBe('failing');
  });
});
