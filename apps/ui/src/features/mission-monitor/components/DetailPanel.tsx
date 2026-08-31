import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuX, LuBot, LuWrench, LuBrain } from 'react-icons/lu';
import type { MonitorNodeData } from '../types';
import { STATUS_COLORS } from '../types';
import { formatTokenCount, normalizeCost, normalizeTokenCount } from '../lib/graph';
import type { GraphNodeStatus, AgentNodePayload, SubagentNodePayload, ToolCallSummary, DetailOpenTarget } from '../lib/graph';
import { GRAPH_STATUS_COLORS, formatToolDuration, getToolCallOutcome } from '../lib/graph';
import { usePersistedSetting } from '../../../shared/hooks/usePersistedSetting';
import { tint } from '../../../shared/utils/colorTint';
import { serializeValue } from '../../settings';

// ── Panel width persistence (R-2, AC2) ─────────────────────────────────────────
// The width is persisted through the app-wide preference path
// (usePersistedSetting → settingsService → get_setting/save_setting SQLite IPC).
// The panel unmounts on close (MissionMonitorPanel), so the width must survive
// mount/unmount cycles — component state alone cannot. No localStorage literal
// lives in Mission Monitor source: the shared hook's localStorage write is a
// dev fallback inside shared code.
const PANEL_WIDTH_KEY = 'Fredo_mm_detail_panel_width';
const DEFAULT_PANEL_WIDTH = 300; // matches the historical hardcoded width
const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH = 520;
const KEYBOARD_STEP = 20;

/** Clamp a width into [MIN, MAX]; non-finite input → default (300). */
function clampPanelWidth(raw: number | string): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, n));
}

const NODE_TYPE_ICONS: Record<string, React.ReactNode> = {
  agent:    <LuBrain size={14} color="#a855f7" />,
  subagent: <LuBot size={14} color="#6366f1" />,
};

