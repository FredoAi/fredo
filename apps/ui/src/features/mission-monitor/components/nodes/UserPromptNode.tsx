import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { LuMessageSquare } from 'react-icons/lu';
import type { MonitorNodeData } from '../../types';
import { STATUS_COLORS } from '../../types';
import { useNodeFocus } from '../NodeFocusContext';
import styles from './MonitorNode.module.css';

export const UserPromptNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  const color = STATUS_COLORS[data.status];
  const isWorking = data.status === 'working';
  const inputTokens = data.payload?.['gen_ai.usage.input_tokens'];
  const tokenCount = typeof inputTokens === 'number' ? inputTokens : undefined;

  return (
    <>
      <Handle type="target" position={Position.Left}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        className={[styles.nodeContainer, isWorking ? styles.working : ''].filter(Boolean).join(' ')}
        style={{
          background: '#12121f',
          border: `1.5px solid ${color}`,
          borderRadius: 12,
          padding: '10px 14px',
          minWidth: 280,
          maxWidth: 360,
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
            <LuMessageSquare size={13} />
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', flex: 1 }}>User Prompt</span>
          {tokenCount != null && (
            <span title="input tokens" style={{
              fontSize: 9, color: `${color}cc`, fontFamily: 'monospace',
              background: `${color}15`, borderRadius: 4, padding: '1px 5px',
            }}>
              {tokenCount.toLocaleString()}
            </span>
          )}
        </div>

        {/* Text content */}
        <div style={{
          background: '#0a0a18',
          border: `1px solid ${color}28`,
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: 11.5,
          color: '#cbd5e1',
          lineHeight: 1.55,
          minHeight: 44,
          maxHeight: 120,
          overflowY: 'auto',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
        }}>
          {data.sublabel ?? <span style={{ color: '#374151' }}>—</span>}
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

