/**
 * #2865 ST-3a — semantic-token bridge repair guard (R-3.2 / F-14).
 *
 * `system.ts` maps the shared `bg.*`/`fg.*`/`border.*` semantic tokens onto the
 * Fredo theme CSS vars. Chakra's `defaultConfig` ALSO defines those namespaces
 * (nested), and the nested definitions win the `colors.<path>` resolution — so a
 * flat dotted key (`'fg.muted'`) emits an unreachable escaped-dot custom property
 * and the stock Chakra value (`#52525b`) survives. These assertions pin the fix:
 * the namespaces are declared nested, so they emit DASH custom properties
 * (`--chakra-colors-fg-muted`) aliasing the Fredo vars with no stock fallback and
 * no empty token.
 */
import { describe, it, expect } from 'vitest';
import { system } from '../system';

/** The resolved base-layer token CSS, keyed by emitted custom-property name. */
const baseTokenVars = (): Record<string, string> => {
  const tokenCss = system.getTokenCss() as Record<string, unknown>;
  const layer = tokenCss['@layer tokens'] as
    | Record<string, Record<string, string>>
    | Array<Record<string, Record<string, string>>>;
  const layerEntry = Array.isArray(layer) ? layer[0] : layer;
  return layerEntry['&:where(html, .chakra-theme)'];
};

/** emitted custom property → the Fredo var it MUST alias. */
const FREDO_TOKEN_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['--chakra-colors-bg-canvas', 'var(--body-bg)'],
  ['--chakra-colors-bg-surface', 'var(--card-bg)'],
  ['--chakra-colors-bg-subtle', 'var(--header-bg)'],
  ['--chakra-colors-bg-muted', 'var(--card-hover-bg)'],
  ['--chakra-colors-bg-hover', 'var(--hover-bg)'],
  ['--chakra-colors-fg-default', 'var(--text-primary)'],
  ['--chakra-colors-fg-muted', 'var(--text-secondary)'],
  ['--chakra-colors-fg-subtle', 'var(--text-subtle)'],
  ['--chakra-colors-fg-on-accent', 'var(--accent-contrast)'],
  // #3035 ST-1 — border.default is the DERIVED contrast-safe control boundary
  // (`--border-strong`); border.subtle keeps the soft authored `--border-color`.
  ['--chakra-colors-border-default', 'var(--border-strong)'],
  ['--chakra-colors-border-subtle', 'var(--border-color)'],
];

