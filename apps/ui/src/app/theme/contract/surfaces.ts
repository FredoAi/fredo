/**
 * Theme contract — surfaces, states, contrast pairs, floors and derivations
 * (Spec #3034 ST-1).
 *
 * The completeness enumeration: every painted surface (13) × every interactive
 * control state (6) maps to the semantic-token NAMES that back it. This is the
 * SUPERSET of the merged contrast gate's enumeration (#3033, 7 surfaces × 5
 * states): ST-3 makes the gate consume a projection of this list, so no surface
 * or state is silently dropped and the `active` state becomes gate-checkable.
 *
 * The vocabulary is adopted VERBATIM from #3033's `SurfaceId`/`ControlState`
 * (`theme/contrast/matrix.ts:31-51`) and extended with the surfaces/states the
 * contract must cover (`overlay`, `nav`, `input`, `card`, `pill`, `badge`;
 * `active`).
 *
 * `DERIVATIONS` is the single home for the weights the engine
 * (`ThemeProvider.tsx:291-295`) and the gate (`matrix.ts:121-125`) both author —
 * collapsing the triplication #3034 exists to remove. `tokens.ts` references it.
 *
 * Read-only, pure, deterministic — no browser, filesystem or randomness.
 */

/** The painted surface a pair is measured against / on. */
export type SurfaceId =
  | 'canvas'
  | 'surface'
  | 'subtle'
  | 'overlay'
  | 'nav'
  | 'input'
  | 'card'
  | 'pill'
  | 'badge'
  | 'control-outline'
  | 'control-solid'
  | 'select'
  | 'radio-card';

/** The interactive state of a control whose colour pair is measured. */
export type ControlState =
  | 'default'
  | 'hover'
  | 'active'
  | 'focus'
  | 'selected'
  | 'disabled';

/** The WCAG category of a pair, which selects its floor. */
export type ContrastKind = 'body' | 'large' | 'ui' | 'border' | 'focus';

/** WCAG AA absolute floor for body text (`wcag.ts:95` — byte-identical). */
export const BODY_FLOOR = 4.5;
/** WCAG AA absolute floor for large text, UI, borders and focus (`wcag.ts:97`). */
export const UI_FLOOR = 3;

/** One enumerated colour pair: which tokens back which surface/state cell. */
export interface ContractPair {
  readonly surface: SurfaceId;
  readonly state: ControlState;
  /** Pair identity within a surface/state (e.g. 'label', 'border', 'focus-ring'). */
  readonly pairId: string;
  readonly kind: ContrastKind;
  /** BODY_FLOOR (4.5) | UI_FLOOR (3), selected by `kind`. */
  readonly floor: number;
  /** Opacity/alpha-derived rendered pair (H1) vs a token read. */
  readonly composed: boolean;
  /** A token NAME resolved via `SEMANTIC_TOKENS`, never a literal. */
  readonly fg: string;
  /** A token NAME resolved via `SEMANTIC_TOKENS`, never a literal. */
  readonly bg: string;
}

/** The painted surfaces, in declaration order (the binding vocabulary). */
export const SURFACE_IDS: readonly SurfaceId[] = [
  'canvas',
  'surface',
  'subtle',
  'overlay',
  'nav',
  'input',
  'card',
  'pill',
  'badge',
  'control-outline',
  'control-solid',
  'select',
  'radio-card',
];

/** The interactive states, in declaration order (the binding vocabulary). */
export const CONTROL_STATE_IDS: readonly ControlState[] = [
  'default',
  'hover',
  'active',
  'focus',
  'selected',
  'disabled',
];

/**
 * The derivation weights — the ONE home (collapses `ThemeProvider.tsx:291-295`
 * ↔ `matrix.ts:121-125` ↔ `system.ts:114-115`). `--accent-strong` stays 55/45,
 * `--hover-bg` stays 6%.
 *
 * ST-1 (#3035) RAISED `--text-subtle` from 65/35 to 55/45 — the stronger mix of
 * `--text-secondary` toward `--text-primary` makes `fg.subtle` clear its 4.5:1
 * body floor on every preset the derivations can reach (solarized is tightened
 * by the authored preset values in ST-2). The weight is the single home the
 * engine, the gate and `theme/system.ts` all read.
 */
export const DERIVATIONS: {
  readonly accentStrong: readonly [number, number];
  readonly textSubtle: readonly [number, number];
  readonly hoverBgPct: number;
} = {
  accentStrong: [0.55, 0.45],
  textSubtle: [0.55, 0.45],
  hoverBgPct: 0.06,
};

/** `[surface, state, pairId, kind, fg, bg, composed?]` seed row. */
type PairSeed = readonly [
  surface: SurfaceId,
  state: ControlState,
  pairId: string,
  kind: ContrastKind,
  fg: string,
  bg: string,
  composed?: boolean,
];

