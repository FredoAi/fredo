import React, { useCallback, useEffect } from 'react';
import { LuX, LuBot, LuWrench, LuFilePen, LuBrain } from 'react-icons/lu';
import type { MonitorNodeData } from '../types';
import { STATUS_COLORS } from '../types';
import { formatTokenCount } from '../lib/graph';
import type { GraphNodeStatus, AgentNodePayload, ToolNodePayload, FileNodePayload, SubagentNodePayload } from '../lib/graph';
import { GRAPH_STATUS_COLORS } from '../lib/graph';

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

  // Agent-specific fields
  const promptTokens = (payload as AgentNodePayload).promptTokens ?? 0;
  const completionTokens = (payload as AgentNodePayload).completionTokens ?? 0;
  const totalTokens = promptTokens + completionTokens;
  const startTime = data.timestamp;
  const endTime = (payload as AgentNodePayload).endTime;

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
      onClick={handleBackgroundClick}
      style={{
        position: 'absolute',
        top: 0, right: 0, bottom: 0,
        width: 300,
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

        {/* Divider when there are token fields */}
        {nodeType === 'agent' && (
          <>
            <div style={{ height: 1, background: '#1e1e3a', margin: '8px 0' }} />
            <div style={{ fontSize: 9, color: '#6366f1', fontWeight: 700, marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Token Usage
            </div>
            <DetailRow label="Prompt" value={formatTokenCount(promptTokens)} mono />
            <DetailRow label="Completion" value={formatTokenCount(completionTokens)} mono />
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
