/**
 * @fredo/theme — generated. Do not edit by hand:
 *   node packages/fredo-theme/scripts/build-theme.mjs
 *
 * A NAME contract, not a value source: the host writes every token value onto your document's documentElement, and this package only names those values. Every entry's `value` is a var() reference or a color-mix() whose operands are var()s — the package contains no colour literal and cannot become a second source of colour.
 *
 * The consumption route is VENDORING: copy this file (and `theme.css`) into your
 * package as `vendor/fredo-theme/` and import it RELATIVELY
 * (`import { cssVar } from './vendor/fredo-theme/index.mjs'`). A bare
 * `@fredo/theme` specifier never resolves in an installed application's document —
 * there is no bundler and no import map — and the host's serve whitelist is the
 * install record, so a file outside the package has no route.
 */

/** The 38 published token names, in contract order. */
export const SEMANTIC_TOKENS = Object.freeze([
  {
    "name": "bg.canvas",
    "varName": "--body-bg",
    "class": "A",
    "authored": true,
    "value": "var(--body-bg)"
  },
  {
    "name": "bg.surface",
    "varName": "--card-bg",
    "class": "A",
    "authored": true,
    "value": "var(--card-bg)"
  },
  {
    "name": "bg.subtle",
    "varName": "--header-bg",
    "class": "A",
    "authored": true,
    "value": "var(--header-bg)"
  },
  {
    "name": "bg.muted",
    "varName": "--card-hover-bg",
    "class": "A",
    "authored": true,
    "value": "var(--card-hover-bg)"
  },
  {
    "name": "bg.hover",
    "varName": "--hover-bg",
    "class": "D",
    "authored": false,
    "value": "var(--hover-bg)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--text-primary"
      ],
      "weights": [
        0.06
      ]
    }
  },
  {
    "name": "fg.default",
    "varName": "--text-primary",
    "class": "A",
    "authored": true,
    "value": "var(--text-primary)"
  },
  {
    "name": "fg.muted",
    "varName": "--text-secondary",
    "class": "A",
    "authored": true,
    "value": "var(--text-secondary)"
  },
  {
    "name": "fg.subtle",
    "varName": "--text-subtle",
    "class": "D",
    "authored": false,
    "value": "var(--text-subtle)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--text-secondary",
        "--text-primary"
      ],
      "weights": [
        0.55,
        0.45
      ]
    }
  },
  {
    "name": "fg.onAccent",
    "varName": "--accent-contrast",
    "class": "D",
    "authored": false,
    "value": "var(--accent-contrast)",
    "derivation": {
      "fn": "wcag-max-contrast",
      "sources": [
        "--accent-primary"
      ]
    }
  },
  {
    "name": "border.default",
    "varName": "--border-strong",
    "class": "D",
    "authored": false,
    "value": "var(--border-strong)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--text-subtle",
        "--border-color"
      ],
      "weights": [
        0.75,
        0.25
      ]
    }
  },
  {
    "name": "border.subtle",
    "varName": "--border-color",
    "class": "A",
    "authored": true,
    "value": "var(--border-color)"
  },
  {
    "name": "overlay.scrim",
    "varName": "--overlay-bg",
    "class": "A",
    "authored": true,
    "value": "var(--overlay-bg)"
  },
  {
    "name": "accent.default",
    "varName": "--accent-primary",
    "class": "A",
    "authored": true,
    "value": "var(--accent-primary)"
  },
  {
    "name": "accent.emphasized",
    "varName": "--accent-secondary",
    "class": "A",
    "authored": true,
    "value": "var(--accent-secondary)"
  },
  {
    "name": "accent.strong",
    "varName": "--accent-strong",
    "class": "D",
    "authored": false,
    "value": "var(--accent-strong)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--accent-primary",
        "--text-primary"
      ],
      "weights": [
        0.55,
        0.45
      ]
    }
  },
  {
    "name": "accent.solid",
    "varName": "--accent-primary",
    "class": "A",
    "authored": true,
    "value": "var(--accent-primary)"
  },
  {
    "name": "accent.contrast",
    "varName": "--accent-contrast",
    "class": "D",
    "authored": false,
    "value": "var(--accent-contrast)",
    "derivation": {
      "fn": "wcag-max-contrast",
      "sources": [
        "--accent-primary"
      ]
    }
  },
  {
    "name": "accent.fg",
    "varName": "--accent-primary",
    "class": "A",
    "authored": true,
    "value": "var(--accent-primary)"
  },
  {
    "name": "accent.subtle",
    "varName": "--accent-primary",
    "class": "N",
    "authored": false,
    "value": "color-mix(in srgb, var(--accent-primary) 8%, transparent)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--accent-primary"
      ],
      "weights": [
        0.08
      ]
    }
  },
  {
    "name": "accent.muted",
    "varName": "--accent-primary",
    "class": "N",
    "authored": false,
    "value": "color-mix(in srgb, var(--accent-primary) 15%, transparent)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--accent-primary"
      ],
      "weights": [
        0.15
      ]
    }
  },
  {
    "name": "accent.focusRing",
    "varName": "--accent-strong",
    "class": "D",
    "authored": false,
    "value": "var(--accent-strong)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--accent-primary",
        "--text-primary"
      ],
      "weights": [
        0.55,
        0.45
      ]
    }
  },
  {
    "name": "accent.border",
    "varName": "--accent-strong",
    "class": "D",
    "authored": false,
    "value": "var(--accent-strong)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--accent-primary",
        "--text-primary"
      ],
      "weights": [
        0.55,
        0.45
      ]
    }
  },
  {
    "name": "accent.subagent",
    "varName": "--accent-subagent",
    "class": "A",
    "authored": true,
    "value": "var(--accent-subagent)"
  },
  {
    "name": "accent.nestedSubagent",
    "varName": "--accent-nested-subagent",
    "class": "A",
    "authored": true,
    "value": "var(--accent-nested-subagent)"
  },
  {
    "name": "accent.tint",
    "varName": "--accent-primary",
    "class": "N",
    "authored": false,
    "value": "color-mix(in srgb, var(--accent-primary) 10%, var(--body-bg) 90%)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--accent-primary",
        "--body-bg"
      ],
      "weights": [
        0.1,
        0.9
      ]
    }
  },
  {
    "name": "avatar.interior",
    "varName": "--fredo-avatar-interior",
    "class": "D",
    "authored": false,
    "value": "var(--fredo-avatar-interior)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--accent-primary",
        "--body-bg"
      ],
      "weights": [
        0.2
      ]
    }
  },
  {
    "name": "status.success",
    "varName": "--status-success",
    "class": "A",
    "authored": true,
    "value": "var(--status-success)"
  },
  {
    "name": "status.warning",
    "varName": "--status-warning",
    "class": "A",
    "authored": true,
    "value": "var(--status-warning)"
  },
  {
    "name": "status.error",
    "varName": "--status-error",
    "class": "A",
    "authored": true,
    "value": "var(--status-error)"
  },
  {
    "name": "status.info",
    "varName": "--status-info",
    "class": "A",
    "authored": true,
    "value": "var(--status-info)"
  },
  {
    "name": "status.onSolids",
    "varName": "--status-on-solids",
    "class": "D",
    "authored": false,
    "value": "var(--status-on-solids)",
    "derivation": {
      "fn": "wcag-max-contrast",
      "sources": [
        "--status-success",
        "--status-warning",
        "--status-error",
        "--status-info"
      ]
    }
  },
  {
    "name": "status.errorTint",
    "varName": "--status-error",
    "class": "N",
    "authored": false,
    "value": "color-mix(in srgb, var(--status-error) 15%, var(--body-bg) 85%)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--status-error",
        "--body-bg"
      ],
      "weights": [
        0.15,
        0.85
      ]
    }
  },
  {
    "name": "status.errorStrong",
    "varName": "--status-error",
    "class": "N",
    "authored": false,
    "value": "color-mix(in srgb, var(--status-error) 50%, var(--text-primary) 50%)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--status-error",
        "--text-primary"
      ],
      "weights": [
        0.5,
        0.5
      ]
    }
  },
  {
    "name": "scrollbar.thumb",
    "varName": "--scrollbar-thumb",
    "class": "D",
    "authored": false,
    "value": "var(--scrollbar-thumb)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--text-secondary"
      ],
      "weights": [
        0.45
      ]
    }
  },
  {
    "name": "scrollbar.thumbHover",
    "varName": "--scrollbar-thumb-hover",
    "class": "D",
    "authored": false,
    "value": "var(--scrollbar-thumb-hover)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--text-secondary"
      ],
      "weights": [
        0.7
      ]
    }
  },
  {
    "name": "life.neutral",
    "varName": "--life-neutral",
    "class": "D",
    "authored": false,
    "value": "var(--life-neutral)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--text-primary",
        "--body-bg"
      ],
      "weights": [
        0.7,
        0.3
      ]
    }
  },
  {
    "name": "life.cell",
    "varName": "--life-cell",
    "class": "D",
    "authored": false,
    "value": "var(--life-cell)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--accent-strong",
        "--life-neutral"
      ],
      "weights": [
        0.65,
        0.35
      ]
    }
  },
  {
    "name": "life.dim",
    "varName": "--life-dim",
    "class": "D",
    "authored": false,
    "value": "var(--life-dim)",
    "derivation": {
      "fn": "color-mix",
      "sources": [
        "--overlay-bg"
      ],
      "weights": [
        0.12
      ]
    }
  }
]);

