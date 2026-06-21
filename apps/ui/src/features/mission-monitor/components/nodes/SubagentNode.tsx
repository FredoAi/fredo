import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData, MonitorNodeStatus } from '../../types';
import { STATUS_COLORS } from '../../types';
import { useNodeFocus } from '../NodeFocusContext';
import { formatTokenCount } from '../../lib/contract';
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
  subagentName?: string;
  instruction?: string;
  output?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  toolsUsed?: number;
  parentCorrelationId?: string;
}

export const SubagentNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const onFocus = useNodeFocus();
  const color = STATUS_COLORS[data.status];
  const glowClass = STATUS_CSS_CLASS[data.status];

  // Read SubagentPayload fields from data.payload
  const payload = data.payload as unknown as SubagentPayload | undefined;

  const subagentName: string = payload?.subagentName ?? data.label;
  const instruction: string = payload?.instruction ?? '';
  const outputText: string = payload?.output ?? '';
  const model: string | undefined = payload?.model;
  const tokensIn: number = payload?.tokensIn ?? 0;
  const tokensOut: number = payload?.tokensOut ?? 0;
  const toolsUsed: number = payload?.toolsUsed ?? 0;
  const totalTokens: number = tokensIn + tokensOut;

  // Is this node awaiting output? (working status, no output text yet)
  const isAwaiting: boolean = data.status === 'working' && !outputText;

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
        {/* ── Title: Subagent · name · model ── */}
        <div className={styles.titleBar}>
          <span className={styles.titleText}>
            Subagent · {subagentName}{model ? ` · ${model}` : ''}
          </span>
        </div>

        {/* ── SECTION 1: INPUT ── */}
        {instruction && (
          <>
            <div className={styles.sectionUser} style={{ marginBottom: 10 }}>
              <div className={styles.sectionLabel} style={{ color: '#64748b' }}>
                ── INPUT ──
              </div>
              <div style={{
                color: '#94a3b8',
                fontSize: 11.5,
                lineHeight: 1.55,
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              }}>
                {instruction}
              </div>
            </div>
            <div className={styles.sectionDivider} style={{ background: `${color}18` }} />
          </>
        )}

        {/* ── SECTION 2: OUTPUT ── */}
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
            {outputText
              ? outputText
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

        {/* ── Bottom bar: tokens + tools ── */}
        <div className={styles.bottomBar}>
          <span className={styles.counterRow}>
            ⬡ {formatTokenCount(tokensIn)} / {formatTokenCount(tokensOut)} / {formatTokenCount(totalTokens)} total | 🔧 {toolsUsed} tools
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Right}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
});
