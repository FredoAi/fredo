/**
 * Spec #3033 ST-5 — the contrast gate's NEGATIVE seams: every excuse layer must
 * fail closed. All fixtures are pure-function inputs; the oracle is the return
 * value of `evaluateContrast` / `evaluateRawColors` (never a live read).
 */

import { describe, expect, it } from 'vitest';
import { BODY_FLOOR, UI_FLOOR } from '../wcag';
import { buildContrastMatrix, type MatrixRow } from '../matrix';
import { evaluateContrast, type ContrastBaselineEntry } from '../evaluate';
import { BASELINE_MAX, CONTRAST_BASELINE } from '../contrastBaseline';
import { defaultScanTargets, scanRawColors } from '../rawColorScan';
import { RAW_COLOR_ALLOWLIST } from '../rawColorAllowlist';
import { evaluateRawColors, type RawColorBaselineEntry } from '../rawColorEvaluate';
import { RAW_COLOR_BASELINE, RAW_COLOR_BASELINE_MAX } from '../rawColorBaseline';

const matrix = buildContrastMatrix();
const hits = scanRawColors(defaultScanTargets());

function injectedRow(over: Partial<MatrixRow> & Pick<MatrixRow, 'key'>): MatrixRow {
  return {
    presetId: 'light-default',
    surface: 'canvas',
    state: 'default',
    pairId: '__injected__',
    kind: 'body',
    ratio: 1.2,
    floor: BODY_FLOOR,
    composed: false,
    exempt: false,
    ...over,
  };
}

/**
 * A synthesized baseline entry — the committed ledger is EMPTY after the #3035
 * ST-2 drain, so the excuse-layer seams build their own fixture rather than
 * indexing `CONTRAST_BASELINE[0]` (now absent). Mirrors the raw-colour stale
 * test's synthesized `{file, literal}` entry.
 */
function injectedBaselineEntry(
  over: Partial<ContrastBaselineEntry> & Pick<ContrastBaselineEntry, 'key'>,
): ContrastBaselineEntry {
  return { ratio: 1.2, issue: 3035, note: 'synthesized ledger fixture', ...over };
}

describe('contrast: an unbaselined below-floor pair is a NEW violation (Q-3 / Q-8, AC2.b)', () => {
  it('reports an injected fresh-key pair absent from the baseline', () => {
    const injected = injectedRow({ key: 'light-default|canvas|default|__injected__' });
    const evaluation = evaluateContrast([...matrix, injected], CONTRAST_BASELINE, BASELINE_MAX);
    expect(evaluation.violations.map((v) => v.key)).toContain(injected.key);
  });

  it('reports every below-floor row against an EMPTY baseline', () => {
    const injected = injectedRow({ key: 'light-default|canvas|default|__injected-empty__' });
    const evaluation = evaluateContrast([injected], [], 1);
    expect(evaluation.violations).toHaveLength(1);
    expect(evaluation.baselined).toEqual([]);
  });

  it('does NOT report a row at exactly its floor (boundary)', () => {
    const boundary = injectedRow({
      key: 'light-default|canvas|default|__boundary__',
      ratio: UI_FLOOR,
      floor: UI_FLOOR,
    });
    expect(evaluateContrast([boundary], [], 1).violations).toEqual([]);
  });

  it('keys a violating row to the baseline by identity (baselined, not new)', () => {
    // #3035 ST-2 — the committed ledger is empty, so synthesize the entry.
    const baselined = injectedBaselineEntry({ key: 'light-default|canvas|default|__ledger__' });
    const row = injectedRow({ key: baselined.key, ratio: 1.2 });
    const evaluation = evaluateContrast([row], [baselined], 1);
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.baselined.map((r) => r.key)).toContain(baselined.key);
  });
});

describe('contrast: a stale baseline entry fails (Q-9)', () => {
  it('reports a baselined entry whose row is absent from the matrix', () => {
    // #3035 ST-2 — the committed ledger is empty, so synthesize an entry whose
    // key cannot match any live matrix row (mirrors the raw-colour stale test).
    const entry = injectedBaselineEntry({ key: 'light-default|canvas|default|__stale__' });
    const evaluation = evaluateContrast(matrix, [entry], 1);
    expect(evaluation.staleBaseline.map((e) => e.key)).toContain(entry.key);
  });
});

