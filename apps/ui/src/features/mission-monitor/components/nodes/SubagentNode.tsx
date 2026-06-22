import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import type { SubagentPayload } from '../../lib/contract';
import styles from './MonitorNode.module.css';

const STATUS_CSS_CLASS: Record<MonitorNodeStatus, string> = {
  working:             styles.working,
  error:               styles.error,
  permission_required: styles.permissionRequired,
  permission_granted:  styles.permissionGranted,
  permission_denied:   styles.permissionDenied,
  inactive:            '',
};

export const SubagentNode = React.memo(({ data }: NodeProps<MonitorNodeData>) => {
  const color = STATUS_COLORS[data.status];
  const glowClass = STATUS_CSS_CLASS[data.status];

  // Read SubagentPayload from data.payload
  const payload = data.payload as unknown as SubagentPayload | undefined;
  const subagentName: string = payload?.subagentName ?? '';
  const instruction: string = payload?.instruction ?? '';
  const output: string = payload?.output ?? '';

  // Is this node awaiting output? (working status, no output text yet)
  const isAwaiting: boolean = data.status === 'working' && !output;

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={{
          background: '#12121f',
          border: `1.5px solid ${color}`,
          borderRadius: 12,
          padding: '10px 14px',
          minWidth: 280,
          maxWidth: 360,
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        }}
      >
        {/* ── Title: Subagent · {name} ── */}
        <div className={styles.titleBar}>
          <span className={styles.titleText} style={{ color: '#6366f1' }}>Subagent · {subagentName}</span>
        </div>

        {/* ── SECTION 1: Input ── */}
        <div className={styles.sectionUser} style={{ marginBottom: 10 }}>
          <div className={styles.sectionLabel} style={{ color: '#6366f1' }}>
            ── INPUT ──
          </div>
          <div style={{
            background: '#0a0a18',
            border: `1px solid ${color}28`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 11.5,
            color: '#cbd5e1',
            lineHeight: 1.55,
            maxHeight: 120,
            overflowY: 'auto',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            {instruction || <span style={{ color: '#374151' }}>—</span>}
          </div>
        </div>

        {/* Section divider */}
        <div className={styles.sectionDivider} style={{ background: `${color}18` }} />

        {/* ── SECTION 2: Output ── */}
        <div style={{ marginBottom: 2 }}>
          <div className={styles.sectionLabel} style={{ color: '#64748b' }}>
            ── OUTPUT ──
          </div>
          <div style={{
            background: '#0a0a18',
            border: `1px solid ${color}28`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 11.5,
            color: '#cbd5e1',
            lineHeight: 1.55,
            maxHeight: 160,
            overflowY: 'auto',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            {output
              ? output
              : isAwaiting
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
      <Handle type="source" position={Position.Bottom}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
});
