import { createSystem, defaultConfig, defineConfig, defineSlotRecipe } from '@chakra-ui/react';
import { SEMANTIC_TOKENS, type SemanticToken } from './contract';

/**
 * Custom Chakra UI system that bridges Fredo CSS variables into Chakra semantic tokens.
 * Components can use `bg="bg.surface"` instead of `bg="var(--card-bg)"` in new code,
 * and Chakra's internal focus-ring / colorPalette tokens pick up the live theme.
 *
 * #3034 ST-2 — every colour token is DERIVED from the theme contract (`./contract`),
 * never re-declared here: `SEMANTIC_TOKENS` is the single home for each token's
 * backing CSS var / `color-mix()` derivation (the triplication
 * `ThemeProvider.tsx:291-295` ↔ `matrix.ts:121-125` ↔ `system.ts:114-115`). This
 * module only maps the Chakra-facing subset into the nested/flat shape Chakra
 * resolves.
 */

/** Namespaces Chakra declares NESTED in `defaultConfig` — keep that exact shape. */
const NESTED_NAMESPACES: ReadonlySet<string> = new Set(['bg', 'fg', 'border']);

/**
 * Engine-presentation namespaces that are NOT Chakra-facing: their consumers read
 * the CSS vars directly (`var(--life-neutral)` / `var(--scrollbar-thumb)`), so they
 * are deliberately not bridged. `system.semanticTokens.test.ts` pins the exact set.
 */
const NON_CHAKRA_NAMESPACES: ReadonlySet<string> = new Set(['scrollbar', 'life']);

/** Authored var names — a derived token aliasing one is a Chakra-only mix. */
const AUTHORED_VARS: ReadonlySet<string> = new Set(
  SEMANTIC_TOKENS.filter((token) => token.authored).map((token) => token.varName),
);

/** One emitted Chakra colour token (or a nested namespace of them). */
interface ColorToken {
  value: string;
}
type ColorTokenTree = { [key: string]: ColorToken | ColorTokenTree };

/**
 * Build the `color-mix(in srgb, …)` value for a contract derivation (the same
 * builder the engine uses, so the bridge and the engine cannot drift).
 */
function colorMixExpression(token: SemanticToken): string {
  const derivation = token.derivation!;
  const stops = derivation.sources.map((source, index) => {
    const weight = derivation.weights?.[index];
    return weight === undefined ? `var(${source})` : `var(${source}) ${Math.round(weight * 100)}%`;
  });
  if (stops.length === 1) stops.push('transparent');
  return `color-mix(in srgb, ${stops.join(', ')})`;
}

/**
 * A token's Chakra `value`:
 *  - an authored token (or a derived token written by the engine) → `var(<var>)`;
 *  - a Chakra-only derived alias (`accent.subtle` / `accent.muted`, which share
 *    `--accent-primary` with authored tokens and have no engine var) → the live
 *    `color-mix()` expression.
 */
function chakraValue(token: SemanticToken): string {
  if (!token.authored && token.derivation?.fn === 'color-mix' && AUTHORED_VARS.has(token.varName)) {
    return colorMixExpression(token);
  }
  return `var(${token.varName})`;
}

/**
 * Chakra's `theme.slotRecipes` type demands a COMPLETE slot recipe (`slots` +
 * variants); a deep-merged PARTIAL override is exactly what `mergeConfigs`
 * supports at runtime — the built-in recipe keeps its own `slots`, so the slot
 * list is never rewritten. This narrows the partial to Chakra's slot-recipe
 * type without changing the runtime shape.
 */
const partialSlotRecipe = (recipe: object): ReturnType<typeof defineSlotRecipe> =>
  recipe as ReturnType<typeof defineSlotRecipe>;

/** Derive the `semanticTokens.colors` map from the contract. */
function buildColorTokens(): ColorTokenTree {
  const tree: ColorTokenTree = {};
  for (const token of SEMANTIC_TOKENS) {
    const [namespace] = token.name.split('.');
    if (NON_CHAKRA_NAMESPACES.has(namespace)) continue;
    const entry: ColorToken = { value: chakraValue(token) };
    if (NESTED_NAMESPACES.has(namespace)) {
      const leaf = token.name.slice(namespace.length + 1);
      const node = (tree[namespace] as ColorTokenTree | undefined) ?? {};
      node[leaf] = entry;
      tree[namespace] = node;
    } else {
      tree[token.name] = entry;
    }
  }
  return tree;
}

