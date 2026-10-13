/**
 * Spec #3034 ST-2 — the engine + bridge derive from the theme contract.
 *
 * Proves the two consumers of the contract (`ThemeProvider.tsx` engine,
 * `theme/system.ts` Chakra bridge) and the ONE shared select recipe read the
 * contract's `SEMANTIC_TOKENS`/`DERIVATIONS` rather than re-declaring weights,
 * and that the `status.onSolids` token + the structural control rule exist.
 *
 * Pure — reads the contract, the built Chakra system and the recipe; no DOM.
 */
import { describe, it, expect } from 'vitest';
import { system } from '../system';
import { SEMANTIC_TOKENS, type SemanticToken } from '../contract';
import { colorMixValueFor, resolveOnSolids } from '../../providers/ThemeProvider';
import { selectRecipe } from '../../../shared/utils/selectStyles';

const TOKEN_BY_NAME = new Map(SEMANTIC_TOKENS.map((token) => [token.name, token]));

function token(name: string): SemanticToken {
  const found = TOKEN_BY_NAME.get(name);
  if (!found) throw new Error(`no contract token ${name}`);
  return found;
}

/** The emitted base-layer token CSS, keyed by custom-property name (#2865 shape). */
const baseTokenVars = (): Record<string, string> => {
  const tokenCss = system.getTokenCss() as Record<string, unknown>;
  const layer = tokenCss['@layer tokens'] as
    | Record<string, Record<string, string>>
    | Array<Record<string, Record<string, string>>>;
  const layerEntry = Array.isArray(layer) ? layer[0] : layer;
  return layerEntry['&:where(html, .chakra-theme)'];
};

const globalBase = (): Record<string, unknown> => {
  const g = system.getGlobalCss() as Record<string, unknown>;
  return g['@layer base'] as Record<string, unknown>;
};

/** Find a globalCss declaration whose selector contains `needle`. */
function globalRuleContaining(needle: string): Record<string, unknown> | undefined {
  const base = globalBase();
  const key = Object.keys(base).find((k) => k.includes(needle));
  return key ? (base[key] as Record<string, unknown>) : undefined;
}

/**
 * The LIVE merged `button` recipe's `variant` group (the built-in recipe
 * deep-merged with `system.ts`'s `theme.recipes.button` override). This is the
 * one mechanism that actually paints outline/ghost buttons (#3035 ST-1 rework).
 */
function buttonVariants(): Record<string, Record<string, unknown>> {
  const recipe = system.getRecipe('button') as {
    variants: { variant: Record<string, Record<string, unknown>> };
  };
  return recipe.variants.variant;
}

describe('#3034 ST-2 — the engine derives color-mix values from the contract', () => {
  it('reproduces the pinned engine expressions byte-for-byte from DERIVATIONS', () => {
    expect(colorMixValueFor(token('bg.hover').derivation!)).toBe(
      'color-mix(in srgb, var(--text-primary) 6%, transparent)',
    );
    expect(colorMixValueFor(token('fg.subtle').derivation!)).toBe(
      // #3035 ST-1 — DERIVATIONS.textSubtle raised 65/35 → 55/45.
      'color-mix(in srgb, var(--text-secondary) 55%, var(--text-primary) 45%)',
    );
    expect(colorMixValueFor(token('accent.strong').derivation!)).toBe(
      'color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary) 45%)',
    );
    expect(colorMixValueFor(token('scrollbar.thumb').derivation!)).toBe(
      'color-mix(in srgb, var(--text-secondary) 45%, transparent)',
    );
    expect(colorMixValueFor(token('scrollbar.thumbHover').derivation!)).toBe(
      'color-mix(in srgb, var(--text-secondary) 70%, transparent)',
    );
    expect(colorMixValueFor(token('avatar.interior').derivation!)).toBe(
      'color-mix(in srgb, var(--accent-primary) 20%, var(--body-bg))',
    );
  });

  it('references exactly the contract sources for each derived token', () => {
    for (const name of ['bg.hover', 'fg.subtle', 'accent.strong', 'avatar.interior']) {
      const derivation = token(name).derivation!;
      const value = colorMixValueFor(derivation);
      for (const source of derivation.sources) {
        expect(value, `${name} must reference ${source}`).toContain(`var(${source})`);
      }
    }
  });
});

