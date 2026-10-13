/**
 * Spec #3033 ST-5 — the contrast gate's positive / coverage / absolute-floor /
 * day-one-green suite.
 *
 * The oracle for every floor and baseline case is the PURE return value of
 * `evaluateContrast` / `evaluateRawColors` — never a live read, never a
 * screenshot. Source-shape assertions (no tolerance tier) read the committed
 * module sources via Vite `?raw` (read-only, no filesystem access).
 */

import { describe, expect, it } from 'vitest';
import { BODY_FLOOR, UI_FLOOR } from '../wcag';
import {
  buildContrastMatrix,
  KNOWN_OUT_OF_SCOPE_PAIRS,
  PRESET_IDS,
  type ControlState,
  type SurfaceId,
} from '../matrix';
import { evaluateContrast } from '../evaluate';
import { BASELINE_MAX, CONTRAST_BASELINE } from '../contrastBaseline';
import { defaultScanTargets, scanRawColors } from '../rawColorScan';
import { RAW_COLOR_ALLOWLIST } from '../rawColorAllowlist';
import { evaluateRawColors } from '../rawColorEvaluate';
import { RAW_COLOR_BASELINE, RAW_COLOR_BASELINE_MAX } from '../rawColorBaseline';
import matrixSource from '../matrix.ts?raw';
import evaluateSource from '../evaluate.ts?raw';

const BASE_PRESET = 'classic (base — no preset)';
const SURFACES: readonly SurfaceId[] = [
  'canvas',
  'surface',
  'subtle',
  'control-outline',
  'control-solid',
  'select',
  'radio-card',
];
const STATES: readonly ControlState[] = ['default', 'hover', 'focus', 'disabled', 'selected'];
const ROW_FIELDS = [
  'key',
  'presetId',
  'surface',
  'state',
  'pairId',
  'kind',
  'ratio',
  'floor',
  'composed',
] as const;

const matrix = buildContrastMatrix();
const contrast = evaluateContrast(matrix, CONTRAST_BASELINE, BASELINE_MAX);

describe('matrix coverage (Q-1, AC1 / R-1)', () => {
  it('enumerates the 19 shipped presets: classic base + 18 built-ins, no turbo', () => {
    expect(PRESET_IDS.length).toBe(19);
    expect(PRESET_IDS[0]).toBe(BASE_PRESET);
    expect(PRESET_IDS).toContain('classic (base — no preset)');
    expect(PRESET_IDS).not.toContain('turbo');
    expect(PRESET_IDS.filter((id) => id === BASE_PRESET)).toHaveLength(1);
    // base distinct from the 18 built-ins
    expect(new Set(PRESET_IDS).size).toBe(19);
  });

  it('every row carries all 9 fields and its identity is <preset>|<surface>|<state>|<pair>', () => {
    for (const row of matrix) {
      for (const field of ROW_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(row, field), `${row.key} missing ${field}`).toBe(
          true,
        );
      }
      expect(row.key).toBe(`${row.presetId}|${row.surface}|${row.state}|${row.pairId}`);
      expect(Number.isFinite(row.ratio)).toBe(true);
      expect(Number.isFinite(row.floor)).toBe(true);
      expect(typeof row.composed).toBe('boolean');
    }
  });

  it('row keys are unique', () => {
    const keys = matrix.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers every declared surface and state for EVERY preset (no vacuous coverage)', () => {
    for (const presetId of PRESET_IDS) {
      const rows = matrix.filter((r) => r.presetId === presetId);
      const surfaces = new Set(rows.map((r) => r.surface));
      const states = new Set(rows.map((r) => r.state));
      for (const surface of SURFACES) {
        expect(surfaces.has(surface), `${presetId} missing surface ${surface}`).toBe(true);
      }
      for (const state of STATES) {
        expect(states.has(state), `${presetId} missing state ${state}`).toBe(true);
      }
    }
  });
});

