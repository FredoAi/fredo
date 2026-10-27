/**
 * Spec #3033 ST-2 / #3034 ST-3 — the contrast matrix: every foreground/background
 * /border token pair across every interactive control state, for every shipped
 * preset.
 *
 * #3034 ST-3 — the matrix is CONTRACT-SOURCED. `SurfaceId` / `ControlState` /
 * `ContrastKind`, the surface/state vocabulary, the derivation weights and every
 * token value are read from `../contract` (the single home), never re-declared
 * here. The contract's `SEMANTIC_TOKENS` registry resolves each gate token by
 * NAME (authored → the theme record var; derived → its `color-mix` /
 * `wcag-max-contrast` rule), so changing a contract token or its weights changes
 * this matrix with zero duplication.
 *
 * The gate evaluates a PROJECTION of the contract's completeness enumeration: the
 * contrast-checkable surface/state pairs (decorative translucent fills are not
 * floor-checked). `gatePairsWithinContract()` proves the projection is a subset
 * of `CONTRACT_PAIRS` cells backed by `TOKEN_NAMES`.
 *
 * The matrix is built with the exact `preset ?? classic base` layering
 * `ThemeProvider` applies, and the exact `color-mix()` derivations it authors
 * (`--accent-strong` 55/45, `--text-subtle` 65/35, `--accent-contrast` = the
 * WCAG-max on-accent foreground) — now sourced from the contract, not copied.
 *
 * Opacity-derived control appearances (no Fredo token) are alpha-composited over
 * their containing surface with `wcag.composite` and recorded with
 * `composed: true` — never read as a token, never omitted (H1).
 *
 * Non-token stock-palette colours the arithmetic cannot derive are routed to the
 * owning defect issue via `KNOWN_OUT_OF_SCOPE_PAIRS`, never silently dropped.
 *
 * Read-only, deterministic, pure — no filesystem, browser or randomness.
 */
import {
  CONTRACT_PAIRS,
  SEMANTIC_TOKENS,
  TOKEN_NAMES,
  type ContrastKind,
  type ControlState,
  type SemanticToken,
  type SurfaceId,
} from '../contract';
import {
  BODY_FLOOR,
  UI_FLOOR,
  composite,
  contrast,
  mixSrgb,
  parseColor,
  round2,
  type Rgb,
} from './wcag';
import { themes, themePresets } from '../../types/theme';

// ── The contract vocabulary, re-exported (never re-declared — #3034 ST-3) ─────
export type { ContrastKind, ControlState, SurfaceId } from '../contract';
export { SURFACE_IDS as GATE_SURFACES, CONTROL_STATE_IDS as GATE_STATES } from '../contract';
export { DERIVATIONS } from '../contract';

/** `<presetId>|<surface>|<state>|<pairId>` — the stable row identity. */
export type MatrixRowKey = string;

/** A pair identity within a surface/state (e.g. `label`, `border`, `focus-ring`). */
export type PairId = string;

/** One measured colour pair for one preset/surface/state. */
export interface MatrixRow {
  key: MatrixRowKey;
  presetId: string;
  surface: SurfaceId;
  state: ControlState;
  pairId: PairId;
  kind: ContrastKind;
  ratio: number;
  floor: number;
  /** True when the pair is opacity/alpha-derived (H1), never a token read. */
  composed: boolean;
  /**
   * #3035 ST-2 — WCAG inactive-component exemption, propagated from the
   * contract (`ContractPair.exempt`, `../contract`). An exempt pair is
   * floor-REPORTED (it stays in the matrix) but never a floor violation.
   */
  exempt: boolean;
}

/**
 * A known colour pair the token-arithmetic gate CANNOT derive deterministically,
 * routed to the issue that owns making it token-driven. Never silently omitted.
 */
export interface OutOfScopePair {
  readonly surface: SurfaceId;
  readonly pairId: PairId;
  readonly reason: string;
  readonly issue: number;
}

