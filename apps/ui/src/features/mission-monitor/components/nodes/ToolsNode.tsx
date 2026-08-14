/**
 * ToolsNode — the #2739 tools-summary node (ST-2).
 *
 * One ToolsNode renders per chat node whose exchange made tool calls (built by
 * ST-1's association pass; id `tools-<parentCorrId>`, type `toolsNode`). It
 * shows a title bar (wrench icon, "Tools · {N} calls", right-aligned Σ of the
 * per-call totals), a Chakra v3 Accordion with ONE item per ToolCallSummary —
 * collapsed: tool name + that call's total tokens (full comma-formatted value
 * in the aria-label, never k/M); expanded: the call's input/output in
 * chat-node-style scrollable boxes (monospace, `nowheel`, themed scrollbar) —
 * and an "Exchange tokens" footer row mirroring the parent chat node's
 * per-turn figures (NFR-1 / Architect D-1).
 *
 * Theming (NFR-9): text/accordion colors come from theme CSS vars
 * (--text-primary / --text-secondary / --accent-primary / --border-color);
 * the only literal colors are the established node-chrome/content-box pattern
 * (dark node surface #12121f, content-box #0a0a18, orange tool accent) shared
 * with the sibling nodes. No new hardcoded hex.
 *
 * Layout (NFR-4): accordion open/close is node-internal (uncontrolled Chakra
 * state) — it never enters the graph layout/structure signature, so expanding
 * or collapsing an item never re-lays-out the graph and never triggers a
 * re-render loop (Spec #275/#523 pattern). The node is memoized on its data
 * reference, which ST-1 only replaces when the payload content changes.
 */
import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Accordion } from '@chakra-ui/react';
import { LuWrench } from 'react-icons/lu';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { COMPACTED_STYLES } from '../../types';
import type { ToolCallSummary, ToolsNodePayload } from '../../lib/graph';
import { GRAPH_NODE_BORDER_COLORS, formatTokenCount, normalizeTokenCount } from '../../lib/graph';
import styles from './MonitorNode.module.css';

const MONO_FONT = "'Cascadia Code','Fira Code','Consolas',monospace";

/** The tool accent — same as the legacy ToolNode and the `tools` edge (graph.ts). */
const TOOLS_ACCENT = GRAPH_NODE_BORDER_COLORS.tools;

const STATUS_CSS_CLASS: Record<MonitorNodeStatus, string> = {
  working:             styles.working,
  error:               styles.error,
  permission_required: styles.permissionRequired,
  permission_granted:  styles.permissionGranted,
  permission_denied:   styles.permissionDenied,
  inactive:            '',
  compacted:           '',
};

/** Chat-node-style content box — monospace, scrollable, wheel-safe (`nowheel`),
 *  themed scrollbar (`.responseScroll`), bounded by maxHeight (NFR-4). The AC3
 *  "same style as the chat node's content" target: same typography/whitespace
 *  as ChatNode's response box, with the ToolNode monospace + height pattern. */
function contentBoxStyle(color: string, maxHeight: number): React.CSSProperties {
  return {
    background: '#0a0a18',
    border: `1px solid ${color}28`,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 11.5,
    color: 'var(--text-primary)',
    lineHeight: 1.55,
    maxHeight,
    overflowY: 'auto',
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
    fontFamily: MONO_FONT,
  };
}

/** One accordion item per tool call — collapsed trigger + expanded I/O boxes. */
const ToolCallAccordionItem: React.FC<{ call: ToolCallSummary; index: number }> = ({ call, index }) => {
  const totalTokens = normalizeTokenCount(call.totalTokens);
  const value = call.correlationId || `tool-${index}`;
  return (
    <Accordion.Item value={value}>
      <Accordion.ItemTrigger
        style={{
          gap: 6,
          paddingTop: 4,
          paddingBottom: 4,
          fontSize: 11,
          color: 'var(--text-primary)',
        }}
      >
        <Accordion.ItemIndicator style={{ color: 'var(--text-secondary)' }} />
        <span style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: 500,
        }}>
          {call.toolName}
        </span>
        <span
          aria-label={`${formatTokenCount(totalTokens)} tokens`}
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: 'var(--text-secondary)',
          }}
        >
          {formatTokenCount(totalTokens)} tokens
        </span>
      </Accordion.ItemTrigger>
      <Accordion.ItemContent>
        <Accordion.ItemBody style={{ paddingTop: 2, paddingBottom: 8 }}>
          <div className={styles.sectionLabel} style={{ color: TOOLS_ACCENT }}>
            ── INPUT ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={contentBoxStyle(TOOLS_ACCENT, 120)}>
            {call.input || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
          </div>
          <div className={styles.sectionLabel} style={{ color: 'var(--text-secondary)', marginTop: 6 }}>
            ── OUTPUT ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={contentBoxStyle(TOOLS_ACCENT, 160)}>
            {call.output || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
          </div>
        </Accordion.ItemBody>
      </Accordion.ItemContent>
    </Accordion.Item>
  );
};

