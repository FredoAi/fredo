import React, { useState } from 'react';
import { LuX, LuMessageSquare, LuWrench, LuFilePen, LuBot, LuListTodo, LuBrain, LuChevronDown, LuChevronRight, LuLock, LuPlay } from 'react-icons/lu';
import type { MonitorNodeData } from '../types';
import { STATUS_COLORS } from '../types';

const NODE_TYPE_ICON: Record<string, React.ReactNode> = {
  userPromptNode:    <LuMessageSquare size={14} />,
  toolUseNode:       <LuWrench size={14} />,
  fileChangedNode:   <LuFilePen size={14} />,
  subagentNode:      <LuBot size={14} />,
  taskNode:          <LuListTodo size={14} />,
  agentResponseNode: <LuBrain size={14} />,
  chatNode:          <LuBrain size={14} />,
  permissionNode:    <LuLock size={14} />,
  sessionNode:       <LuPlay size={14} />,
};

// ── Type-specific section components ──────────────────────────────────────────

interface SectionProps {
  data: MonitorNodeData;
  color: string;
}

const ChatSection: React.FC<SectionProps> = ({ data, color }) => {
  const modelName: string | undefined = data.payload?.['gen_ai.response.model']
    ?? data.payload?.model
    ?? (typeof data.payload?.model_name === 'string' ? data.payload.model_name : undefined);
  const inputTokens: number | undefined = data.payload?.['gen_ai.usage.input_tokens'];
  const outputTokens: number | undefined = data.payload?.['gen_ai.usage.output_tokens'];
  const prompt: string | undefined = data.payload?.prompt ?? data.payload?.input;
  const response: string | undefined = data.payload?.response ?? data.payload?.content;
  const userPrompt: string | undefined =
    typeof data.payload?.userPrompt === 'string'
      ? data.payload.userPrompt
      : undefined;
  const thinkingText: string | undefined =
    typeof data.payload?.thinkingText === 'string'
      ? data.payload.thinkingText
      : undefined;
  const turnToolCount: number | undefined =
    typeof data.payload?.turnToolCount === 'number'
      ? data.payload.turnToolCount
      : undefined;
  const turnFileCount: number | undefined =
    typeof data.payload?.turnFileCount === 'number'
      ? data.payload.turnFileCount
      : undefined;

  const [openSection, setOpenSection] = useState<string | null>(
    response ? 'response' : thinkingText ? 'thinking' : userPrompt ? 'userPrompt' : null
  );

  const hasContent = modelName || inputTokens != null || outputTokens != null ||
    prompt || response || userPrompt || thinkingText;
  if (!hasContent) return null;

  const toggleSection = (section: string) =>
    setOpenSection((prev) => (prev === section ? null : section));

  const textBoxStyle: React.CSSProperties = {
    background: '#07070f', borderRadius: 4, padding: '4px 8px', fontSize: 9,
    color: '#94a3b8', maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap',
    wordBreak: 'break-word', lineHeight: 1.5,
  };

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
    fontSize: 9, color: '#4b5563', marginBottom: 2, userSelect: 'none',
  };

  return (
    <div style={{ padding: '6px 10px', borderBottom: `1px solid ${color}18`, flexShrink: 0 }}>
      {/* Model & token info row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        {modelName && (
          <>
            <span style={{ fontSize: 9, color: '#4b5563' }}>Model</span>
            <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace' }}>{modelName}</span>
          </>
        )}
        {(inputTokens != null || outputTokens != null) && (
          <span style={{ fontSize: 9, color, fontFamily: 'monospace' }}>
            ↑{inputTokens?.toLocaleString() ?? '?'} / ↓{outputTokens?.toLocaleString() ?? '?'}
          </span>
        )}
      </div>

      {/* Turn count badges */}
      {(turnToolCount != null || turnFileCount != null) && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          {turnToolCount != null && (
            <span style={{ fontSize: 8, background: '#6366f122', color: '#6366f1', borderRadius: 3, padding: '1px 5px', fontWeight: 600 }}>
              Tools: {turnToolCount}
            </span>
          )}
          {turnFileCount != null && (
            <span style={{ fontSize: 8, background: '#10b98122', color: '#10b981', borderRadius: 3, padding: '1px 5px', fontWeight: 600 }}>
              Files: {turnFileCount}
            </span>
          )}
        </div>
      )}

      {/* Collapsible sections: UserPrompt → Thinking → Response */}
      {userPrompt && (
        <div style={{ marginBottom: 3 }}>
          <div style={sectionHeaderStyle} onClick={() => toggleSection('userPrompt')}>
            {openSection === 'userPrompt' ? <LuChevronDown size={9} color={color} /> : <LuChevronRight size={9} color="#4b5563" />}
            <span>User Prompt</span>
          </div>
          {openSection === 'userPrompt' && (
            <div style={textBoxStyle}>
              {userPrompt.length > 500 ? userPrompt.slice(0, 500) + '…' : userPrompt}
            </div>
          )}
        </div>
      )}

      {thinkingText && (
        <div style={{ marginBottom: 3 }}>
          <div style={sectionHeaderStyle} onClick={() => toggleSection('thinking')}>
            {openSection === 'thinking' ? <LuChevronDown size={9} color={color} /> : <LuChevronRight size={9} color="#4b5563" />}
            <span>Thinking</span>
          </div>
          {openSection === 'thinking' && (
            <div style={{ ...textBoxStyle, color: '#a78bfa' }}>
              {thinkingText.length > 500 ? thinkingText.slice(0, 500) + '…' : thinkingText}
            </div>
          )}
        </div>
      )}

      {response && (
        <div style={{ marginBottom: 3 }}>
          <div style={sectionHeaderStyle} onClick={() => toggleSection('response')}>
            {openSection === 'response' ? <LuChevronDown size={9} color={color} /> : <LuChevronRight size={9} color="#4b5563" />}
            <span>Response</span>
          </div>
          {openSection === 'response' && (
            <div style={{ ...textBoxStyle, color }}>
              {response.length > 500 ? response.slice(0, 500) + '…' : response}
            </div>
          )}
        </div>
      )}

      {/* Legacy prompt fallback (if userPrompt not set) */}
      {!userPrompt && prompt && (
        <div style={{ marginBottom: 3 }}>
          <div style={sectionHeaderStyle} onClick={() => toggleSection('prompt')}>
            {openSection === 'prompt' ? <LuChevronDown size={9} color={color} /> : <LuChevronRight size={9} color="#4b5563" />}
            <span>Prompt</span>
          </div>
          {openSection === 'prompt' && (
            <div style={textBoxStyle}>
              {prompt.length > 300 ? prompt.slice(0, 300) + '…' : prompt}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const PermissionSection: React.FC<SectionProps> = ({ data, color }) => {
  const toolName: string | undefined = data.payload?.tool_name ?? data.payload?.scope;
  const scope: string | undefined = data.payload?.scope ?? data.payload?.permission_scope;
  const decision: string | undefined = data.payload?.decision ?? data.payload?.result;
  const asked: boolean = data.payload?.asked === true || data.payload?.granted !== undefined;

  if (!toolName && !scope && !decision && !asked) return null;

  return (
    <div style={{ padding: '6px 10px', borderBottom: `1px solid ${color}18`, flexShrink: 0 }}>
      {(toolName || scope) && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#4b5563', minWidth: 52 }}>Scope</span>
          <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace' }}>
            {toolName ?? scope}
          </span>
        </div>
      )}
      {decision && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#4b5563', minWidth: 52 }}>Decision</span>
          <span style={{
            fontSize: 9, fontWeight: 700,
            color: decision === 'granted' || decision === 'allowed' ? '#22c55e'
                 : decision === 'denied' ? '#f97316' : color,
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>
            {decision}
          </span>
        </div>
      )}
    </div>
  );
};

const SessionSection: React.FC<SectionProps> = ({ data, color }) => {
  const duration: number | undefined = data.payload?.duration_ms ?? data.payload?.duration;
  const count: number = data.relatedEvents.length;

  if (duration == null && count === 0) return null;

  return (
    <div style={{ padding: '6px 10px', borderBottom: `1px solid ${color}18`, flexShrink: 0 }}>
      {duration != null && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#4b5563', minWidth: 52 }}>Duration</span>
          <span style={{ fontSize: 9, color, fontFamily: 'monospace' }}>
            {formatDurationMs(duration)}
          </span>
        </div>
      )}
      {count > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#4b5563', minWidth: 52 }}>Events</span>
          <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace' }}>
            {count}
          </span>
        </div>
      )}
    </div>
  );
};

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

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

      {/* Type-specific details */}
      {(data.eventType === 'chat' || data.eventType === 'invoke_agent') && (
        <ChatSection data={data} color={color} />
      )}
      {data.eventType === 'permission' && (
        <PermissionSection data={data} color={color} />
      )}
      {data.eventType === 'SessionStart' && (
        <SessionSection data={data} color={color} />
      )}

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
