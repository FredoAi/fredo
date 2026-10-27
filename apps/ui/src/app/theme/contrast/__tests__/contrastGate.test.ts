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
  type MatrixRow,
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
  'exempt',
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

  it('every row carries all 10 fields and its identity is <preset>|<surface>|<state>|<pair>', () => {
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
      expect(typeof row.exempt).toBe('boolean');
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

  it('resolves the light-default primary focus pairs from the deepened contract chrome token and clears 3', () => {
    // ST-2 (#3035) — the gate now resolves `accent.focusRing` (the deepened
    // contract token) rather than the raw brand fill, so these rows clear the
    // 3:1 floor and leave the (now empty) baseline.
    for (const key of [
      'light-default|canvas|focus|focus-ring',
      'light-default|surface|focus|focus-ring',
    ]) {
      const row = matrix.find((r) => r.key === key);
      expect(row, key).toBeDefined();
      expect(row!.kind).toBe('focus');
      expect(row!.floor).toBe(UI_FLOOR);
      expect(row!.ratio, `${key} must clear its 3:1 floor`).toBeGreaterThanOrEqual(UI_FLOOR);
      expect(CONTRAST_BASELINE.find((e) => e.key === key), `${key} must not be baselined`).toBeUndefined();
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
      // #3086 — the slider DISABLED rail is a UI boundary (`range`), not body
      // text; every other disabled pair is the `label` body pair.
      if (row.pairId === 'range') {
        expect(row.kind, row.key).toBe('ui');
        expect(row.floor, row.key).toBe(UI_FLOOR);
      } else {
        expect(row.kind, row.key).toBe('body');
        expect(row.floor, row.key).toBe(BODY_FLOOR);
      }
      // ST-2 (#3035) — WCAG inactive-component exemption (never a floor violation).
      expect(row.exempt, `${row.key} must be WCAG-exempt`).toBe(true);
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

  it('closes the RadioCard.ItemIndicator route: KNOWN_OUT_OF_SCOPE_PAIRS is empty and the indicator is an in-scope row', () => {
    // ST-2 (#3035) — the indicator is now token-backed, so the out-of-scope
    // route is emptied and it becomes a first-class gate row.
    expect(KNOWN_OUT_OF_SCOPE_PAIRS).toEqual([]);
    for (const presetId of PRESET_IDS) {
      const row = matrix.find(
        (r) =>
          r.presetId === presetId &&
          r.surface === 'radio-card' &&
          r.state === 'selected' &&
          r.pairId === 'indicator',
      );
      expect(row, `${presetId} radio-card|selected|indicator`).toBeDefined();
      expect(row!.kind).toBe('ui');
      expect(row!.floor).toBe(UI_FLOOR);
    }
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
  it('contrast matrix evaluates green: no violations, no stale, the ledger emptied and the cap at 0', () => {
    expect(contrast.violations).toEqual([]);
    expect(contrast.staleBaseline).toEqual([]);
    expect(BASELINE_MAX).toBe(0);
    expect(CONTRAST_BASELINE.length).toBe(0);
  });

  it('exempt (WCAG inactive-component) rows are floor-reported but never violations', () => {
    const exemptRows = matrix.filter((r) => r.exempt);
    expect(exemptRows.length).toBeGreaterThan(0);
    const violationKeys = new Set(contrast.violations.map((v) => v.key));
    for (const row of exemptRows) {
      expect(violationKeys.has(row.key), `${row.key} must never be a violation`).toBe(false);
    }
    // Every `disabled` gate row is exempt; no non-disabled row is.
    for (const row of matrix) {
      expect(row.exempt, row.key).toBe(row.state === 'disabled');
    }
  });

  it('filters an exempt row out of belowFloor regardless of ratio (WCAG exemption, not a baseline)', () => {
    // A below-floor exempt row is never a violation; an identical NON-exempt row
    // at the same ratio IS. Proves the exemption is a scope filter, not a cap.
    const base: MatrixRow = {
      key: 'x|control-outline|disabled|label',
      presetId: 'x',
      surface: 'control-outline',
      state: 'disabled',
      pairId: 'label',
      kind: 'body',
      ratio: 1,
      floor: BODY_FLOOR,
      composed: false,
      exempt: true,
    };
    const exempt = base;
    const floorRow: MatrixRow = {
      ...base,
      key: 'x|control-outline|default|label',
      state: 'default',
      exempt: false,
    };
    const evaluation = evaluateContrast([exempt, floorRow], [], 0);
    expect(evaluation.violations.map((v) => v.key)).toEqual([floorRow.key]);
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

describe('#3086 — Wireframe control classes in the gate projection (Q-6, R-3)', () => {
  const WIREFRAME_SURFACES: readonly SurfaceId[] = [
    'segmented',
    'slider',
    'number-input',
    'control-ghost',
    'status-solid',
    'banner',
  ];

  it('represents every Wireframe surface for every preset (no vacuous coverage)', () => {
    for (const presetId of PRESET_IDS) {
      const rows = matrix.filter((r) => r.presetId === presetId);
      const surfaces = new Set(rows.map((r) => r.surface));
      for (const surface of WIREFRAME_SURFACES) {
        expect(surfaces.has(surface), `${presetId} missing Wireframe surface ${surface}`).toBe(true);
      }
    }
  });

  it('gates the Wireframe default/focus/disabled pairs with the absolute floors', () => {
    for (const presetId of PRESET_IDS) {
      for (const [surface, state, pairId, kind] of [
        ['segmented', 'default', 'label', 'body'],
        ['segmented', 'default', 'track', 'ui'],
        ['segmented', 'selected', 'label', 'body'],
        ['slider', 'default', 'track', 'ui'],
        ['slider', 'default', 'range', 'ui'],
        ['number-input', 'default', 'label', 'body'],
        ['number-input', 'default', 'stepper', 'ui'],
        ['control-ghost', 'active', 'label', 'body'],
        ['status-solid', 'default', 'label', 'body'],
        ['banner', 'default', 'label', 'body'],
        ['banner', 'default', 'icon', 'ui'],
        ['canvas', 'default', 'fallback-label', 'body'],
        ['subtle', 'default', 'chip-label', 'body'],
        ['surface', 'default', 'overlay-label', 'body'],
      ] as const) {
        const row = matrix.find(
          (r) => r.presetId === presetId && r.surface === surface && r.state === state && r.pairId === pairId,
        );
        expect(row, `${presetId}|${surface}|${state}|${pairId}`).toBeDefined();
        expect(row!.kind, `${presetId}|${surface}|${state}|${pairId}`).toBe(kind);
        expect(row!.floor, `${presetId}|${surface}|${state}|${pairId}`).toBe(
          kind === 'body' ? BODY_FLOOR : UI_FLOOR,
        );
        expect(row!.exempt, `${presetId}|${surface}|${state}|${pairId}`).toBe(state === 'disabled');
      }
    }
  });

  it('the #3081 Discard pair is gate-guarded and clears the floor on every preset', () => {
    for (const presetId of PRESET_IDS) {
      const row = matrix.find(
        (r) => r.presetId === presetId && r.surface === 'status-solid' && r.state === 'default' && r.pairId === 'label',
      );
      expect(row, `${presetId} status-solid|default|label`).toBeDefined();
      expect(row!.kind).toBe('body');
      expect(row!.floor).toBe(BODY_FLOOR);
      expect(row!.ratio, `${presetId} Discard pair must clear 4.5`).toBeGreaterThanOrEqual(BODY_FLOOR);
    }
  });
});