export const ToolsNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const isCompacted = data.status === 'compacted';
  const color = isCompacted ? COMPACTED_STYLES.borderColor : TOOLS_ACCENT;
  const glowClass = isCompacted ? '' : STATUS_CSS_CLASS[data.status];

  const payload = data.payload as unknown as ToolsNodePayload | undefined;
  const toolCalls: ToolCallSummary[] = payload?.toolCalls ?? [];
  const callCount = toolCalls.length;

  // Σ of the per-call totals (AC2 semantics) — zero-guarded; 0 for opencode
  // (Architect D-1), byte-equal to telemetry absence. Never abbreviated.
  const totalTokens = toolCalls.reduce(
    (sum, call) => sum + normalizeTokenCount(call.totalTokens),
    0,
  );

  // Exchange-level figures mirrored from the parent chat node (NFR-1).
  const exchangeInputTokens = normalizeTokenCount(payload?.exchangeInputTokens);
  const exchangeCacheReadTokens = normalizeTokenCount(payload?.exchangeCacheReadTokens);
  const exchangeReasoningTokens = normalizeTokenCount(payload?.exchangeReasoningTokens);
  const exchangeOutputTokens = normalizeTokenCount(payload?.exchangeOutputTokens);
  const exchangeTotalTokens = normalizeTokenCount(payload?.exchangeTotalTokens);

  const containerStyle: React.CSSProperties = {
    background: '#12121f',
    border: isCompacted
      ? `1.5px dashed ${COMPACTED_STYLES.borderColor}`
      : `1.5px solid ${color}`,
    borderRadius: 12,
    padding: '10px 14px',
    minWidth: 280,
    maxWidth: 360,
    opacity: isCompacted ? COMPACTED_STYLES.opacity : 1,
    filter: isCompacted ? COMPACTED_STYLES.grayscale : 'none',
    boxShadow: selected
      ? isCompacted
        ? `0 0 0 2px ${COMPACTED_STYLES.selectionRing}`
        : `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
      : '0 2px 8px rgba(0,0,0,0.4)',
    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
  };

  const exchangeFigures: { label: string; fullLabel: string; value: number }[] = [
    { label: 'In', fullLabel: 'Input', value: exchangeInputTokens },
    { label: 'Ca', fullLabel: 'Cache', value: exchangeCacheReadTokens },
    { label: 'Re', fullLabel: 'Reasoning', value: exchangeReasoningTokens },
    { label: 'Ou', fullLabel: 'Output', value: exchangeOutputTokens },
    { label: 'Σ', fullLabel: 'Total', value: exchangeTotalTokens },
  ];

  return (
    <>
      <Handle type="target" position={Position.Left} id="target-left"
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        role="group"
        aria-label={`Tools summary — ${callCount} calls, ${formatTokenCount(totalTokens)} tokens`}
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={containerStyle}
      >
        {/* ── Title bar: wrench icon · Tools · N calls · Σ per-call total ── */}
        <div className={styles.titleBar}>
          <span style={{ color: TOOLS_ACCENT, display: 'flex', alignItems: 'center', marginRight: 6 }}>
            <LuWrench size={14} />
          </span>
          <span className={styles.titleText}>Tools · {callCount} calls</span>
          <span
            aria-label={`Total tokens: ${formatTokenCount(totalTokens)}`}
            style={{
              marginLeft: 'auto',
              flexShrink: 0,
              whiteSpace: 'nowrap',
              fontSize: 10,
              fontFamily: MONO_FONT,
              color: 'var(--accent-primary)',
            }}
          >
            Σ {formatTokenCount(totalTokens)}
          </span>
        </div>

        {/* ── Accordion: one item per tool call (NFR-4 — node-internal state) ── */}
        <Accordion.Root multiple defaultValue={[]} variant="plain">
          {toolCalls.map((call, index) => (
            <ToolCallAccordionItem
              key={call.correlationId || `tool-${index}`}
              call={call}
              index={index}
            />
          ))}
        </Accordion.Root>

        {/* ── Exchange tokens footer row (NFR-1): the parent chat node's
            per-turn figures — formatTokenCount, full values in aria-labels
            (NFR-2), abbreviated labels like the chat-node compact bar. ── */}
        <div
          role="group"
          aria-label="Exchange token breakdown"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            flexWrap: 'nowrap',
            overflow: 'hidden',
            marginTop: 8,
            paddingTop: 6,
            borderTop: '1px solid var(--border-color)',
          }}
        >
          <span
            style={{
              fontSize: 8,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--text-secondary)',
              flexShrink: 0,
            }}
          >
            Exchange tokens:
          </span>
          {exchangeFigures.map((figure, index) => (
            <React.Fragment key={figure.label}>
              {index > 0 && (
                <span aria-hidden="true" style={{ color: 'var(--text-secondary)', fontSize: 8, flexShrink: 0 }}>
                  ·
                </span>
              )}
              <span
                aria-label={`Exchange ${figure.fullLabel.toLowerCase()} tokens: ${formatTokenCount(figure.value)}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                <span style={{
                  fontSize: 8,
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--text-secondary)',
                }}>
                  {figure.label}
                </span>
                <span style={{
                  fontSize: 9,
                  lineHeight: 1.3,
                  fontFamily: MONO_FONT,
                  color: figure.fullLabel === 'Total' ? 'var(--accent-primary)' : 'var(--text-primary)',
                  fontWeight: figure.fullLabel === 'Total' ? 600 : 'normal',
                }}>
                  {formatTokenCount(figure.value)}
                </span>
              </span>
            </React.Fragment>
          ))}
        </div>
      </div>
    </>
  );
});
