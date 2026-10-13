/**
 * Theme contract — the semantic-token registry (Spec #3034 ST-1).
 *
 * The SINGLE machine-readable home for every semantic token the theming engine
 * authors and the Chakra bridge (`app/theme/system.ts`) exposes: the token's
 * Chakra-style name, the CSS custom property it bridges, whether it is authored
 * by a theme record or derived live, and — for derived tokens — the ONE home for
 * its derivation rule (function, inputs, weights).
 *
 * This module is the PRODUCER (G-255): it imports NOTHING from
 * `providers/ThemeProvider.tsx`, `theme/system.ts`, or `theme/contrast/**`, so
 * every consumer can import it with no cycle. The derivation weights for the
 * three collapsing-regression tokens (`--accent-strong`, `--text-subtle`,
 * `--hover-bg`) live in `DERIVATIONS` (`./surfaces`) — this file references them,
 * it does not re-declare them (the triplication #3034 exists to remove:
 * `ThemeProvider.tsx:291-295` ↔ `matrix.ts:121-125` ↔ `system.ts:114-115`).
 *
 * Every `varName` / derivation below is byte-identical to the value the engine
 * already writes (`ThemeProvider.tsx:255-324`) — no new colour VALUE is
 * introduced. `status.onSolids` is the one NEW token (declared here; the engine
 * consumes it in ST-2), derived by the same WCAG-max luminance rule already used
 * for `--accent-contrast` (`ThemeProvider.tsx:153-160`).
 */
import { DERIVATIONS } from './surfaces';

/** A CSS custom property name, e.g. `--body-bg`. */
export type CssVarName = `--${string}`;

/** The derivation function a non-authored token resolves through. */
export type DerivationFn = 'color-mix' | 'wcag-max-contrast' | 'alpha-composite' | 'literal';

/** The single home for a derived token's rule. */
export interface TokenDerivation {
  readonly fn: DerivationFn;
  /** Input custom properties, in mix order. */
  readonly sources: readonly CssVarName[];
  /** Mix weights (e.g. `[0.55, 0.45]` for `--accent-strong`); absent where N/A. */
  readonly weights?: readonly number[];
}

/** One semantic token: its Chakra name, backing var, and (if derived) its rule. */
export interface SemanticToken {
  /** Chakra-style dotted name, e.g. 'bg.surface', 'fg.subtle', 'accent.strong'. */
  readonly name: string;
  /** The CSS custom property the engine writes / the component reads. */
  readonly varName: CssVarName;
  /** Authored by a theme record vs derived live from other tokens. */
  readonly authored: boolean;
  /** Present iff authored === false; the ONE home for the derivation weights. */
  readonly derivation?: TokenDerivation;
}

/**
 * Every `system.ts:56-136` colour token plus the derived engine vars
 * (`ThemeProvider.tsx:287-324`), plus the NEW `status.onSolids`.
 *
 * Authored tokens bridge a record-backed CSS var; derived tokens carry a
 * `derivation` (and their `varName` is the live var they resolve to / through).
 */
