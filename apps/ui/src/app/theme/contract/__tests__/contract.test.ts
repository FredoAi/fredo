/**
 * Spec #3034 ST-1 — the theme contract self-check (R-1, R-1.1, R-1.2).
 *
 * Proves, against the shipped preset set (the locked `classic` base + the 18
 * built-in presets), that:
 *  - every enumerated pair's `fg`/`bg` resolves to a name in the token registry
 *    (R-1.2 — a dangling name FAILS);
 *  - every `SurfaceId` × `ControlState` cell is represented (R-1.1 completeness);
 *  - floors are the byte-identical WCAG constants (4.5 body / 3 UI);
 *  - the derivation weights are byte-identical AND single-homed in `DERIVATIONS`;
 *  - the data/art allowlist is byte-identical to the gate's current copy;
 *  - the NEW `status.onSolids` token is declared and derived.
 *
 * Pure — reads the in-repo records only; no DOM, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  ART_PALETTE_ALLOWLIST,
  BODY_FLOOR,
  CONTRACT_PAIRS,
  CONTROL_STATE_IDS,
  DERIVATIONS,
  SEMANTIC_TOKENS,
  SURFACE_IDS,
  TOKEN_NAMES,
  UI_FLOOR,
  type ControlState,
  type SemanticToken,
  type SurfaceId,
} from '../index';
import { RAW_COLOR_ALLOWLIST } from '../../contrast/rawColorAllowlist';
import { themePresets, themes } from '../../../types/theme';

/** The base record's id in the gate's `PRESET_IDS` — the locked `classic` base. */
const BASE_PRESET_ID = 'classic (base — no preset)';

/** The 19 shipped presets: `classic` base + the 18 built-ins. */
const PRESET_IDS: readonly string[] = [
  BASE_PRESET_ID,
  ...themePresets.map((preset) => preset.id),
];

/** Custom-property → the theme-record key that authors it. */
const VAR_TO_THEME_KEY: Readonly<Record<string, string>> = {
  '--body-bg': 'bodyBg',
  '--header-bg': 'headerBg',
  '--card-bg': 'cardBg',
  '--card-hover-bg': 'cardHoverBg',
  '--text-primary': 'textPrimary',
  '--text-secondary': 'textSecondary',
  '--border-color': 'borderColor',
  '--accent-primary': 'accentPrimary',
  '--accent-secondary': 'accentSecondary',
  '--accent-subagent': 'accentSubagent',
  '--accent-nested-subagent': 'accentNestedSubagent',
  '--status-success': 'statusSuccess',
  '--status-warning': 'statusWarning',
  '--status-error': 'statusError',
  '--status-info': 'statusInfo',
  '--overlay-bg': 'overlayBg',
};

const TOKEN_BY_NAME = new Map(SEMANTIC_TOKENS.map((token) => [token.name, token]));
const KNOWN_VARS = new Set(SEMANTIC_TOKENS.map((token) => token.varName));
const AUTHORED_VARS = new Set(
  SEMANTIC_TOKENS.filter((token) => token.authored).map((token) => token.varName),
);

/** var → token, preferring an authored token when several alias one var. */
const VAR_TO_TOKEN = new Map<string, SemanticToken>();
for (const token of SEMANTIC_TOKENS) {
  const existing = VAR_TO_TOKEN.get(token.varName);
  if (!existing || (token.authored && !existing.authored)) {
    VAR_TO_TOKEN.set(token.varName, token);
  }
}

/** The effective `preset ?? classic base` palette for a preset id. */
function effectiveColors(presetId: string): Record<string, string> {
  const base = themes.classic.colors as unknown as Record<string, string>;
  if (presetId === BASE_PRESET_ID) return { ...base };
  const preset = themePresets.find((candidate) => candidate.id === presetId);
  if (!preset) throw new Error(`unknown preset id: ${presetId}`);
  return { ...base, ...(preset.colors as Record<string, string>) };
}

/** Every authored leaf custom-property a token transitively derives from. */
function authoredLeaves(token: SemanticToken, seen: Set<string> = new Set()): string[] {
  if (seen.has(token.name)) return [];
  seen.add(token.name);
  if (token.authored || !token.derivation) return [token.varName];
  const leaves: string[] = [];
  for (const source of token.derivation.sources) {
    const next = VAR_TO_TOKEN.get(source);
    leaves.push(...(next ? authoredLeaves(next, seen) : [source]));
  }
  return leaves;
}

describe('#3034 ST-1 contract — token registry', () => {
  it('declares unique, well-formed tokens with derivation iff non-authored', () => {
    const names = SEMANTIC_TOKENS.map((token) => token.name);
    expect(new Set(names).size).toBe(names.length);
    for (const token of SEMANTIC_TOKENS) {
      expect(token.varName.startsWith('--'), token.name).toBe(true);
      if (token.authored) {
        expect(token.derivation, token.name).toBeUndefined();
      } else {
        expect(token.derivation, token.name).toBeDefined();
        expect(token.derivation!.sources.length, token.name).toBeGreaterThan(0);
      }
    }
    expect(TOKEN_NAMES.size).toBe(names.length);
  });

  it('has no dangling derivation source (every source is a known var)', () => {
    for (const token of SEMANTIC_TOKENS) {
      for (const source of token.derivation?.sources ?? []) {
        expect(KNOWN_VARS.has(source), `${token.name} -> ${source}`).toBe(true);
      }
    }
  });
});

