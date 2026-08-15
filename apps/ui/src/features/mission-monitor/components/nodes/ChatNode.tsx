import React, { useState } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import type { AgentNodePayload } from '../../lib/graph';
import { formatCompactTokenCount, formatTokenCount, normalizeTokenCount } from '../../lib/graph';
import { COMPACTED_STYLES } from '../../types';
import styles from './MonitorNode.module.css';

const STATUS_CSS_CLASS: Record<MonitorNodeStatus, string> = {
  working:             styles.working,
  error:               styles.error,
  permission_required: styles.permissionRequired,
  permission_granted:  styles.permissionGranted,
  permission_denied:   styles.permissionDenied,
  inactive:            '',
  compacted:           '',
};

export const ChatNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const isCompacted = data.status === 'compacted';
  const color = isCompacted ? COMPACTED_STYLES.borderColor : STATUS_COLORS[data.status];
  const glowClass = isCompacted ? '' : STATUS_CSS_CLASS[data.status];
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // Read AgentNodePayload from data.payload (merged via AgentNodePayload shape)
  const payload = data.payload as unknown as AgentNodePayload | undefined;

  const userMessage: string = payload?.userMessage ?? '';
  const thinkingText: string = payload?.agentThinking ?? '';
  const responseText: string = payload?.agentReply ?? '';
  // Spec #2723 (R-2 / AC2): five token figures — Input / Cache / Reasoning /
  // Output / Total — in ONE compact single-line, right-aligned row (abbreviated
  // labels, display-only k-format). Zero AND absent categories render as `0`
  // (R-3.3), never NaN/negative/mislabeled. cacheWriteTokens is carried but
  // never displayed.
  const inputTokens: number = normalizeTokenCount(payload?.promptTokens);
  const cacheReadTokens: number = normalizeTokenCount(payload?.cacheReadTokens);
  const reasoningTokens: number = normalizeTokenCount(payload?.reasoningTokens);
  const outputTokens: number = normalizeTokenCount(payload?.completionTokens);
  // R-3.1: Total = Input + Cache + Reasoning + Output exactly.
  const totalTokens: number = inputTokens + cacheReadTokens + reasoningTokens + outputTokens;
  const agent: string | undefined = payload?.agent;
  const model: string | undefined = payload?.model;

  // Is this node awaiting a response? (working/active status, no response text yet)
  const isAwaiting: boolean = (data.status === 'working' || data.status === 'permission_required') && !responseText;

  // Collapsed preview: first ~60 chars
  const thinkingPreview: string =
    thinkingText.length > 60
      ? thinkingText.slice(0, 60) + '…'
      : thinkingText;

  // REQ-8: Compacted node styling
  const containerStyle: React.CSSProperties = {
    background: '#12121f',
    border: isCompacted
      ? `1.5px dashed ${COMPACTED_STYLES.borderColor}`
      : `1.5px solid ${color}`,
    borderRadius: 12,
    padding: '10px 14px',
    minWidth: 420,
    maxWidth: 540,
    opacity: isCompacted ? COMPACTED_STYLES.opacity : 1,
    filter: isCompacted ? COMPACTED_STYLES.grayscale : 'none',
    boxShadow: selected
      ? isCompacted
        ? `0 0 0 2px ${COMPACTED_STYLES.selectionRing}`
        : `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
      : '0 2px 8px rgba(0,0,0,0.4)',
    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
  };

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={containerStyle}
      >
        {/* ── Title: agent · model ── */}
        <div className={styles.titleBar}>
          <span className={styles.titleText}>{data.label}</span>
          {isCompacted && (
            <span
              className={styles.statusBadge}
              style={{
                background: COMPACTED_STYLES.badgeBackground,
                color: COMPACTED_STYLES.badgeColor,
                fontSize: 8,
              }}
              aria-label="Session compacted"
            >
              COMPACTED
            </span>
          )}
        </div>

        {/* ── SECTION 1: User ── */}
        <div className={styles.sectionUser} style={{ marginBottom: 10 }}>
          <div className={styles.sectionLabel} style={{ color: '#64748b' }}>
            ── USER ──
          </div>
          <div style={{
            color: '#94a3b8',
            fontSize: 11.5,
            lineHeight: 1.55,
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            {userMessage || <span style={{ color: '#374151' }}>—</span>}
          </div>
        </div>

        {/* Section divider */}
        <div className={styles.sectionDivider} style={{ background: `${color}18` }} />

        {/* ── SECTION 2: Thinking (collapsible) ── */}
        {thinkingText && (
          <>
            <div className={styles.thinkingSection}>
              <div className={styles.sectionLabel} style={{ color: '#a855f7' }}>
                ── THINKING ──
              </div>
              <div style={{
                fontSize: 11.5,
                color: '#cbd5e1',
                lineHeight: 1.55,
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              }}>
                {thinkingExpanded ? thinkingText : thinkingPreview}
              </div>
              <button
                className={styles.thinkingToggle}
                onClick={() => setThinkingExpanded((prev) => !prev)}
                type="button"
              >
                {thinkingExpanded ? '[Collapse]' : '[Expand]'}
              </button>
            </div>
            <div className={styles.sectionDivider} style={{ background: `${color}18` }} />
          </>
        )}

        {/* ── SECTION 3: Response ── */}
        <div style={{ marginBottom: 2 }}>
          <div className={styles.sectionLabel} style={{ color: '#64748b' }}>
            ── RESPONSE ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={{
            background: '#0a0a18',
            border: `1px solid ${color}28`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 11.5,
            color: '#cbd5e1',
            lineHeight: 1.55,
            maxHeight: 160,
            overflowY: 'auto',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            {responseText
              ? responseText
              : isAwaiting
                ? <span className={styles.loadingDots}>
                    <span className={styles.loadingDot}>●</span>
                    <span className={styles.loadingDot}>●</span>
                    <span className={styles.loadingDot}>●</span>
                  </span>
                : <span style={{ color: '#374151' }}>—</span>
            }
          </div>

        </div>

        {/* ── Bottom bar: full-label comma-formatted token figures (#2743 ST-2
            AC-2/3/4) — "Token Usage" at the left, the five figures at the right.
            Every displayed value is formatTokenCount (comma-grouped en-US,
            never k/M); every figure's aria-label carries the same full
            comma-formatted number. Zero AND absent categories render `0`
            (R-3.3), never NaN/negative/mislabeled. cacheWriteTokens is
            carried but never displayed. ── */}
        <div
          className={styles.bottomBar}
          role="group"
          aria-label="Node token breakdown"
        >
          <span className={styles.bottomBarTitle}>Token Usage</span>
          <span className={styles.bottomBarFigures}>
            <span
              className={styles.compactFigure}
              aria-label={`Input tokens: ${formatTokenCount(inputTokens)}`}
            >
              <span className={styles.compactLabel}>INPUT</span>
              <span className={styles.compactValue}>{formatTokenCount(inputTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Cache tokens: ${formatTokenCount(cacheReadTokens)}`}
            >
              <span className={styles.compactLabel}>CACHE</span>
              <span className={styles.compactValue}>{formatTokenCount(cacheReadTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Reasoning tokens: ${formatTokenCount(reasoningTokens)}`}
            >
              <span className={styles.compactLabel}>REASONING</span>
              <span className={styles.compactValue}>{formatTokenCount(reasoningTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Output tokens: ${formatTokenCount(outputTokens)}`}
            >
              <span className={styles.compactLabel}>OUTPUT</span>
              <span className={styles.compactValue}>{formatTokenCount(outputTokens)}</span>
            </span>
            <span
              className={`${styles.compactFigure} ${styles.compactTotal}`}
              aria-label={`Total tokens: ${formatTokenCount(totalTokens)}`}
            >
              <span className={styles.compactLabel}>TOTAL</span>
              <span className={styles.compactValue}>{formatTokenCount(totalTokens)}</span>
            </span>
          </span>
        </div>

        {/* ── Cost row (#2743 ST-2 AC-12): the exchange's estimated cost from
            the LLM span's delivered cost_usd. `payload.costUsd` is set by the
            graph builder ONLY when the delivery carries a valid non-negative
            figure — absent stays absent so this renders the absent-state '—'
            (never a hardcoded figure). A delivered $0.00 renders '$0.0000'
            (the telemetry value, never a literal). Comma-grouped en-US with
            4 decimal places for precision. ── */}
        <div
          className={styles.costRow}
          role="group"
          aria-label="Estimated cost"
        >
          <span className={styles.costRowLabel}>Estimated Cost</span>
          <span
            className={styles.costRowValue}
            aria-label={
              payload?.costUsd === undefined
                ? 'Estimated cost: unavailable'
                : `Estimated cost: $${payload.costUsd.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
            }
          >
            {payload?.costUsd === undefined
              ? '—'
              : `$${payload.costUsd.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      {/* #2739 NFR-6 / D-5: additive right-side source handle for the ToolsNode
          summary edge. Rendered LAST in JSX so ReactFlow's first-source-handle
          default keeps existing chat-chain edges on the bottom handle (zero
          behavior change to existing edges). The tools edge explicitly sets
          sourceHandle='source-right' → ToolsNode target-left. */}
      <Handle type="source" position={Position.Right} id="source-right"
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
});
