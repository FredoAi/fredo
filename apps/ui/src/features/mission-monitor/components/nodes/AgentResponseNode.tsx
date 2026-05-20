import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { LuBrain } from 'react-icons/lu';
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

const STATUS_LABEL: Record<MonitorNodeStatus, string> = {
  working: 'WORKING', error: 'ERROR',
  permission_required: 'WAITING', permission_granted: 'GRANTED',
  permission_denied: 'DENIED', inactive: '',
};

export const AgentResponseNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  const color = STATUS_COLORS[data.status];
  const glowClass = STATUS_CSS_CLASS[data.status];
  const isWorking = data.status === 'working';

  // Counters from payload + relatedEvents
  const inputTokens: number | undefined = data.payload?.['gen_ai.usage.input_tokens'];
  const outputTokens: number | undefined = data.payload?.['gen_ai.usage.output_tokens'];
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);

  const toolsCount  = data.relatedEvents.filter(e =>
    e.eventType === 'execute_tool' || e.eventType === 'PreToolUse'
  ).length;
  const filesCount  = data.relatedEvents.filter(e =>
    ['edit','create','write','str_replace_based_edit_tool','apply_patch'].includes(e.eventType)
  ).length;
  const agentCount  = data.relatedEvents.filter(e => e.eventType === 'SubagentStart').length;

  const counters = [
    { val: toolsCount  > 0 ? toolsCount  : null, title: 'tools called' },
    { val: filesCount  > 0 ? filesCount  : null, title: 'files changed' },
    { val: agentCount  > 0 ? agentCount  : null, title: 'subagents' },
    { val: totalTokens > 0 ? totalTokens : null, title: `↑${inputTokens ?? 0} ↓${outputTokens ?? 0} tokens` },
  ];

  return (
    <>
      <Handle type="target" position={Position.Left}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={{
          background: '#12121f',
          border: `1.5px solid ${color}`,
          borderRadius: 12,
          padding: '10px 14px',
          minWidth: 300,
          maxWidth: 380,
          boxShadow: selected
            ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
            : '0 2px 8px rgba(0,0,0,0.4)',
          transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        }}
        onDoubleClick={(e) => { e.stopPropagation(); onFocus?.(data); }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ color, display: 'flex', alignItems: 'center' }}>
            <LuBrain size={13} />
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', flex: 1 }}>Agent Response</span>

          {/* Status badge */}
          {data.status !== 'inactive' && (
            <span style={{
              fontSize: 8, background: `${color}22`, color,
              borderRadius: 3, padding: '1px 5px', fontWeight: 700, letterSpacing: '0.05em',
            }}>
              {STATUS_LABEL[data.status]}
            </span>
          )}

          {/* Counters 1 2 3 4 */}
          {counters.map(({ val, title }, i) => val != null && (
            <span key={i} title={title} style={{
              fontSize: 9, color: `${color}bb`, background: `${color}15`,
              borderRadius: 3, padding: '1px 4px', fontFamily: 'monospace',
              minWidth: 14, textAlign: 'center',
            }}>
              {typeof val === 'number' && val > 9999
                ? `${(val / 1000).toFixed(1)}k`
                : val}
            </span>
          ))}
        </div>

        {/* Response text box */}
        <div style={{
          background: '#0a0a18',
          border: `1px solid ${color}28`,
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: 11.5,
          color: '#cbd5e1',
          lineHeight: 1.55,
          minHeight: 56,
          maxHeight: 150,
          overflowY: 'auto',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
        }}>
          {data.sublabel
            ? data.sublabel
            : isWorking
              ? <span style={{ color: `${color}77` }}>thinking…</span>
              : <span style={{ color: '#374151' }}>—</span>
          }
        </div>

        <div style={{ marginTop: 5, fontSize: 9, color: '#374151' }}>
          {new Date(data.timestamp).toLocaleTimeString()}
        </div>
      </div>
      <Handle type="source" position={Position.Right}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
};

