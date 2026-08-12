import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuX, LuBot, LuWrench, LuFilePen, LuBrain } from 'react-icons/lu';
import type { MonitorNodeData } from '../types';
import { STATUS_COLORS } from '../types';
import { formatTokenCount, normalizeTokenCount } from '../lib/graph';
import type { GraphNodeStatus, AgentNodePayload, ToolNodePayload, FileNodePayload, SubagentNodePayload } from '../lib/graph';
import { GRAPH_STATUS_COLORS } from '../lib/graph';
import { usePersistedSetting } from '../../../shared/hooks/usePersistedSetting';
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
  tool:     <LuWrench size={14} color="#f97316" />,
  file:     <LuFilePen size={14} color="#22c55e" />,
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
  if (eventType === 'tool') return 'tool';
  if (eventType === 'file') return 'file';
  return eventType;
}

interface DetailPanelProps {
  data: MonitorNodeData;
  onClose: () => void;
}

export const DetailPanel: React.FC<DetailPanelProps> = ({ data, onClose }) => {
  const nodeType = extractNodeTypeFromEventType(data.eventType);
  const status = data.status;
  const statusColor = STATUS_COLORS[status] ?? '#334155';
  const icon = NODE_TYPE_ICONS[nodeType] ?? <LuBrain size={14} />;

  // Extract common fields
  const payload = data.payload ?? {};
  const id = data.payload?.correlationId as string ?? data.payload?.sessionId as string ?? '';
  const statusLabel = status.replace(/_/g, ' ');

  // Agent-specific fields — Spec #2717 (R-2): the same five token categories
  // the node renders. Zero/absent categories show as 0 (R-3.3); Total uses the
  // node's arithmetic: Input + Cache + Reasoning + Output (R-3.1).
  const agentPayload = payload as AgentNodePayload;
  const inputTokens = normalizeTokenCount(agentPayload.promptTokens);
  const cacheReadTokens = normalizeTokenCount(agentPayload.cacheReadTokens);
  const reasoningTokens = normalizeTokenCount(agentPayload.reasoningTokens);
  const outputTokens = normalizeTokenCount(agentPayload.completionTokens);
  const totalTokens = inputTokens + cacheReadTokens + reasoningTokens + outputTokens;
  const startTime = data.timestamp;
  const endTime = agentPayload.endTime;

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
        borderLeft: '1px solid #1e1e3a',
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
            ? 'var(--accent-primary)55'
            : hovered
              ? 'var(--accent-primary)33'
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
        borderBottom: '1px solid #1e1e3a',
        flexShrink: 0,
      }}>
        {icon}
        <span style={{ fontSize: 11, fontWeight: 700, color: '#e2e8f0', flex: 1 }}>
          {nodeType.charAt(0).toUpperCase() + nodeType.slice(1)}
        </span>
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
        {/* Node ID */}
        <DetailRow label="ID" value={id} mono />

        {/* Type */}
        <DetailRow label="Type" value={nodeType} />

        {/* Status */}
        <DetailRow label="Status" value={statusLabel} color={statusColor} />

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

        {/* Divider when there are token fields */}
        {nodeType === 'agent' && (
          <>
            <div style={{ height: 1, background: '#1e1e3a', margin: '8px 0' }} />
            <div style={{ fontSize: 9, color: '#6366f1', fontWeight: 700, marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Token Usage
            </div>
            <DetailRow label="Input" value={formatTokenCount(inputTokens)} mono />
            <DetailRow label="Cache" value={formatTokenCount(cacheReadTokens)} mono />
            <DetailRow label="Reasoning" value={formatTokenCount(reasoningTokens)} mono />
            <DetailRow label="Output" value={formatTokenCount(outputTokens)} mono />
            <DetailRow label="Total" value={formatTokenCount(totalTokens)} mono />
          </>
        )}

        {/* Divider for timestamps */}
        {(startTime || endTime) && (
          <>
            <div style={{ height: 1, background: '#1e1e3a', margin: '8px 0' }} />
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
      </div>
    </div>
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
