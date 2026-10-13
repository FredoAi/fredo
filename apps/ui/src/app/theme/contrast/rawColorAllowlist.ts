/**
 * Spec #3033 ST-4 — literal-pinned raw-colour allowlist (AC3 / R-3).
 *
 * The allowlist is for **non-UI data/art palettes only** (UI/UX policy): colours
 * painted into a canvas/WebGL context, a terminal renderer's ANSI palette, node
 * identity hues explicitly declared token-equivalent, or test fixtures that
 * assert parser/scanner behaviour.
 *
 * Anti-widening (binding): an entry is **literal-pinned, not file-scoped**. A
 * hit is allowed IFF an entry has `entry.file === hit.file` (exact POSIX
 * relative path, NO glob/regex matching) AND `entry.literals.includes(hit.literal)`
 * (the `normalizeRawLiteral`-normalised token). Listing a file therefore does
 * NOT license a literal added to that file later.
 *
 * UI-chrome files are NEVER allowlistable — e.g. `dev-mode/components/DevMode.tsx`,
 * `optimizely/components/OptimizelyFlagsPanel.tsx`,
 * `diagram/components/NodeContextMenu.tsx`, `mission-monitor/components/FocusWindow.tsx`.
 * Their literals are reported and owned by the token/defect sweep (#3034/#3035).
 */

export interface RawColorAllowlistEntry {
  /** POSIX-relative path from the repo root; exact match, no glob. */
  readonly file: string;
  readonly kind: 'terminal-ansi' | 'canvas-3d' | 'node-identity' | 'test-fixture';
  /** EXACT `normalizeRawLiteral`-normalised literals permitted in THIS file. */
  readonly literals: readonly string[];
  /** Issue reference recording the reviewed allowlisting edit. */
  readonly since: string;
}

export const RAW_COLOR_ALLOWLIST: readonly RawColorAllowlistEntry[] = [
  {
    // Canvas-owned art palette: the Three.js legend/sprite identity hues and the
    // `#000` viewport, plus the in-canvas sprite gradient/glyph colours (all
    // painted into the Three canvas — never DOM chrome). The DOM caption
    // `rgba(255,255,255,0.25)` and the mode-chip colours are deliberately NOT
    // pinned here so they are reported for tokenisation (#3034/#3035).
    file: 'apps/ui/src/applications/dev-mode/components/SpatiotemporalManifold.tsx',
    kind: 'canvas-3d',
    literals: [
      '#000',
      '#04a5ec',
      '#22c55e',
      '#3b82f6',
      '#9333f2',
      '#ef4444',
      '#f59e0b',
      'rgba(255,255,255,0.95)',
      'rgba(255,255,255,0.28)',
      'rgba(255,255,255,0.0)',
      'rgba(255,255,255,1)',
    ],
    since: '#3033',
  },
  {
    // The Ghostty terminal renderer's own data palette (ghostty-web owns the
    // canvas colours; the window chrome reads Fredo theme tokens). Consumed by
    // the terminal renderer only — a status badge that merely looks like a
    // terminal colour does not qualify.
    file: 'apps/ui/src/applications/terminal/components/SessionTerminal.tsx',
    kind: 'terminal-ansi',
    literals: [
      '#0d0d0d',
      '#4ec9b0',
      '#569cd6',
      '#808080',
      '#9cdcfe',
      '#c586c0',
      '#d4d4d4',
      '#dcdcaa',
      '#e0e0e0',
      '#f44747',
      '#ffffff',
    ],
    since: '#3033',
  },
];