/**
 * KNOWN colour pairs the token-arithmetic gate CANNOT derive deterministically,
 * routed to the issue that owns making them token-driven. Never silently omitted.
 *
 * #3035 ST-2 — EMPTY. The former `radio-card|item-indicator` route is closed:
 * the `RadioCard.ItemIndicator` is token-driven (ST-4 adds the component
 * `colorPalette`), so it is now the in-scope, token-backed
 * `radio-card|selected|indicator` gate row (`PAIR_SPECS` below).
 */
export const KNOWN_OUT_OF_SCOPE_PAIRS: readonly OutOfScopePair[] = [];

/** The base record's id in the matrix — `themes.classic`, the locked base. */
const BASE_PRESET_ID = 'classic (base — no preset)';

const BASE_COLORS = themes.classic.colors as unknown as Record<string, string>;

/**
 * The 19 shipped presets: the `classic` base (no preset) plus the 18 built-ins
 * (`themes.turbo` is excluded — the base is LOCKED to `classic`,
 * `ThemeProvider.tsx:176`).
 */
const PRESET_SOURCES: ReadonlyArray<{ id: string; colors: Record<string, string> }> = [
  { id: BASE_PRESET_ID, colors: {} },
  ...themePresets.map((p) => ({ id: p.id, colors: p.colors as Record<string, string> })),
];

/** The 19 shipped preset ids (base first, then the 18 built-ins). */
export const PRESET_IDS: readonly string[] = PRESET_SOURCES.map((p) => p.id);

/** `preset ?? classic base` token resolution — exactly ThemeProvider's layering. */
export function resolvePresetToken(colors: Record<string, string>, key: string): string {
  return colors[key] ?? BASE_COLORS[key];
}

// ── Contract-driven token resolution (#3034 ST-3) ────────────────────────────
//
// Every gate token is resolved by its CONTRACT NAME through `SEMANTIC_TOKENS`:
// an authored token reads the theme record var it bridges; a derived token
// applies its contract `derivation` (color-mix / wcag-max-contrast). The
// derivation WEIGHTS live in the contract, so no weight is re-declared here.

/** Custom property → the theme-record key that authors it. */
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

const TOKEN_BY_NAME = new Map<string, SemanticToken>(
  SEMANTIC_TOKENS.map((token) => [token.name, token]),
);

/** Custom property → its token, preferring an authored token when several alias one var. */
const TOKEN_BY_VAR = new Map<string, SemanticToken>();
for (const token of SEMANTIC_TOKENS) {
  const existing = TOKEN_BY_VAR.get(token.varName);
  if (!existing || (token.authored && !existing.authored)) {
    TOKEN_BY_VAR.set(token.varName, token);
  }
}

function mustParse(color: string | undefined, key: string): Rgb {
  const rgb = color ? parseColor(color) : null;
  if (!rgb) throw new Error(`contrast matrix: token "${key}" is not a parseable colour (${String(color)})`);
  return rgb;
}

/** `resolveAccentContrast` (:153-160) foreground candidates. */
const ACCENT_CONTRAST_LIGHT: Rgb = [255, 255, 255];
const ACCENT_CONTRAST_DARK: Rgb = [12, 17, 23];

/** The WCAG-max on-accent foreground for an accent (mirrors `resolveAccentContrast`). */
function resolveAccentContrastRgb(accent: Rgb): Rgb {
  const againstWhite = contrast(ACCENT_CONTRAST_LIGHT, accent);
  const againstDark = contrast(ACCENT_CONTRAST_DARK, accent);
  return againstWhite >= againstDark ? ACCENT_CONTRAST_LIGHT : ACCENT_CONTRAST_DARK;
}

/**
 * Spec #3086 — the WCAG-max on-status foreground: the candidate (`white` |
 * `dark`) that maximises the MINIMUM contrast across every status colour, so a
 * status pill never pairs white-on-yellow on any preset. Mirrors
 * `resolveAccentContrastRgb` (one candidate vs one colour) generalised to the
 * status set (`ThemeProvider.tsx` `--status-on-solids`).
 */
