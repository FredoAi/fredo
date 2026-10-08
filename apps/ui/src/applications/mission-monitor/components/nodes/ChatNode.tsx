import React, { useState } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Accordion } from '@chakra-ui/react';
import type { MonitorNodeData } from '../../types';
import { COMPACTED_STYLES } from '../../types';
import type { AgentNodePayload } from '../../lib/graph';
import { formatTokenCount, normalizeTokenCount } from '../../lib/graph';
import { useNodeFocus, useNodeKeyboardOpen } from '../NodeFocusContext';
import { ToolCallAccordionItem } from './ToolCallAccordionItem';
import styles from './MonitorNode.module.css';
import { tint } from '../../../../shared/utils/colorTint';

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
        : `0 0 0 2px ${tint('var(--accent-primary)', 40)}, 0 4px 16px ${tint('var(--border-color)', 33)}`
      : `0 2px 8px ${tint('var(--border-color)', 20)}`,
    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
  };

  // #2743 ST-6 (AC-7): keyboard access equivalent to double-click — Tab to the
  // node, Enter opens its detail (tabIndex + onKeyDown on the container).
  const keyboardProps = useNodeKeyboardOpen(data);

  // ── #2764 ST-2: the embedded `── TOOLS (N) ──` section ──
  // Non-task tool calls the builder resolved to this exchange's anchor
  // (payload.tools — the #2762 SubagentNodePayload.tools pattern). Absent or
  // empty → the section is hidden ENTIRELY (FR-3 byte-parity: a no-tool chat
  // node renders exactly as before). #2743 ST-6 (AC-8): the scoped tool-call
  // detail opener — double-clicking an embedded item (FR-2, inside the shared
  // ToolCallAccordionItem) calls the focus handler with the `tool-call`
  // target union; the DetailPanel renders that call's own
  // input/output/outcome/duration.
  const onFocus = useNodeFocus();
  const tools = payload?.tools;
  const sessionId = payload?.sessionId ?? '';

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
          {/* A long user prompt (live agent runs can embed large context / tool
              echoes into the message) must not blow the node's height — bounded
              scrollable box, same style contract as the RESPONSE box. */}
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
            {userMessage || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
          </div>
        </div>

        {/* Section divider */}
        <div className={styles.sectionDivider} style={{ background: tint('var(--border-color)', 9) }} />

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
            <div className={styles.sectionDivider} style={{ background: tint('var(--border-color)', 9) }} />
          </>
        )}

        {/* ── TOOLS (N) (#2764 ST-2; moved before RESPONSE by #2766 ST-1) —
            this exchange's own tool calls, embedded by containment (the
            #2762 SubagentNode pattern; the standalone ToolsNode + its
            summary edge were removed). #2766 R1: the section renders between
            the THINKING conditional and RESPONSE so the node reads
            USER → TOOLS → RESPONSE, mirroring SubagentNode's
            instructions → tools → output order. Hidden entirely when N = 0
            (FR-3 byte-parity: a no-tool chat node renders exactly as
            before). `nowheel` + bounded maxHeight so a tool-heavy exchange
            never makes the node unbounded; accordion open/close is
            node-internal Chakra state — it never enters the graph structure
            signature (NFR-4). ── */}
        {tools && tools.length > 0 && (
          <>
            <div style={{ marginBottom: 10 }}>
              <div className={styles.sectionLabel} style={{ color: 'var(--text-secondary)' }}>
                ── TOOLS ({tools.length}) ──
              </div>
              <div
                className="nowheel"
                style={{
                  background: 'var(--body-bg)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                  padding: '2px 8px',
                  maxHeight: 160,
                  overflowY: 'auto',
                }}
              >
                <Accordion.Root multiple defaultValue={[]} variant="plain">
                  {tools.map((call, index) => (
                    <ToolCallAccordionItem
                      key={call.correlationId || `tool-${index}`}
                      call={call}
                      index={index}
                      onOpenDetail={() => onFocus?.({ kind: 'tool-call', call, sessionId })}
                    />
                  ))}
                </Accordion.Root>
              </div>
            </div>

            {/* Section divider — mirrors SubagentNode.tsx:308-309 (the divider
                between the TOOLS-conditional region and the OUTPUT/RESPONSE
                section). It rides with the TOOLS conditional so a no-tool
                chat never renders a doubled/orphaned divider before RESPONSE
                (#2766 R2: no empty gap or divider orphan between USER and
                RESPONSE when N = 0). */}
            <div className={styles.sectionDivider} style={{ background: tint('var(--border-color)', 9) }} />
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
      {/* #2766 ST-2 (R6): RIGHT-side source handle for the SubagentNode
          companion edge — subagents render in their own column RIGHT of the
          chat chain (source-right → SubagentNode target-left). Rendered AFTER
          the bottom handle so ReactFlow's first-source-handle default keeps
          existing chat-chain edges on the bottom handle. (#2764 ST-2 had
          deleted the `source-right` handle along with the ToolsNode it fed;
          #2766 re-introduces it for the mirrored companion edge and removes
          the now-dead `source-left` — no dead handles.) */}
      <Handle type="source" position={Position.Right} id="source-right"
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
});
