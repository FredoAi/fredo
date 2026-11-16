/**
 * Theme contract — the named data/art palette allowlist (Spec #3034 ST-1).
 *
 * The ONLY permanent permit for a raw hex/rgba literal, for **non-UI data/art
 * palettes only** (UI/UX policy): colours painted into a canvas/WebGL context, a
 * terminal renderer's own ANSI palette, node identity hues explicitly declared
 * token-equivalent, or test fixtures that assert parser/scanner behaviour.
 *
 * Anti-widening (binding): an entry is **literal-pinned, not file-scoped** — a
 * hit is permitted IFF an entry has `entry.file === hit.file` (exact POSIX
 * relative path, NO glob/regex) AND `entry.literals.includes(hit.literal)`.
 * Listing a file therefore does NOT license a literal added to that file later.
 *
 * Byte-identical to the merged gate's `theme/contrast/rawColorAllowlist.ts:31-66`
 * (#3033 ST-4); ST-3 makes the gate re-export THIS copy so there is exactly one
 * source. UI-chrome files are NEVER allowlistable.
 */

/** One literal-pinned data/art palette permit. */
export interface ArtPaletteAllowlistEntry {
  /** POSIX-relative path from the repo root; exact match, no glob. */
  readonly file: string;
  /** The non-UI-chrome palette class this file's literals belong to. */
  readonly kind: 'terminal-ansi' | 'canvas-3d' | 'node-identity' | 'test-fixture';
  /** EXACT `normalizeRawLiteral`-normalised literals permitted in THIS file. */
  readonly literals: readonly string[];
  /** Issue reference recording the reviewed allowlisting edit. */
  readonly since: string;
}

/** The named data/art allowlist — the ONLY permanent raw-color permit. */
export const ART_PALETTE_ALLOWLIST: readonly ArtPaletteAllowlistEntry[] = [
  {
    // Canvas-owned art palette: the Three.js manifold legend/sprite identity
    // hues (`:542-553`) and the `#000` viewport (`:562`) — the enumerated
    // literal set settled in the plan. The DOM caption `rgba(255,255,255,0.25)`
    // (`:579`) and every DOM mode-chip literal in the same file are deliberately
    // NOT pinned, so adding/keeping DOM chrome here is still reported
    // (#3034/#3035). The manifest pins exactly these literals — no file scope.
    file: 'apps/ui/src/applications/dev-mode/components/SpatiotemporalManifold.tsx',
    kind: 'canvas-3d',
    literals: ['#000', '#04a5ec', '#22c55e', '#3b82f6', '#9333f2', '#ef4444', '#f59e0b'],
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
