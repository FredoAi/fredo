import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import { useNodeFocus } from '../NodeFocusContext';
import styles from './MonitorNode.module.css';

const GLOW_CLASS: Record<MonitorNodeStatus, string> = {
  working: styles.working, error: styles.error,
  permission_required: styles.permissionRequired, permission_granted: styles.permissionGranted,
  permission_denied: styles.permissionDenied, inactive: '',
};

export const ToolUseNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  const color = STATUS_COLORS[data.status];
  const isWorking = data.status === 'working';

  return (
    <>
      <Handle type="target" position={Position.Left}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        className={[styles.nodeContainer, GLOW_CLASS[data.status]].filter(Boolean).join(' ')}
        style={{
          background: '#12121f',
          border: `1.5px solid ${color}`,
          borderRadius: 8,
          padding: '7px 12px',
          minWidth: 150,
          maxWidth: 230,
          boxShadow: selected
            ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
            : '0 2px 8px rgba(0,0,0,0.4)',
          transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        }}
        onDoubleClick={(e) => { e.stopPropagation(); onFocus?.(data); }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 9, color: '#4b5563', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Tool use
          </span>
          <span
            className={isWorking ? styles.fileArrow : ''}
            style={{ color, fontSize: 17, fontWeight: 700, lineHeight: 1, display: 'inline-block' }}
            title={data.status}
          >›</span>
        </div>
        <div style={{
          marginTop: 2, fontSize: 13, fontWeight: 600, color: '#e2e8f0',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {data.sublabel ?? data.label}
        </div>
      </div>
      <Handle type="source" position={Position.Right}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
};