/** The same tokens, keyed by published name. */
export const tokensByName = Object.freeze(
  Object.fromEntries(SEMANTIC_TOKENS.map((token) => [token.name, token])),
);

/** The readable-but-unpublished custom properties — a promise of privacy. */
export const THEME_EXCLUSIONS = Object.freeze([
  {
    "varName": "--footer-bg",
    "reason": "host chrome; readable but not a published token"
  },
  {
    "varName": "--gradient-text",
    "reason": "host chrome; readable but not a published token"
  },
  {
    "varName": "--gradient-button",
    "reason": "host chrome; readable but not a published token"
  },
  {
    "varName": "--node-bg",
    "reason": "Mission Monitor art; readable but not a published token"
  },
  {
    "varName": "--node-box-shadow",
    "reason": "Mission Monitor art; readable but not a published token"
  },
  {
    "varName": "--edge-gradient",
    "reason": "Mission Monitor art; readable but not a published token"
  },
  {
    "varName": "--shadow-dialog",
    "reason": "host elevation; readable but not a published token"
  },
  {
    "varName": "--font-family",
    "reason": "host typography; readable but not a published token"
  },
  {
    "varName": "--font-mono",
    "reason": "NEVER written by the host — only PANEL_CSS reads it with a fallback (scheme.rs:420); naming it as a token would be false at every theme"
  }
]);

