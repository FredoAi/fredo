import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

/**
 * Custom Chakra UI system that bridges Fredo CSS variables into Chakra semantic tokens.
 * Components can use `bg="bg.surface"` instead of `bg="var(--card-bg)"` in new code,
 * and Chakra's internal focus-ring / colorPalette tokens pick up the live theme.
 */
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
    'button[data-variant="outline"]': { borderColor: 'var(--border-color)' },
    'button[data-variant="outline"]:hover': { borderColor: 'var(--accent-primary)' },
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
      colors: {
        // Backgrounds
        'bg.canvas': { value: 'var(--body-bg)' },
        'bg.surface': { value: 'var(--card-bg)' },
        'bg.subtle': { value: 'var(--header-bg)' },
        'bg.muted': { value: 'var(--card-hover-bg)' },
        // #2864 ST-1 (T1): derived row/nav hover fill — `color-mix` from the live
        // text color so it stays legible in light AND dark with no per-preset value.
        'bg.hover': { value: 'var(--hover-bg)' },

        // Foreground
        'fg.default': { value: 'var(--text-primary)' },
        'fg.muted': { value: 'var(--text-secondary)' },
        // #2864 ST-1 (T2): xs help/caption text — derived toward `--text-primary`
        // so 12px help clears WCAG AA on dark surfaces.
        'fg.subtle': { value: 'var(--text-subtle)' },
        // #2864 ST-1 (T5): the foreground ON an accent-filled control, computed in
        // ThemeProvider from the RESOLVED accent's WCAG luminance.
        'fg.onAccent': { value: 'var(--accent-contrast)' },

        // Borders
        'border.default': { value: 'var(--border-color)' },
        'border.subtle': { value: 'var(--border-color)' },

        // Overlay
        // #2864 ST-1 (T7): dialog backdrop scrim (base-record only).
        'overlay.scrim': { value: 'var(--overlay-bg)' },

        // Accent — maps to the live accent-primary/secondary CSS vars
        'accent.default': { value: 'var(--accent-primary)' },
        'accent.emphasized': { value: 'var(--accent-secondary)' },
        // #2864 ST-1 (T6): deepened/lightened accent for the active-nav indicator
        // so pale accents still clear 3:1 on the nav surface.
        'accent.strong': { value: 'var(--accent-strong)' },
        // #2864 ST-1: a live-`accent` Chakra colorPalette, so `colorPalette="accent"`
        // resolves to the accent CSS vars instead of a stock Chakra hue (ST-3 swaps
        // the Switch's stock-purple palette for this). Chakra's palette contract keys.
        'accent.solid': { value: 'var(--accent-primary)' },
        'accent.contrast': { value: 'var(--accent-contrast)' },
        'accent.fg': { value: 'var(--accent-primary)' },
        'accent.subtle': { value: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' },
        'accent.muted': { value: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' },
        'accent.focusRing': { value: 'var(--accent-primary)' },
        'accent.border': { value: 'var(--accent-primary)' },
        // #2745 ST-5: the subagent identity accent (--accent-subagent) — a
        // dedicated hue so subagent chrome stays distinguishable from the
        // chat node's --accent-primary working state at a glance.
        'accent.subagent': { value: 'var(--accent-subagent)' },
        // #2770: the nested-subagent identity accent (--accent-nested-subagent)
        // — depth ≥ 2 cards; hue/luminance-distinct from accent.subagent (L1).
        'accent.nestedSubagent': { value: 'var(--accent-nested-subagent)' },

        // Status
        'status.success': { value: 'var(--status-success)' },
        'status.warning': { value: 'var(--status-warning)' },
        'status.error': { value: 'var(--status-error)' },
        'status.info': { value: 'var(--status-info)' },
      },
      shadows: {
        // #2864 ST-1 (T8): dialog elevation shadow (base-record only).
        'shadow.dialog': { value: 'var(--shadow-dialog)' },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
