import React from 'react';
import { formatTokenCount } from '../lib/graph';

/**
 * SessionTokenBar — session "Total Top Bar" (Spec #2723 R-1, #2743 ST-3).
 *
 * Pure presentational component: figures in fixed order
 * Input / Cache / Reasoning / Output / Subagents / Total for the SELECTED
 * session's aggregate token consumption, plus the session's ESTIMATED COST
 * and TOTAL MESSAGES (#2743 ST-1 / AC-12). The parent (MissionMonitorPanel)
 * computes everything via `computeSessionMetrics(mergedDeliveries,
 * selectedSessionId)` and passes the figures in — this component has no
 * hooks, no state, no click handlers, and performs no metrics computation.
 *
 * Spec #2723 (R-1) redesign — the bar moved from the bottom of the canvas to a
 * compact strip at the TOP of the main view (below the header, above the
 * canvas). #2743 (ST-3 / AC-2/3/4/12) redesign:
 * - Full display labels INPUT / CACHE / REASONING / OUTPUT / TOTAL — no
 *   abbreviated labels anywhere on the bar (AC-3).
 * - Left title "Session Token Usage" + figures right (`justify-content:
 *   space-between` — AC-4), with the figure group hugging the right edge.
 * - ESTIMATED COST (`totalCostUsd`) and TOTAL MESSAGES (`totalMessages`)
 *   figures derived frontend-side from the same chat-node deliveries the
 *   token figures consume (ST-1 session-totals decision — never a hardcoded
 *   figure; a delivered $0.00 renders `$0.0000`).
 * - Values comma-formatted via `formatTokenCount` (byte-identical to the
 *   #2717 figure set — zero/absent categories render as `0`, never dropped);
 *   full label names preserved in every value's `aria-label`.
 * - #2748 ST-5 / AC3: a SUBAGENTS figure (parent's subagent token totals,
 *   fed as `subagentTokens`) joins between OUTPUT and TOTAL, styled like the
 *   token categories but with a left border separator and the subagent accent
 *   label (`var(--accent-subagent)`); TOTAL becomes parent five-way +
 *   SUBAGENTS ("Total tokens (parent + subagents): X" in `aria-label`/`title`).
 *   INPUT/CACHE/REASONING/OUTPUT stay parent-only (R-3.3). Pure prop contract:
 *   `totalTokens` is the parent five-way total and MUST NOT include subagent
 *   tokens — this component combines `totalTokens + subagentTokens` only for
 *   the TOTAL headline display (R-3.2); it never derives a figure itself.
 * - Height budget ~23px (4px + 14px content + 4px + 1px border) vs ~48px.
 * - `cacheWriteTokens` is never passed here: the "Cache" category = cacheRead
 *   only (G-023). The parent five-way Total = Input + Cache + Reasoning +
 *   Output (R-3.1); the displayed TOTAL = that five-way + SUBAGENTS (R-3.2).
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
  /**
   * Parent five-way total — promptTokens + cacheReadTokens + reasoningTokens +
   * completionTokens (R-3.1). MUST NOT include subagent tokens: the TOTAL
   * headline renders `totalTokens + subagentTokens` (R-3.2), so feeding a
   * pre-summed value here would double-count the SUBAGENTS figure.
   */
  totalTokens: number;
  /**
   * Σ subagent token totals for the selected session (#2748 ST-5, R-3.2) —
   * the SUBAGENTS figure. The parent computes it via ST-1
   * `computeSubagentTokenTotals` and passes it in; 0/absent renders `0`
   * (a session with no subagents shows SUBAGENTS `0`, never NaN). Parent-only
   * INPUT/CACHE/REASONING/OUTPUT never include this figure (R-3.3).
   */
  subagentTokens?: number;
  /** Σ normalizeCost(p.cost_usd) over last-wins chat keys (ST-1 / AC-12). */
  estimatedCost?: number;
  /** Count of distinct last-wins chat keys — TOTAL MESSAGES (ST-1 / AC-12). */
  totalMessages?: number;
}

/** Fixed order — display label + full label for the aria-label (AC-3). */
const CATEGORIES = [
  { full: 'Input', abbr: 'INPUT' },
  { full: 'Cache', abbr: 'CACHE' },
  { full: 'Reasoning', abbr: 'REASONING' },
  { full: 'Output', abbr: 'OUTPUT' },
] as const;

