import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import type { SubagentNodePayload } from '../../lib/graph';
import { COMPACTED_STYLES } from '../../types';
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

export const SubagentNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const isCompacted = data.status === 'compacted';
  const color = isCompacted ? COMPACTED_STYLES.borderColor : STATUS_COLORS[data.status];
  const glowClass = isCompacted ? '' : STATUS_CSS_CLASS[data.status];

  // Read SubagentNodePayload from data.payload
  const payload = data.payload as unknown as SubagentNodePayload | undefined;
  const name: string = payload?.name ?? '';
  const instruction: string = payload?.instruction ?? '';
  const rawOutput: string = payload?.output ?? '';

  // Sanitize output: strip ALL <br> tag variants and normalize line breaks
  // Matches: <br>, <BR>, <br/>, <br />, <br  >, <br class="x">, < br>
  // Does NOT match "br" in legitimate words like "library", "February", "broken"
  const output: string = rawOutput.replace(/<\s*br[^>]*>/gi, '\n');

  // Is this node awaiting output?
  const isAwaiting: boolean = data.status === 'working' && !output;

  // REQ-8: Compacted node styling
  const containerStyle: React.CSSProperties = {
    background: '#12121f',
    border: isCompacted
      ? `1.5px dashed ${COMPACTED_STYLES.borderColor}`
      : `1.5px solid ${color}`,
    borderRadius: 12,
    padding: '10px 14px',
    minWidth: 420,
    maxWidth: 540,
    opacity: isCompacted ? COMPACTED_STYLES.opacity : 1,
    filter: isCompacted ? COMPACTED_STYLES.grayscale : 'none',
    boxShadow: selected
      ? isCompacted
        ? `0 0 0 2px ${COMPACTED_STYLES.selectionRing}`
        : `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
      : '0 2px 8px rgba(0,0,0,0.4)',
    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
  };

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        title={data.label}
        className={[styles.nodeContainer, glowClass].filter(Boolean).join(' ')}
        style={containerStyle}
      >
        {/* ── Title: Subagent · {name} ── */}
        <div className={styles.titleBar}>
          <span className={styles.titleText} style={{ color: '#6366f1' }}>Subagent · {name}</span>
          {isCompacted && (
            <span
              className={styles.statusBadge}
              style={{
                background: COMPACTED_STYLES.badgeBackground,
                color: COMPACTED_STYLES.badgeColor,
                fontSize: 8,
              }}
              aria-label="Session compacted"
            >
              COMPACTED
            </span>
          )}
        </div>

        {/* ── SECTION 1: Input ── */}
        <div className={styles.sectionUser} style={{ marginBottom: 10 }}>
          <div className={styles.sectionLabel} style={{ color: '#6366f1' }}>
            ── INPUT ──
          </div>
          <div className={`nowheel ${styles.responseScroll}`} style={{
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
          <div className={`nowheel ${styles.responseScroll}`} style={{
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
