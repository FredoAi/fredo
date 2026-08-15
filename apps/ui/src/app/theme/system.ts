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

        // Foreground
        'fg.default': { value: 'var(--text-primary)' },
        'fg.muted': { value: 'var(--text-secondary)' },

        // Borders
        'border.default': { value: 'var(--border-color)' },
        'border.subtle': { value: 'var(--border-color)' },

        // Accent — maps to the live accent-primary/secondary CSS vars
        'accent.default': { value: 'var(--accent-primary)' },
        'accent.emphasized': { value: 'var(--accent-secondary)' },
        // #2745 ST-5: the subagent identity accent (--accent-subagent) — a
        // dedicated hue so subagent chrome stays distinguishable from the
        // chat node's --accent-primary working state at a glance.
        'accent.subagent': { value: 'var(--accent-subagent)' },

        // Status
        'status.success': { value: 'var(--status-success)' },
        'status.warning': { value: 'var(--status-warning)' },
        'status.error': { value: 'var(--status-error)' },
        'status.info': { value: 'var(--status-info)' },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
