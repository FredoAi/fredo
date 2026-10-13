import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';
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
   * Global CSS normalizations.
   *
   * `button { color: inherit }` — Chakra's ghost/outline/subtle variants default to the
   * "gray" colorPalette which is nearly invisible on dark surfaces. Forcing inheritance
   * means every button picks up the container text color (body → theme CSS vars)
   * automatically, including any new feature components created in the future.
   */
  globalCss: {
    button: { color: 'inherit' },
    /**
     * ST-1 (#3035) — the outline control boundary is now the ENABLED control
     * boundary `border.default` (`--border-strong`, ≥3:1 by construction). The
     * `:hover` shape below stays byte-identical (`var(--accent-primary)`); the
     * `:disabled` rule repaints the soft `border.subtle` (`--border-color`) so
     * enabled and disabled are never confused.
     */
    'button[data-variant="outline"]': { borderColor: 'var(--border-strong)' },
    'button[data-variant="outline"]:hover': { borderColor: 'var(--accent-primary)' },
    /**
     * Spec #3034 ST-2 (R-4.1) — the ONE structural control-level rule: the
     * implicated control classes (outline buttons, selects, radio cards) resolve
     * their chrome from the contract tokens, so no component needs a local colour
     * override. `disabled` is the `border.subtle` boundary (`--border-color`) +
     * the `fg.subtle` TOKEN (`--text-subtle`), never an opacity wash (which was
     * the direct source of every composed `disabled|label` violation). This is
     * the WCAG-exempt disabled treatment: it reads dimmer, it does not reach AA.
     */
    'button[data-variant="outline"]:disabled': {
      color: 'var(--text-subtle)',
      borderColor: 'var(--border-color)',
      opacity: 1,
    },
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
