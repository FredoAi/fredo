/**
 * SubagentNode — the #2745 ST-5 RICH subagent deliverable card (AC-1).
 *
 * One node per user-requested `task` dispatch (built by ST-4's association
 * pass; id `subagent-<corrId>`, type `subagentNode`). It renders the dispatch
 * intent (name + instruction), the child's final output
 * (`gen_ai.tool.call.result`), the deterministic duration, the child's token
 * usage / estimated cost / session-link chip, and a status badge — ALL from
 * the delivered `SubagentNodePayload` (`data.payload`).
 *
 * Theming (AC-1 letter — theme tokens ONLY): surface `var(--card-bg)`,
 * content boxes `var(--body-bg)`, borders/dividers `var(--border-color)`
 * (+ var-alpha tints like `var(--accent-subagent)28` — NEVER rgba), body text
 * `var(--text-primary)`, labels/placeholders `var(--text-secondary)`, identity
 * accent `var(--accent-subagent)`, error `var(--status-error)`. The width
 * bounds are the shared ST-4 constants from lib/layout.ts (420/540) — no
 * component-local width literals (the dead component's hardcoded dark surface
 * / indigo accents / dark content boxes and inline width bounds are
 * eliminated). `COMPACTED_STYLES` numeric values (opacity/grayscale) are
 * reused; any literal-colored compacted chrome the node renders is tokenized.
 *
 * The node is terminal (NO source handle): the edge comes from the parent
 * ChatNode's additive `source-right` handle into this node's single
 * `target-left` handle (companion-column contract, `makeToolsReactFlowEdge`
 * handle pair). Keyboard-open (Enter → DetailPanel) is retained via
 * `useNodeKeyboardOpen` (the #2743 ST-6 AC-7 pattern).
 */
import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { LuBot } from 'react-icons/lu';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { COMPACTED_STYLES } from '../../types';
import type { SubagentNodePayload } from '../../lib/graph';
import {
  formatSubagentOutput,
  formatToolDuration,
  formatTokenCount,
  normalizeCost,
  normalizeTokenCount,
} from '../../lib/graph';
import { SUBAGENT_NODE_MIN_WIDTH, SUBAGENT_NODE_MAX_WIDTH } from '../../lib/layout';
import { useNodeKeyboardOpen } from '../NodeFocusContext';
import styles from './MonitorNode.module.css';

const MONO_FONT = "'Cascadia Code','Fira Code','Consolas',monospace";

const STATUS_CSS_CLASS: Record<MonitorNodeStatus, string> = {
  working:             styles.working,
  error:               styles.error,
  permission_required: styles.permissionRequired,
  permission_granted:  styles.permissionGranted,
  permission_denied:   styles.permissionDenied,
  inactive:            '',
  compacted:           '',
};

/**
 * Human-readable status badge label (a11y: status is never color-only).
 * The builder already applied `graphStatusToMonitorStatus` when it built the
 * node's `data.status` (useMissionMonitor.ts makeMonitorNodeData), so
 * GraphNodeStatus 'complete' arrives here as MonitorNodeStatus 'inactive'.
 */
function statusBadgeLabel(status: MonitorNodeStatus): string {
  switch (status) {
    case 'working':             return 'WORKING';
    case 'inactive':            return 'DONE';
    case 'error':               return 'FAILED';
    case 'compacted':           return 'COMPACTED';
    case 'permission_required': return 'PERMISSION REQUIRED';
    case 'permission_granted':  return 'PERMISSION GRANTED';
    case 'permission_denied':   return 'PERMISSION DENIED';
  }
}

/**
 * Badge colors — theme tokens only (UI/UX §2.1): accent tint for working,
 * neutral border tint for done, status-error tint for failed, neutral for
 * compacted. STATUS_COLORS' literal hex is not usable under AC-1's
 * "theme tokens only" letter, so the badge uses var-alpha tints instead.
 */
function statusBadgeStyle(status: MonitorNodeStatus): { background: string; color: string } {
  switch (status) {
    case 'working': return { background: 'var(--accent-subagent)22', color: 'var(--accent-subagent)' };
    case 'error':   return { background: 'var(--status-error)22',    color: 'var(--status-error)' };
    case 'compacted':
    default:        return { background: 'var(--border-color)33',    color: 'var(--text-secondary)' };
  }
}

