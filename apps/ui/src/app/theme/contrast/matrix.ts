/**
 * Spec #3033 ST-2 — the contrast matrix: every foreground/background/border token
 * pair across every interactive control state, for every shipped preset.
 *
 * The matrix is built from the LIVE token data (`app/types/theme.ts`) with the
 * exact `preset ?? classic base` layering `ThemeProvider` applies, and the exact
 * `color-mix()` derivations it authors (`--accent-strong` 55/45,
 * `--text-subtle` 65/35, `--accent-contrast` = the WCAG-max on-accent foreground).
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

/** `<presetId>|<surface>|<state>|<pairId>` — the stable row identity. */
export type MatrixRowKey = string;

/** The WCAG category of a pair, which selects its floor. */
export type ContrastKind = 'body' | 'large' | 'ui' | 'border' | 'focus';

/** The interactive state of a control whose colour pair is measured. */
export type ControlState = 'default' | 'hover' | 'focus' | 'disabled' | 'selected';

/** The painted surface a pair is measured against / on. */
export type SurfaceId =
  | 'canvas'
  | 'surface'
  | 'subtle'
  | 'control-outline'
  | 'control-solid'
  | 'select'
  | 'radio-card';

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
 * `RadioCard.ItemIndicator` declares no `colorPalette`/`color`
 * (`AppPresentationSettings.tsx:123`, `PostgresSettings.tsx:164`, `CliOption.tsx:48`),
 * so it resolves from Chakra's stock palette — not a Fredo token. #3035 owns
 * making it token-driven (add a `colorPalette`), after which it becomes an
 * in-scope row and this entry is removed.
 */
export const KNOWN_OUT_OF_SCOPE_PAIRS: readonly OutOfScopePair[] = [
  {
    surface: 'radio-card',
    pairId: 'item-indicator',
    reason:
      'RadioCard.ItemIndicator declares no colorPalette/color → resolves from the Chakra stock palette, not a Fredo token; the token-arithmetic gate cannot derive it deterministically.',
    issue: 3035,
  },
];

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

// ── Derived-token weights (mirror ThemeProvider.tsx) ─────────────────────────

/** `--accent-strong` = `color-mix(accent-primary 55%, text-primary 45%)` (T6, :295). */
const ACCENT_STRONG_ACCENT_PCT = 0.55;
const ACCENT_STRONG_TEXT_PCT = 0.45;
/** `--text-subtle` = `color-mix(text-secondary 65%, text-primary 35%)` (T2, :292). */
const TEXT_SUBTLE_SECONDARY_PCT = 0.65;
const TEXT_SUBTLE_PRIMARY_PCT = 0.35;

/** `resolveAccentContrast` (:153-160) foreground candidates. */
const ACCENT_CONTRAST_LIGHT: Rgb = [255, 255, 255];
const ACCENT_CONTRAST_DARK: Rgb = [12, 17, 23];

// ── Opacity-derived control appearances (H1, no Fredo token) ─────────────────

/** Chakra `Button` `disabled` layer-style opacity (outline button disabled). */
const OUTLINE_DISABLED_OPACITY = 0.5;
/** `chakra.select` `_disabled: { opacity: 0.5 }` (LayoutSettings.tsx:88). */
const SELECT_DISABLED_OPACITY = 0.5;
/** `RadioCard.ItemControl` `opacity={disabled ? 0.55 : 1}` (AppPresentationSettings.tsx:111). */
const RADIO_DISABLED_OPACITY = 0.55;
/** Solid confirm Button `_hover={{ opacity: 0.9 }}` (AppPresentationSettings.tsx:422). */
const SOLID_HOVER_OPACITY = 0.9;
/** Radio-card selected fill `tint(--accent-primary, 12)` (AppPresentationSettings.tsx:110). */
const RADIO_SELECTED_TINT = 0.12;

/** The resolved Rgb tokens + derived values for one preset. */
interface PresetTokens {
  readonly accent: Rgb;
  readonly accentStrong: Rgb;
  readonly accentContrast: Rgb;
  readonly textPrimary: Rgb;
  readonly textSecondary: Rgb;
  readonly textSubtle: Rgb;
  readonly borderColor: Rgb;
  readonly bodyBg: Rgb;
  readonly cardBg: Rgb;
  readonly headerBg: Rgb;
}

/** One pair specification, resolved against a preset's tokens. */
interface PairSpec {
  readonly surface: SurfaceId;
  readonly state: ControlState;
  readonly pairId: PairId;
  readonly kind: ContrastKind;
  readonly floor: number;
  readonly composed: boolean;
  readonly fg: (t: PresetTokens) => Rgb;
  readonly bg: (t: PresetTokens) => Rgb;
}

function mustParse(color: string | undefined, key: string): Rgb {
  const rgb = color ? parseColor(color) : null;
  if (!rgb) throw new Error(`contrast matrix: token "${key}" is not a parseable colour (${String(color)})`);
  return rgb;
}

/** The WCAG-max on-accent foreground for an accent (mirrors `resolveAccentContrast`). */
function resolveAccentContrastRgb(accent: Rgb): Rgb {
  const againstWhite = contrast(ACCENT_CONTRAST_LIGHT, accent);
  const againstDark = contrast(ACCENT_CONTRAST_DARK, accent);
  return againstWhite >= againstDark ? ACCENT_CONTRAST_LIGHT : ACCENT_CONTRAST_DARK;
}

