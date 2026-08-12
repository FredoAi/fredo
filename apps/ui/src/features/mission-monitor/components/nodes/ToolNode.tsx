import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { LuWrench } from 'react-icons/lu';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import type { ToolNodePayload } from '../../lib/graph';
import styles from './MonitorNode.module.css';

const STATUS_CSS_CLASS: Record<MonitorNodeStatus, string> = {
  working:             styles.working,
  error:               styles.error,
  permission_required: styles.permissionRequired,
  permission_granted:  styles.permissionGranted,
  permission_denied:   styles.permissionDenied,
  inactive:            '',
  compacted:           '',
};

export const ToolNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const color = '#f97316'; // Orange accent
  const glowClass = STATUS_CSS_CLASS[data.status];
  const isInProgress = data.status === 'working' || data.status === 'permission_required';

  const payload = data.payload as unknown as ToolNodePayload | undefined;
  const toolName: string = payload?.toolName ?? 'unknown';
  const input: string = payload?.input ?? '';
  const output: string = payload?.output ?? '';

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        title={data.label}
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={{
          background: '#12121f',
          border: `1.5px solid ${color}`,
          borderRadius: 12,
          padding: '10px 14px',
          minWidth: 240,
          maxWidth: 320,
          boxShadow: selected
            ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
            : '0 2px 8px rgba(0,0,0,0.4)',
          transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        }}
      >
        {/* ── Title: Tool · {toolName} ── */}
        <div className={styles.titleBar}>
          <span style={{ color, display: 'flex', alignItems: 'center', marginRight: 6 }}>
            {isInProgress ? (
              <span className={styles.iconAnimateSpin}>
                <LuWrench size={12} />
              </span>
            ) : (
              <LuWrench size={12} />
            )}
          </span>
          <span className={styles.titleText} style={{ color: '#f97316' }}>
            Tool · {toolName}
          </span>
        </div>

        {/* ── SECTION 1: Input ── */}
        <div className={styles.sectionUser} style={{ marginBottom: 10 }}>
          <div className={styles.sectionLabel} style={{ color: '#f97316' }}>
            ── INPUT ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={{
            background: '#0a0a18',
            border: `1px solid ${color}28`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 10,
            color: '#cbd5e1',
            lineHeight: 1.55,
            maxHeight: 120,
            overflowY: 'auto',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            fontFamily: "'Cascadia Code','Fira Code',monospace",
          }}>
            {input || <span style={{ color: '#374151' }}>—</span>}
          </div>
        </div>

        {/* Section divider */}
        <div className={styles.sectionDivider} style={{ background: `${color}18` }} />

        {/* ── SECTION 2: Output ── */}
        <div style={{ marginBottom: 2 }}>
          <div className={styles.sectionLabel} style={{ color: '#64748b' }}>
            ── OUTPUT ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={{
            background: '#0a0a18',
            border: `1px solid ${color}28`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 10,
            color: '#cbd5e1',
            lineHeight: 1.55,
            maxHeight: 160,
            overflowY: 'auto',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            fontFamily: "'Cascadia Code','Fira Code',monospace",
          }}>
            {output
              ? output
              : isInProgress
                ? <span className={styles.loadingDots}>
                    <span className={styles.loadingDot}>●</span>
                    <span className={styles.loadingDot}>●</span>
                    <span className={styles.loadingDot}>●</span>
                  </span>
                : <span style={{ color: '#374151' }}>—</span>
            }
          </div>
        </div>
      </div>
    </>
  );
});