function formatDuration(startTime?: string, endTime?: string): string {
  if (!startTime) return '—';
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function extractNodeTypeFromEventType(eventType: string): string {
  if (eventType === 'agent') return 'agent';
  if (eventType === 'subagent') return 'subagent';
  return eventType;
}

/**
 * #2743 ST-6 (AC-8): the scoped tool-call status — mirrors the AC-9 indicator
 * states (single shared outcome definition from graph.ts, so the accordion dot
 * and this status row can never drift).
 */
function toolCallStatus(call: ToolCallSummary): { label: string; color: string } {
  const outcome = getToolCallOutcome(call);
  switch (outcome) {
    case 'error':       return { label: 'Failed', color: 'var(--status-error)' };
    case 'in-progress': return { label: 'In progress', color: 'var(--accent-primary)' };
    default:            return { label: 'Succeeded', color: 'var(--status-success)' };
  }
}

interface DetailPanelProps {
  target: DetailOpenTarget;
  onClose: () => void;
}

export const DetailPanel: React.FC<DetailPanelProps> = ({ target, onClose }) => {
  // #2743 ST-6 (AC-7/AC-8): the open target is a union — a graph node
  // (`{ kind: 'node' }`, opened by ReactFlow onNodeDoubleClick) or a scoped
  // tool call (`{ kind: 'tool-call' }`, opened by an embedded tool accordion
  // item double-click — #2764: in the chat node's or a subagent's embedded
  // TOOLS section). The panel shell (width persistence, resize, Escape) is
  // shared; only the header + content differ.
  const isToolCall = target.kind === 'tool-call';

  const nodeType = isToolCall ? 'tool-call' : extractNodeTypeFromEventType(target.data.eventType);
  const status = isToolCall ? 'inactive' : target.data.status;
  const statusColor = isToolCall
    ? toolCallStatus(target.call).color
    : (STATUS_COLORS[status] ?? '#334155');
  const icon = isToolCall
    ? <LuWrench size={14} />
    : (NODE_TYPE_ICONS[nodeType] ?? <LuBrain size={14} />);

  // Extract common fields
  const payload = isToolCall ? {} : (target.data.payload ?? {});
  const id = isToolCall
    ? target.call.correlationId
    : (target.data.payload?.correlationId as string ?? target.data.payload?.sessionId as string ?? '');
  const statusLabel = isToolCall
    ? toolCallStatus(target.call).label
    : status.replace(/_/g, ' ');

  // Agent-specific fields — Spec #2717 (R-2): the same five token categories
  // the node renders. Zero/absent categories show as 0 (R-3.3); Total uses the
  // node's arithmetic: Input + Cache + Reasoning + Output (R-3.1).
  const agentPayload = payload as AgentNodePayload;
  const inputTokens = normalizeTokenCount(agentPayload.promptTokens);
  const cacheReadTokens = normalizeTokenCount(agentPayload.cacheReadTokens);
  const reasoningTokens = normalizeTokenCount(agentPayload.reasoningTokens);
  const outputTokens = normalizeTokenCount(agentPayload.completionTokens);
  const totalTokens = inputTokens + cacheReadTokens + reasoningTokens + outputTokens;
  // Spec #2723 (R-6 / AC6): Start/End come from the span-derived times the
  // adapter injects into the payload (RFC3339 UTC from startTimeUnixNano /
  // endTimeUnixNano) so the rows match telemetry_spans. Fall back to the
  // delivery timestamps only when the payload lacks them (non-OTLP / legacy /
  // streaming span without an end). Display stays local-time via
  // toLocaleTimeString() (Architect #13 — format unchanged).
  const startTime = isToolCall ? undefined : (agentPayload.startTime ?? target.data.timestamp);
  const endTime = isToolCall ? undefined : agentPayload.endTime;

  // ── Panel width (R-2): persisted + drag-resizable ─────────────────────────
  // `persistedWidth` is loaded from settingsService on mount and written ONLY
  // when a drag ends (pointer-up) or a keyboard step commits — never per
  // pointer-move (no SQLite write during the drag). `dragWidth` drives the
  // live render while the pointer is down.
  const [persistedWidth, setPersistedWidth] = usePersistedSetting<number>(
    PANEL_WIDTH_KEY,
    DEFAULT_PANEL_WIDTH,
    serializeValue,
    clampPanelWidth,
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const dragRef = useRef<{ startClientX: number; startWidth: number } | null>(null);
  const dragWidthRef = useRef<number>(DEFAULT_PANEL_WIDTH);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const width = dragWidth ?? persistedWidth;

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Left-edge drag: width = startWidth + (startX - clientX). Pointer capture
    // keeps the move/up stream on the handle even when the pointer leaves it.
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
    dragRef.current = { startClientX: e.clientX, startWidth: persistedWidth };
    dragWidthRef.current = persistedWidth;
    setDragging(true);
    document.body.style.userSelect = 'none';
  }, [persistedWidth]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    const next = clampPanelWidth(start.startWidth + (start.startClientX - e.clientX));
    dragWidthRef.current = next;
    setDragWidth(next);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current) return;
    // Commit the clamped width exactly once, at drag end.
    setPersistedWidth(clampPanelWidth(dragWidthRef.current));
    setDragWidth(null);
    setDragging(false);
    dragRef.current = null;
    document.body.style.userSelect = '';
  }, [setPersistedWidth]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setPersistedWidth(clampPanelWidth(persistedWidth - KEYBOARD_STEP));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setPersistedWidth(clampPanelWidth(persistedWidth + KEYBOARD_STEP));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setPersistedWidth(MIN_PANEL_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      setPersistedWidth(MAX_PANEL_WIDTH);
    }
  }, [persistedWidth, setPersistedWidth]);

  // Escape: cancels an in-progress pointer drag (restoring the pre-drag width,
  // since the persisted width is untouched until pointer-up), otherwise closes
  // the panel. One listener owns both behaviors so Escape never both cancels
  // AND closes.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dragRef.current) {
        setDragWidth(null);
        setDragging(false);
        dragRef.current = null;
        document.body.style.userSelect = '';
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Unmount safety: never leave body user-select disabled mid-drag.
  useEffect(() => {
    return () => { document.body.style.userSelect = ''; };
  }, []);

  // Close on background click
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      data-testid="detail-panel"
      onClick={handleBackgroundClick}
      style={{
        position: 'absolute',
        top: 0, right: 0, bottom: 0,
        width,
        zIndex: 30,
        background: '#12121f',
        borderLeft: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'detail-slide-in 0.3s ease',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
      }}
    >
      <style>{`
        @keyframes detail-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
      `}</style>

      {/* Resize handle — left edge (R-2): 12px hit target, themed 1px line,
          accent tints on hover/drag, keyboard-accessible separator. */}
      <div
        data-testid="detail-panel-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize detail panel"
        aria-valuenow={Math.round(width)}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={(e) => {
          let visible = false;
          try { visible = e.currentTarget.matches(':focus-visible'); } catch { /* older jsdom */ }
          setFocused(visible);
        }}
        onBlur={() => setFocused(false)}
        style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: 12,
          cursor: 'col-resize',
          zIndex: 31,
          borderLeft: '1px solid var(--border-color)',
          background: dragging
            ? tint('var(--accent-primary)', 33)
            : hovered
              ? tint('var(--accent-primary)', 20)
              : 'transparent',
          transition: 'background 0.15s ease',
          touchAction: 'none',
          userSelect: 'none',
          outline: focused ? '2px solid var(--accent-primary)' : 'none',
          outlineOffset: focused ? -2 : 0,
        }}
      />

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px',
        borderBottom: '1px solid var(--border-color)',
        flexShrink: 0,
      }}>
        {icon}
        <span style={{ fontSize: 11, fontWeight: 700, color: '#e2e8f0', flex: 1 }}>
          {/* AC-8: the scoped tool-call header is `🔧 toolName` (never a generic
              all-tools view). #2764 AC4: a call whose toolName never resolved
              falls back to 'Unknown tool' — the header never renders blank. */}
          {isToolCall
            ? `🔧 ${target.call.toolName || 'Unknown tool'}`
            : nodeType.charAt(0).toUpperCase() + nodeType.slice(1)}
        </span>
        {/* #2750 ST-2 (AC2): the header status pill renders ONLY for tool-call
            targets (the per-tool outcome indicator — AC letter). Node targets
            no longer show any status chrome here: #2748 removed node status
            from the graph nodes themselves, and the detail panel must not
            contradict the graph by re-adding it. */}
        {isToolCall && (
          <span style={{
            fontSize: 9,
            background: `${statusColor}22`,
            color: statusColor,
            borderRadius: 3,
            padding: '1px 5px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            {statusLabel}
          </span>
        )}
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#4b5563', padding: 2, display: 'flex', alignItems: 'center',
          }}
        >
          <LuX size={13} />
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        {isToolCall ? (
          /* #2743 ST-6 (AC-8): the scoped per-tool detail — THAT call's own
             Status / Duration / Input / Output, never a generic all-tools view. */
          <ToolCallDetailView call={target.call} />
        ) : (
          <>
        {/* Node ID */}
        <DetailRow label="ID" value={id} mono />

        {/* Type */}
        <DetailRow label="Type" value={nodeType} />

        {/* #2750 ST-2 (AC2): the Status row is REMOVED for node targets — the
            graph nodes carry no status (#2748), so the detail panel must not
            re-add the status chrome the graph dropped. Per-tool outcome
            indicators inside a tool call remain (ToolCallDetailView). */}

        {/* #2688 AC4: input / output / thoughts / model rows for chat nodes.
            Absent sections are hidden, not rendered empty. */}
        {nodeType === 'agent' && (
          <>
            {agentPayload.userMessage ? (
              <DetailRow label="Input" value={agentPayload.userMessage} mono />
            ) : null}
            {agentPayload.agentReply ? (
              <DetailRow label="Output" value={agentPayload.agentReply} mono />
            ) : null}
            {agentPayload.agentThinking ? (
              <DetailRow label="Thoughts" value={agentPayload.agentThinking} mono />
            ) : null}
            {agentPayload.model ? (
              <DetailRow label="Model" value={agentPayload.model} mono />
            ) : null}
          </>
        )}

        {/* #2745 ST-5 (AC-1): the rich SubagentNode disclosure — instruction /
            output / childSessionId content rows + a Child Usage block (child
            tokens / cost / messages). Mirrors the AgentNodePayload pattern:
            absent sections are hidden, not rendered empty. */}
        {nodeType === 'subagent' && (
          <SubagentDetailView payload={payload as SubagentNodePayload} />
        )}

        {/* Divider when there are token fields */}
        {nodeType === 'agent' && (
          <>
            <div style={{ height: 1, background: 'var(--border-color)', margin: '8px 0' }} />
            <div style={{ fontSize: 9, color: '#6366f1', fontWeight: 700, marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Token Usage
            </div>
            <DetailRow label="Input" value={formatTokenCount(inputTokens)} mono />
            <DetailRow label="Cache" value={formatTokenCount(cacheReadTokens)} mono />
            <DetailRow label="Reasoning" value={formatTokenCount(reasoningTokens)} mono />
            <DetailRow label="Output" value={formatTokenCount(outputTokens)} mono />
            <DetailRow label="Total" value={formatTokenCount(totalTokens)} mono />
            {/* #2750 ST-4 (AC5): the node's Estimated Cost — byte-identical to
                the ChatNode cost row (ChatNode.tsx:239-251): en-US comma-
                grouped, 4-decimal `$X.XXXX`. Read from the RAW payload field
                (agentPayload.costUsd — never through normalizeCost); absent →
                the design's '—' (the per-node figure matches the graph). */}
            <DetailRow
              label="Estimated Cost"
              value={
                agentPayload.costUsd === undefined
                  ? '—'
                  : `$${agentPayload.costUsd.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
              }
              mono
            />
          </>
        )}

        {/* Divider for timestamps — the delivery-timestamp fallback renders a
            Start/Duration pair only when the payload carries real times. */}
        {(startTime || endTime) && (
          <>
            <div style={{ height: 1, background: 'var(--border-color)', margin: '8px 0' }} />
            <div style={{ fontSize: 9, color: '#6366f1', fontWeight: 700, marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Timing
            </div>
            {startTime && (
              <DetailRow label="Start" value={new Date(startTime).toLocaleTimeString()} />
            )}
            {endTime && (
              <DetailRow label="End" value={new Date(endTime).toLocaleTimeString()} />
            )}
            <DetailRow label="Duration" value={formatDuration(startTime, endTime)} mono />
          </>
        )}
          </>
        )}
      </div>
    </div>
  );
};

// ── #2745 ST-5 (AC-1): rich SubagentNode detail view ─────────────────────────
//
// The panel opened by selecting a SubagentNode. Mirrors the AgentNodePayload
// disclosure (absent sections hidden, not rendered empty): the dispatch
// instruction, the child's final output, the child session id chip, and a
// "Child Usage" block with the child's token total / cost / message count —
// the same zero-guarded figures the node renders (normalizeTokenCount /
// normalizeCost; absent child cost renders the absent-state '—').

const SubagentDetailView: React.FC<{ payload: SubagentNodePayload }> = ({ payload }) => {
  const childTokens = normalizeTokenCount(payload.childTokens);
  const childCost = payload.childCost === undefined
    ? undefined
    : normalizeCost(payload.childCost);
  return (
    <>
      {payload.instruction ? (
        <DetailRow label="Instruction" value={payload.instruction} mono />
      ) : null}
      {payload.output ? (
        <DetailRow label="Output" value={payload.output} mono />
      ) : null}
      {payload.childSessionId ? (
        <DetailRow label="Child Session" value={payload.childSessionId} mono />
      ) : null}

      {/* Divider + Child Usage block — present whenever any child figure is
          deliverable; the figures themselves zero-guard (never NaN). */}
      <div style={{ height: 1, background: 'var(--border-color)', margin: '8px 0' }} />
      <div style={{ fontSize: 9, color: '#6366f1', fontWeight: 700, marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        Child Usage
      </div>
      <DetailRow label="Tokens" value={formatTokenCount(childTokens)} mono />
      <DetailRow
        label="Cost"
        value={childCost === undefined ? '—' : `$${childCost.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`}
        mono
      />
      {payload.childMessages !== undefined ? (
        <DetailRow label="Messages" value={String(payload.childMessages)} mono />
      ) : null}
    </>
  );
};

// ── #2743 ST-6 (AC-8): scoped per-tool detail view ───────────────────────────
//
// The panel opened by double-clicking an embedded tool accordion item
// (#2764: in the chat node's or a subagent's `── TOOLS (N) ──` section).
// Shows THAT call's own outcome (Status), Duration, full Input and full Output
// — never a generic or all-tools detail view. Status mirrors the AC-9 indicator
// (shared getToolCallOutcome); Duration uses the same formatToolDuration the
// accordion item uses (duration_ms → start/end delta → '—').
//
// #2764 AC4 (FR-4): every row degrades to an explicit placeholder — the panel
// shell (close button, resize handle, Escape) always renders, Input/Output
// empty strings read as '—', and when BOTH input and output are empty one
// secondary hint line makes the panel read as data-absent, never broken.

const ToolCallDetailView: React.FC<{ call: ToolCallSummary }> = ({ call }) => {
  const outcome = toolCallStatus(call);
  const duration = formatToolDuration(call.durationMs, call.startTime, call.endTime);
  return (
    <>
      <DetailRow label="Status" value={outcome.label} color={outcome.color} />
      <DetailRow label="Duration" value={duration} mono />
      <DetailRow label="Input" value={call.input || '—'} mono />
      <DetailRow label="Output" value={call.output || '—'} mono />
      {/* #2764 AC4: when BOTH input and output are empty, one secondary hint
          line — the panel reads as data-absent, never as broken. */}
      {!call.input && !call.output && (
        <div style={{
          fontSize: 10,
          color: 'var(--text-secondary)',
          fontStyle: 'italic',
          marginTop: 8,
          lineHeight: 1.5,
        }}>
          No call details were captured for this tool call.
        </div>
      )}
    </>
  );
};

// ── Detail row helper ────────────────────────────────────────────────────────

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
}

const DetailRow: React.FC<DetailRowProps> = ({ label, value, mono, color }) => (
  <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'baseline' }}>
    <span style={{
      fontSize: 9, color: '#4b5563', minWidth: 70,
      textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
    }}>
      {label}
    </span>
    <span style={{
      fontSize: 10,
      fontFamily: mono ? "'Cascadia Code','Fira Code',monospace" : 'inherit',
      color: color ?? '#cbd5e1',
      wordBreak: 'break-all',
      lineHeight: 1.4,
    }}>
      {value}
    </span>
  </div>
);
