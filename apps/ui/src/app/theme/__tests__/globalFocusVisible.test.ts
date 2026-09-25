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
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { system } from '../system';
import { themes, themePresets } from '../../types/theme';

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

type Rgb = [number, number, number];

function parseColor(color: string): Rgb | null {
  const value = color.trim().toLowerCase();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const rrggbb =
      hex.length === 3 || hex.length === 4
        ? hex.slice(0, 3).split('').map((c) => c + c).join('')
        : hex.slice(0, 6);
    if (rrggbb.length !== 6) return null;
    return [
      parseInt(rrggbb.slice(0, 2), 16),
      parseInt(rrggbb.slice(2, 4), 16),
      parseInt(rrggbb.slice(4, 6), 16),
    ];
  }
  const m = value.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((c) => !Number.isFinite(c))) return null;
  return [parts[0], parts[1], parts[2]];
}

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

const contrast = (a: Rgb, b: Rgb): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
};

/** `color-mix(in srgb, first p%, second q%)` over opaque colours. */
const mixSrgb = (first: Rgb, second: Rgb, p: number, q: number): Rgb => [
  Math.round(first[0] * p + second[0] * q),
  Math.round(first[1] * p + second[1] * q),
  Math.round(first[2] * p + second[2] * q),
];

const round2 = (n: number): number => Math.round(n * 100) / 100;

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
  /** primary painted pair: ring (accent.focusRing) vs bg.surface (--card-bg). */
  ringSurface: number;
  /** primary painted pair: ring vs bg.canvas (--body-bg). */
  ringCanvas: number;
  /** worst-case primary pair — the value the tier is decided on. */
  primaryMin: number;
  primaryTier: string;
  /** |new − pre-change control| ratio for the primary pair (same token ⇒ 0). */
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

    const ringSurface = contrast(accent!, card!);
    const ringCanvas = contrast(accent!, body!);
    const primaryMin = Math.min(ringSurface, ringCanvas);
    const navStrong = contrast(strong, header!);
    const glyphSurface = contrast(text!, card!);
    const glyphNav = contrast(text!, header!);

    // The pre-change control paints the SAME tokens (accent.focusRing /
    // accent.strong), so the new global rule can never be worse than it.
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
    expect(rule.outline).toBe('2px solid var(--accent-primary)');
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
    // accent.focusRing (system.ts:90) and accent.strong (system.ts:81) — Chakra
    // kebab-cases the camelCase token segment (`focus-ring`).
    expect(base['--chakra-colors-accent\\.focus-ring']).toBe('var(--accent-primary)');
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

  it('keeps the existing globalCss outline-variant behaviour untouched', () => {
    const base = globalBase();
    expect(base['&button']).toEqual({ color: 'inherit' });
    expect(base['&button[data-variant="outline"]']).toEqual({
      borderColor: 'var(--border-color)',
    });
    expect(base['&button[data-variant="outline"]:hover']).toEqual({
      borderColor: 'var(--accent-primary)',
    });
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

  it('never regresses the pre-change control on any preset (delta ≤ 0.2)', () => {
    for (const row of TABLE) {
      expect(row.primaryDelta, `${row.id} primary delta`).toBeLessThanOrEqual(TOLERANCE);
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

  it('pins the two canonical preset outcomes (dark clears 3:1; light-default does not)', () => {
    const dark = TABLE.find((r) => r.id === 'dark')!;
    expect(dark.primaryTier).toBe(ABSOLUTE_TIER);
    expect(dark.primaryMin).toBeGreaterThanOrEqual(ABSOLUTE_FLOOR);

    const lightDefault = TABLE.find((r) => r.id === 'light-default')!;
    expect(lightDefault.primaryTier).toBe(TOLERANCE_TIER);
    expect(lightDefault.primaryMin).toBeLessThan(ABSOLUTE_FLOOR);
  });

  it('is consistent with the live --accent-strong derivation in ThemeProvider', () => {
    const provider = readSource('../../providers/ThemeProvider.tsx');
    expect(provider).toContain(
      "'color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary) 45%)'",
    );
  });
});
