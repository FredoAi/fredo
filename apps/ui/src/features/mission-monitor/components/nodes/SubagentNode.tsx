import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { LuBot, LuListTodo } from 'react-icons/lu';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import { useNodeFocus } from '../NodeFocusContext';
import styles from './MonitorNode.module.css';

const STATUS_CSS_CLASS: Record<MonitorNodeStatus, string> = {
  working:             styles.working,
  error:               styles.error,
  permission_required: styles.permissionRequired,
  permission_granted:  styles.permissionGranted,
  permission_denied:   styles.permissionDenied,
  inactive:            '',
};

interface SubagentPayload {
  parentCorrelationId: string;
  agentName?: string;
  subagentType: 'agent' | 'subtask';
  status: 'working' | 'inactive';
  outputText?: string;
}

export const SubagentNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const onFocus = useNodeFocus();
  const color = STATUS_COLORS[data.status];
  const glowClass = STATUS_CSS_CLASS[data.status];

  const payload = data.payload as unknown as SubagentPayload | undefined;
  const subagentType = payload?.subagentType ?? 'agent';
  const agentName = payload?.agentName;
  const outputText = payload?.outputText ?? '';

  const icon = subagentType === 'subtask' ? <LuListTodo size={14} /> : <LuBot size={14} />;

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: color, border: 'none', width: 6, height: 6 }} />
      <div
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={{
          background: '#12121f',
          border: `1.5px solid ${color}`,
          borderRadius: 8,
          padding: '6px 10px',
          minWidth: 160,
          maxWidth: 260,
          boxShadow: selected
            ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
            : '0 2px 8px rgba(0,0,0,0.4)',
          transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        }}
        onDoubleClick={(e) => { e.stopPropagation(); onFocus?.(data); }}
      >
        {/* ── Icon + Label row ── */}
        <div className={styles.iconRow}>
          <span style={{ color, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            {icon}
          </span>
          <span className={styles.label}>{data.label}</span>
          {data.status !== 'inactive' && (
            <span
              className={styles.statusBadge}
              style={{ background: `${color}22`, color }}
            >
              {subagentType === 'subtask' ? 'subtask' : 'agent'}
            </span>
          )}
        </div>

        {/* ── Agent name ── */}
        {agentName && (
          <div style={{
            fontSize: 10,
            color: '#94a3b8',
            marginTop: 2,
            fontFamily: 'monospace',
          }}>
            {agentName}
          </div>
        )}

        {/* ── Output text preview ── */}
        {outputText && (
          <div style={{
            fontSize: 10,
            color: '#cbd5e1',
            marginTop: 3,
            lineHeight: 1.4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 240,
          }}>
            {outputText.length > 80 ? outputText.slice(0, 80) + '…' : outputText}
          </div>
        )}

        <div className={styles.timestamp}>
          {new Date(data.timestamp).toLocaleTimeString()}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom}
        style={{ background: color, border: 'none', width: 6, height: 6 }} />
    </>
  );
});
