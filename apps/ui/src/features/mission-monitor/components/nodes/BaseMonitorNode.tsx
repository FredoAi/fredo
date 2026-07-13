import React from 'react';
import { Handle, Position } from 'reactflow';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import styles from './MonitorNode.module.css';

const STATUS_LABEL: Record<MonitorNodeStatus, string> = {
  working:             'working',
  error:               'error',
  permission_required: 'needs permission',
  permission_granted:  'granted',
  permission_denied:   'denied',
  inactive:            'done',
  compacted:           'COMPACTED',
};

const STATUS_CSS_CLASS: Record<MonitorNodeStatus, string> = {
  working:             styles.working,
  error:               styles.error,
  permission_required: styles.permissionRequired,
  permission_granted:  styles.permissionGranted,
  permission_denied:   styles.permissionDenied,
  inactive:            '',
  compacted:           styles.compacted,
};

interface BaseMonitorNodeProps {
  data: MonitorNodeData;
  selected?: boolean;
  icon: React.ReactNode;
  minWidth?: number;
  /** Called when the user double-clicks — used to open Focus Window */
  onFocus?: (data: MonitorNodeData) => void;
}

export const BaseMonitorNode: React.FC<BaseMonitorNodeProps> = ({
  data,
  selected,
  icon,
  minWidth = 160,
  onFocus,
}) => {
  const color = STATUS_COLORS[data.status];
  const glowClass = STATUS_CSS_CLASS[data.status];

  const isCompacted = data.status === 'compacted';
  const containerStyle: React.CSSProperties = {
    background: '#12121f',
    border: `1.5px ${isCompacted ? 'dashed' : 'solid'} ${color}`,
    borderRadius: '8px',
    padding: '8px 12px',
    minWidth: `${minWidth}px`,
    maxWidth: '240px',
    boxShadow: selected
      ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
      : '0 2px 8px rgba(0,0,0,0.4)',
    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
    ...(isCompacted ? {
      opacity: 0.45,
      filter: 'grayscale(0.7)',
    } : {}),
  };

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: color, border: 'none', width: 8, height: 8, transition: 'background 0.3s ease' }}
      />

      <div
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={containerStyle}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onFocus?.(data);
        }}
      >
        <div className={styles.iconRow}>
          <span style={{ color, flexShrink: 0, display: 'flex', alignItems: 'center', transition: 'color 0.3s ease' }}>
            {icon}
          </span>
          <span className={styles.label}>{data.label}</span>
          {data.status !== 'inactive' && (
            <span
              className={styles.statusBadge}
              style={{ background: `${color}22`, color }}
            >
              {STATUS_LABEL[data.status]}
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

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: color, border: 'none', width: 8, height: 8, transition: 'background 0.3s ease' }}
      />
    </>
  );
};