/** Cost figure formatting — byte-identical to the ChatNode cost row (ST-2). */
function formatCostUsd(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

export const SessionTokenBar: React.FC<SessionTokenBarProps> = ({
  promptTokens,
  cacheReadTokens,
  reasoningTokens,
  completionTokens,
  totalTokens,
  subagentTokens,
  estimatedCost,
  totalMessages,
}) => {
  const values: Record<(typeof CATEGORIES)[number]['full'], number> = {
    Input: promptTokens,
    Cache: cacheReadTokens,
    Reasoning: reasoningTokens,
    Output: completionTokens,
  };

  // R-3.2 (#2748 ST-5): TOTAL headline = parent five-way + subagent tokens.
  // Pure presentational combine of the two props — the panel computes both;
  // this component never derives a figure. Zero/absent subagents → 0.
  const subagents = subagentTokens ?? 0;
  const grandTotal = totalTokens + subagents;

  return (
    <div
      data-testid="session-token-bar"
      role="group"
      aria-label="Session token breakdown"
      style={{
        display: 'flex',
        alignItems: 'center',
        // AC-4: "Session Token Usage" left title + figures right (ST-3 flip
        // from the #2723 right-only `flex-end`).
        justifyContent: 'space-between',
        gap: '16px',
        padding: '4px 14px',
        background: 'var(--header-bg)',
        borderBottom: '1px solid var(--border-color)',
        flexShrink: 0,
      }}
    >
      {/* Left title (AC-4) — same styling language as the ChatNode "Token Usage"
          label; flex-shrink so the figures always keep their right edge. */}
      <span
        style={{
          flexShrink: 0,
          fontSize: '9px',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
        }}
      >
        Session Token Usage
      </span>

      {/* Figures group — margin-left:auto hugs the right edge (AC-4). */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '16px',
          marginLeft: 'auto',
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

        {/* Subagents (#2748 ST-5 / AC3) — mirrors the INPUT..OUTPUT figures
            (9px label + 9px mono value) but with a left border separator (the
            TOTAL separator pattern) and the subagent accent label so it reads
            as "the other bucket" without competing with TOTAL. Zero/absent
            renders `0`. */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: '4px',
            borderLeft: '1px solid var(--border-color)',
            paddingLeft: '16px',
          }}
        >
          <span
            style={{
              fontSize: '9px',
              color: 'var(--accent-subagent)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            SUBAGENTS
          </span>
          <span
            aria-label={`Subagents tokens: ${formatTokenCount(subagents)}`}
            title="Tokens consumed by the session's subagents (not included in INPUT/CACHE/REASONING/OUTPUT)"
            style={{
              fontSize: '9px',
              color: 'var(--text-primary)',
              fontFamily: "'Cascadia Code', monospace",
            }}
          >
            {formatTokenCount(subagents)}
          </span>
        </span>

        {/* Total — bold, accent-colored, 1px left border separator. */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: '4px',
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
            TOTAL
          </span>
          <span
            aria-label={`Total tokens (parent + subagents): ${formatTokenCount(grandTotal)}`}
            title={`Total tokens (parent + subagents): ${formatTokenCount(grandTotal)}`}
            style={{
              fontSize: '11px',
              fontWeight: 700,
              color: 'var(--accent-primary)',
              fontFamily: "'Cascadia Code', monospace",
            }}
          >
            {formatTokenCount(grandTotal)}
          </span>
        </span>

        {/* Estimated Cost (ST-1 / AC-12) — same $X.XXXX format as the ChatNode
            cost row; absent renders the design's '—' (never a hardcoded
            figure — the panel feeds the computed totalCostUsd). */}
        <span
          role="group"
          aria-label="Estimated cost"
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: '4px',
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
            ESTIMATED COST
          </span>
          <span
            aria-label={
              estimatedCost === undefined
                ? 'Estimated cost: unavailable'
                : `Estimated cost (parent + subagents): ${formatCostUsd(estimatedCost)}`
            }
            title={
              estimatedCost === undefined
                ? 'Estimated cost: unavailable'
                : `Estimated cost (parent + subagents): ${formatCostUsd(estimatedCost)}`
            }
            style={{
              fontSize: '9px',
              color: 'var(--text-primary)',
              fontFamily: "'Cascadia Code', monospace",
            }}
          >
            {estimatedCost === undefined ? '—' : formatCostUsd(estimatedCost)}
          </span>
        </span>

        {/* Total Messages (ST-1 / AC-12) — count of distinct chat keys. */}
        <span
          role="group"
          aria-label="Total messages"
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: '4px',
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
            TOTAL MESSAGES
          </span>
          <span
            aria-label={
              totalMessages === undefined
                ? 'Total messages: unavailable'
                : `Total messages: ${totalMessages}`
            }
            style={{
              fontSize: '9px',
              color: 'var(--text-primary)',
              fontFamily: "'Cascadia Code', monospace",
            }}
          >
            {totalMessages === undefined ? '—' : `${totalMessages} msgs`}
          </span>
        </span>
      </span>
    </div>
  );
};