function resolveTokens(colors: Record<string, string>): PresetTokens {
  const accent = mustParse(resolvePresetToken(colors, 'accentPrimary'), 'accentPrimary');
  const textPrimary = mustParse(resolvePresetToken(colors, 'textPrimary'), 'textPrimary');
  const textSecondary = mustParse(resolvePresetToken(colors, 'textSecondary'), 'textSecondary');
  const borderColor = mustParse(resolvePresetToken(colors, 'borderColor'), 'borderColor');
  const bodyBg = mustParse(resolvePresetToken(colors, 'bodyBg'), 'bodyBg');
  const cardBg = mustParse(resolvePresetToken(colors, 'cardBg'), 'cardBg');
  const headerBg = mustParse(resolvePresetToken(colors, 'headerBg'), 'headerBg');
  return {
    accent,
    accentStrong: mixSrgb(accent, textPrimary, ACCENT_STRONG_ACCENT_PCT, ACCENT_STRONG_TEXT_PCT),
    accentContrast: resolveAccentContrastRgb(accent),
    textPrimary,
    textSecondary,
    textSubtle: mixSrgb(
      textSecondary,
      textPrimary,
      TEXT_SUBTLE_SECONDARY_PCT,
      TEXT_SUBTLE_PRIMARY_PCT,
    ),
    borderColor,
    bodyBg,
    cardBg,
    headerBg,
  };
}

/**
 * The full AC5 enumeration: outline buttons (`system.ts:18-20`), selects
 * (canonical `selectStyles` — `LayoutSettings.tsx:71-89`, mirrored at
 * `PostgresSettings.tsx:94`, `ZoneLayoutEditor.tsx:61`, `ThemingSettings.tsx:47`),
 * radio cards (`AppPresentationSettings.tsx:100-124`) and solid controls
 * (`system.ts:111,89`; `AppPresentationSettings.tsx:418-427`), plus the base
 * `canvas`/`surface`/`subtle` text and focus pairs.
 */
const PAIR_SPECS: readonly PairSpec[] = [
  // ── canvas (--body-bg) ──────────────────────────────────────────────────────
  { surface: 'canvas', state: 'default', pairId: 'fg-default', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textPrimary, bg: (t) => t.bodyBg },
  { surface: 'canvas', state: 'default', pairId: 'fg-muted', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textSecondary, bg: (t) => t.bodyBg },
  { surface: 'canvas', state: 'default', pairId: 'fg-subtle', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textSubtle, bg: (t) => t.bodyBg },
  { surface: 'canvas', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.bodyBg },

  // ── surface (--card-bg) ─────────────────────────────────────────────────────
  { surface: 'surface', state: 'default', pairId: 'fg-default', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'surface', state: 'default', pairId: 'fg-muted', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textSecondary, bg: (t) => t.cardBg },
  { surface: 'surface', state: 'default', pairId: 'fg-subtle', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textSubtle, bg: (t) => t.cardBg },
  { surface: 'surface', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.cardBg },

  // ── subtle (--header-bg) ────────────────────────────────────────────────────
  { surface: 'subtle', state: 'default', pairId: 'fg-default', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textPrimary, bg: (t) => t.headerBg },
  { surface: 'subtle', state: 'default', pairId: 'fg-muted', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textSecondary, bg: (t) => t.headerBg },
  { surface: 'subtle', state: 'default', pairId: 'fg-subtle', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textSubtle, bg: (t) => t.headerBg },
  { surface: 'subtle', state: 'focus', pairId: 'nav-focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fg: (t) => t.accentStrong, bg: (t) => t.headerBg },

  // ── control-outline (global `button` + `button[data-variant=outline]`, :18-20) ─
  { surface: 'control-outline', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'control-outline', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'control-outline', state: 'hover', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.cardBg },
  { surface: 'control-outline', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.cardBg },
  { surface: 'control-outline', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fg: (t) => composite(t.textPrimary, t.cardBg, OUTLINE_DISABLED_OPACITY), bg: (t) => composite(t.cardBg, t.cardBg, OUTLINE_DISABLED_OPACITY) },

  // ── select (canonical `selectStyles`, LayoutSettings.tsx:71-89) ─────────────
  { surface: 'select', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'select', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'select', state: 'hover', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.cardBg },
  { surface: 'select', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.cardBg },
  { surface: 'select', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fg: (t) => composite(t.textPrimary, t.cardBg, SELECT_DISABLED_OPACITY), bg: (t) => composite(t.cardBg, t.cardBg, SELECT_DISABLED_OPACITY) },

  // ── radio-card (AppPresentationSettings.tsx:100-124) ────────────────────────
  { surface: 'radio-card', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.textPrimary, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'default', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fg: (t) => t.borderColor, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'hover', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'focus', pairId: 'focus-ring', kind: 'focus', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.cardBg },
  { surface: 'radio-card', state: 'disabled', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fg: (t) => composite(t.textSecondary, t.cardBg, RADIO_DISABLED_OPACITY), bg: (t) => composite(t.cardBg, t.cardBg, RADIO_DISABLED_OPACITY) },
  { surface: 'radio-card', state: 'selected', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fg: (t) => t.textPrimary, bg: (t) => composite(t.accent, t.cardBg, RADIO_SELECTED_TINT) },
  { surface: 'radio-card', state: 'selected', pairId: 'border', kind: 'border', floor: UI_FLOOR, composed: false, fg: (t) => t.accent, bg: (t) => t.cardBg },

  // ── control-solid (system.ts:111,89; AppPresentationSettings.tsx:418-427) ───
  { surface: 'control-solid', state: 'default', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: false, fg: (t) => t.accentContrast, bg: (t) => t.accent },
  { surface: 'control-solid', state: 'hover', pairId: 'label', kind: 'body', floor: BODY_FLOOR, composed: true, fg: (t) => composite(t.accentContrast, t.cardBg, SOLID_HOVER_OPACITY), bg: (t) => composite(t.accent, t.cardBg, SOLID_HOVER_OPACITY) },
];

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
      });
    }
  }
  return rows;
}