export function resolveStatusOnSolidsRgb(statusColors: Rgb[]): Rgb {
  const worstCase = (candidate: Rgb): number =>
    Math.min(...statusColors.map((status) => contrast(candidate, status)));
  const againstWhite = worstCase(ACCENT_CONTRAST_LIGHT);
  const againstDark = worstCase(ACCENT_CONTRAST_DARK);
  return againstWhite >= againstDark ? ACCENT_CONTRAST_LIGHT : ACCENT_CONTRAST_DARK;
}

/** The contract token NAME for a custom property (sources are declared as vars). */
function tokenNameForVar(varName: string): string {
  const token = TOKEN_BY_VAR.get(varName);
  if (!token) throw new Error(`contrast matrix: no contract token backs "${varName}"`);
  return token.name;
}

/**
 * Resolve a CONTRACT TOKEN NAME to an opaque Rgb for one preset, following the
 * contract's own authored/derived rule. The one home for the arithmetic the
 * engine and the gate share.
 */
function resolveTokenRgb(
  name: string,
  colors: Record<string, string>,
  seen: Set<string> = new Set(),
): Rgb {
  const token = TOKEN_BY_NAME.get(name);
  if (!token) throw new Error(`contrast matrix: unknown contract token "${name}"`);
  if (token.authored || !token.derivation) {
    const key = VAR_TO_THEME_KEY[token.varName];
    return mustParse(key ? resolvePresetToken(colors, key) : undefined, token.varName);
  }
  if (seen.has(name)) {
    throw new Error(`contrast matrix: cyclic contract derivation for "${name}"`);
  }
  seen.add(name);
  const derivation = token.derivation;
  if (derivation.fn === 'wcag-max-contrast') {
    const sources = derivation.sources.map((varName) =>
      resolveTokenRgb(tokenNameForVar(varName), colors, seen),
    );
    // One source → the on-accent foreground; several → the on-status foreground
    // (maximises the MINIMUM contrast across the status set, #3086).
    return sources.length === 1
      ? resolveAccentContrastRgb(sources[0])
      : resolveStatusOnSolidsRgb(sources);
  }
  const sources = derivation.sources.map((varName) =>
    resolveTokenRgb(tokenNameForVar(varName), colors, seen),
  );
  const weights = derivation.weights ?? [];
  if (sources.length === 2 && weights.length === 2) {
    return mixSrgb(sources[0], sources[1], weights[0], weights[1]);
  }
  // A single source (a mix toward `transparent`): the opaque equivalent is the source.
  return sources[0];
}

/** The resolved Rgb tokens + derived values for one preset (contract-sourced). */
interface PresetTokens {
  readonly accent: Rgb;
  readonly accentStrong: Rgb;
  /** `accent.border` — the deepened hover/selected control boundary (ST-1). */
  readonly accentBorder: Rgb;
  /** `accent.focusRing` — the deepened keyboard focus ring (ST-1). */
  readonly accentFocusRing: Rgb;
  readonly accentContrast: Rgb;
  readonly textPrimary: Rgb;
  readonly textSecondary: Rgb;
  readonly textSubtle: Rgb;
  readonly borderColor: Rgb;
  readonly bodyBg: Rgb;
  readonly cardBg: Rgb;
  readonly headerBg: Rgb;
  /** `bg.muted` (`--card-hover-bg`) — the slider rail fill (#3086). */
  readonly cardHoverBg: Rgb;
  /** `status.error` (`--status-error`) — the Discard fill / banner accent (#3086). */
  readonly statusError: Rgb;
  /** `status.onSolids` — the WCAG-max on-status foreground (#3086). */
  readonly statusOnSolids: Rgb;
  /** `accent.tint` — the selected-segment indicator fill (#3086). */
  readonly accentTint: Rgb;
  /** `status.errorTint` — the solid status-button fill (#3086). */
  readonly statusErrorTint: Rgb;
  /** `status.errorStrong` — the deepened error accent (#3086). */
  readonly statusErrorStrong: Rgb;
}