const config = defineConfig({
  /**
   * Global CSS normalizations — emitted into Chakra's `@layer base` (which is
   * OUTRANKED by component recipes in `@layer recipes`, so component chrome must
   * be themed via `theme.recipes`, not a global selector).
   */
  globalCss: {
    /**
     * `button { color: inherit }` — kept byte-identical (pinned by
     * `globalFocusVisible.test.ts`). NOTE: this rule is emitted into `@layer base`
     * and therefore LOSES to Chakra's button recipe in `@layer recipes` (layer
     * order `reset, base, tokens, recipes`) — it does not by itself theme any
     * button. The outline/ghost chrome is delivered by the `theme.recipes.button`
     * override below (the cascade-winning path), NOT by a `data-variant`
     * attribute selector: Chakra v3.34.0 never emits `data-variant` on a Button
     * (the former `button[data-variant="outline"]*` rules matched NOTHING).
     */
    button: { color: 'inherit' },
    /**
     * Spec #3034 ST-2 (R-4.1) — the shared select control resolves its chrome
     * from the contract tokens. `disabled` is the `fg.subtle` TOKEN
     * (`--text-subtle`), never an opacity wash (the direct source of every
     * composed `disabled|label` violation). WCAG-exempt: it reads dimmer, it does
     * not reach AA.
     */
    select: {
      backgroundColor: 'var(--card-bg)',
      borderColor: 'var(--border-color)',
      color: 'var(--text-primary)',
    },
    'select:hover': { borderColor: 'var(--accent-primary)' },
    'select:disabled': {
      color: 'var(--text-subtle)',
      opacity: 1,
      cursor: 'not-allowed',
    },
    '.chakra-radio-card__itemControl': { borderColor: 'var(--border-color)' },
    '.chakra-radio-card__itemControl:hover': { borderColor: 'var(--accent-primary)' },
    '.chakra-radio-card__itemControl[data-state="checked"]': {
      borderColor: 'var(--accent-primary)',
    },
    '.chakra-radio-card__itemControl[data-disabled]': { color: 'var(--text-subtle)' },
    /**
     * Spec #2946 ST-11 (R-1.3) — the SINGLE global keyboard-focus guarantee.
     *
     * `:focus-visible` (never `:focus`) so pointer interaction never paints the
     * ring; a 2px accent outline with a 2px offset makes focus visible on EVERY
     * interactive control without any per-component opt-in. `outline: none` is
     * never used (G-235's non-colour-only / visible requirement). Chakra emits
     * `globalCss` into the `base` cascade layer, so an unlayered component
     * `_focusVisible` style still wins — the existing per-component rings
     * (`SettingsSurface.tsx:66`, `LauncherAppGrid.tsx:73`,
     * `DetailPanel.tsx:292-293`) are preserved, not replaced.
     */
    ':focus-visible': {
      outline: '2px solid var(--accent-strong)',
      outlineOffset: '2px',
    },
    /**
     * Nav surfaces: chrome on `--header-bg` and semantic navigation landmarks
     * paint with the deepened `--accent-strong` (#2864 T6 — derived to clear
     * 3:1 on nav surfaces). Selector-only — no markup is added (the nav
     * chrome class + the semantic landmark role are both pre-existing).
     */
    '.fredo-window__header :focus-visible, [role="navigation"] :focus-visible, nav :focus-visible': {
      outline: '2px solid var(--accent-strong)',
      outlineOffset: '2px',
    },
  },
  theme: {
    /**
     * ST-1 (#3035 rework) — the ONE live mechanism for the app-wide outline/ghost
     * button chrome. Chakra deep-merges `defineConfig.theme.recipes.button` over
     * its built-in `button` recipe (`merge-config.js` + the recursive
     * `utils/merge.js`), and the merged recipe's class is emitted into
     * `@layer recipes` — which BEATS the old `@layer base` `data-variant` rules by
     * cascade-layer order (`reset, base, tokens, recipes`). `IconButton` shares
     * this recipe, so the edit/delete icon buttons are covered by the same change.
     *
     * This is the single source for: `layout-new-button`, `layout-{assign,edit,
     * delete}`, `db-conn-test`, `db-conn-cancel`, `db-query-tab-new`,
     * `db-export-{csv,json}` and `db-query-run-all`. Contract tokens only — no
     * raw colour, no `!important`. The `_disabled` override drops the built-in
     * `disabled` layer style (0.5 opacity wash) and repaints the WCAG-exempt
     * `fg.subtle` label + `border.subtle` boundary so enabled and disabled are
     * never confused.
     */
    recipes: {
      button: {
        variants: {
          variant: {
            outline: {
              color: 'fg.default',
              borderColor: 'border.default',
              _hover: { borderColor: 'accent.border' },
              _disabled: {
                layerStyle: 'none',
                opacity: 1,
                cursor: 'not-allowed',
                color: 'fg.subtle',
                borderColor: 'border.subtle',
              },
            },
            ghost: {
              color: 'fg.default',
              _disabled: {
                layerStyle: 'none',
                opacity: 1,
                cursor: 'not-allowed',
                color: 'fg.subtle',
              },
            },
          },
        },
      },
    },
    /**
     * Spec #3086 ST-2 — the Chakra SLOT recipes for the Wireframe control classes.
     * Chakra deep-merges `defineConfig.theme.slotRecipes.<key>` over its built-in
     * slot recipe (`mergeConfigs` + the recursive `utils/merge.js`), and the
     * merged recipe emits into `@layer recipes` — the cascade-WINNING path
     * (`reset, base, tokens, recipes`). A `globalCss` selector would land in
     * `@layer base` and LOSE (G-365). Each override paints the SAME contract
     * token pair the contrast gate validates (one home per pair, G-366):
     *
     *  - `segmentGroup` (Wireframe `SegmentedField.tsx`): root `bg.surface` with a
     *    `border.default` rail boundary, hover boundary `accent.border`, selected
     *    indicator `accent.tint` with an `accent.strong` boundary, item text
     *    `fg.default` (selected + unselected), disabled `fg.subtle`, focus ring
     *    `accent.focusRing` (= `--accent-strong`).
     *  - `slider` (Wireframe `NumberSliderField.tsx`): rail fill `bg.subtle` with
     *    a `border.default` boundary, range/thumb `accent.strong`, disabled range
     *    `fg.subtle`, focus ring `accent.focusRing`.
     *  - `numberInput` (Wireframe `NumberSliderField.tsx`): input `bg.surface` /
     *    `fg.default` / `border.default` (hover `accent.border`), stepper
     *    `fg.muted`, focus ring `accent.focusRing`.
     *
     * Contract tokens only — no raw colour. The one var reference
     * (`var(--border-strong)` / `var(--accent-strong)`) is the same contract
     * boundary the `boxShadow: 'inset'` ring already drew, only recoloured (no
     * layout change).
     */
    slotRecipes: {
      segmentGroup: partialSlotRecipe({
        base: {
          root: {
            bg: 'bg.surface',
            boxShadow: 'inset 0 0 0 1px var(--border-strong)',
            _hover: { boxShadow: 'inset 0 0 0 1px var(--accent-strong)' },
          },
          item: {
            color: 'fg.default',
            '&[data-state=checked]': { color: 'fg.default' },
            _before: { bg: 'border.default' },
            _disabled: { opacity: 1, color: 'fg.subtle' },
            '&:has(input:focus-visible)': { outlineColor: 'var(--accent-strong)' },
          },
          indicator: {
            bg: 'accent.tint',
            borderColor: 'accent.strong',
            borderWidth: '1px',
          },
        },
      }),
      slider: partialSlotRecipe({
        variants: {
          variant: {
            outline: {
              track: {
                bg: 'bg.subtle',
                boxShadow: 'inset 0 0 0 1px var(--border-strong)',
              },
              range: { bg: 'accent.strong', _disabled: { bg: 'fg.subtle' } },
              thumb: { bg: 'accent.strong', borderColor: 'accent.strong' },
            },
            solid: {
              track: { bg: 'bg.subtle' },
              range: { bg: 'accent.strong', _disabled: { bg: 'fg.subtle' } },
              thumb: { bg: 'accent.strong' },
            },
          },
        },
        base: {
          thumb: { _focusVisible: { ringColor: 'var(--accent-strong)' } },
        },
      }),
      numberInput: partialSlotRecipe({
        variants: {
          variant: {
            outline: {
              input: {
                bg: 'bg.surface',
                color: 'fg.default',
                borderColor: 'border.default',
                focusRingColor: 'var(--accent-strong)',
                _hover: { borderColor: 'accent.border' },
              },
            },
          },
        },
        base: {
          control: { color: 'fg.muted' },
          incrementTrigger: { color: 'fg.muted' },
          decrementTrigger: { color: 'fg.muted' },
        },
      }),
    },
    tokens: {
      fonts: {
        heading: { value: 'var(--font-primary)' },
        body: { value: 'var(--font-base)' },
        mono: { value: "'JetBrains Mono', 'Fira Mono', 'Courier New', monospace" },
      },
    },
    semanticTokens: {
      // #3034 ST-2 — derived from the contract (see `buildColorTokens`). The
      // `bg`/`fg`/`border` namespaces MUST stay NESTED (Chakra's `defaultConfig`
      // declares them nested and the nested definitions win `colors.<path>`;
      // #2865 R-3.2). Every other token keeps its flat dotted key.
      colors: buildColorTokens(),
      shadows: {
        // #2864 ST-1 (T8): dialog elevation shadow (base-record only).
        'shadow.dialog': { value: 'var(--shadow-dialog)' },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
