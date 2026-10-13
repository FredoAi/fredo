/**
 * Spec #2946 ST-11 (R-1.3) — global visible focus + G-235 pre-validation.
 *
 * R-1.3 [continuous]: WHILE focus is anywhere inside Fredo, the focused element
 * renders a visible focus indicator that is not colour-only and clears its
 * contrast floor against the adjacent surface in both light and dark themes.
 *
 * This suite pins three things:
 *  1. `system.ts` ships ONE global `:focus-visible` treatment (2px accent
 *     outline + 2px offset, NEVER `outline: none`), plus the nav-surface
 *     variant that paints with `--accent-strong` — selector-only, no markup.
 *  2. The rule is emitted into Chakra's `base` cascade layer with no
 *     `!important`, so an existing per-component `_focusVisible` ring is
 *     PRESERVED (regression invariant), never overridden.
 *  3. The G-235 governing-tier table: for every shipped preset (the 18 curated
 *     presets + the reachable no-preset `classic` base) the suite computes the
 *     primary painted pair, the nav pair and the foreground-on-surface pair and
 *     asserts the tier (`absolute-3:1` | `no-worse-than-control`) is consistent
 *     with the theme tokens — settled BEFORE implementation, not after a FAIL.
 *
 * #3035 ST-3 re-based this suite (regression surface). ST-1 re-pointed
 * `accent.focusRing` — and the painted global `:focus-visible` ring — from the
 * raw brand fill (`--accent-primary`) to the deepened `accent.strong`
 * (`--accent-strong`), and split `border.default` onto the derived
 * `--border-strong`. The pins below now assert the NEW contract values, and the
 * G-235 table scores the DEEPENED ring (the same `accent.strong` mix the painted
 * rule resolves to). The `no-worse-than-control` machinery is retained (it still
 * governs any pair that genuinely cannot clear the absolute floor); it is simply
 * empty now that the deepened ring clears every preset.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { system } from '../system';
import { SEMANTIC_TOKENS } from '../contract';
import { colorMixValueFor } from '../../providers/ThemeProvider';
import { themes, themePresets } from '../../types/theme';
// #3033 ST-1 — the WCAG arithmetic is single-sourced into `../contrast/wcag`
// (the contrast gate's shared implementation). Imported, not re-declared; the
// assertions, floors and tiers below stay byte-identical (G-235 history).
import { type Rgb, contrast, mixSrgb, parseColor, round2 } from '../contrast/wcag';

// ── globalCss / token CSS readers (same shape the #2865 suite uses) ───────────

type Dict = Record<string, unknown>;

const globalBase = (): Dict => {
  const g = system.getGlobalCss() as Dict;
  return g['@layer base'] as Dict;
};

const tokenBase = (): Record<string, string> => {
  const tokenCss = system.getTokenCss() as Dict;
  const layer = tokenCss['@layer tokens'] as Dict | Dict[];
  const entry = Array.isArray(layer) ? layer[0] : layer;
  return entry['&:where(html, .chakra-theme)'] as Record<string, string>;
};

/** The global `:focus-visible` declaration (serialize prefixes the key with `&`). */
const globalFocusRule = (): Dict => globalBase()['&:focus-visible'] as Dict;

/** The nav-surface `:focus-visible` declaration, located by its selector. */
const navFocusRule = (): Dict => {
  const key = Object.keys(globalBase()).find((k) => k.includes('.fredo-window__header'));
  expect(key, 'nav-surface :focus-visible rule must exist').toBeTruthy();
  return globalBase()[key as string] as Dict;
};

const readSource = (relative: string): string =>
  fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** Strip line and block comments from a source string (keeps string content). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ── WCAG contrast arithmetic (the G-235 pre-validation) ──────────────────────
// #3033 ST-1 — `Rgb`, `parseColor`, `contrast`, `mixSrgb`, `round2` (and the
// internal `luminance`) live in `../contrast/wcag`, imported above. The table
// below is byte-identical to its pre-extraction form (G-235 history).

// ── The table ────────────────────────────────────────────────────────────────

const ABSOLUTE_TIER = 'absolute-3:1';
const TOLERANCE_TIER = 'no-worse-than-control';
const ABSOLUTE_FLOOR = 3;
const TOLERANCE = 0.2;

