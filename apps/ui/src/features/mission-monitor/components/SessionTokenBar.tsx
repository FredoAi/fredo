import React from 'react';
import { formatTokenCount } from '../lib/graph';

/**
 * SessionTokenBar — Spec #2723 (R-1) session token totals top strip.
 *
 * Pure presentational component: five figures in fixed order
 * Input / Cache / Reasoning / Output / Total for the SELECTED session's
 * aggregate token consumption. The parent (MissionMonitorPanel) computes the
 * totals via `computeSessionTokenTotals(mergedDeliveries, selectedSessionId)`
 * and passes them in — this component has no hooks, no state, no click
 * handlers.
 *
 * Spec #2723 (R-1) redesign — the bar moved from the bottom of the canvas to a
 * compact strip at the TOP of the main view (below the header, above the
 * canvas):
 * - Single horizontal row, right-aligned (`justify-content: flex-end`).
 * - Abbreviated display labels (`In:`/`Ca:`/`Re:`/`Ou:`/`Σ`) — full labels
 *   preserved in every value's `aria-label` (accessibility, Q-2.1 pattern).
 * - Values byte-identical to the #2717 figure set — same five categories,
 *   same comma formatting via `formatTokenCount`, zero/absent categories
 *   render as `0` (never dropped, never NaN).
 * - Height budget ~23px (4px + 14px content + 4px + 1px border) vs ~48px.
 * - `cacheWriteTokens` is never passed here: the "Cache" category = cacheRead
 *   only (G-023), and Total = Input + Cache + Reasoning + Output (R-3.1).
 * - Theme tokens only — every color resolves through `var(--*)` so the bar
 *   follows the user's light/dark/accent theme.
 */
interface SessionTokenBarProps {
  /** Per-turn Δinput summed across the session's composite keys (R-3.2). */
  promptTokens: number;
  /** cacheRead per key summed — the "Cache" category (cacheWrite never shown). */
  cacheReadTokens: number;
  /** reasoning output per key summed. */
  reasoningTokens: number;
  /** completion output per key summed. */
  completionTokens: number;
  /** promptTokens + cacheReadTokens + reasoningTokens + completionTokens (R-3.1). */
  totalTokens: number;
}

/** Fixed order — display abbreviation + full label for the aria-label. */
const CATEGORIES = [
  { full: 'Input', abbr: 'In:' },
  { full: 'Cache', abbr: 'Ca:' },
  { full: 'Reasoning', abbr: 'Re:' },
  { full: 'Output', abbr: 'Ou:' },
] as const;

export const SessionTokenBar: React.FC<SessionTokenBarProps> = ({
  promptTokens,
  cacheReadTokens,
  reasoningTokens,
  completionTokens,
  totalTokens,
}) => {
  const values: Record<(typeof CATEGORIES)[number]['full'], number> = {
    Input: promptTokens,
    Cache: cacheReadTokens,
    Reasoning: reasoningTokens,
    Output: completionTokens,
  };

  return (
    <div
      data-testid="session-token-bar"
      role="group"
      aria-label="Session token breakdown"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '12px',
        padding: '4px 14px',
        background: 'var(--header-bg)',
        borderBottom: '1px solid var(--border-color)',
        flexShrink: 0,
      }}
    >
      {CATEGORIES.map(({ full, abbr }) => {
        const formatted = formatTokenCount(values[full]);
        return (
          <span
            key={full}
            style={{ display: 'inline-flex', alignItems: 'baseline', gap: '4px' }}
          >
            <span
              style={{
                fontSize: '9px',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {abbr}
            </span>
            <span
              aria-label={`${full} tokens: ${formatted}`}
              style={{
                fontSize: '9px',
                color: 'var(--text-primary)',
                fontFamily: "'Cascadia Code', monospace",
              }}
            >
              {formatted}
            </span>
          </span>
        );
      })}

      {/* Total — bold, accent-colored, 1px left border separator. */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: '4px',
          borderLeft: '1px solid var(--border-color)',
          paddingLeft: '12px',
        }}
      >
        <span
          style={{
            fontSize: '9px',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Σ
        </span>
        <span
          aria-label={`Total tokens: ${formatTokenCount(totalTokens)}`}
          style={{
            fontSize: '11px',
            fontWeight: 700,
            color: 'var(--accent-primary)',
            fontFamily: "'Cascadia Code', monospace",
          }}
        >
          {formatTokenCount(totalTokens)}
        </span>
      </span>
    </div>
  );
};