function resolveTokens(colors: Record<string, string>): PresetTokens {
  return {
    accent: resolveTokenRgb('accent.default', colors),
    accentStrong: resolveTokenRgb('accent.strong', colors),
    // #3035 ST-2 — the gate resolves the DECLARED contract chrome tokens by NAME
    // (not the raw brand `accent.default`), so ST-1's deepening of
    // `accent.border` / `accent.focusRing` propagates into the matrix.
    accentBorder: resolveTokenRgb('accent.border', colors),
    accentFocusRing: resolveTokenRgb('accent.focusRing', colors),
    accentContrast: resolveTokenRgb('fg.onAccent', colors),
    textPrimary: resolveTokenRgb('fg.default', colors),
    textSecondary: resolveTokenRgb('fg.muted', colors),
    textSubtle: resolveTokenRgb('fg.subtle', colors),
    borderColor: resolveTokenRgb('border.default', colors),
    bodyBg: resolveTokenRgb('bg.canvas', colors),
    cardBg: resolveTokenRgb('bg.surface', colors),
    headerBg: resolveTokenRgb('bg.subtle', colors),
    // #3086 — the Wireframe control-class tokens: the slider rail fill, the
    // status fill/foreground pair and the banner composition inputs.
    cardHoverBg: resolveTokenRgb('bg.muted', colors),
    statusError: resolveTokenRgb('status.error', colors),
    statusOnSolids: resolveTokenRgb('status.onSolids', colors),
    accentTint: resolveTokenRgb('accent.tint', colors),
    statusErrorTint: resolveTokenRgb('status.errorTint', colors),
    statusErrorStrong: resolveTokenRgb('status.errorStrong', colors),
  };
}

// ── Alpha-derived control appearances (H1, no Fredo token) ───────────────────
//
// #3034 follow-up (G-299): `disabled` is the `fg.subtle` TOKEN resolved on the
// surface — matching the shipped structural rule (`system.ts:107-127`,
// `--text-subtle`, `opacity: 1`) — NEVER an opacity wash. The old composed-opacity
// model was a stale mechanism and the direct source of every `disabled|label`
// violation. The only remaining alpha-derived appearances are the solid control's
// hover and the radio-card selected fill (`tint(--accent-primary, 12)`, still
// painted by `AppPresentationSettings.tsx:110`).

/** Solid confirm Button `_hover={{ opacity: 0.9 }}` (AppPresentationSettings.tsx:422). */
const SOLID_HOVER_OPACITY = 0.9;
/**
 * Radio-card selected fill `tint(--accent-primary, RADIO_SELECTED_TINT)`.
 *
 * #3035 ST-2 lowered this from 0.12 to 0.08 so `fg.default` over the composed
 * selected fill clears its 4.5:1 body floor on the short solarized preset
 * (solarized `radio-card|selected|label` 3.92 → 4.93). The component tint
 * (owned by the surface call sites) must mirror this exact value.
 */
const RADIO_SELECTED_TINT = 0.08;

/**
 * Spec #3086 — Wireframe control-class compositions (all `tint()`-derived over
 * an opaque surface, no Fredo token of their own, so `composed: true`):
 *  - ghost toolbar button hover `tint(--accent-primary, 10)` and pressed
 *    `tint(--accent-primary, 18)` over `--card-bg` (`WireframeInsertMenu.tsx:113-115`);
 *  - file-error banner `tint(--status-error, 10)` over `--body-bg`
 *    (`WireframeFileError.tsx:31`).
 * The components must paint the exact same tint (G-366); these are the one home.
 */
const GHOST_HOVER_TINT = 0.1;
const GHOST_ACTIVE_TINT = 0.18;
const BANNER_ERROR_TINT = 0.1;

/** One pair specification, resolved against a preset's tokens. */
interface PairSpec {
  readonly surface: SurfaceId;
  readonly state: ControlState;
  readonly pairId: PairId;
  readonly kind: ContrastKind;
  readonly floor: number;
  readonly composed: boolean;
  /** Contract token NAME backing the foreground (validated against TOKEN_NAMES). */
  readonly fgToken: string;
  /** Contract token NAME backing the background (validated against TOKEN_NAMES). */
  readonly bgToken: string;
  readonly fg: (t: PresetTokens) => Rgb;
  readonly bg: (t: PresetTokens) => Rgb;
}