/** The ThemeProvider `--accent-strong` derivation (T6): 55% accent + 45% text. */
const ACCENT_STRONG_ACCENT_PCT = 0.55;
const ACCENT_STRONG_TEXT_PCT = 0.45;

interface GoverningRow {
  id: string;
  /**
   * primary painted pair: the DEEPENED ring (`accent.focusRing` → `accent.strong`,
   * #3035 ST-1) vs bg.surface (--card-bg).
   */
  ringSurface: number;
  /** primary painted pair: deepened ring vs bg.canvas (--body-bg). */
  ringCanvas: number;
  /** worst-case primary pair — the value the tier is decided on. */
  primaryMin: number;
  primaryTier: string;
  /** |deepened ring − pre-change control| ratio for the primary pair (same token ⇒ 0). */
  primaryDelta: number;
  /** nav pair: ring (accent.strong) vs bg.subtle (--header-bg). */
  navStrong: number;
  navTier: string;
  navDelta: number;
  /** foreground-on-surface: focused glyph (fg.default) vs the control fill. */
  glyphSurface: number;
  glyphNav: number;
  glyphTier: string;
}

const BASE_COLORS = themes.classic.colors as unknown as Record<string, string>;

/** `preset ?? base` token resolution — exactly ThemeProvider's layering. */
const resolveToken = (presetColors: Record<string, string>, key: string): string =>
  presetColors[key] ?? BASE_COLORS[key];

/** Build the per-preset governing-tier table from the theme token data. */
function buildGoverningTierTable(): GoverningRow[] {
  const rows: Array<{ id: string; colors: Record<string, string> }> = [
    { id: 'classic (base — no preset)', colors: {} },
    ...themePresets.map((p) => ({ id: p.id, colors: p.colors as Record<string, string> })),
  ];

  return rows.map(({ id, colors }) => {
    const accent = parseColor(resolveToken(colors, 'accentPrimary'));
    const text = parseColor(resolveToken(colors, 'textPrimary'));
    const card = parseColor(resolveToken(colors, 'cardBg'));
    const body = parseColor(resolveToken(colors, 'bodyBg'));
    const header = parseColor(resolveToken(colors, 'headerBg'));
    expect(accent, `${id}: accentPrimary parseable`).toBeTruthy();
    expect(text, `${id}: textPrimary parseable`).toBeTruthy();
    expect(card, `${id}: cardBg parseable`).toBeTruthy();
    expect(body, `${id}: bodyBg parseable`).toBeTruthy();
    expect(header, `${id}: headerBg parseable`).toBeTruthy();

    // `--accent-strong` is a live color-mix over the resolved accent + text.
    const strong = mixSrgb(accent!, text!, ACCENT_STRONG_ACCENT_PCT, ACCENT_STRONG_TEXT_PCT);

    // #3035 ST-1 — the painted ring is the deepened `accent.strong`
    // (`accent.focusRing` was re-pointed from the raw brand fill), so the
    // G-235 table scores the DEEPENED ring, never the raw accent.
    const ringSurface = contrast(strong, card!);
    const ringCanvas = contrast(strong, body!);
    const primaryMin = Math.min(ringSurface, ringCanvas);
    const navStrong = contrast(strong, header!);
    const glyphSurface = contrast(text!, card!);
    const glyphNav = contrast(text!, header!);

    // The pre-change control painted the RAW brand fill (`--accent-primary`)
    // as the ring; `primaryDelta` measures how far the deepened ring moved from
    // it. A positive delta is normally an improvement; on a near-white accent
    // the deepened mix can dip marginally (still far above the floor), which the
    // governing tier accounts for.
    const primaryDelta = round2(Math.max(
      Math.abs(ringSurface - contrast(accent!, card!)),
      Math.abs(ringCanvas - contrast(accent!, body!)),
    ));
    const navDelta = round2(Math.abs(navStrong - contrast(strong, header!)));

    const primaryTier = primaryMin >= ABSOLUTE_FLOOR ? ABSOLUTE_TIER : TOLERANCE_TIER;
    const navTier = navStrong >= ABSOLUTE_FLOOR ? ABSOLUTE_TIER : TOLERANCE_TIER;
    const glyphTier =
      Math.min(glyphSurface, glyphNav) >= ABSOLUTE_FLOOR ? ABSOLUTE_TIER : TOLERANCE_TIER;

    return {
      id,
      ringSurface: round2(ringSurface),
      ringCanvas: round2(ringCanvas),
      primaryMin: round2(primaryMin),
      primaryTier,
      primaryDelta,
      navStrong: round2(navStrong),
      navTier,
      navDelta,
      glyphSurface: round2(glyphSurface),
      glyphNav: round2(glyphNav),
      glyphTier,
    };
  });
}

