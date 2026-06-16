import React, { useState } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import { useNodeFocus } from '../NodeFocusContext';
import type { TurnPayload } from '../../lib/contract';
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

export const ChatNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  const color = STATUS_COLORS[data.status];
  const glowClass = STATUS_CSS_CLASS[data.status];
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // Read TurnPayload fields from data.payload (populated by graph builder)
  const payload = data.payload as unknown as TurnPayload | undefined;

  const userPrompt: string = payload?.userPrompt ?? '';
  const userTimestamp: string = payload?.userTimestamp ?? data.timestamp;
  const thinkingText: string = payload?.thinkingText ?? '';
  const responseText: string = payload?.responseText ?? '';
  const turnTools: number = payload?.turnTools ?? 0;
  const turnFiles: number = payload?.turnFiles ?? 0;

  // Collapsed preview: first ~60 chars
  const thinkingPreview: string =
    thinkingText.length > 60
      ? thinkingText.slice(0, 60) + '…'
      : thinkingText;

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
          minWidth: 280,
          maxWidth: 360,
          boxShadow: selected
            ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
            : '0 2px 8px rgba(0,0,0,0.4)',
          transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        }}
        onDoubleClick={(e) => { e.stopPropagation(); onFocus?.(data); }}
      >
        {/* Compact status badge (only visible indicator of node state) */}
        {data.status !== 'inactive' && (
          <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontSize: 8, background: `${color}22`, color,
              borderRadius: 3, padding: '1px 5px', fontWeight: 700, letterSpacing: '0.05em',
            }}>
              {STATUS_LABEL[data.status]}
            </span>
          </div>
        )}

        {/* ── SECTION 1: User ── */}
        <div className={styles.sectionUser} style={{ marginBottom: 10 }}>
          <div className={styles.sectionLabel} style={{ color: '#64748b' }}>
            ── USER ──
          </div>
          <div style={{
            color: '#94a3b8',
            fontSize: 11.5,
            lineHeight: 1.55,
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            {userPrompt || <span style={{ color: '#374151' }}>—</span>}
          </div>
          <div className={styles.timestamp}>
            {new Date(userTimestamp).toLocaleTimeString()}
          </div>
        </div>

        {/* Section divider */}
        <div className={styles.sectionDivider} style={{ background: `${color}18` }} />

        {/* ── SECTION 2: Thinking (collapsible) ── */}
        {thinkingText && (
          <>
            <div className={styles.thinkingSection}>
              <div className={styles.sectionLabel} style={{ color: '#a855f7' }}>
                ── THINKING ──
              </div>
              <div style={{
                fontSize: 11.5,
                color: '#cbd5e1',
                lineHeight: 1.55,
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              }}>
                {thinkingExpanded ? thinkingText : thinkingPreview}
              </div>
              <button
                className={styles.thinkingToggle}
                onClick={() => setThinkingExpanded((prev) => !prev)}
                type="button"
              >
                {thinkingExpanded ? '[Collapse]' : '[Expand]'}
              </button>
            </div>
            <div className={styles.sectionDivider} style={{ background: `${color}18` }} />
          </>
        )}

        {/* ── SECTION 3: Response ── */}
        <div style={{ marginBottom: 2 }}>
          <div className={styles.sectionLabel} style={{ color: '#64748b' }}>
            ── RESPONSE ──
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
            {responseText
              ? responseText
              : <span style={{ color: '#374151' }}>—</span>
            }
          </div>

          {/* Mini-counters: tools and files per turn */}
          <div className={styles.counterRow}>
            <span>[tools: {turnTools}]</span>
            <span>[files: {turnFiles}]</span>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
};