describe('#3034 ST-1 contract — R-1.2: no pair names a token absent from the registry', () => {
  it('fails the oracle for a dangling token name', () => {
    const dangling = ['accent.__notReal__', 'fg.__notReal__'].filter(
      (name) => !TOKEN_NAMES.has(name),
    );
    expect(dangling).toHaveLength(2);
  });

  it('resolves every ContractPair fg/bg to a registered token', () => {
    for (const pair of CONTRACT_PAIRS) {
      expect(TOKEN_NAMES.has(pair.fg), `${pair.surface}/${pair.state}:fg=${pair.fg}`).toBe(true);
      expect(TOKEN_NAMES.has(pair.bg), `${pair.surface}/${pair.state}:bg=${pair.bg}`).toBe(true);
    }
  });
});

describe('#3034 ST-1 contract — R-1.1: the surface × state completeness enumeration', () => {
  it('exposes the binding surface/state vocabulary', () => {
    expect(SURFACE_IDS).toHaveLength(19);
    expect(CONTROL_STATE_IDS).toHaveLength(6);
    expect(CONTROL_STATE_IDS).toContain('active');
    for (const surface of ['overlay', 'nav', 'input', 'card', 'pill', 'badge'] as SurfaceId[]) {
      expect(SURFACE_IDS).toContain(surface);
    }
    // Spec #3086 — the six Wireframe control classes join the vocabulary.
    for (const surface of [
      'segmented',
      'slider',
      'number-input',
      'control-ghost',
      'status-solid',
      'banner',
    ] as SurfaceId[]) {
      expect(SURFACE_IDS).toContain(surface);
    }
  });

  it('represents every SurfaceId × ControlState cell', () => {
    for (const surface of SURFACE_IDS) {
      for (const state of CONTROL_STATE_IDS) {
        const found = CONTRACT_PAIRS.some(
          (pair) => pair.surface === surface && pair.state === state,
        );
        expect(found, `${surface} × ${state}`).toBe(true);
      }
    }
  });
});

describe('#3034 ST-1 contract — floors and derivations are byte-identical', () => {
  it('declares the WCAG floors unchanged', () => {
    expect(BODY_FLOOR).toBe(4.5);
    expect(UI_FLOOR).toBe(3);
  });

  it('applies the floor selected by the pair kind', () => {
    for (const pair of CONTRACT_PAIRS) {
      expect(pair.floor, `${pair.surface}/${pair.state}/${pair.pairId}`).toBe(
        pair.kind === 'body' ? 4.5 : 3,
      );
    }
  });

  it('single-homes the derivation weights in DERIVATIONS', () => {
    expect([...DERIVATIONS.accentStrong]).toEqual([0.55, 0.45]);
    // #3035 ST-1 — textSubtle raised 65/35 → 55/45 so `fg.subtle` clears 4.5.
    expect([...DERIVATIONS.textSubtle]).toEqual([0.55, 0.45]);
    expect(DERIVATIONS.hoverBgPct).toBe(0.06);

    expect([...(TOKEN_BY_NAME.get('accent.strong')!.derivation!.weights ?? [])]).toEqual([
      ...DERIVATIONS.accentStrong,
    ]);
    expect([...(TOKEN_BY_NAME.get('fg.subtle')!.derivation!.weights ?? [])]).toEqual([
      ...DERIVATIONS.textSubtle,
    ]);
    expect([...(TOKEN_BY_NAME.get('bg.hover')!.derivation!.weights ?? [])]).toEqual([
      DERIVATIONS.hoverBgPct,
    ]);
  });
});

describe('#3034 ST-1 contract — status.onSolids (NEW token)', () => {
  it('is declared and derived by the WCAG-max luminance rule', () => {
    const onSolids = TOKEN_BY_NAME.get('status.onSolids');
    expect(onSolids).toBeDefined();
    expect(onSolids!.authored).toBe(false);
    expect(onSolids!.derivation!.fn).toBe('wcag-max-contrast');
  });
});

describe('#3034 ST-1 contract — preset coverage (19 shipped palettes)', () => {
  it('ships the classic base plus the 18 built-ins', () => {
    expect(PRESET_IDS).toHaveLength(19);
    expect(PRESET_IDS[0]).toBe(BASE_PRESET_ID);
    expect(new Set(PRESET_IDS).size).toBe(19);
  });

  it('backs every pair token for every shipped preset (authored leaves resolve)', () => {
    for (const authoredVar of AUTHORED_VARS) {
      expect(VAR_TO_THEME_KEY[authoredVar], authoredVar).toBeDefined();
    }
    for (const presetId of PRESET_IDS) {
      const colors = effectiveColors(presetId);
      for (const pair of CONTRACT_PAIRS) {
        for (const tokenName of [pair.fg, pair.bg]) {
          const token = TOKEN_BY_NAME.get(tokenName)!;
          for (const leaf of authoredLeaves(token)) {
            const value = colors[VAR_TO_THEME_KEY[leaf]];
            expect(value, `${presetId} ${tokenName} ${leaf}`).toBeTruthy();
          }
        }
      }
    }
  });
});

describe('#3034 ST-1 contract — the data/art allowlist', () => {
  it('is byte-identical to the gate’s current allowlist (ST-3 re-export)', () => {
    expect(ART_PALETTE_ALLOWLIST).toEqual(RAW_COLOR_ALLOWLIST);
  });

  it('permits only named data/art kinds', () => {
    const allowed = new Set(['terminal-ansi', 'canvas-3d', 'node-identity', 'test-fixture']);
    for (const entry of ART_PALETTE_ALLOWLIST) {
      expect(allowed.has(entry.kind), entry.file).toBe(true);
      expect(entry.literals.length).toBeGreaterThan(0);
    }
  });
});