const TABLE = buildGoverningTierTable();

// ── Tests ────────────────────────────────────────────────────────────────────

describe('#2946 ST-11 global :focus-visible rule', () => {
  it('emits ONE global :focus-visible treatment with a tokenised 2px accent ring', () => {
    const rule = globalFocusRule();
    expect(rule, 'global :focus-visible rule').toBeTruthy();
    // #3035 ST-1 — the deepened ring (`accent.strong`) is now the painted
    // global treatment, not the raw brand fill.
    expect(rule.outline).toBe('2px solid var(--accent-strong)');
    expect(rule.outlineOffset).toBe('2px');
  });

  it('never ships an `outline: none` blanket override', () => {
    expect(globalFocusRule().outline).not.toBe('none');
    expect(JSON.stringify(globalBase())).not.toContain('outline:none');
    expect(globalFocusRule().outline).not.toBeUndefined();
  });

  it('nav-surface variant paints with the deepened --accent-strong (selector-only, no markup)', () => {
    const nav = navFocusRule();
    expect(nav.outline).toBe('2px solid var(--accent-strong)');
    expect(nav.outlineOffset).toBe('2px');
    // Both selector legs reference pre-existing DOM (chrome class + landmark role).
    const key = Object.keys(globalBase()).find((k) => k.includes('.fredo-window__header'))!;
    expect(key).toContain('[role="navigation"]');
    expect(key).toContain('nav');
  });

  it('resolves the ring tokens through the semantic-token bridge', () => {
    const base = tokenBase();
    // accent.focusRing (system.ts) and accent.strong — Chakra kebab-cases the
    // camelCase token segment (`focus-ring`). #3035 ST-1 re-pointed
    // accent.focusRing onto the deepened `--accent-strong`.
    expect(base['--chakra-colors-accent\\.focus-ring']).toBe('var(--accent-strong)');
    expect(base['--chakra-colors-accent\\.strong']).toBe('var(--accent-strong)');
    expect(globalFocusRule().outline).toContain(base['--chakra-colors-accent\\.focus-ring']);
    expect(navFocusRule().outline).toContain(base['--chakra-colors-accent\\.strong']);
  });

  it('lives in the base cascade layer with no !important, so component rings win', () => {
    // Chakra wraps globalCss in `@layer base`; unlayered component styles (all
    // the existing `_focusVisible` rings) beat it. This is the mechanism that
    // preserves the per-component rings — pinned here.
    const g = system.getGlobalCss() as Dict;
    expect(g['@layer base']).toBeTruthy();
    expect(JSON.stringify(globalBase())).not.toContain('!important');
  });

  it('keeps the `button { color: inherit }` pin and re-bases the outline chrome onto the recipe', () => {
    const base = globalBase();
    // The pre-existing globalCss `button { color: inherit }` pin is retained.
    expect(base['&button']).toEqual({ color: 'inherit' });
    // #3035 ST-1 rework — the outline/ghost chrome lives in the recipe (the
    // cascade-winning `@layer recipes` path), not in `button[data-variant=…]`
    // global rules that match nothing (Chakra v3.34.0 emits no `data-variant`).
    // Those dead selectors are GONE; the LIVE recipe carries the contract tokens.
    expect(base['&button[data-variant="outline"]']).toBeUndefined();
    expect(base['&button[data-variant="outline"]:hover']).toBeUndefined();
    const recipe = system.getRecipe('button') as {
      variants: { variant: Record<string, Record<string, unknown>> };
    };
    expect(recipe.variants.variant.outline.color).toBe('fg.default');
    expect(recipe.variants.variant.outline.borderColor).toBe('border.default');
  });

  it('source audit — zero hex/rgba and zero var()NN alpha-append in system.ts', () => {
    const source = stripComments(readSource('../system.ts'));
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgba?|hsla?)\s*\(/);
    expect(source).not.toMatch(/var\(--[^)]+\)\d/);
  });
});

