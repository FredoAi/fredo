/**
 * ToolsNode — the #2739 tools-summary node (ST-2).
 *
 * One ToolsNode renders per chat node whose exchange made tool calls (built by
 * ST-1's association pass; id `tools-<parentCorrId>`, type `toolsNode`). It
 * shows a title bar (wrench icon, "Tools · {N} calls", right-aligned Σ of the
 * per-call totals) and a Chakra v3 Accordion with ONE item per ToolCallSummary —
 * collapsed: tool name; expanded: the call's input/output in chat-node-style
 * scrollable boxes (monospace, `nowheel`, themed scrollbar). #2743 AC-1 removed
 * the per-call token figure and the "Exchange tokens:" footer row.
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
      </div>
    </>
  );
});