describe('contrast: the frozen cap fails closed (Q-10)', () => {
  it('throws when the baseline grows past BASELINE_MAX', () => {
    // #3034 follow-up: the ledger ratcheted DOWN below the frozen cap, so exceed
    // the cap explicitly (intent unchanged: an over-cap baseline must throw).
    const overCap: ContrastBaselineEntry[] = Array.from(
      { length: BASELINE_MAX - CONTRAST_BASELINE.length + 1 },
      (_, index) => ({
        key: `light-default|canvas|default|__over-cap-${index}__`,
        ratio: 1,
        issue: 3035,
        note: 'injected over-cap entry',
      }),
    );
    expect(() =>
      evaluateContrast(matrix, [...CONTRAST_BASELINE, ...overCap], BASELINE_MAX),
    ).toThrow();
  });

  it('throws when a baseline entry cites no live issue number', () => {
    const bogus: ContrastBaselineEntry = {
      key: 'light-default|canvas|default|__bogus__',
      ratio: 1,
      issue: 0,
      note: 'no live issue',
    };
    expect(() => evaluateContrast(matrix, [bogus], 1)).toThrow();
  });
});

describe('raw colour: an unbaselined literal is a NEW violation (Q-4 re-bind, AC2.c)', () => {
  it('reports an injected hardcoded colour via the evaluator', () => {
    const injected = scanRawColors([
      { path: 'src/applications/__injected__/Bad.tsx', source: 'const c = "#ff0000";' },
    ]);
    const evaluation = evaluateRawColors(
      injected,
      RAW_COLOR_ALLOWLIST,
      RAW_COLOR_BASELINE,
      RAW_COLOR_BASELINE_MAX,
    );
    expect(evaluation.violations.map((v) => v.literal)).toContain('#ff0000');
  });
});

describe('raw colour: a stale baseline entry fails', () => {
  it('reports a baselined literal that no longer appears in the tree', () => {
    // #3034 ST-4 emptied the committed ledger, so the stale-proof synthesizes
    // its own baseline entry (a `{file, literal}` that cannot match any live
    // hit) instead of indexing `RAW_COLOR_BASELINE[0]` (now absent).
    const entry: RawColorBaselineEntry = {
      file: 'apps/ui/src/applications/__stale__/Gone.tsx',
      literal: '#ff00aa',
      issue: 3035,
      note: 'stale entry — the literal is no longer present in the tree',
    };
    const evaluation = evaluateRawColors(hits, RAW_COLOR_ALLOWLIST, [entry], 1);
    expect(
      evaluation.staleBaseline.some(
        (e) => e.file === entry.file && e.literal === entry.literal,
      ),
    ).toBe(true);
  });
});

describe('raw colour: the frozen cap fails closed', () => {
  it('throws when the baseline grows past RAW_COLOR_BASELINE_MAX', () => {
    const extra: RawColorBaselineEntry = {
      file: 'apps/ui/src/applications/__injected__/Bad.tsx',
      literal: '#ff00aa',
      issue: 3035,
      note: 'injected over-cap entry',
    };
    expect(() =>
      evaluateRawColors(
        hits,
        RAW_COLOR_ALLOWLIST,
        [...RAW_COLOR_BASELINE, extra],
        RAW_COLOR_BASELINE_MAX,
      ),
    ).toThrow();
  });
});

describe('raw colour: anti-widening — an allowlisted file licenses ONLY its pinned literals', () => {
  const canvasEntry = RAW_COLOR_ALLOWLIST.find((e) => e.kind === 'canvas-3d')!;

  it('excuses a pinned literal in the allowlisted file', () => {
    const pinned = canvasEntry.literals[0];
    const control = scanRawColors([
      { path: canvasEntry.file, source: `const c = '${pinned}';` },
    ]);
    const evaluation = evaluateRawColors(
      control,
      RAW_COLOR_ALLOWLIST,
      RAW_COLOR_BASELINE,
      RAW_COLOR_BASELINE_MAX,
    );
    expect(evaluation.violations).toEqual([]);
  });

  it('reports a NON-baselined UI-chrome literal added to the same allowlisted file', () => {
    const bad = scanRawColors([
      { path: canvasEntry.file, source: "color='#ff00aa';" },
    ]);
    const evaluation = evaluateRawColors(
      bad,
      RAW_COLOR_ALLOWLIST,
      RAW_COLOR_BASELINE,
      RAW_COLOR_BASELINE_MAX,
    );
    expect(evaluation.violations.map((v) => v.literal)).toContain('#ff00aa');
  });
});
