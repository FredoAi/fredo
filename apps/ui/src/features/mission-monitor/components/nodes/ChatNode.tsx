import React, { useState } from 'react';
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

export const ChatNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  const color = STATUS_COLORS[data.status];
  const glowClass = STATUS_CSS_CLASS[data.status];
  const isWorking = data.status === 'working';

  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  const modelName: string | undefined = data.payload?.['gen_ai.response.model']
    ?? data.payload?.model
    ?? (typeof data.payload?.model_name === 'string' ? data.payload.model_name : undefined)
    ?? (data.label && data.label !== 'Agent Response' ? data.label : undefined);

  const inputTokens: number | undefined = data.payload?.['gen_ai.usage.input_tokens'];
  const outputTokens: number | undefined = data.payload?.['gen_ai.usage.output_tokens'];

  const userPrompt: string | undefined = data.payload?.userPrompt;

  const thinkingText: string | undefined = data.payload?.thinkingText;

  const responseText: string | undefined = data.payload?.response
    ?? data.payload?.content
    ?? data.sublabel;

  const turnToolCount: number | undefined = data.payload?.turnToolCount;
  const turnFileCount: number | undefined = data.payload?.turnFileCount;

  const hasThinkingText = !!thinkingText;
  const hasUserPrompt = !!userPrompt;

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
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ color, display: 'flex', alignItems: 'center' }}>
            <LuBrain size={13} />
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', flex: 1 }}>
            {modelName ?? 'Chat'}
          </span>

          {/* Status badge */}
          {data.status !== 'inactive' && (
            <span style={{
              fontSize: 8, background: `${color}22`, color,
              borderRadius: 3, padding: '1px 5px', fontWeight: 700, letterSpacing: '0.05em',
            }}>
              {STATUS_LABEL[data.status]}
            </span>
          )}

          {/* Tokens in/out counters */}
          {inputTokens != null && (
            <span title={`${inputTokens} input tokens`} style={{
              fontSize: 9, color: `${color}cc`, fontFamily: 'monospace',
              background: `${color}15`, borderRadius: 3, padding: '1px 4px',
            }}>
              ↑{formatTokenCount(inputTokens)}
            </span>
          )}
          {outputTokens != null && (
            <span title={`${outputTokens} output tokens`} style={{
              fontSize: 9, color: `${color}cc`, fontFamily: 'monospace',
              background: `${color}15`, borderRadius: 3, padding: '1px 4px',
            }}>
              ↓{formatTokenCount(outputTokens)}
            </span>
          )}
        </div>

        {/* ── User Section ── */}
        {hasUserPrompt && (
          <>
            <div className={[styles.section, styles.userSection].join(' ')}>
              <div className={styles.sectionLabel}>User</div>
              <div className={styles.sectionText}>{userPrompt}</div>
              <div className={styles.sectionTimestamp}>
                {new Date(data.timestamp).toLocaleTimeString()}
              </div>
            </div>
            <div className={styles.sectionArrow}>▾</div>
          </>
        )}

        {/* ── Thinking Section ── */}
        <div className={[styles.section, styles.thinkingSection].join(' ')}>
          <div className={styles.sectionLabel}>Thinking</div>
          {hasThinkingText ? (
            <>
              {thinkingExpanded ? (
                <div className={styles.thinkingFull}>{thinkingText}</div>
              ) : (
                <div className={styles.thinkingPreview}>
                  {thinkingText.length > 80
                    ? thinkingText.slice(0, 80) + '…'
                    : thinkingText}
                </div>
              )}
              <button
                className={styles.thinkingToggle}
                onClick={() => setThinkingExpanded((v) => !v)}
              >
                <span
                  className={[
                    styles.thinkingToggleIcon,
                    thinkingExpanded ? styles.expanded : '',
                  ].filter(Boolean).join(' ')}
                >
                  ▶
                </span>
                {thinkingExpanded ? 'Collapse' : 'Expand'}
              </button>
            </>
          ) : (
            <span style={{ color: '#4b5563', fontStyle: 'italic' }}>
              {isWorking ? 'Processing…' : '—'}
            </span>
          )}
        </div>

        {/* ── Connector Arrow → Response ── */}
        <div className={styles.sectionArrow}>▾</div>

        {/* ── Response Section ── */}
        <div className={[styles.section, styles.responseSection].join(' ')}>
          <div className={styles.sectionLabel}>Response</div>
          <div className={styles.sectionText}>
            {responseText
              ? responseText
              : isWorking
                ? <span style={{ color: `${color}77` }}>thinking…</span>
                : <span style={{ color: '#374151' }}>—</span>
            }
          </div>

          {/* Mini-badges for tool/file count */}
          {(turnToolCount != null && turnToolCount > 0) ||
           (turnFileCount != null && turnFileCount > 0) ? (
            <div className={styles.miniBadgeRow}>
              {turnToolCount != null && turnToolCount > 0 && (
                <span className={[styles.miniBadge, styles.miniBadgeTool].join(' ')}>
                  ⚙ {turnToolCount} tool{turnToolCount !== 1 ? 's' : ''}
                </span>
              )}
              {turnFileCount != null && turnFileCount > 0 && (
                <span className={[styles.miniBadge, styles.miniBadgeFile].join(' ')}>
                  📄 {turnFileCount} file{turnFileCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Right}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
};

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}
