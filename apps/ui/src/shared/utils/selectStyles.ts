/**
 * Spec #3034 ST-2 — the ONE shared select-style recipe (R-4.1).
 *
 * The four `selectStyles` copies (`ThemingSettings.tsx:47`, `LayoutSettings.tsx:71`,
 * `PostgresSettings.tsx:94`, `ZoneLayoutEditor.tsx:61`) duplicate the same
 * token-chrome by hand — the duplication IS the per-component override need. This
 * module is the single token-prop recipe every select consumes: the value of each
 * prop comes from the contract's semantic tokens (`bg.surface`, `border.default`,
 * `fg.default`, `accent.border`, `fg.subtle`) or the live accent var, never a
 * component-local colour decision. ST-4 replaces the four copies with this import.
 *
 * `disabled` uses the `fg.subtle` TOKEN — never an opacity wash (the opacity
 * states were the direct source of the composed `disabled|label` contrast
 * violations). `NativeSelect` remains forbidden (ENGINEERING_RULES): the recipe
 * is spread onto `<chakra.select>`.
 */
export const selectRecipe = {
  bg: 'bg.surface',
  border: '1px solid',
  borderColor: 'border.default',
  color: 'fg.default',
  borderRadius: 'md',
  fontSize: 'sm',
  cursor: 'pointer',
  _hover: { borderColor: 'accent.border' },
  _focus: {
    outline: 'none',
    borderColor: 'accent.border',
    boxShadow: '0 0 0 1px var(--accent-primary)',
  },
  _disabled: { color: 'fg.subtle', cursor: 'not-allowed' },
} as const;

/**
 * The recipe plus per-use presentational overrides (e.g. `width`/`minW`). The
 * override can never replace a token prop with a literal colour — it only adds
 * layout/props on top of the single contract-sourced base.
 */
export function selectRecipeWith<T extends Record<string, unknown>>(overrides: T) {
  return { ...selectRecipe, ...overrides };
}