describe('#2946 ST-11 G-235 per-preset governing-tier table', () => {
  it('covers every shipped preset plus the reachable no-preset base', () => {
    expect(TABLE).toHaveLength(themePresets.length + 1);
    const ids = TABLE.map((r) => r.id);
    for (const preset of themePresets) expect(ids).toContain(preset.id);
    expect(ids).toContain('classic (base — no preset)');
  });

  it('assigns a tier consistent with the absolute floor for every row', () => {
    for (const row of TABLE) {
      expect([ABSOLUTE_TIER, TOLERANCE_TIER], row.id).toContain(row.primaryTier);
      if (row.primaryTier === ABSOLUTE_TIER) {
        expect(row.primaryMin, `${row.id} absolute tier ⇒ ≥3:1`).toBeGreaterThanOrEqual(
          ABSOLUTE_FLOOR,
        );
      } else {
        // The declared tolerance governs where the pre-change control fails the floor.
        expect(row.primaryMin, `${row.id} tolerance tier ⇒ below floor`).toBeLessThan(
          ABSOLUTE_FLOOR,
        );
        expect(row.primaryDelta, `${row.id} within ≤0.2 of control`).toBeLessThanOrEqual(TOLERANCE);
      }
    }
  });

  it('holds the pre-change control guarantee via the tier (absolute clears; tolerance bounded)', () => {
    for (const row of TABLE) {
      // #3035 ST-3 — the deepened ring now clears the absolute floor on every
      // preset, so NO row needs the no-worse-than-control fallback; the machinery
      // remains for any pair that genuinely cannot clear (checked in the else leg).
      if (row.primaryTier === ABSOLUTE_TIER) {
        expect(row.primaryMin, `${row.id} absolute tier ⇒ ≥3:1`).toBeGreaterThanOrEqual(
          ABSOLUTE_FLOOR,
        );
      } else {
        // A pair that cannot clear must stay within the tolerance of the control.
        expect(row.primaryDelta, `${row.id} within ≤0.2 of control`).toBeLessThanOrEqual(TOLERANCE);
      }
      // The nav pair already painted `accent.strong` pre-change (delta === 0).
      expect(row.navDelta, `${row.id} nav delta`).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('nav + foreground pairs clear the absolute floor on every preset', () => {
    for (const row of TABLE) {
      expect(row.navStrong, `${row.id} nav accent-strong`).toBeGreaterThanOrEqual(ABSOLUTE_FLOOR);
      expect(row.navTier, row.id).toBe(ABSOLUTE_TIER);
      expect(row.glyphTier, row.id).toBe(ABSOLUTE_TIER);
    }
  });

  it('pins the two canonical preset outcomes (both clear 3:1 on the deepened ring)', () => {
    // #3035 ST-3 — with the deepened ring, light-default (the pale-accent preset
    // that previously needed the tolerance tier) now clears the absolute floor,
    // exactly like dark. Neither row needs the no-worse-than-control fallback.
    const dark = TABLE.find((r) => r.id === 'dark')!;
    expect(dark.primaryTier).toBe(ABSOLUTE_TIER);
    expect(dark.primaryMin).toBeGreaterThanOrEqual(ABSOLUTE_FLOOR);

    const lightDefault = TABLE.find((r) => r.id === 'light-default')!;
    expect(lightDefault.primaryTier).toBe(ABSOLUTE_TIER);
    expect(lightDefault.primaryMin).toBeGreaterThanOrEqual(ABSOLUTE_FLOOR);
  });

  it('derives --accent-strong from the contract DERIVATIONS (single weight home)', () => {
    // #3034 ST-2 — the engine no longer inlines the weight: it reads the ONE
    // contract home (`SEMANTIC_TOKENS`) that the contrast gate also consumes, so
    // the derivation cannot drift from the G-235 table above. The derived
    // expression still resolves to the pinned 55/45 mix this suite was settled on.
    const provider = readSource('../../providers/ThemeProvider.tsx');
    expect(provider).toContain('SEMANTIC_TOKENS');
    const strong = SEMANTIC_TOKENS.find((token) => token.name === 'accent.strong');
    expect(strong, 'contract declares accent.strong').toBeDefined();
    expect(strong!.derivation!.weights).toEqual([0.55, 0.45]);
    expect(colorMixValueFor(strong!.derivation!)).toBe(
      'color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary) 45%)',
    );
  });
});