describe('#2865 ST-3a semantic-token bridge', () => {
  it('registers bg/fg/border as NESTED semantic tokens (not flat dotted keys)', () => {
    const fg = system.query.semanticTokens.search('colors', 'fg');
    expect(fg).toContain('fg.default');
    expect(fg).toContain('fg.muted');
    expect(fg).toContain('fg.subtle');
    expect(fg).toContain('fg.onAccent');

    const bg = system.query.semanticTokens.search('colors', 'bg');
    expect(bg).toContain('bg.canvas');
    expect(bg).toContain('bg.surface');
    expect(bg).toContain('bg.subtle');
    expect(bg).toContain('bg.muted');
    expect(bg).toContain('bg.hover');

    const border = system.query.semanticTokens.search('colors', 'border');
    expect(border).toContain('border.default');
    expect(border).toContain('border.subtle');
  });

  it('emits dash custom properties aliasing the Fredo vars (F-14 acceptance)', () => {
    const base = baseTokenVars();
    for (const [name, expected] of FREDO_TOKEN_ALIASES) {
      expect(base[name], name).toBe(expected);
    }
  });

  it('never resolves to a stock Chakra value and never emits an empty token', () => {
    const base = baseTokenVars();
    // Stock Chakra gray.600 / gray.400 — the pre-fix failure surface.
    expect(base['--chakra-colors-fg-muted']).not.toBe('#52525b');
    expect(base['--chakra-colors-fg-subtle']).not.toBe('#a1a1aa');
    for (const [name] of FREDO_TOKEN_ALIASES) {
      expect(base[name], name).toBeTruthy();
      expect(String(base[name]).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the live-accent colorPalette + non-overlapping namespaces unchanged', () => {
    const base = baseTokenVars();
    // Regression invariant: `colorPalette="accent"` still resolves to the vars.
    expect(system.token('colors.accent.solid')).toBeDefined();
    expect(base['--chakra-colors-accent\\.solid']).toBe('var(--accent-primary)');
    expect(base['--chakra-colors-accent\\.contrast']).toBe('var(--accent-contrast)');
    // Non-overlapping namespaces keep their escaped-dot emission.
    expect(base['--chakra-colors-overlay\\.scrim']).toBe('var(--overlay-bg)');
    expect(base['--chakra-colors-status\\.success']).toBe('var(--status-success)');
  });
});

/** A loose view of a merged slot recipe (base + variants), for the ST-2 pins. */
type LooseSlotRecipe = {
  base?: Record<string, Record<string, unknown>>;
  variants?: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
};

const slotRecipe = (key: string): LooseSlotRecipe =>
  system.getSlotRecipe(key) as unknown as LooseSlotRecipe;

describe('#3086 ST-2 — Wireframe control-class slot recipes (cascade-winning path)', () => {
  it('registers segmentGroup / slider / numberInput as slot recipes', () => {
    for (const key of ['segmentGroup', 'slider', 'numberInput']) {
      expect(system.isSlotRecipe(key), key).toBe(true);
      expect(system.getSlotRecipe(key), key).toBeDefined();
    }
  });

  it('emits the bounded Wireframe tokens as live color-mix() expressions', () => {
    const base = baseTokenVars();
    expect(base['--chakra-colors-accent\\.tint']).toBe(
      'color-mix(in srgb, var(--accent-primary) 10%, var(--body-bg) 90%)',
    );
    // Chakra kebab-cases camelCase token leaves (`errorTint` → `error-tint`).
    expect(base['--chakra-colors-status\\.error-tint']).toBe(
      'color-mix(in srgb, var(--status-error) 15%, var(--body-bg) 85%)',
    );
    expect(base['--chakra-colors-status\\.error-strong']).toBe(
      'color-mix(in srgb, var(--status-error) 50%, var(--text-primary) 50%)',
    );
  });

  it('segmentGroup paints the contract token pairs (gate ↔ paint agreement)', () => {
    const recipe = slotRecipe('segmentGroup');
    expect(recipe.base!.root.bg).toBe('bg.surface');
    expect(recipe.base!.root.boxShadow).toBe('inset 0 0 0 1px var(--border-strong)');
    expect(recipe.base!.item.color).toBe('fg.default');
    expect(recipe.base!.item._disabled).toMatchObject({ opacity: 1, color: 'fg.subtle' });
    expect(recipe.base!.indicator.bg).toBe('accent.tint');
    expect(recipe.base!.indicator.borderColor).toBe('accent.strong');
  });

  it('slider paints the contract token pairs (rail fill bg.subtle, range/thumb accent.strong)', () => {
    const outline = slotRecipe('slider').variants!.variant.outline;
    expect(outline.track.bg).toBe('bg.subtle');
    expect(outline.track.boxShadow).toBe('inset 0 0 0 1px var(--border-strong)');
    expect(outline.range.bg).toBe('accent.strong');
    expect(outline.thumb.bg).toBe('accent.strong');
  });

  it('numberInput paints the contract token pairs (input surface/field, stepper fg.muted)', () => {
    const recipe = slotRecipe('numberInput');
    expect(recipe.variants!.variant.outline.input.bg).toBe('bg.surface');
    expect(recipe.variants!.variant.outline.input.color).toBe('fg.default');
    expect(recipe.variants!.variant.outline.input.borderColor).toBe('border.default');
    expect(recipe.base!.control.color).toBe('fg.muted');
  });
});
