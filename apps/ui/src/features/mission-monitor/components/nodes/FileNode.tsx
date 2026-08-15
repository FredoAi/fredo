import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { LuFilePen } from 'react-icons/lu';
import type { MonitorNodeData } from '../../types';
import { useNodeKeyboardOpen } from '../NodeFocusContext';
import styles from './MonitorNode.module.css';

export const FileNode = React.memo(({ data, selected }: NodeProps<MonitorNodeData>) => {
  const color = '#22c55e'; // Green accent

  // #2745 ST-4: the dead file-node payload type was removed from lib/graph.ts
  // (the builder path was never live) — this dead component keeps a local
  // shape until ST-6 deletes the file.
  const payload = data.payload as unknown as { filePath?: string; operation?: string } | undefined;
  const filePath: string = payload?.filePath ?? 'unknown';
  const operation: string = payload?.operation ?? 'read';
  const fileName: string = filePath.split('/').pop() ?? filePath;

  // #2743 ST-6 (AC-7): keyboard access equivalent to double-click.
  const keyboardProps = useNodeKeyboardOpen(data);

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        title={data.label}
        className={styles.nodeContainer}
        style={{
          background: '#12121f',
          border: `1.5px solid ${color}`,
          borderRadius: 12,
          padding: '10px 14px',
          minWidth: 300,
          maxWidth: 420,
          boxShadow: selected
            ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,0.5)`
            : '0 2px 8px rgba(0,0,0,0.4)',
          transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        }}
        role="article"
        {...keyboardProps}
      >
        {/* ── Title: File: {filename} ── */}
        <div className={styles.titleBar}>
          <span style={{ color, display: 'flex', alignItems: 'center', marginRight: 6 }}>
            <LuFilePen size={12} />
          </span>
          <span className={styles.titleText} style={{ color: '#22c55e', fontSize: 10 }}>
            File: {fileName}
          </span>
        </div>

        {/* Operation badge */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{
            fontSize: 9,
            background: operation === 'write' ? '#22c55e22' : '#64748b33',
            color: operation === 'write' ? '#22c55e' : '#94a3b8',
            borderRadius: 3,
            padding: '1px 5px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            {operation}
          </span>
          <span style={{
            fontSize: 9,
            color: '#64748b',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: "'Cascadia Code','Fira Code',monospace",
          }}>
            {filePath.length > 40 ? '…' + filePath.slice(-37) : filePath}
          </span>
        </div>
      </div>
    </>
  );
});