/** en-US 4-decimal cost format (`$X.XXXX` — the ChatNode AC-12 pattern). */
function formatChildCost(cost: number): string {
  return cost.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

export const SubagentNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const isCompacted = data.status === 'compacted';
  const isError = data.status === 'error';
  const glowClass = isCompacted ? '' : STATUS_CSS_CLASS[data.status];

  // Read SubagentNodePayload from data.payload
  const payload = data.payload as unknown as SubagentNodePayload | undefined;
  const name: string = payload?.name ?? '';
  const instruction: string = payload?.instruction ?? '';
  const rawOutput: string = payload?.output ?? '';

  // Sanitize output for display: strip the opencode angle-bracket control tags
  // (`<SystemReminder>`/`<prefix>`/…) while keeping their inner text, normalize
  // `<br>` variants, and collapse whitespace noise (formatSubagentOutput — the
  // UI/UX-owned formatter in graph.ts).
  const output: string = formatSubagentOutput(rawOutput);

  // Deterministic duration — durationMs → startTime/endTime delta → '—'
  // (formatToolDuration; NEVER a render-time clock — T-Rich-3).
  const duration = formatToolDuration(payload?.durationMs, payload?.startTime, payload?.endTime);

  // Child token usage — the payload carries the child's TOTAL tokens
  // (`childTokens` = child_total_tokens, ST-3 projection) PLUS the per-family
  // breakdown (child_input_/child_cache_read_/child_reasoning_/child_output_
  // tokens → childInputTokens/… camelCase, ST-3 follow-up). Zero/absent guard
  // via normalizeTokenCount (renders 0 — never NaN/negative). TOTAL = the sum
  // of the four displayed families when the breakdown is present (cache WRITE
  // is never displayed — the ChatNode cacheWrite contract), else falls back to
  // the aggregate childTokens for legacy deliveries.
  const childInputTokens = normalizeTokenCount(payload?.childInputTokens);
  const childCacheReadTokens = normalizeTokenCount(payload?.childCacheReadTokens);
  const childReasoningTokens = normalizeTokenCount(payload?.childReasoningTokens);
  const childOutputTokens = normalizeTokenCount(payload?.childOutputTokens);
  const hasBreakdown =
    payload?.childInputTokens !== undefined ||
    payload?.childCacheReadTokens !== undefined ||
    payload?.childReasoningTokens !== undefined ||
    payload?.childOutputTokens !== undefined;
  const childTokens = hasBreakdown
    ? childInputTokens + childCacheReadTokens + childReasoningTokens + childOutputTokens
    : normalizeTokenCount(payload?.childTokens);
  // Child cost — normalizeCost-guarded; ABSENT stays absent → renders '—'
  // (never a hardcoded literal, never 0 for absent; a delivered $0.0000
  // renders the telemetry value).
  const childCost = payload?.childCost === undefined
    ? undefined
    : normalizeCost(payload.childCost);

  // Is this node awaiting the child's final output? (working state, none yet)
  const isAwaiting: boolean = data.status === 'working' && !output;

  // #2745 ST-5 (AC-1): border — indigo identity, `var(--status-error)` on
  // error (errors must be unmistakable), tokenized dashed compacted border.
  const border = isCompacted
    ? '1.5px dashed var(--border-color)'
    : `1.5px solid ${isError ? 'var(--status-error)' : 'var(--accent-subagent)'}`;

  const containerStyle: React.CSSProperties = {
    background: 'var(--card-bg)',
    border,
    borderRadius: 12,
    padding: '10px 14px',
    minWidth: SUBAGENT_NODE_MIN_WIDTH,
    maxWidth: SUBAGENT_NODE_MAX_WIDTH,
    opacity: isCompacted ? COMPACTED_STYLES.opacity : 1,
    filter: isCompacted ? COMPACTED_STYLES.grayscale : 'none',
    boxShadow: selected
      ? isCompacted
        ? '0 0 0 2px var(--border-color)66'
        : `0 0 0 2px ${isError ? 'var(--status-error)' : 'var(--accent-subagent)'}66`
      : '0 2px 8px var(--border-color)33',
    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
  };

  // #2743 ST-6 (AC-7): keyboard access equivalent to double-click.
  const keyboardProps = useNodeKeyboardOpen(data);

  const badgeLabel = statusBadgeLabel(data.status);
  const badgeColors = statusBadgeStyle(data.status);

  // §A-8: the child-session link navigates when the child session exists in
  // the session list, copies otherwise. Child sessions never appear in the
  // sidebar (sessions derive ONLY from chat-node deliveries — useSessionHistory
  // filters isChatNodeDelivery). The childSessionId is kept in the payload for
  // this purpose but is NOT rendered in the node (human decision: the id is
  // noise on the node; the session link is available on demand via the
  // detail view).

  return (
    <>
      {/* The single target handle — the edge from the parent ChatNode's
          `source-left` lands here (companion-column contract; subagents sit
          LEFT of the chat chain). The node is terminal — no source handle. */}
      <Handle type="target" position={Position.Right} id="target-right"
        style={{
          background: isError ? 'var(--status-error)' : 'var(--accent-subagent)',
          border: 'none', width: 8, height: 8,
        }} />
      <div
        title="Double-click to view details"
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={containerStyle}
        role="article"
        aria-label={`Subagent · ${name || '—'} — ${badgeLabel}`}
        {...keyboardProps}
      >
        {/* ── Title bar: LuBot · Subagent · name · working pulse · duration · badge ── */}
        <div className={styles.titleBar}>
          <span style={{ color: 'var(--accent-subagent)', display: 'flex', alignItems: 'center', marginRight: 6 }}>
            <LuBot size={14} />
          </span>
          <span className={styles.titleText} style={{ color: 'var(--accent-subagent)' }}>
            Subagent · {name || '—'}
          </span>
          {/* Working pulse — the existing pulse-icon indicator (UI/UX §2.5,
              reuses `.iconAnimatePulse` — no new keyframe). */}
          {data.status === 'working' && (
            <span
              className={styles.iconAnimatePulse}
              aria-label="Subagent working"
              style={{
                display: 'inline-block', width: 8, height: 8,
                borderRadius: '50%', background: 'var(--accent-subagent)',
                flexShrink: 0, marginRight: 6,
              }}
            />
          )}
          <span
            aria-label={`Duration ${duration}`}
            style={{
              marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap',
              fontSize: 10, fontFamily: MONO_FONT, color: 'var(--text-secondary)',
            }}
          >
            {duration}
          </span>
          <span
            className={styles.statusBadge}
            style={{ background: badgeColors.background, color: badgeColors.color }}
          >
            {badgeLabel}
          </span>
        </div>

        {/* ── SECTION 1: Instruction ── */}
        <div className={styles.sectionUser} style={{ marginBottom: 10 }}>
          <div className={styles.sectionLabel} style={{ color: 'var(--accent-subagent)' }}>
            ── INSTRUCTION ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={{
            background: 'var(--body-bg)',
            border: '1px solid var(--accent-subagent)28',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 11.5,
            color: 'var(--text-primary)',
            lineHeight: 1.55,
            maxHeight: 96,
            overflowY: 'auto',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            {instruction || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
          </div>
        </div>

        {/* Section divider */}
        <div className={styles.sectionDivider} style={{ background: 'var(--border-color)18' }} />

        {/* ── SECTION 2: Output (child's final output, mono) ── */}
        <div style={{ marginBottom: 2 }}>
          <div className={styles.sectionLabel} style={{ color: 'var(--text-secondary)' }}>
            ── OUTPUT ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={{
            background: 'var(--body-bg)',
            border: '1px solid var(--accent-subagent)28',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 11.5,
            color: 'var(--text-primary)',
            lineHeight: 1.55,
            maxHeight: 160,
            overflowY: 'auto',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            fontFamily: MONO_FONT,
          }} aria-live="polite">
            {output
              ? output
              : isAwaiting
                ? <span className={styles.loadingDots}>
                    <span className={styles.loadingDot}>●</span>
                    <span className={styles.loadingDot}>●</span>
                    <span className={styles.loadingDot}>●</span>
                  </span>
                : <span style={{ color: 'var(--text-secondary)' }}>—</span>
            }
          </div>
        </div>

        {/* ── Token Usage row (#2743 bottomBar pattern): the child's five-way
            breakdown INPUT/CACHE/REASONING/OUTPUT/TOTAL. TOTAL = the sum of the
            four displayed families (cache WRITE never displayed — ChatNode
            contract). Comma-formatted en-US, full value in each aria-label;
            zero-guarded via normalizeTokenCount. ── */}
        <div
          className={styles.bottomBar}
          role="group"
          aria-label="Node token breakdown"
        >
          <span className={styles.bottomBarTitle}>Token Usage</span>
          <span className={styles.bottomBarFigures}>
            <span
              className={styles.compactFigure}
              aria-label={`Input tokens: ${formatTokenCount(childInputTokens)}`}
            >
              <span className={styles.compactLabel}>INPUT:</span>
              <span className={styles.compactValue}>{formatTokenCount(childInputTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Cache tokens: ${formatTokenCount(childCacheReadTokens)}`}
            >
              <span className={styles.compactLabel}>CACHE:</span>
              <span className={styles.compactValue}>{formatTokenCount(childCacheReadTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Reasoning tokens: ${formatTokenCount(childReasoningTokens)}`}
            >
              <span className={styles.compactLabel}>REASONING:</span>
              <span className={styles.compactValue}>{formatTokenCount(childReasoningTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Output tokens: ${formatTokenCount(childOutputTokens)}`}
            >
              <span className={styles.compactLabel}>OUTPUT:</span>
              <span className={styles.compactValue}>{formatTokenCount(childOutputTokens)}</span>
            </span>
            <span
              className={`${styles.compactFigure} ${styles.compactTotal}`}
              aria-label={`Total tokens: ${formatTokenCount(childTokens)}`}
            >
              <span className={styles.compactLabel}>TOTAL:</span>
              <span className={styles.compactValue}>{formatTokenCount(childTokens)}</span>
            </span>
          </span>
        </div>

        {/* ── Estimated Cost row (#2743 costRow pattern): the child's cost.
            Absent → '—' (never a hardcoded figure); a delivered value renders
            $X.XXXX (comma-grouped en-US, 4 decimals). ── */}
        <div
          className={styles.costRow}
          role="group"
          aria-label="Estimated cost"
        >
          <span className={styles.costRowLabel}>Estimated Cost</span>
          <span
            className={styles.costRowValue}
            aria-label={
              childCost === undefined
                ? 'Estimated cost: unavailable'
                : `Estimated cost: $${formatChildCost(childCost)}`
            }
          >
            {childCost === undefined ? '—' : `$${formatChildCost(childCost)}`}
          </span>
        </div>
      </div>
    </>
  );
});
