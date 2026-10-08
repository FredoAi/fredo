/**
 * ToolCallAccordionItem — one accordion item per tool call (#2739 ST-2,
 * extracted to its own module by #2764 ST-2 so the removed ToolsNode.tsx file
 * could be deleted). Shared by ChatNode's and SubagentNode's embedded
 * `── TOOLS (N) ──` sections — the SAME anatomy renders both surfaces, so
 * they can never drift.
 *
 * Collapsed trigger: outcome dot (shared `getToolCallOutcome` colors — the
 * same mapping the DetailPanel scoped status row uses) + tool name (ellipsis)
 * + right-aligned per-tool duration (AC-10: duration_ms → start/end delta →
 * '—'). Expanded: the call's input/output in chat-node-style scrollable boxes
 * (monospace, `nowheel`, themed scrollbar).
 *
 * #2748 ST-7 (AC-5): the #2743 AC-9 success/error/in-progress outcome dots
 * are NEUTRALIZED — every call renders an identical plain `var(--border-color)`
 * dot with no status aria-label and no pulse animation. Per-call outcomes
 * remain visible in the DetailPanel scoped tool-call view (unchanged consumer).
 *
 * #2764 ST-3 (FR-2): the `onDoubleClick` + `stopPropagation` + `onOpenDetail`
 * interception covers the WHOLE `Accordion.Item` — collapsed trigger AND
 * expanded info content (INPUT/OUTPUT boxes). Double-clicking any part of an
 * item opens the scoped tool-call detail (`{ kind: 'tool-call' }` target) and
 * NEVER bubbles to ReactFlow's `onNodeDoubleClick`, which would otherwise
 * open/select the PARENT node (the reported double-click dead-end). Single
 * click stays accordion-toggle only (FR-6 — the Chakra uncontrolled state).
 *
 * Theming (NFR-9): ALL colors come from theme CSS vars — zero hardcoded
 * hex/rgba. Layout (NFR-4): accordion open/close is node-internal (uncontrolled
 * Chakra state) — it never enters the graph layout/structure signature
 * (Spec #275/#523 pattern).
 */
import React from 'react';
import { Accordion } from '@chakra-ui/react';
import type { ToolCallSummary } from '../../lib/graph';
import { formatToolDuration, getToolCallOutcome } from '../../lib/graph';
import styles from './MonitorNode.module.css';

const MONO_FONT = "'Cascadia Code','Fira Code','Consolas',monospace";

/**
 * Tool-call outcome → { label, color } — the SAME mapping the DetailPanel
 * scoped status row uses (shared getToolCallOutcome from graph.ts), so the
 * accordion dot and the detail status can never drift. error → status-error,
 * in-progress → accent-primary, success → status-success.
 */
function toolCallStatus(call: ToolCallSummary): { label: string; color: string } {
  const outcome = getToolCallOutcome(call);
  switch (outcome) {
    case 'error':       return { label: 'Failed', color: 'var(--status-error)' };
    case 'in-progress': return { label: 'In progress', color: 'var(--accent-primary)' };
    default:            return { label: 'Succeeded', color: 'var(--status-success)' };
  }
}

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

export const ToolCallAccordionItem: React.FC<{ call: ToolCallSummary; index: number; onOpenDetail: () => void }> = ({ call, index, onOpenDetail }) => {
  const value = call.correlationId || `tool-${index}`;

  // AC-10: per-tool duration — durationMs → startTime/endTime delta → '—'.
  const duration = formatToolDuration(call.durationMs, call.startTime, call.endTime);

  return (
    <Accordion.Item
      value={value}
      // #2764 ST-3 (FR-2): intercept double-click on the WHOLE item — trigger
      // AND expanded info content. stopPropagation so ReactFlow's
      // onNodeDoubleClick never also opens/selects the parent node.
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpenDetail();
      }}
    >
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
        {/* Tool-call outcome dot — reflects the call's real status via the
            shared getToolCallOutcome (same source as the DetailPanel scoped
            status row, so the two surfaces can never drift): error →
            var(--status-error), in-progress → var(--accent-primary), success →
            var(--status-success). */}
        <span
          aria-hidden="true"
          data-testid="tool-call-outcome-dot"
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: toolCallStatus(call).color,
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
