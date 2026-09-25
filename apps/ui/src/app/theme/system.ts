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
      outline: '2px solid var(--accent-primary)',
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
      colors: {
        // #2865 R-3.2 — these namespaces MUST be defined in the SAME NESTED shape
        // as Chakra's `defaultConfig` (NOT flat dotted keys). `defaultConfig`
        // declares `bg`/`fg`/`border` as nested objects, which emit dash custom
        // properties (`--chakra-colors-fg-muted`) and WIN the `colors.<path>`
        // resolution; the same names as flat dotted keys emit escaped-dot
        // properties (`--chakra-colors-fg\.muted`) that no consumer resolves, so
        // the stock Chakra default survived (fg.muted rendered #52525b, bg.subtle a
        // stock near-white). Nested keys merge over the defaults, so the Fredo vars
        // win for every token-name consumer (F-14/F-15).
        //
        // Backgrounds
        bg: {
          canvas: { value: 'var(--body-bg)' },
          surface: { value: 'var(--card-bg)' },
          subtle: { value: 'var(--header-bg)' },
          muted: { value: 'var(--card-hover-bg)' },
          // #2864 ST-1 (T1): derived row/nav hover fill — `color-mix` from the live
          // text color so it stays legible in light AND dark with no per-preset value.
          hover: { value: 'var(--hover-bg)' },
        },

        // Foreground
        fg: {
          default: { value: 'var(--text-primary)' },
          muted: { value: 'var(--text-secondary)' },
          // #2864 ST-1 (T2): xs help/caption text — derived toward `--text-primary`
          // so 12px help clears WCAG AA on dark surfaces.
          subtle: { value: 'var(--text-subtle)' },
          // #2864 ST-1 (T5): the foreground ON an accent-filled control, computed in
          // ThemeProvider from the RESOLVED accent's WCAG luminance.
          // (nested key emits `--chakra-colors-fg-on-accent`)
          onAccent: { value: 'var(--accent-contrast)' },
        },

        // Borders
        border: {
          default: { value: 'var(--border-color)' },
          subtle: { value: 'var(--border-color)' },
        },

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

        // #2917 ST-1: the FREDO avatar interior fill. An OPAQUE derived token
        // (accent mixed into the opaque body surface) so the figure reads solid
        // instead of hollow; the value is derived live in ThemeProvider.
        'avatar.interior': { value: 'var(--fredo-avatar-interior)' },

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
