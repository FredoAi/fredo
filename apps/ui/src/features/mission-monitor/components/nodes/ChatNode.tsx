import React, { useState } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData } from '../../types';
import { COMPACTED_STYLES } from '../../types';
import type { AgentNodePayload } from '../../lib/graph';
import { formatTokenCount, normalizeTokenCount } from '../../lib/graph';
import { useNodeKeyboardOpen } from '../NodeFocusContext';
import styles from './MonitorNode.module.css';

export const ChatNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const isCompacted = data.status === 'compacted';
  // #2748 ST-7 (AC-5): status-driven chrome is gone — every node renders the
  // plain neutral border regardless of status. STATUS_COLORS stays in types.ts
  // for the DetailPanel/FocusWindow consumers; only the node-render
  // application is removed.
  const color = 'var(--border-color)';
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

  // REQ-8: Compacted node styling — #2748 ST-7 (AC-5): plain neutral chrome —
  // `var(--card-bg)` surface + `1.5px solid var(--border-color)` regardless of
  // status (compacted keeps the dashed border + opacity/grayscale as a
  // NON-text state signal). Selection ring is accent (not status).
  const containerStyle: React.CSSProperties = {
    background: 'var(--card-bg)',
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
        : '0 0 0 2px var(--accent-primary)66, 0 4px 16px var(--border-color)55'
      : '0 2px 8px var(--border-color)33',
    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
  };

  // #2743 ST-6 (AC-7): keyboard access equivalent to double-click — Tab to the
  // node, Enter opens its detail (tabIndex + onKeyDown on the container).
  const keyboardProps = useNodeKeyboardOpen(data);

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        className={styles.nodeContainer}
        style={containerStyle}
        role="article"
        title="Double-click to view details"
        {...keyboardProps}
      >
        {/* ── Title: agent · model ── */}
        <div className={styles.titleBar}>
          <span className={styles.titleText}>{data.label}</span>
        </div>

        {/* ── SECTION 1: User ── */}
        <div className={styles.sectionUser} style={{ marginBottom: 10 }}>
          <div className={styles.sectionLabel} style={{ color: 'var(--text-secondary)' }}>
            ── USER ──
          </div>
          <div style={{
            color: 'var(--text-primary)',
            fontSize: 11.5,
            lineHeight: 1.55,
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            {userMessage || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
          </div>
        </div>

        {/* Section divider */}
        <div className={styles.sectionDivider} style={{ background: 'var(--border-color)18' }} />

        {/* ── SECTION 2: Thinking (collapsible) — shown only when there is ALSO a
             separate response. #2750 AC4-3: thinking is NEVER rendered as the
             RESPONSE body — a text-less turn (dispatch/tool-call-only) renders
             the loading indicator or '—' in its RESPONSE section. ── */}
        {thinkingText && responseText && (
          <>
            <div className={styles.thinkingSection}>
              <div className={styles.sectionLabel} style={{ color: 'var(--accent-primary)' }}>
                ── THINKING ──
              </div>
              <div style={{
                fontSize: 11.5,
                color: 'var(--text-primary)',
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
            <div className={styles.sectionDivider} style={{ background: 'var(--border-color)18' }} />
          </>
        )}

        {/* ── SECTION 3: Response ── */}
        <div style={{ marginBottom: 2 }}>
          <div className={styles.sectionLabel} style={{ color: 'var(--text-secondary)' }}>
            ── RESPONSE ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={{
            background: 'var(--body-bg)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 11.5,
            color: 'var(--text-primary)',
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
                : <span style={{ color: 'var(--text-secondary)' }}>—</span>
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
              <span className={styles.compactLabel}>INPUT:</span>
              <span className={styles.compactValue}>{formatTokenCount(inputTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Cache tokens: ${formatTokenCount(cacheReadTokens)}`}
            >
              <span className={styles.compactLabel}>CACHE:</span>
              <span className={styles.compactValue}>{formatTokenCount(cacheReadTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Reasoning tokens: ${formatTokenCount(reasoningTokens)}`}
            >
              <span className={styles.compactLabel}>REASONING:</span>
              <span className={styles.compactValue}>{formatTokenCount(reasoningTokens)}</span>
            </span>
            <span
              className={styles.compactFigure}
              aria-label={`Output tokens: ${formatTokenCount(outputTokens)}`}
            >
              <span className={styles.compactLabel}>OUTPUT:</span>
              <span className={styles.compactValue}>{formatTokenCount(outputTokens)}</span>
            </span>
            <span
              className={`${styles.compactFigure} ${styles.compactTotal}`}
              aria-label={`Total tokens: ${formatTokenCount(totalTokens)}`}
            >
              <span className={styles.compactLabel}>TOTAL:</span>
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
      {/* #2745: additive LEFT-side source handle for the SubagentNode companion
          edge — subagents render in their own column LEFT of the chat chain
          (source-left → SubagentNode target-right). Same rendered-last ordering
          rule as source-right so the bottom-handle default is unchanged. */}
      <Handle type="source" position={Position.Left} id="source-left"
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
});
