/**
 * Spec #2893 ST-6 — pins THE ONE app-identity resolution rule (R-2.7).
 *
 * Deterministic, no React: `appIdentity.ts` is pure, so every branch
 * (normalize -> exact id -> `appNameMatches` candidates -> ambiguous/unknown)
 * is asserted directly, including the QA-8 mocked >=2-entry registry ambiguity
 * pin that the live single-app registry cannot exercise.
 */
import { describe, it, expect } from 'vitest';

import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import { normalizeAppQuery, resolveAppIdentity } from '../appIdentity';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const entry = (id: string, name: string, showable = true): FredoFeatureClass =>
  ({ id, name, showable }) as unknown as FredoFeatureClass;

const MISSION_MONITOR = entry('mission-monitor', 'Mission Monitor');
const SETTINGS = entry('settings-app', 'Settings');
/** QA-8 — the mocked second addressable app for the ambiguity branch. */
const MONITOR_TWO = entry('mission-monitor-two', 'Mission Monitor Two');
/** Hidden feature — never addressable (Q-6 non-showable edge). */
const SECRET = entry('secret-tool', 'Mission Monitor Secret', false);

// ── normalizeAppQuery (R-2.7) ────────────────────────────────────────────────

describe('normalizeAppQuery — trim, strip quotes, strip ONE leading verb (R-2.7)', () => {
  it('trims leading/trailing whitespace only (internal whitespace preserved)', () => {
    expect(normalizeAppQuery('  Mission Monitor  ')).toBe('Mission Monitor');
    expect(normalizeAppQuery('Mission  Monitor')).toBe('Mission  Monitor');
    expect(normalizeAppQuery('')).toBe('');
    expect(normalizeAppQuery('   ')).toBe('');
  });

  it('strips surrounding double and single quotes', () => {
    expect(normalizeAppQuery('"Mission Monitor"')).toBe('Mission Monitor');
    expect(normalizeAppQuery("'Mission Monitor'")).toBe('Mission Monitor');
    expect(normalizeAppQuery('"Mission Monitor')).toBe('"Mission Monitor');
  });

  it('strips ONE leading command verb, case-insensitively', () => {
    expect(normalizeAppQuery('open Mission Monitor')).toBe('Mission Monitor');
    expect(normalizeAppQuery('OPEN mission-monitor')).toBe('mission-monitor');
    expect(normalizeAppQuery('launch Mission Monitor')).toBe('Mission Monitor');
    expect(normalizeAppQuery('show Mission Monitor')).toBe('Mission Monitor');
    expect(normalizeAppQuery('start Mission Monitor')).toBe('Mission Monitor');
  });

  it('strips only ONE verb', () => {
    expect(normalizeAppQuery('open open Mission Monitor')).toBe('open Mission Monitor');
  });

  it('does not strip a bare verb with no name remainder', () => {
    expect(normalizeAppQuery('open')).toBe('open');
    expect(normalizeAppQuery('launch')).toBe('launch');
  });

  it('handles quotes outside or inside the verb', () => {
    expect(normalizeAppQuery('"open Mission Monitor"')).toBe('Mission Monitor');
    expect(normalizeAppQuery('open "Mission Monitor"')).toBe('Mission Monitor');
  });

  it('preserves the user\u2019s case (the reply echoes their words)', () => {
    expect(normalizeAppQuery('open mIsSiOn MoNiToR')).toBe('mIsSiOn MoNiToR');
  });
});

// ── resolveAppIdentity — resolved via exact id ───────────────────────────────

describe('resolveAppIdentity — exact id match (case-insensitive)', () => {
  const features = [SETTINGS, MISSION_MONITOR];

  it('resolves a stable kebab id', () => {
    const result = resolveAppIdentity('mission-monitor', features);
    expect(result).toEqual({
      kind: 'resolved',
      feature: MISSION_MONITOR,
      displayName: 'Mission Monitor',
    });
  });

  it('resolves the id case-insensitively, with an `open` verb and quotes', () => {
    expect(resolveAppIdentity('open "MISSION-MONITOR"', features)).toEqual({
      kind: 'resolved',
      feature: MISSION_MONITOR,
      displayName: 'Mission Monitor',
    });
  });

  it('prefers the exact id over a display-name candidate', () => {
    const named = entry('mission-monitor', 'Legacy Name');
    const result = resolveAppIdentity('mission-monitor', [MISSION_MONITOR, named]);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.feature).toBe(MISSION_MONITOR);
  });
});

// ── resolveAppIdentity — resolved via appNameMatches ─────────────────────────

describe('resolveAppIdentity — display-name match via appNameMatches', () => {
  const features = [SETTINGS, MISSION_MONITOR];

  it('resolves a whole-query prefix and a whole-word run', () => {
    expect(resolveAppIdentity('Miss', features).kind).toBe('resolved');
    expect(resolveAppIdentity('monitor', features).kind).toBe('resolved');
    expect(resolveAppIdentity('open Mission Mon', features).kind).toBe('resolved');
    expect(resolveAppIdentity('Settings', features).kind).toBe('resolved');
  });

  it('never matches a fragment (`Missing all the time`) or an alias (`MM`)', () => {
    expect(resolveAppIdentity('Missing all the time', features)).toEqual({
      kind: 'unknown',
      spokenName: 'Missing all the time',
    });
    expect(resolveAppIdentity('MM', features)).toEqual({ kind: 'unknown', spokenName: 'MM' });
  });
});

// ── resolveAppIdentity — unknown ─────────────────────────────────────────────

describe('resolveAppIdentity — unknown', () => {
  const features = [SETTINGS, MISSION_MONITOR];

  it('returns the normalized spoken name verbatim (case preserved, verb dropped)', () => {
    expect(resolveAppIdentity('open NotARealApp', features)).toEqual({
      kind: 'unknown',
      spokenName: 'NotARealApp',
    });
    expect(resolveAppIdentity('  "NotARealApp"  ', features)).toEqual({
      kind: 'unknown',
      spokenName: 'NotARealApp',
    });
  });

  it('returns unknown for an empty normalized query', () => {
    expect(resolveAppIdentity('', features)).toEqual({ kind: 'unknown', spokenName: '' });
  });

  it('never resolves a non-showable feature (Q-6 edge)', () => {
    expect(resolveAppIdentity('secret-tool', [SECRET])).toEqual({
      kind: 'unknown',
      spokenName: 'secret-tool',
    });
    expect(resolveAppIdentity('Mission Monitor Secret', [SECRET]).kind).toBe('unknown');
  });
});

// ── resolveAppIdentity — ambiguous (QA-8 mocked >=2 registry) ────────────────

describe('resolveAppIdentity — ambiguous (QA-8)', () => {
  const twoMonitorFeatures = [MISSION_MONITOR, MONITOR_TWO];

  it('returns both candidates when the whole-word query matches more than one', () => {
    const result = resolveAppIdentity('monitor', twoMonitorFeatures);
    expect(result).toEqual({
      kind: 'ambiguous',
      spokenName: 'monitor',
      candidates: [MISSION_MONITOR, MONITOR_TWO],
    });
  });

  it('returns ambiguity for a shared prefix', () => {
    const result = resolveAppIdentity('open Mission', twoMonitorFeatures);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.candidates).toHaveLength(2);
  });

  it('does not report ambiguity for a duplicated registration of ONE feature', () => {
    expect(resolveAppIdentity('monitor', [MISSION_MONITOR, MISSION_MONITOR])).toEqual({
      kind: 'resolved',
      feature: MISSION_MONITOR,
      displayName: 'Mission Monitor',
    });
  });
});