export const SEMANTIC_TOKENS: readonly SemanticToken[] = [
  // ── Backgrounds ────────────────────────────────────────────────────────────
  { name: 'bg.canvas', varName: '--body-bg', authored: true },
  { name: 'bg.surface', varName: '--card-bg', authored: true },
  { name: 'bg.subtle', varName: '--header-bg', authored: true },
  { name: 'bg.muted', varName: '--card-hover-bg', authored: true },
  {
    name: 'bg.hover',
    varName: '--hover-bg',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--text-primary'],
      weights: [DERIVATIONS.hoverBgPct],
    },
  },

  // ── Foreground ─────────────────────────────────────────────────────────────
  { name: 'fg.default', varName: '--text-primary', authored: true },
  { name: 'fg.muted', varName: '--text-secondary', authored: true },
  {
    name: 'fg.subtle',
    varName: '--text-subtle',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--text-secondary', '--text-primary'],
      weights: [...DERIVATIONS.textSubtle],
    },
  },
  {
    name: 'fg.onAccent',
    varName: '--accent-contrast',
    authored: false,
    derivation: { fn: 'wcag-max-contrast', sources: ['--accent-primary'] },
  },

  // ── Borders ────────────────────────────────────────────────────────────────
  { name: 'border.default', varName: '--border-color', authored: true },
  { name: 'border.subtle', varName: '--border-color', authored: true },

  // ── Overlay ────────────────────────────────────────────────────────────────
  { name: 'overlay.scrim', varName: '--overlay-bg', authored: true },

  // ── Accent ─────────────────────────────────────────────────────────────────
  { name: 'accent.default', varName: '--accent-primary', authored: true },
  { name: 'accent.emphasized', varName: '--accent-secondary', authored: true },
  {
    name: 'accent.strong',
    varName: '--accent-strong',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--accent-primary', '--text-primary'],
      weights: [...DERIVATIONS.accentStrong],
    },
  },
  { name: 'accent.solid', varName: '--accent-primary', authored: true },
  {
    name: 'accent.contrast',
    varName: '--accent-contrast',
    authored: false,
    derivation: { fn: 'wcag-max-contrast', sources: ['--accent-primary'] },
  },
  { name: 'accent.fg', varName: '--accent-primary', authored: true },
  {
    // system.ts:114 — `color-mix(in srgb, var(--accent-primary) 8%, transparent)`.
    name: 'accent.subtle',
    varName: '--accent-primary',
    authored: false,
    derivation: { fn: 'color-mix', sources: ['--accent-primary'], weights: [0.08] },
  },
  {
    // system.ts:115 — `color-mix(in srgb, var(--accent-primary) 15%, transparent)`.
    name: 'accent.muted',
    varName: '--accent-primary',
    authored: false,
    derivation: { fn: 'color-mix', sources: ['--accent-primary'], weights: [0.15] },
  },
  { name: 'accent.focusRing', varName: '--accent-primary', authored: true },
  { name: 'accent.border', varName: '--accent-primary', authored: true },
  { name: 'accent.subagent', varName: '--accent-subagent', authored: true },
  { name: 'accent.nestedSubagent', varName: '--accent-nested-subagent', authored: true },

  // ── Avatar (derived engine var) ──────────────────────────────────────────────
  {
    // ThemeProvider.tsx:324 — accent mixed into the OPAQUE body surface.
    name: 'avatar.interior',
    varName: '--fredo-avatar-interior',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--accent-primary', '--body-bg'],
      weights: [0.2],
    },
  },

  // ── Status ─────────────────────────────────────────────────────────────────
  { name: 'status.success', varName: '--status-success', authored: true },
  { name: 'status.warning', varName: '--status-warning', authored: true },
  { name: 'status.error', varName: '--status-error', authored: true },
  { name: 'status.info', varName: '--status-info', authored: true },
  {
    // NEW (ST-1 declares it; ST-2's engine consumes it). The status-solid
    // foreground, derived by the SAME WCAG-max luminance rule as
    // `resolveAccentContrast` (`ThemeProvider.tsx:153-160`) so a status pill
    // never pairs white-on-yellow.
    name: 'status.onSolids',
    varName: '--status-on-solids',
    authored: false,
    derivation: {
      fn: 'wcag-max-contrast',
      sources: ['--status-success', '--status-warning', '--status-error', '--status-info'],
    },
  },

  // ── Derived presentation vars (ThemeProvider.tsx:291-324) ───────────────────
  {
    name: 'scrollbar.thumb',
    varName: '--scrollbar-thumb',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--text-secondary'],
      weights: [0.45],
    },
  },
  {
    name: 'scrollbar.thumbHover',
    varName: '--scrollbar-thumb-hover',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--text-secondary'],
      weights: [0.7],
    },
  },
  {
    name: 'life.neutral',
    varName: '--life-neutral',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--text-primary', '--body-bg'],
      weights: [0.7, 0.3],
    },
  },
  {
    name: 'life.cell',
    varName: '--life-cell',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--accent-strong', '--life-neutral'],
      weights: [0.65, 0.35],
    },
  },
  {
    name: 'life.dim',
    varName: '--life-dim',
    authored: false,
    derivation: {
      fn: 'color-mix',
      sources: ['--overlay-bg'],
      weights: [0.12],
    },
  },
];

/** Every token name in the registry — the R-1.2 dangling-name oracle. */
export const TOKEN_NAMES: ReadonlySet<string> = new Set(
  SEMANTIC_TOKENS.map((token) => token.name),
);