const seeds: PairSeed[] = [];

/**
 * Append the standard surface/state matrix for a text-or-control surface painted
 * on `bg`: default label/muted/border, hover fill+border, active fill+border,
 * focus ring, selected indicator + on-accent label, disabled label.
 *
 * `focusRing` is `accent.focusRing` by default; nav/subtle chrome deepens to
 * `accent.strong` (`system.ts:43-46`) so a pale accent still clears 3:1.
 */
function addSurface(
  surface: SurfaceId,
  bg: string,
  focusRing: string = 'accent.focusRing',
): void {
  seeds.push(
    [surface, 'default', 'label', 'body', 'fg.default', bg],
    [surface, 'default', 'muted', 'body', 'fg.muted', bg],
    [surface, 'default', 'border', 'border', 'border.default', bg],
    [surface, 'hover', 'fill', 'ui', 'bg.hover', bg],
    [surface, 'hover', 'border', 'border', 'accent.border', bg],
    [surface, 'active', 'fill', 'ui', 'bg.muted', bg],
    [surface, 'active', 'border', 'border', 'accent.strong', bg],
    [surface, 'focus', 'focus-ring', 'focus', focusRing, bg],
    [surface, 'selected', 'indicator', 'ui', 'accent.strong', bg],
    [surface, 'selected', 'label', 'body', 'fg.onAccent', 'accent.strong'],
    [surface, 'disabled', 'label', 'body', 'fg.subtle', bg],
  );
}

// ── Text + structural surfaces ────────────────────────────────────────────────
addSurface('canvas', 'bg.canvas');
addSurface('surface', 'bg.surface');
addSurface('subtle', 'bg.subtle', 'accent.strong');
addSurface('overlay', 'overlay.scrim');
addSurface('nav', 'bg.subtle', 'accent.strong');
addSurface('input', 'bg.surface');
addSurface('card', 'bg.surface');
addSurface('pill', 'bg.hover');
addSurface('badge', 'bg.hover');

// ── Control surfaces ──────────────────────────────────────────────────────────
addSurface('control-outline', 'bg.surface');
addSurface('select', 'bg.surface');
addSurface('radio-card', 'bg.surface');

// ── Accent-filled control (label on the accent fill) ─────────────────────────
seeds.push(
  ['control-solid', 'default', 'label', 'body', 'fg.onAccent', 'accent.solid'],
  ['control-solid', 'hover', 'label', 'body', 'fg.onAccent', 'accent.solid'],
  ['control-solid', 'active', 'label', 'body', 'fg.onAccent', 'accent.strong'],
  ['control-solid', 'focus', 'focus-ring', 'focus', 'accent.focusRing', 'accent.solid'],
  ['control-solid', 'selected', 'label', 'body', 'fg.onAccent', 'accent.strong'],
  ['control-solid', 'disabled', 'label', 'body', 'fg.onAccent', 'accent.solid'],
);

// ── Surface-specific extras (status/accent pills, selected control labels) ────
seeds.push(
  ['badge', 'default', 'status-label', 'body', 'status.onSolids', 'status.success', true],
  ['badge', 'default', 'status-warning-label', 'body', 'status.onSolids', 'status.warning', true],
  ['badge', 'default', 'status-error-label', 'body', 'status.onSolids', 'status.error', true],
  ['badge', 'default', 'status-info-label', 'body', 'status.onSolids', 'status.info', true],
  ['pill', 'default', 'accent-label', 'body', 'fg.onAccent', 'accent.solid'],
  ['control-outline', 'selected', 'label', 'body', 'fg.onAccent', 'accent.strong'],
  ['select', 'selected', 'label', 'body', 'fg.onAccent', 'accent.strong'],
  ['radio-card', 'selected', 'label', 'body', 'fg.onAccent', 'accent.strong'],
);

/** `kind` → absolute floor (body 4.5; large/ui/border/focus 3). */
function floorFor(kind: ContrastKind): number {
  return kind === 'body' ? BODY_FLOOR : UI_FLOOR;
}

/**
 * The AC1 completeness enumeration (superset of the gate's current 7×5).
 * Every `SURFACE_IDS` × `CONTROL_STATE_IDS` cell is represented; `fg`/`bg` are
 * token names resolved via `SEMANTIC_TOKENS` (`./tokens`), never literals.
 */
export const CONTRACT_PAIRS: readonly ContractPair[] = seeds.map(
  ([surface, state, pairId, kind, fg, bg, composed]) => ({
    surface,
    state,
    pairId,
    kind,
    floor: floorFor(kind),
    composed: composed ?? false,
    fg,
    bg,
  }),
);