/** The generated stylesheet (the same text as `theme.css`). */
export const THEME_STYLESHEET = "/*\n * @fredo/theme — generated. Do not edit by hand:\n *   node packages/fredo-theme/scripts/build-theme.mjs\n *\n * The host writes every token VALUE into your document’s documentElement before\n * your code runs, so this stylesheet never supplies a colour. It (1) declares the\n * five published alias NAMES as custom properties computed from the host’s own\n * vars, and (2) offers the zero-colour panel recipe built only from published\n * token names. Including it is an ergonomic choice, never a source of values.\n *\n * Do NOT redefine a published token on :root or body: the host pushes a resolved\n * token stream, so redefining one leaves its derived neighbours stale.\n */\n\n:root {\n  --fredo-alias-accent-subtle: color-mix(in srgb, var(--accent-primary) 8%, transparent);\n  --fredo-alias-accent-muted: color-mix(in srgb, var(--accent-primary) 15%, transparent);\n  --fredo-alias-accent-tint: color-mix(in srgb, var(--accent-primary) 10%, var(--body-bg) 90%);\n  --fredo-alias-status-errortint: color-mix(in srgb, var(--status-error) 15%, var(--body-bg) 85%);\n  --fredo-alias-status-errorstrong: color-mix(in srgb, var(--status-error) 50%, var(--text-primary) 50%);\n}\n\n/* The zero-colour panel recipe (UI/UX §1) — published token names only. */\n.fredo-theme-panel {\n  background: var(--body-bg);\n  color: var(--text-primary);\n}\n.fredo-theme-panel__surface {\n  background: var(--card-bg);\n  border: 1px solid var(--border-strong);\n}\n.fredo-theme-panel__text {\n  color: var(--text-primary);\n}\n.fredo-theme-panel__muted {\n  color: var(--text-secondary);\n}\n.fredo-theme-panel__focus:focus-visible {\n  outline: 2px solid var(--accent-strong);\n  outline-offset: 2px;\n}\n.fredo-theme-panel__accent {\n  background: var(--accent-primary);\n  color: var(--accent-contrast);\n}\n.fredo-theme-panel__tint {\n  background: var(--fredo-alias-accent-subtle);\n}\n.fredo-theme-panel__disabled {\n  color: var(--text-subtle);\n  border-color: var(--border-color);\n}\n";

/** Every published name. */
export const TOKEN_NAMES = Object.freeze(SEMANTIC_TOKENS.map((token) => token.name));

/**
 * Resolve a published token to the CSS form you should write.
 *
 * - a published NAME ('bg.surface') → `var(--card-bg)`, or — for one of the five
 *   NAME-ONLY aliases (`accent.subtle`, `accent.muted`, `accent.tint`,
 *   `status.errorTint`, `status.errorStrong`) — the published `color-mix()`
 *   expression, never a bare `var()`;
 * - a custom property ('--card-bg') → `var(--card-bg)`, so a host-written var that
 *   is not one of the published names still composes.
 *
 * An unknown name THROWS: silently returning something for a typo is how an
 * author ships a colour the contract never promised.
 *
 * @param {string} name a published token name, or a `--custom-property`
 * @returns {string}
 */
export function cssVar(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('cssVar(name) needs a token name such as "bg.surface" or a var such as "--card-bg"');
  }
  if (name.startsWith('--')) {
    return `var(${name})`;
  }
  const token = tokensByName[name];
  if (token === undefined) {
    throw new RangeError(
      `"${name}" is not one of the published theme tokens. The published names are: ` +
        TOKEN_NAMES.join(', ') +
        ' — see tokens.json for the full contract.',
    );
  }
  return token.value;
}
