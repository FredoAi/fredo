/**
 * ToolsNode — the #2739 tools-summary node (ST-2).
 *
 * One ToolsNode renders per chat node whose exchange made tool calls (built by
 * ST-1's association pass; id `tools-<parentCorrId>`, type `toolsNode`). It
 * shows a title bar (wrench icon, "Tools · {N} calls", right-aligned Σ of the
 * per-call totals) and a Chakra v3 Accordion with ONE item per ToolCallSummary —
 * collapsed: tool name + neutral dot; expanded: the call's input/output in
 * chat-node-style scrollable boxes (monospace, `nowheel`, themed scrollbar).
 * #2743 AC-1 removed the per-call token figure and the "Exchange tokens:"
 * footer row.
 *
 * Theming (NFR-9): ALL colors come from theme CSS vars
 * (--text-primary / --text-secondary / --accent-primary / --border-color /
 * --card-bg / --body-bg). #2748 ST-7 (AC-5) removed the last literal node
 * chrome (dark #12121f surface, #0a0a18 content box, orange #f97316 accent) —
 * node border/glow/handles/dots are plain neutral, the tools identity accent
 * survives only in the title-bar icon as `var(--accent-primary)`. Zero
 * hardcoded hex/rgba in the source.
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
import type { MonitorNodeData } from '../../types';
import { COMPACTED_STYLES } from '../../types';
import { useNodeFocus } from '../NodeFocusContext';
import { useNodeKeyboardOpen } from '../NodeFocusContext';
import type { ToolCallSummary, ToolsNodePayload } from '../../lib/graph';
import { formatTokenCount, formatToolDuration, normalizeTokenCount } from '../../lib/graph';
import styles from './MonitorNode.module.css';

const MONO_FONT = "'Cascadia Code','Fira Code','Consolas',monospace";

/**
 * Chat-node-style content box — monospace, scrollable, wheel-safe (`nowheel`),
 *  themed scrollbar (`.responseScroll`), bounded by maxHeight (NFR-4). The AC3
 *  "same style as the chat node's content" target: same typography/whitespace
 *  as ChatNode's response box, with the monospace + height pattern. #2748
 *  ST-7 (AC-5): neutral `var(--body-bg)` + `1px solid var(--border-color)` —
 *  no status/accent tint on content boxes. */
function contentBoxStyle(maxHeight: number): React.CSSProperties {
  return {
    background: 'var(--body-bg)',
    border: '1px solid var(--border-color)',
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

/**
 * One accordion item per tool call — collapsed trigger: neutral outcome dot
 * + tool name + per-tool duration (AC-10); expanded: the call's input/output
 * in chat-node-style scrollable boxes (monospace, `nowheel`, themed scrollbar).
 *
 * #2748 ST-7 (AC-5): the #2743 AC-9 success/error/in-progress outcome dots
 * are NEUTRALIZED — every call renders an identical plain `var(--border-color)`
 * dot with no status aria-label and no pulse animation. Per-call outcomes
 * remain visible in the DetailPanel scoped tool-call view (unchanged consumer).
 *
 * AC-10 duration: `duration_ms` first, startTime/endTime delta fallback, `—`
 * when both absent (formatToolDuration — deterministic, never Date.now()).
 */
const ToolCallAccordionItem: React.FC<{ call: ToolCallSummary; index: number; onOpenDetail: () => void }> = ({ call, index, onOpenDetail }) => {
  const value = call.correlationId || `tool-${index}`;

  // AC-10: per-tool duration — durationMs → startTime/endTime delta → '—'.
  const duration = formatToolDuration(call.durationMs, call.startTime, call.endTime);

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
        // AC-8: double-clicking an individual tool entry opens the SCOPED
        // per-tool detail. stopPropagation so ReactFlow's onNodeDoubleClick
        // never also opens the node's own detail (single double-click trigger).
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpenDetail();
        }}
      >
        <Accordion.ItemIndicator style={{ color: 'var(--text-secondary)' }} />
        {/* #2748 ST-7 (AC-5): neutral per-call dot — plain `var(--border-color)`,
            no status color / no pulse / no status aria-label. */}
        <span
          aria-hidden="true"
          data-testid="tool-call-outcome-dot"
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: 'var(--border-color)',
          }}
        />
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
        {/* AC-10: per-tool duration (right-aligned) */}
        <span
          aria-label={duration}
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: 'var(--text-secondary)',
          }}
        >
          {duration}
        </span>
      </Accordion.ItemTrigger>
      <Accordion.ItemContent>
        <Accordion.ItemBody style={{ paddingTop: 2, paddingBottom: 8 }}>
          <div className={styles.sectionLabel} style={{ color: 'var(--accent-primary)' }}>
            ── INPUT ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={contentBoxStyle(120)}>
            {call.input || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
          </div>
          <div className={styles.sectionLabel} style={{ color: 'var(--text-secondary)', marginTop: 6 }}>
            ── OUTPUT ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={contentBoxStyle(160)}>
            {call.output || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
          </div>
        </Accordion.ItemBody>
      </Accordion.ItemContent>
    </Accordion.Item>
  );
};

export const ToolsNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const isCompacted = data.status === 'compacted';
  // #2748 ST-7 (AC-5): plain neutral border regardless of status — the tools
  // identity accent survives only in the title-bar icon (type identity), never
  // on the node border/glow/handles.
  const color = 'var(--border-color)';
  // #2743 ST-6 (AC-8): the scoped tool-call detail opener — double-clicking an
  // accordion item calls the focus handler with the `tool-call` target union
  // (the DetailPanel renders that call's own input/output/outcome/duration).
  const onFocus = useNodeFocus();
  // #2743 ST-6 (AC-7): keyboard access equivalent to double-click on the node
  // itself (Tab to the node, Enter opens the full Tools Summary detail).
  const keyboardProps = useNodeKeyboardOpen(data);

  const payload = data.payload as unknown as ToolsNodePayload | undefined;
  const toolCalls: ToolCallSummary[] = payload?.toolCalls ?? [];
  const callCount = toolCalls.length;
  const sessionId = payload?.sessionId ?? '';

  // Σ of the per-call totals (AC2 semantics) — zero-guarded; 0 for opencode
  // (Architect D-1), byte-equal to telemetry absence. Never abbreviated.
  const totalTokens = toolCalls.reduce(
    (sum, call) => sum + normalizeTokenCount(call.totalTokens),
    0,
  );

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

  return (
    <>
      <Handle type="target" position={Position.Left} id="target-left"
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        role="group"
        aria-label={`Tools summary — ${callCount} calls, ${formatTokenCount(totalTokens)} tokens`}
        className={styles.nodeContainer}
        style={containerStyle}
        title="Double-click to view details"
        {...keyboardProps}
      >
        {/* ── Title bar: wrench icon · Tools · N calls · Σ per-call total ── */}
        <div className={styles.titleBar}>
          <span style={{ color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', marginRight: 6 }}>
            <LuWrench size={14} />
          </span>
          <span className={styles.titleText}>Tools · {callCount} calls</span>
        </div>

        {/* ── Accordion: one item per tool call (NFR-4 — node-internal state) ── */}
        <Accordion.Root multiple defaultValue={[]} variant="plain">
          {toolCalls.map((call, index) => (
            <ToolCallAccordionItem
              key={call.correlationId || `tool-${index}`}
              call={call}
              index={index}
              onOpenDetail={() => onFocus?.({ kind: 'tool-call', call, sessionId })}
            />
          ))}
        </Accordion.Root>
      </div>
    </>
  );
});