/**
 * The gate's PROJECTION of the contract: the contrast-checkable pairs for the
 * outline/select/radio-card control classes (`system.ts:18-20`, canonical
 * `selectStyles` `LayoutSettings.tsx:71-89`, `AppPresentationSettings.tsx:100-124`),
 * solid controls (`system.ts:111,89`) and the base `canvas`/`surface`/`subtle`
 * text and focus pairs. Decorative translucent fills are not floor-checked and
 * are therefore outside the gate's projection.
 */
const PAIR_SPECS: readonly PairSpec[] = [
  // ── canvas (--body-bg) ──────────────────────────────────────────────────────
  { surface: 'canvas', state: 'default', pairId: 'fg-default', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.canvas', fg: (t) => t.textPrimary, bg: (t) => t.bodyBg },
  { surface: 'canvas', state: 'default', pairId: 'fg-muted', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.muted', bgToken: 'bg.canvas', fg: (t) => t.textSecondary, bg: (t) => t.bodyBg },
  { surface: 'canvas', state: 'default', pairId: 'fg-subtle', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.canvas', fg: (t) => t.textSubtle, bg: (t) => t.bodyBg },
  { surface: 'canvas', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.canvas', fg: (t) => t.accentFocusRing, bg: (t) => t.bodyBg },

  // ── surface (--card-bg) ─────────────────────────────────────────────────────
  { surface: 'surface', state: 'default', pairId: 'fg-default', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'surface', state: 'default', pairId: 'fg-muted', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.muted', bgToken: 'bg.surface', fg: (t) => t.textSecondary, bg: (t) => t.cardBg },
  { surface: 'surface', state: 'default', pairId: 'fg-subtle', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.surface', fg: (t) => t.textSubtle, bg: (t) => t.cardBg },
  { surface: 'surface', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },

  // ── subtle (--header-bg) ────────────────────────────────────────────────────
  { surface: 'subtle', state: 'default', pairId: 'fg-default', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.subtle', fg: (t) => t.textPrimary, bg: (t) => t.headerBg },
  { surface: 'subtle', state: 'default', pairId: 'fg-muted', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.muted', bgToken: 'bg.subtle', fg: (t) => t.textSecondary, bg: (t) => t.headerBg },
  { surface: 'subtle', state: 'default', pairId: 'fg-subtle', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.subtle', fg: (t) => t.textSubtle, bg: (t) => t.headerBg },
  { surface: 'subtle', state: 'focus', pairId: 'nav-focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.strong', bgToken: 'bg.subtle', fg: (t) => t.accentStrong, bg: (t) => t.headerBg },

  // ── control-outline (global `button` + `button[data-variant=outline]`, :18-20) ─
  { surface: 'control-outline', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'control-outline', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'border.default', bgToken: 'bg.surface', fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'control-outline', state: 'hover', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'accent.border', bgToken: 'bg.surface', fg: (t) => t.accentBorder, bg: (t) => t.cardBg },
  { surface: 'control-outline', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },
  { surface: 'control-outline', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.surface', fg: (t) => t.textSubtle, bg: (t) => t.cardBg },

  // ── select (canonical `selectStyles`, LayoutSettings.tsx:71-89) ─────────────
  { surface: 'select', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'select', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'border.default', bgToken: 'bg.surface', fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'select', state: 'hover', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'accent.border', bgToken: 'bg.surface', fg: (t) => t.accentBorder, bg: (t) => t.cardBg },
  { surface: 'select', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },
  { surface: 'select', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.surface', fg: (t) => t.textSubtle, bg: (t) => t.cardBg },

  // ── radio-card (AppPresentationSettings.tsx:100-124) ────────────────────────
  { surface: 'radio-card', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'border.default', bgToken: 'bg.surface', fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'hover', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'accent.border', bgToken: 'bg.surface', fg: (t) => t.accentBorder, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.surface', fg: (t) => t.textSubtle, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'selected', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fgToken: 'fg.default', bgToken: 'accent.solid', fg: (t) => t.textPrimary, bg: (t) => composite(t.accent, t.cardBg, RADIO_SELECTED_TINT) },
  { surface: 'radio-card', state: 'selected', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'accent.border', bgToken: 'bg.surface', fg: (t) => t.accentBorder, bg: (t) => t.cardBg },
  // #3035 ST-2 — the selected indicator dot (was KNOWN_OUT_OF_SCOPE_PAIRS). It
  // is now a token-backed row: the contract enumerates `radio-card|selected|
  // indicator` as `accent.strong` on `bg.surface` (`surfaces.ts` `addSurface`),
  // which the surface fixes (ST-4) make truthful by token-driving the dot.
  { surface: 'radio-card', state: 'selected', pairId: 'indicator', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'accent.strong', bgToken: 'bg.surface', fg: (t) => t.accentStrong, bg: (t) => t.cardBg },

  // ── control-solid (system.ts:111,89; AppPresentationSettings.tsx:418-427) ───
  { surface: 'control-solid', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.onAccent', bgToken: 'accent.solid', fg: (t) => t.accentContrast, bg: (t) => t.accent },
  { surface: 'control-solid', state: 'hover', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fgToken: 'fg.onAccent', bgToken: 'accent.solid', fg: (t) => composite(t.accentContrast, t.cardBg, SOLID_HOVER_OPACITY), bg: (t) => composite(t.accent, t.cardBg, SOLID_HOVER_OPACITY) },

  // ── Wireframe control classes (Spec #3086) ──────────────────────────────────
  // The gate PROJECTION of the six Wireframe contract surfaces. Row identities,
  // tokens and floors are the binding names block (with the UI/UX painted-token
  // substitutions folded in): the gated pair is the control's identifiable
  // BOUNDARY / indicator, not its decorative subtle fill (SC 1.4.11).
  //
  // segmented (Chakra SegmentGroup — SegmentedField.tsx)
  { surface: 'segmented', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'segmented', state: 'default', pairId: 'muted', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.muted', bgToken: 'bg.surface', fg: (t) => t.textSecondary, bg: (t) => t.cardBg },
  { surface: 'segmented', state: 'default', pairId: 'track', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'border.default', bgToken: 'bg.surface', fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'segmented', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'border.default', bgToken: 'bg.surface', fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'segmented', state: 'hover', pairId: 'fill', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'accent.border', bgToken: 'bg.surface', fg: (t) => t.accentBorder, bg: (t) => t.cardBg },
  { surface: 'segmented', state: 'hover', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'accent.border', bgToken: 'bg.surface', fg: (t) => t.accentBorder, bg: (t) => t.cardBg },
  { surface: 'segmented', state: 'selected', pairId: 'indicator', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'accent.strong', bgToken: 'bg.surface', fg: (t) => t.accentStrong, bg: (t) => t.cardBg },
  // #3086 (G-235 pre-validation) — `accent.strong` cannot host ANY 4.5:1
  // foreground on several presets (its luminance sits in the band where even the
  // WCAG-max white/dark tops out at ~4.37), so the selected item's fill is the
  // bounded `accent.tint` and its label is `fg.default` (worst 5.49, solarized).
  { surface: 'segmented', state: 'selected', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'accent.tint', fg: (t) => t.textPrimary, bg: (t) => t.accentTint },
  { surface: 'segmented', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },
  { surface: 'segmented', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.surface', fg: (t) => t.textSubtle, bg: (t) => t.cardBg },

  // slider (Chakra Slider — NumberSliderField.tsx). The rail BOUNDARY is the
  // gated pair. #3086 (G-235) — the rail FILL is `bg.subtle`, not `bg.muted`:
  // `bg.muted` (`--card-hover-bg`) is not preset-authored, so on the 18 built-ins
  // it falls back to classic's dark grey and NO token clears 3:1 against it
  // (paper 2.0). `bg.subtle` is preset-authored and clears on every preset.
  { surface: 'slider', state: 'default', pairId: 'track', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'border.default', bgToken: 'bg.surface', fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'slider', state: 'default', pairId: 'range', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'accent.strong', bgToken: 'bg.subtle', fg: (t) => t.accentStrong, bg: (t) => t.headerBg },
  { surface: 'slider', state: 'default', pairId: 'thumb', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'accent.strong', bgToken: 'bg.subtle', fg: (t) => t.accentStrong, bg: (t) => t.headerBg },
  { surface: 'slider', state: 'hover', pairId: 'thumb', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'accent.border', bgToken: 'bg.subtle', fg: (t) => t.accentBorder, bg: (t) => t.headerBg },
  { surface: 'slider', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },
  { surface: 'slider', state: 'disabled', pairId: 'range', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.subtle', fg: (t) => t.textSubtle, bg: (t) => t.headerBg },

  // number-input (Chakra NumberInput — NumberSliderField.tsx)
  { surface: 'number-input', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'number-input', state: 'default', pairId: 'stepper', kind: 'ui', floor: UI_FLOOR, composed: false, fgToken: 'fg.muted', bgToken: 'bg.surface', fg: (t) => t.textSecondary, bg: (t) => t.cardBg },
  { surface: 'number-input', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'border.default', bgToken: 'bg.surface', fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'number-input', state: 'hover', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'accent.border', bgToken: 'bg.surface', fg: (t) => t.accentBorder, bg: (t) => t.cardBg },
  { surface: 'number-input', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },
  { surface: 'number-input', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.surface', fg: (t) => t.textSubtle, bg: (t) => t.cardBg },

  // control-ghost (variant="ghost" pressable buttons — WireframeInsertMenu.tsx).
  // The pressed CONTRACT state is `active` (the component expresses "pressed" via
  // `aria-pressed`/`data-state`); the label stays surface text while the accent
  // fill intensity carries the hover→pressed signal.
  { surface: 'control-ghost', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'control-ghost', state: 'hover', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => composite(t.accent, t.cardBg, GHOST_HOVER_TINT) },
  { surface: 'control-ghost', state: 'active', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => composite(t.accent, t.cardBg, GHOST_ACTIVE_TINT) },
  { surface: 'control-ghost', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },
  { surface: 'control-ghost', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'bg.surface', fg: (t) => t.textSubtle, bg: (t) => t.cardBg },

  // status-solid (status-filled button — Wireframe Discard, #3081 pair).
  // #3086 (G-235) — `status.error` cannot host ANY 4.5:1 foreground on several
  // presets (solarized 4.10 with the WCAG-max on-status), so the destructive
  // fill is the bounded `status.errorTint` with `fg.default` as its label
  // (worst 4.89, solarized). The row identity is unchanged.
  { surface: 'status-solid', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'status.errorTint', fg: (t) => t.textPrimary, bg: (t) => t.statusErrorTint },
  { surface: 'status-solid', state: 'hover', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'status.errorTint', fg: (t) => t.textPrimary, bg: (t) => t.statusErrorTint },
  { surface: 'status-solid', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fgToken: 'accent.focusRing', bgToken: 'bg.surface', fg: (t) => t.accentFocusRing, bg: (t) => t.cardBg },
  { surface: 'status-solid', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.subtle', bgToken: 'status.errorTint', fg: (t) => t.textSubtle, bg: (t) => t.statusErrorTint },

  // banner (file-error banner — WireframeFileError.tsx). #3086 (G-235) — the raw
  // `status.error` is below the 3:1 UI floor against the canvas on several light
  // presets (arctic 2.84), so the icon + border use the bounded deepened
  // `status.errorStrong` (still the error hue; worst 4.91/5.46). The label is
  // `fg.default` (worst 5.24) so the message never relies on colour alone.
  { surface: 'banner', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fgToken: 'fg.default', bgToken: 'bg.canvas', fg: (t) => t.textPrimary, bg: (t) => composite(t.statusError, t.bodyBg, BANNER_ERROR_TINT) },
  { surface: 'banner', state: 'default', pairId: 'icon', kind: 'ui', floor: UI_FLOOR, composed: true, fgToken: 'status.errorStrong', bgToken: 'bg.canvas', fg: (t) => t.statusErrorStrong, bg: (t) => composite(t.statusError, t.bodyBg, BANNER_ERROR_TINT) },
  { surface: 'banner', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fgToken: 'status.errorStrong', bgToken: 'bg.canvas', fg: (t) => t.statusErrorStrong, bg: (t) => t.bodyBg },

  // Wireframe extras: the canvas loading fallback, the status-bar Pan chip and
  // the Wireframe dialog title/body (all already-rendered pairs, now gated).
  // #3086 (G-235) — `bg.muted` is not preset-authored, so the fallback/chip fills
  // move to the preset-authored `bg.subtle` / `bg.surface` (worst 4.67 / 4.58).
  { surface: 'canvas', state: 'default', pairId: 'fallback-label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.muted', bgToken: 'bg.subtle', fg: (t) => t.textSecondary, bg: (t) => t.headerBg },
  { surface: 'subtle', state: 'default', pairId: 'chip-label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.muted', bgToken: 'bg.surface', fg: (t) => t.textSecondary, bg: (t) => t.cardBg },
  { surface: 'surface', state: 'default', pairId: 'overlay-label', kind: 'body', floor: BODY_FLOOR, composed: false, fgToken: 'fg.default', bgToken: 'bg.surface', fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
];

/** The contract `surface|state` cells (the completeness enumeration). */
export const CONTRACT_CELLS: ReadonlySet<string> = new Set(
  CONTRACT_PAIRS.map((pair) => `${pair.surface}|${pair.state}`),
);

/**
 * The contract `surface|state|pairId` cells flagged WCAG-exempt (#3035 ST-2),
 * propagated from the contract (`ContractPair.exempt`) so the gate never
 * re-invents the inactive-component exemption. `evaluateContrast` filters these
 * rows out of `belowFloor`, so an exempt pair is never a floor violation.
 */
const EXEMPT_CELLS: ReadonlySet<string> = new Set(
  CONTRACT_PAIRS.filter((pair) => pair.exempt).map(
    (pair) => `${pair.surface}|${pair.state}|${pair.pairId}`,
  ),
);

/**
 * True when every gate pair is backed by the contract: its `(surface, state)` is
 * a declared contract cell AND its fg/bg tokens resolve in `TOKEN_NAMES`. This is
 * the gate ⊆ contract projection check (R-5.1 / AC5).
 */
export function gatePairsWithinContract(): boolean {
  return PAIR_SPECS.every(
    (spec) =>
      CONTRACT_CELLS.has(`${spec.surface}|${spec.state}`) &&
      TOKEN_NAMES.has(spec.fgToken) &&
      TOKEN_NAMES.has(spec.bgToken),
  );
}

/**
 * Build the full contrast matrix: `PRESET_IDS × PAIR_SPECS` rows, each carrying
 * its computed ratio, absolute floor and composed flag. Deterministic ordering
 * (preset-major, then the declared pair order) so two calls are deep-equal.
 */
export function buildContrastMatrix(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const { id: presetId, colors } of PRESET_SOURCES) {
    const tokens = resolveTokens(colors);
    for (const spec of PAIR_SPECS) {
      rows.push({
        key: `${presetId}|${spec.surface}|${spec.state}|${spec.pairId}`,
        presetId,
        surface: spec.surface,
        state: spec.state,
        pairId: spec.pairId,
        kind: spec.kind,
        ratio: round2(contrast(spec.fg(tokens), spec.bg(tokens))),
        floor: spec.floor,
        composed: spec.composed,
        exempt: EXEMPT_CELLS.has(`${spec.surface}|${spec.state}|${spec.pairId}`),
      });
    }
  }
  return rows;
}
