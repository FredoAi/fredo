import React from 'react';
import { LuHistory, LuTrash2, LuChevronLeft } from 'react-icons/lu';
import type { SessionRecord } from '../lib/sessionStorage';

interface SessionHistoryDrawerProps {
  sessions: SessionRecord[];
  /** sessionId currently selected in the panel */
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  open: boolean;
  onToggle: () => void;
}

export const SessionHistoryDrawer: React.FC<SessionHistoryDrawerProps> = ({
  sessions,
  selectedSessionId,
  onSelect,
  onDelete,
  open,
  onToggle,
}) => {
  const DRAWER_WIDTH = 210;

  const drawerStyle: React.CSSProperties = {
    width: open ? DRAWER_WIDTH : 0,
    minWidth: open ? DRAWER_WIDTH : 0,
    overflow: 'hidden',
    transition: 'width 0.22s ease, min-width 0.22s ease',
    background: '#0d0d1c',
    borderRight: '1px solid #1e1e3a',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    position: 'relative',
  };

  return (
    <>
      {/* Collapsed icon bar */}
      {!open && (
        <button
          onClick={onToggle}
          style={{
            width: 28, flexShrink: 0, background: '#0d0d1c', border: 'none',
            borderRight: '1px solid #1e1e3a', cursor: 'pointer', display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 6, padding: '10px 0',
          }}
          title="Show sessions"
        >
          <LuHistory size={14} color="#6366f1" />
          {sessions.length > 0 && (
            <span style={{ fontSize: 9, background: '#6366f133', color: '#6366f1', borderRadius: 3, padding: '1px 4px', fontWeight: 700 }}>
              {sessions.length}
            </span>
          )}
        </button>
      )}

      {/* Drawer panel */}
      <div style={drawerStyle}>
        {open && (
          <>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 6px', borderBottom: '1px solid #1e1e3a', flexShrink: 0 }}>
              <LuHistory size={12} color="#6366f1" />
              <span style={{ fontSize: 10, fontWeight: 700, color: '#6366f1', letterSpacing: '0.08em', textTransform: 'uppercase', flex: 1 }}>
                Sessions
              </span>
              <button onClick={onToggle} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#4b5563', display: 'flex' }} title="Close">
                <LuChevronLeft size={13} />
              </button>
            </div>

            {/* Session list - just a plain list, no Live row */}
            {/* Session list */}
            <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
              {sessions.map((session) => {
                const isSelected = selectedSessionId === session.sessionId;
                return (
                  <div
                    key={session.sessionId}
                    style={{
                      display: 'flex', alignItems: 'flex-start', padding: '6px 10px',
                      background: isSelected ? '#6366f115' : 'transparent',
                      borderLeft: isSelected ? '2px solid #6366f1' : '2px solid transparent',
                      borderBottom: '1px solid #0f0f1e', cursor: 'pointer', gap: 6,
                    }}
                    onClick={() => onSelect(session.sessionId)}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 10, color: isSelected ? '#a5b4fc' : '#94a3b8', fontWeight: isSelected ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.label}
                      </div>
                      <div style={{ display: 'flex', gap: 5, marginTop: 2, alignItems: 'center' }}>
                        <span style={{ fontSize: 9, color: '#4b5563' }}>{session.eventCount} events</span>
                        {session.endTime && <span style={{ fontSize: 9, color: '#374151' }}>ended</span>}
                      </div>
                    </div>

                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(session.sessionId); }}
                      style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', opacity: 0.35 }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.35')}
                      title="Delete session"
                    >
                      <LuTrash2 size={11} color="#ef4444" />
                    </button>
                  </div>
                );
              })}

              {sessions.length === 0 && (
                <div style={{ padding: '16px 10px', fontSize: 10, color: '#374151', textAlign: 'center' }}>
                  No past sessions yet
                </div>
              )}
            </div>

            {/* Collapse toggle */}
            <div
              style={{ position: 'absolute', right: -14, top: '50%', transform: 'translateY(-50%)', zIndex: 10, width: 14, height: 36, background: '#1e1e3a', border: '1px solid #2d2d4a', borderLeft: 'none', borderRadius: '0 4px 4px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#6366f1' }}
              onClick={onToggle}
            >
              <LuChevronLeft size={10} />
            </div>
          </>
        )}
      </div>
    </>
  );
};
