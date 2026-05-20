import React, { useState } from 'react';
import { LuX, LuMessageSquare, LuWrench, LuFilePen, LuBot, LuListTodo, LuBrain, LuChevronDown, LuChevronRight } from 'react-icons/lu';
import type { MonitorNodeData } from '../types';
import { STATUS_COLORS } from '../types';

const NODE_TYPE_ICON: Record<string, React.ReactNode> = {
  userPromptNode:    <LuMessageSquare size={14} />,
  toolUseNode:       <LuWrench size={14} />,
  fileChangedNode:   <LuFilePen size={14} />,
  subagentNode:      <LuBot size={14} />,
  taskNode:          <LuListTodo size={14} />,
  agentResponseNode: <LuBrain size={14} />,
};

interface FocusWindowProps {
  data: MonitorNodeData;
  onClose: () => void;
}

export const FocusWindow: React.FC<FocusWindowProps> = ({ data, onClose }) => {
  const color = STATUS_COLORS[data.status];
  const icon = NODE_TYPE_ICON[data.eventType] ?? <LuWrench size={14} />;
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  return (
    <div
      style={{
        position: 'absolute',
        top: 12, right: 12,
        width: '28%',
        minWidth: 260,
        maxWidth: 380,
        maxHeight: 'calc(100% - 24px)',
        zIndex: 20,
        background: '#0d0d1a',
        border: `1.5px solid ${color}`,
        borderRadius: 10,
        boxShadow: `0 0 24px ${color}33, 0 8px 32px rgba(0,0,0,0.6)`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'focus-slide-in 0.18s ease-out',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <style>{`
        @keyframes focus-slide-in {
          from { opacity: 0; transform: translate(12px, -8px) scale(0.96); }
          to   { opacity: 1; transform: translate(0, 0) scale(1); }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${color}30`, flexShrink: 0 }}>
        <span style={{ color, display: 'flex', alignItems: 'center' }}>{icon}</span>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: '#e2e8f0' }}>{data.label}</span>
        <span style={{ fontSize: 9, background: `${color}22`, color, borderRadius: 3, padding: '1px 5px', fontWeight: 600, textTransform: 'uppercase', marginRight: 4 }}>
          {data.status.replace(/_/g, ' ')}
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4b5563', padding: 2, display: 'flex', alignItems: 'center' }}>
          <LuX size={13} />
        </button>
      </div>

      {/* Events list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {data.relatedEvents.map((snap, i) => {
          const isOpen = openIdx === i;
          const keys = Object.keys(snap.payload ?? {});
          return (
            <div key={i} style={{ borderBottom: `1px solid #0f0f1e` }}>
              {/* Event header row */}
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: keys.length > 0 ? 'pointer' : 'default' }}
                onClick={() => keys.length > 0 && setOpenIdx(isOpen ? null : i)}
              >
                {keys.length > 0
                  ? (isOpen ? <LuChevronDown size={10} color={color} /> : <LuChevronRight size={10} color="#4b5563" />)
                  : <span style={{ width: 10 }} />}
                <span style={{ fontSize: 9, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.04em', flex: 1 }}>
                  {snap.eventType}
                </span>
                <span style={{ fontSize: 9, color: '#374151' }}>
                  {new Date(snap.timestamp).toLocaleTimeString()}
                </span>
              </div>

              {/* JSON payload — collapsed/expanded */}
              {isOpen && keys.length > 0 && (
                <pre style={{
                  margin: 0,
                  padding: '6px 12px 8px',
                  fontSize: 9,
                  color: '#94a3b8',
                  fontFamily: "'Cascadia Code','Fira Code',monospace",
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  background: '#07070f',
                  borderTop: `1px solid #1e1e3a`,
                  maxHeight: 300,
                  overflowY: 'auto',
                  lineHeight: 1.5,
                }}>
                  {JSON.stringify(snap.payload, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ padding: '4px 10px', borderTop: `1px solid #1e1e3a`, fontSize: 9, color: '#374151', flexShrink: 0 }}>
        {new Date(data.timestamp).toLocaleString()}
      </div>
    </div>
  );
};