describe('#3034 ST-2 — the Chakra bridge derives from the contract', () => {
  it('bridges the Chakra-only accent mixes from the contract derivation', () => {
    const base = baseTokenVars();
    // accent.subtle / accent.muted alias --accent-primary and have no engine var,
    // so their value MUST be the contract's live color-mix (not hand-authored).
    expect(base['--chakra-colors-accent\\.subtle']).toBe(
      colorMixValueFor(token('accent.subtle').derivation!),
    );
    expect(base['--chakra-colors-accent\\.muted']).toBe(
      colorMixValueFor(token('accent.muted').derivation!),
    );
    expect(base['--chakra-colors-accent\\.subtle']).toBe(
      'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
    );
    expect(base['--chakra-colors-accent\\.muted']).toBe(
      'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
    );
  });

  it('bridges every authored + engine-written contract token to var(--<var>)', () => {
    const base = baseTokenVars();
    const emitted = (name: string): string =>
      base[`--chakra-colors-${name.replace(/\./g, '\\.').replace(/([A-Z])/g, '-$1').toLowerCase()}`];
    // Representative authored + engine-derived tokens resolve to their CSS var.
    expect(base['--chakra-colors-bg-canvas']).toBe('var(--body-bg)');
    expect(base['--chakra-colors-bg-hover']).toBe('var(--hover-bg)');
    expect(base['--chakra-colors-fg-subtle']).toBe('var(--text-subtle)');
    expect(base['--chakra-colors-accent\\.strong']).toBe('var(--accent-strong)');
    // #3035 ST-1 — accent.focusRing resolves from accent.strong (deepened ring).
    expect(base['--chakra-colors-accent\\.focus-ring']).toBe('var(--accent-strong)');
    expect(base['--chakra-colors-avatar\\.interior']).toBe('var(--fredo-avatar-interior)');
    expect(base['--chakra-colors-overlay\\.scrim']).toBe('var(--overlay-bg)');
    expect(emitted('status.onSolids')).toBe('var(--status-on-solids)');
  });

  it('bridges the NEW status.onSolids token (R-1 status foreground)', () => {
    expect(system.token('colors.status.onSolids')).toBeDefined();
    expect(baseTokenVars()['--chakra-colors-status\\.on-solids']).toBe('var(--status-on-solids)');
  });

  it('does NOT bridge the engine-presentation-only namespaces', () => {
    const base = baseTokenVars();
    for (const prefix of ['scrollbar\\.', 'life\\.']) {
      expect(
        Object.keys(base).some((key) => key.startsWith(`--chakra-colors-${prefix}`)),
        `must not bridge ${prefix}`,
      ).toBe(false);
    }
  });
});

describe('#3034 ST-2 — status.onSolids resolves by the WCAG-max rule', () => {
  it('picks the near-black foreground for light status hues (no white-on-yellow)', () => {
    // A light yellow / pale green fill pair → the near-black foreground wins.
    expect(resolveOnSolids(['#facc15', '#fde68a'])).toBe('#0c1117');
  });

  it('picks white for dark status hues', () => {
    expect(resolveOnSolids(['#0c4a6e', '#7f1d1d'])).toBe('#ffffff');
  });

  it('falls back to the safe classic light foreground for empty input', () => {
    expect(resolveOnSolids([])).toBe('#ffffff');
    expect(resolveOnSolids(['not-a-color'])).toBe('#ffffff');
  });
});

describe('#3034 ST-2 — the ONE structural control rule + shared select recipe', () => {
  it('ships the shared select recipe with token props and a token (not opacity) disabled state', () => {
    expect(selectRecipe.bg).toBe('bg.surface');
    expect(selectRecipe.borderColor).toBe('border.default');
    expect(selectRecipe.color).toBe('fg.default');
    expect((selectRecipe._hover as Record<string, unknown>).borderColor).toBe('accent.border');
    // disabled = the `fg.subtle` TOKEN — never an opacity wash.
    expect((selectRecipe._disabled as Record<string, unknown>).color).toBe('fg.subtle');
    expect(selectRecipe._disabled).not.toHaveProperty('opacity');
    expect(selectRecipe).not.toHaveProperty('opacity');
  });

  it('extends globalCss with the select / radio-card structural rules', () => {
    const selectDisabled = globalRuleContaining('select:disabled');
    expect(selectDisabled).toBeDefined();
    expect(selectDisabled!.color).toBe('var(--text-subtle)');
    expect(selectDisabled!.opacity).toBe(1);

    expect(globalRuleContaining('select:hover')).toBeDefined();
    expect(globalRuleContaining('.chakra-radio-card__itemControl[data-state="checked"]')).toBeDefined();
    expect(globalRuleContaining('.chakra-radio-card__itemControl:hover')).toBeDefined();
  });

  it('themes outline/ghost buttons via the LIVE recipe (the dead data-variant rules are gone)', () => {
    // #3035 ST-1 rework — the former `button[data-variant="outline"]*` global
    // rules were INERT: Chakra v3.34.0 emits no `data-variant` (the selector
    // matched nothing), and a `@layer base` global rule also loses to the recipe
    // in `@layer recipes` by layer order. The chrome is now delivered by
    // `theme.recipes.button`, deep-merged over the built-in recipe — assert the
    // contract tokens actually land on the LIVE recipe. This re-bases the pin to
    // the real new mechanism; it is not a relaxation.
    expect(globalRuleContaining('button[data-variant="outline"]')).toBeUndefined();

    const variants = buttonVariants();
    expect(variants.outline.color).toBe('fg.default');
    expect(variants.outline.borderColor).toBe('border.default');
    expect((variants.outline._hover as Record<string, unknown>).borderColor).toBe('accent.border');

    const outlineDisabled = variants.outline._disabled as Record<string, unknown>;
    expect(outlineDisabled.color).toBe('fg.subtle');
    expect(outlineDisabled.borderColor).toBe('border.subtle');
    expect(outlineDisabled.opacity).toBe(1);
    // The built-in `disabled` layer style (a 0.5 opacity wash) is dropped.
    expect(outlineDisabled.layerStyle).toBe('none');

    expect(variants.ghost.color).toBe('fg.default');
    const ghostDisabled = variants.ghost._disabled as Record<string, unknown>;
    expect(ghostDisabled.color).toBe('fg.subtle');
    expect(ghostDisabled.opacity).toBe(1);
    expect(ghostDisabled.layerStyle).toBe('none');
  });
});
