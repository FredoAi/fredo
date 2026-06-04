import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { LuLock } from 'react-icons/lu';
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

const PERM_STATUS_LABEL: Record<MonitorNodeStatus, string> = {
  working: '',
  error: '',
  permission_required: 'ASKED',
  permission_granted: 'GRANTED',
  permission_denied: 'DENIED',
  inactive: '',
};

export const PermissionNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  const color = STATUS_COLORS[data.status];
  const glowClass = STATUS_CSS_CLASS[data.status];
  const labelText = PERM_STATUS_LABEL[data.status];

  return (
    <>
      <Handle type="target" position={Position.Left}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={{
          background: '#12121f',
          border: `1.5px solid ${color}`,
          borderRadius: 8,
          padding: '8px 12px',
          minWidth: 180,
          maxWidth: 240,
          boxShadow: selected
            ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
            : '0 2px 8px rgba(0,0,0,0.4)',
          transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        }}
        onDoubleClick={(e) => { e.stopPropagation(); onFocus?.(data); }}
      >
        <div className={styles.iconRow}>
          <span style={{ color, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <LuLock size={13} />
          </span>
          <span className={styles.label}>{data.label}</span>
          {labelText && (
            <span className={styles.statusBadge} style={{ background: `${color}22`, color }}>
              {labelText}
            </span>
          )}
        </div>

        {data.sublabel && (
          <div className={styles.sublabel} title={data.sublabel}>
            {data.sublabel}
          </div>
        )}

        <div className={styles.timestamp}>
          {new Date(data.timestamp).toLocaleTimeString()}
        </div>
      </div>
      <Handle type="source" position={Position.Right}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
};
