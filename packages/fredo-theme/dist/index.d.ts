/**
 * @fredo/theme — generated type surface. Do not edit by hand:
 *   node packages/fredo-theme/scripts/build-theme.mjs
 *
 * A NAME contract, not a value source: the host writes every token value onto your document's documentElement, and this package only names those values. Every entry's `value` is a var() reference or a color-mix() whose operands are var()s — the package contains no colour literal and cannot become a second source of colour.
 */

/** A CSS custom property name, e.g. `--card-bg`. */
export type CssVarName = `--${string}`;

/** The class of a published token (UI/UX §1). */
export type ThemeTokenClass =
  | 'A' // authored by a theme record
  | 'D' // derived by the host engine into its own var
  | 'N'; // NAME-ONLY alias: no own var, published as a color-mix() expression

/** Every published token name. */
export type ThemeTokenName =
  | 'bg.canvas'
  | 'bg.surface'
  | 'bg.subtle'
  | 'bg.muted'
  | 'bg.hover'
  | 'fg.default'
  | 'fg.muted'
  | 'fg.subtle'
  | 'fg.onAccent'
  | 'border.default'
  | 'border.subtle'
  | 'overlay.scrim'
  | 'accent.default'
  | 'accent.emphasized'
  | 'accent.strong'
  | 'accent.solid'
  | 'accent.contrast'
  | 'accent.fg'
  | 'accent.subtle'
  | 'accent.muted'
  | 'accent.focusRing'
  | 'accent.border'
  | 'accent.subagent'
  | 'accent.nestedSubagent'
  | 'accent.tint'
  | 'avatar.interior'
  | 'status.success'
  | 'status.warning'
  | 'status.error'
  | 'status.info'
  | 'status.onSolids'
  | 'status.errorTint'
  | 'status.errorStrong'
  | 'scrollbar.thumb'
  | 'scrollbar.thumbHover'
  | 'life.neutral'
  | 'life.cell'
  | 'life.dim';

/** The derivation function a derived token resolves through. */
export type ThemeDerivationFn = 'color-mix' | 'wcag-max-contrast' | 'alpha-composite' | 'literal';

/** The single home for a derived token's rule (weights mirror the contract). */
export interface ThemeTokenDerivation {
  readonly fn: ThemeDerivationFn;
  readonly sources: readonly CssVarName[];
  readonly weights?: readonly number[];
}

/** One published token. */
export interface ThemeToken {
  readonly name: ThemeTokenName;
  readonly varName: CssVarName;
  readonly class: ThemeTokenClass;
  readonly authored: boolean;
  /** A `var(--…)` reference, or a `color-mix()` over `var()`s for a class-N alias. */
  readonly value: string;
  readonly derivation?: ThemeTokenDerivation;
}

/** One readable-but-unpublished custom property. */
export interface ThemeExclusion {
  readonly varName: CssVarName;
  readonly reason: string;
}

/** The 38 published tokens, in contract order. */
export declare const SEMANTIC_TOKENS: readonly ThemeToken[];

/** The same tokens, keyed by published name. */
export declare const tokensByName: Readonly<Record<ThemeTokenName, ThemeToken>>;

/** Every published name, in contract order. */
export declare const TOKEN_NAMES: readonly ThemeTokenName[];

/** The readable-but-unpublished custom properties — a promise of privacy. */
export declare const THEME_EXCLUSIONS: readonly ThemeExclusion[];

/** The generated stylesheet (the same text as `theme.css`). */
export declare const THEME_STYLESHEET: string;

/**
 * Resolve a published token name (or a `--custom-property`) to the CSS form to
 * write. Throws for an unknown token name.
 */
export declare function cssVar(name: ThemeTokenName | CssVarName | (string & {})): string;
