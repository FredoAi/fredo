/**
 * Mission Monitor — CLI identity chip (Spec #2945 ST-3).
 *
 * A single non-interactive, purely presentational component renders the CLI
 * identity of a session on BOTH surfaces (the session-list row and the selected
 * session's header), so the mapping and the theming can never drift between
 * them (AC2 / AC5 / REQ-2, REQ-3, REQ-7).
 *
 * Identity is conveyed through FOUR channels, never colour alone:
 *   - the visible uppercase display label (`Unknown CLI` fallback included),
 *   - a leading `aria-hidden` glyph,
 *   - `role="img"` + `aria-label` (the accessible name — `CLI: <name>`, or the
 *     literal `CLI unknown` for the fallback),
 *   - `title` (the same text, for hover).
 *
 * Colours come EXCLUSIVELY from theming-feature semantic tokens
 * (`--text-primary`, `--accent-primary`, `--accent-secondary`,
 * `--border-color`, `--status-warning`, `--card-hover-bg`); translucent fills
 * go through the shared `tint()` helper (`color-mix`) — never `var(--x)NN`
 * alpha-append, which is invalid CSS (#2770 round 5). Zero hardcoded colour.
 *
 * The chip is a plain `<span>` with no click handler: a click bubbles to the
 * row and selects the session (existing row behavior preserved), and the chip
 * is never focusable so the focus order is unchanged.
 */
import React from 'react';
import { resolveCliLabel } from '../lib/cliLabel';
import { tint } from '../../../shared/utils/colorTint';

export interface CliLabelProps {
  /** Canonical provider token; `null`/absent/unknown → the explicit fallback. */
  provider: string | null;
  /** Which surface the chip renders on (selects the default `data-testid`). */
  variant: 'row' | 'header';
  /** DOM `id` — lets the row reference the chip via `aria-describedby`. */
  id?: string;
  /** Override the variant-default testid. */
  'data-testid'?: string;
}

/** Hue token for each known provider; `null` = neutral pill (claude_code/internal). */
function hueFor(provider: string | null | undefined): string | null {
  switch (provider) {
    case 'open_code':
      return 'var(--accent-primary)';
    case 'copilot_cli':
      return 'var(--accent-secondary)';
    case 'claude_code':
    case 'internal':
      return null;
    default:
      return null;
  }
}

export const CliLabel: React.FC<CliLabelProps> = ({
  provider,
  variant,
  id,
  'data-testid': dataTestId,
}) => {
  const { displayLabel, longName, glyph, isUnknown } = resolveCliLabel(provider);

  // The accessible name is `CLI: <name>` for a recognized provider; for the
  // fallback, `longName` is already the complete `CLI unknown` (QA-4).
  const accessibleName = isUnknown ? longName : `CLI: ${longName}`;

  // `data-provider` exposes the RAW token for test/debug only (the unrecognized
  // string is never rendered as visible text).
  const providerToken =
    typeof provider === 'string' && provider.trim().length > 0 ? provider : 'unknown';

  const hue = isUnknown ? null : hueFor(provider);

  const chipStyle: React.CSSProperties = isUnknown
    ? {
        color: 'var(--status-warning)',
        background: tint('var(--status-warning)', 14),
        border: '1px dashed var(--status-warning)',
      }
    : hue === null
      ? {
          // Neutral pill (claude_code / internal): the card-hover surface with a
          // solid border so it stays legible on the row hover/selected tints.
          color: 'var(--text-primary)',
          background: 'var(--card-hover-bg)',
          border: '1px solid var(--border-color)',
        }
      : {
          // Accent chip (open_code = accent-primary, copilot_cli = accent-secondary):
          // translucent fill + a stronger-tinted solid border via `tint()`.
          color: 'var(--text-primary)',
          background: tint(hue, 18),
          border: `1px solid ${tint(hue, 55)}`,
        };

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    borderRadius: 3,
    padding: '1px 5px',
    whiteSpace: 'nowrap',
    lineHeight: 1.4,
    flexShrink: 0,
  };

  return (
    <span
      id={id}
      data-testid={dataTestId ?? (variant === 'header' ? 'mm-selected-cli-label' : 'mm-session-cli-label')}
      data-provider={providerToken}
      data-cli-unknown={isUnknown ? 'true' : 'false'}
      role="img"
      aria-label={accessibleName}
      title={accessibleName}
      style={{ ...baseStyle, ...chipStyle }}
    >
      <span aria-hidden>{glyph}</span>
      {displayLabel}
    </span>
  );
};
