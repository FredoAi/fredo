/**
 * SubagentNode — the #2745 ST-5 RICH subagent deliverable card (AC-1).
 *
 * One node per user-requested `task` dispatch (built by ST-4's association
 * pass; id `subagent-<corrId>`, type `subagentNode`). It renders the dispatch
 * intent (name + instruction), the child's final output
 * (`gen_ai.tool.call.result`), the deterministic duration, and the child's
 * token usage / estimated cost — ALL from the delivered `SubagentNodePayload`
 * (`data.payload`). #2748 ST-7 (AC-5) removed the status badge + working pulse
 * (R-5.1/R-5.3) — node border/glow/handles are plain neutral.
 *
 * Theming (AC-1 letter — theme tokens ONLY): surface `var(--card-bg)`,
 * content boxes `var(--body-bg)`, borders/dividers `var(--border-color)`
 * (+ var-alpha tints like `var(--accent-subagent)28` — NEVER rgba), body text
 * `var(--text-primary)`, labels/placeholders `var(--text-secondary)`, identity
 * accent `var(--accent-subagent)` (title-bar icon + INSTRUCTION label only —
 * never on node border/glow/handles). The width bounds are the shared ST-4
 * constants from lib/layout.ts (420/540) — no component-local width literals
 * (the dead component's hardcoded dark surface / indigo accents / dark content
 * boxes and inline width bounds are eliminated). `COMPACTED_STYLES` numeric
 * values (opacity/grayscale) are reused; any literal-colored compacted chrome
 * the node renders is tokenized.
 *
 * The node is no longer terminal (#2762 ST-3): it keeps its `target-right`
 * handle (the edge from the parent's `source-left` lands there) and gains an
 * additive `source-left` handle so ITS OWN nested subagents can chain off it
 * (the nested `e-calls-*` edge family sources here; root edges keep explicit
 * handles, so root rendering is unchanged).
 *
 * #2762 ST-3 (D-1b/D-3): the card embeds a `── TOOLS (N) ──` accordion (the
 * child session's own tool calls, reusing ToolCallAccordionItem from
 * ToolsNode), a `[L{depth}]` chip (only when the session's max delegation
 * depth ≥ 2 — flat parity), a `▸ N nested` chip (only when the subagent
 * dispatched subagents itself), and a compact L3+ variant (title + one
 * summary line — bounding DOM weight for deep trees). All conditional on
 * payload fields that stay ABSENT in no-nesting sessions, so those cards are
 * byte-identical to today (R-7). Keyboard-open (Enter → DetailPanel) is
 * retained via `useNodeKeyboardOpen` (the #2743 ST-6 AC-7 pattern).
 */
import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Accordion } from '@chakra-ui/react';
import { LuBot } from 'react-icons/lu';
import type { MonitorNodeData } from '../../types';
import { COMPACTED_STYLES } from '../../types';
import type { SubagentNodePayload } from '../../lib/graph';
import {
  formatCompactTokenCount,
  formatSubagentOutput,
  formatToolDuration,
  formatTokenCount,
  normalizeCost,
  normalizeTokenCount,
} from '../../lib/graph';
import { SUBAGENT_NODE_MIN_WIDTH, SUBAGENT_NODE_MAX_WIDTH } from '../../lib/layout';
import { useNodeFocus, useNodeKeyboardOpen } from '../NodeFocusContext';
import { ToolCallAccordionItem } from './ToolsNode';
import styles from './MonitorNode.module.css';

const MONO_FONT = "'Cascadia Code','Fira Code','Consolas',monospace";

