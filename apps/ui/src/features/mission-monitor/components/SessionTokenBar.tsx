import React from 'react';
import { formatTokenCount } from '../lib/graph';

/**
 * SessionTokenBar — Spec #2717 (R-1) session token totals bottom bar.
 *
 * Pure presentational component: five labeled figures in fixed order
 * Input / Cache / Reasoning / Output / Total for the SELECTED session's
 * aggregate token consumption. The parent (MissionMonitorPanel) computes the
 * totals via `computeSessionTokenTotals(mergedDeliveries, selectedSessionId)`
 * and passes them in — this component has no hooks, no state, no click
 * handlers.
 *
 * - Byte-identical full labels on both surfaces (Architect binding G-023) —
 *   no abbreviation layer.
 * - Comma formatting via `formatTokenCount` (R-3.4): < 1,000 → raw, ≥ 1,000 →
 *   en-US thousands separators.
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

const CATEGORY_LABELS = ['Input', 'Cache', 'Reasoning', 'Output'] as const;

export const SessionTokenBar: React.FC<SessionTokenBarProps> = ({
  promptTokens,
  cacheReadTokens,
  reasoningTokens,
  completionTokens,
  totalTokens,
}) => {
  const values: Record<(typeof CATEGORY_LABELS)[number], number> = {
    Input: promptTokens,
    Cache: cacheReadTokens,
    Reasoning: reasoningTokens,
    Output: completionTokens,
  };

  return (
    <div
      data-testid="session-token-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '16px',
        padding: '6px 14px',
        background: 'var(--header-bg)',
        borderTop: '1px solid var(--border-color)',
        flexShrink: 0,
      }}
    >
      {CATEGORY_LABELS.map((label) => {
        const value = values[label];
        const formatted = formatTokenCount(value);
        return (
          <span
            key={label}
            style={{ display: 'flex', flexDirection: 'column', gap: 1 }}
          >
            <span
              style={{
                fontSize: '9px',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {label}
            </span>
            <span
              aria-label={`${label} tokens: ${formatted}`}
              style={{
                fontSize: '11px',
                color: 'var(--text-primary)',
                fontFamily: "'Cascadia Code', monospace",
              }}
            >
              {formatted}
            </span>
          </span>
        );
      })}

      {/* Total — visually distinct: bold, accent-colored, 1px left separator. */}
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          borderLeft: '1px solid var(--border-color)',
          paddingLeft: '16px',
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
          Total
        </span>
        <span
          aria-label={`Total tokens: ${formatTokenCount(totalTokens)}`}
          style={{
            fontSize: '13px',
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