describe('absolute floor, no tolerance tier (Q-2, AC2 / R-2)', () => {
  it('never reports below floor without a baseline key', () => {
    const baselineKeys = new Set(CONTRAST_BASELINE.map((e) => e.key));
    for (const row of matrix) {
      if (row.ratio < row.floor) {
        expect(baselineKeys.has(row.key), `unbaselined violation ${row.key}`).toBe(true);
      }
    }
  });

  it('assigns the absolute floor by kind: body = 4.5, large|ui|border|focus = 3', () => {
    for (const row of matrix) {
      if (row.kind === 'body') {
        expect(row.floor, row.key).toBe(BODY_FLOOR);
      } else {
        expect(row.floor, row.key).toBe(UI_FLOOR);
      }
    }
    expect(BODY_FLOOR).toBe(4.5);
    expect(UI_FLOOR).toBe(3);
  });

  it('floor-checks the light-default primary focus pairs at 3 and baselines them to #3035', () => {
    for (const key of [
      'light-default|canvas|focus|focus-ring',
      'light-default|surface|focus|focus-ring',
    ]) {
      const row = matrix.find((r) => r.key === key);
      expect(row, key).toBeDefined();
      expect(row!.kind).toBe('focus');
      expect(row!.floor).toBe(UI_FLOOR);
      const entry = CONTRAST_BASELINE.find((e) => e.key === key);
      expect(entry, `${key} must be baselined`).toBeDefined();
      expect(entry!.issue).toBe(3035);
    }
  });

  it('has no no-worse-than-control / tolerance tier in matrix.ts or evaluate.ts', () => {
    for (const source of [matrixSource, evaluateSource]) {
      expect(source).not.toMatch(/no-worse-than-control/i);
      expect(source).not.toMatch(/tolerance/i);
    }
  });
});

describe('AC5 control classes and states (Q-7, R-5)', () => {
  it('includes outline / select / radio-card surfaces with disabled + selected states per preset', () => {
    for (const presetId of PRESET_IDS) {
      for (const surface of ['control-outline', 'select', 'radio-card'] as const) {
        const rows = matrix.filter((r) => r.presetId === presetId && r.surface === surface);
        expect(rows.length, `${presetId} ${surface}`).toBeGreaterThan(0);
        expect(
          rows.some((r) => r.state === 'disabled'),
          `${presetId} ${surface} disabled`,
        ).toBe(true);
        if (surface === 'radio-card') {
          expect(rows.some((r) => r.state === 'selected'), `${presetId} radio-card selected`).toBe(
            true,
          );
        }
      }
    }
  });

  it('models disabled as the fg.subtle TOKEN (not opacity), identically across the control classes', () => {
    const disabled = matrix.filter((r) => r.state === 'disabled');
    expect(disabled.length).toBeGreaterThan(0);
    for (const row of disabled) {
      expect(row.composed, `${row.key} must be a token read, not an opacity composition`).toBe(false);
      expect(row.kind, row.key).toBe('body');
      expect(row.floor, row.key).toBe(BODY_FLOOR);
    }
    // `fg.subtle` on the surface background is preset-uniform across the three classes.
    for (const presetId of PRESET_IDS) {
      const ratios = (['control-outline', 'select', 'radio-card'] as const).map((surface) => {
        const row = matrix.find(
          (r) => r.presetId === presetId && r.surface === surface && r.state === 'disabled',
        );
        expect(row, `${presetId} ${surface} disabled`).toBeDefined();
        return row!.ratio;
      });
      expect(new Set(ratios).size, `${presetId} disabled ratios must be identical`).toBe(1);
    }
    // The only remaining composed pairs are the alpha-derived solid hover / radio selected fill.
    const solidHover = matrix.find(
      (r) => r.surface === 'control-solid' && r.state === 'hover',
    );
    expect(solidHover?.composed).toBe(true);
  });

  it('routes the non-token RadioCard.ItemIndicator to #3035 in KNOWN_OUT_OF_SCOPE_PAIRS', () => {
    const entry = KNOWN_OUT_OF_SCOPE_PAIRS.find(
      (p) => p.surface === 'radio-card' && p.pairId === 'item-indicator',
    );
    expect(entry).toBeDefined();
    expect(entry!.issue).toBe(3035);
  });

  it('uses the 4.5 body floor for the radio-card label (body text), not 3', () => {
    for (const row of matrix) {
      if (row.surface === 'radio-card' && row.pairId === 'label') {
        expect(row.floor).toBe(BODY_FLOOR);
      }
    }
  });
});

describe('day-one green on the tip (Q-5 re-bind, AC1 / AC3)', () => {
  it('contrast matrix evaluates green: no violations, no stale, baseline at or under the frozen cap', () => {
    expect(contrast.violations).toEqual([]);
    expect(contrast.staleBaseline).toEqual([]);
    expect(BASELINE_MAX).toBe(184);
    expect(CONTRAST_BASELINE.length).toBeLessThanOrEqual(BASELINE_MAX);
  });

  it('raw-colour scan evaluates green on the real tree: no violations, no stale, cap === baseline length', () => {
    const hits = scanRawColors(defaultScanTargets());
    expect(hits.length).toBeGreaterThan(0);
    const evaluation = evaluateRawColors(hits, RAW_COLOR_ALLOWLIST, RAW_COLOR_BASELINE, RAW_COLOR_BASELINE_MAX);
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.staleBaseline).toEqual([]);
    expect(RAW_COLOR_BASELINE.length).toBe(RAW_COLOR_BASELINE_MAX);
  });
});