/** en-US 4-decimal cost format (`$X.XXXX` — the ChatNode AC-12 pattern). */
function formatChildCost(cost: number): string {
  return cost.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

export const SubagentNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const isCompacted = data.status === 'compacted';

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

  // ── #2762 ST-3 nested-card inputs (all absent in no-nesting sessions) ──
  const tools = payload?.tools ?? [];
  const nestedCount = payload?.nestedCount ?? 0;
  const depth = payload?.depth;
  const sessionMaxDepth = payload?.sessionMaxDepth;
  // D-1c flat parity: the depth chip renders ONLY when the session's max
  // observed delegation depth ≥ 2.
  const showDepthChip = depth !== undefined && sessionMaxDepth !== undefined && sessionMaxDepth >= 2;
  // D-3 compact variant: cards at L3+ render reduced anatomy (title + one
  // summary line) — bounding DOM weight for deep trees; full detail stays one
  // double-click away in DetailPanel.
  const isCompact = (depth ?? 0) >= 3;
  // #2743 ST-6 (AC-8): scoped tool-call detail for embedded accordion items.
  const onFocus = useNodeFocus();
  const sessionId = payload?.sessionId ?? '';

  // Is this node awaiting the child's final output? (working state, none yet)
  const isAwaiting: boolean = data.status === 'working' && !output;

  // #2748 ST-7 (AC-5): plain neutral border — `1.5px solid var(--border-color)`
  // regardless of status (the subagent identity accent stays ONLY in the
  // title-bar icon + INSTRUCTION label, never on the node border/glow/handles).
  // Compacted keeps the tokenized dashed border + opacity/grayscale as a
  // NON-text state signal.
  const border = isCompacted
    ? '1.5px dashed var(--border-color)'
    : '1.5px solid var(--border-color)';

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
      ? '0 0 0 2px var(--accent-primary)66'
      : '0 2px 8px var(--border-color)33',
    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
  };

  // #2743 ST-6 (AC-7): keyboard access equivalent to double-click.
  const keyboardProps = useNodeKeyboardOpen(data);

  // §A-8: the child-session link navigates when the child session exists in
  // the session list, copies otherwise. Child sessions never appear in the
  // sidebar (sessions derive ONLY from chat-node deliveries — useSessionHistory
  // filters isChatNodeDelivery). The childSessionId is kept in the payload for
  // this purpose but is NOT rendered in the node (human decision: the id is
  // noise on the node; the session link is available on demand via the
  // detail view).

  return (
    <>
      {/* The target handle — the edge from the parent's `source-left` lands
          here (chat node for L1 dispatches, SubagentNode for nested ones —
          both use the same handle contract; subagents sit LEFT of their
          parent). #2762 ST-3: the node is no longer terminal — the additive
          `source-left` handle below sources ITS OWN nested-subagent edges.
          Root edges keep explicit handles, so root rendering is unchanged.
          #2748 ST-7 (AC-5): neutral handle — `var(--border-color)`. */}
      <Handle type="target" position={Position.Right} id="target-right"
        style={{
          background: 'var(--border-color)',
          border: 'none', width: 8, height: 8,
        }} />
      <Handle type="source" position={Position.Left} id="source-left"
        style={{
          background: 'var(--border-color)',
          border: 'none', width: 8, height: 8,
        }} />
      <div
        title="Double-click to view details"
        className={styles.nodeContainer}
        style={containerStyle}
        role="article"
        aria-label={`Subagent · ${name || '—'}${depth !== undefined ? ` · level ${depth}` : ''}`}
        {...keyboardProps}
      >
        {/* ── Title bar: LuBot · Subagent · name · [L{depth}] chip · duration
            (#2748 ST-7/AC-5: status badge + working pulse removed; depth chip
            only when the session's max delegation depth ≥ 2 — D-1c) ── */}
        <div className={styles.titleBar}>
          <span style={{ color: 'var(--accent-subagent)', display: 'flex', alignItems: 'center', marginRight: 6 }}>
            <LuBot size={14} />
          </span>
          <span className={styles.titleText} style={{ color: 'var(--accent-subagent)' }}>
            Subagent · {name || '—'}
          </span>
          {showDepthChip && (
            <span
              aria-label={`Delegation level ${depth}`}
              style={{
                marginLeft: 6, flexShrink: 0, whiteSpace: 'nowrap',
                fontSize: 10, fontFamily: MONO_FONT,
                color: 'var(--text-secondary)', background: 'var(--body-bg)',
                border: '1px solid var(--border-color)', borderRadius: 4,
                padding: '0 4px',
              }}
            >
              [L{depth}]
            </span>
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
        </div>

        {isCompact ? (
          /* ── Compact L3+ variant (D-3): one summary line — full detail stays
              one double-click away in DetailPanel. ── */
          <div
            style={{
              marginTop: 8, fontSize: 11, fontFamily: MONO_FONT,
              color: 'var(--text-secondary)', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}
            aria-label={`${tools.length} tools, ${nestedCount} nested, ${formatCompactTokenCount(childTokens)} tokens`}
          >
            {tools.length} tools · {nestedCount} nested · {formatCompactTokenCount(childTokens)} tok
          </div>
        ) : (
          <>
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

        {/* ── SECTION 2: TOOLS (N) (#2762 ST-3 / D-1b/D-3) — the child
            session's own tool calls, embedded by containment (never a
            floating sibling column). Reuses ToolCallAccordionItem so the
            anatomy cannot drift from the root ToolsNode. Hidden entirely
            when N = 0 (flat parity). `nowheel` + bounded maxHeight so a
            tool-heavy child never makes the card unbounded; accordion
            open/close is node-internal Chakra state — it never enters the
            graph structure signature (NFR-4). ── */}
        {tools.length > 0 && (
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
                    key={call.correlationId || `subtool-${index}`}
                    call={call}
                    index={index}
                    onOpenDetail={() => onFocus?.({ kind: 'tool-call', call, sessionId })}
                  />
                ))}
              </Accordion.Root>
            </div>
          </div>
        )}

        {/* Section divider */}
        <div className={styles.sectionDivider} style={{ background: 'var(--border-color)18' }} />

        {/* ── SECTION 3: Output (child's final output, mono) ── */}
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

        {/* ── Nested-activity chip (#2762 ST-3 / D-3 §6) — only when this
            subagent dispatched subagents itself. Passive indicator for now;
            the D-5 collapse toggle that upgrades it is ST-4's. ── */}
        {nestedCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <span
              aria-label={`${nestedCount} nested subagents`}
              style={{
                fontSize: 10, fontFamily: MONO_FONT, whiteSpace: 'nowrap',
                color: 'var(--text-secondary)',
              }}
            >
              ▸ {nestedCount} nested
            </span>
          </div>
        )}
          </>
        )}
      </div>
    </>
  );
});
