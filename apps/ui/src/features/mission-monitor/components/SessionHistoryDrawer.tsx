import React, { useState, useCallback, useRef } from 'react';
import { LuHistory, LuTrash2, LuChevronLeft, LuSearch } from 'react-icons/lu';
import type { MissionMonitorSession } from '../lib/graph';

interface SessionHistoryDrawerProps {
  sessions: MissionMonitorSession[];
  filteredSessions: MissionMonitorSession[];
  /** sessionId currently selected in the panel */
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onToggle: () => void;
  open: boolean;
  searchFilter: string;
  onSearchChange: (value: string) => void;
}

export const SessionHistoryDrawer: React.FC<SessionHistoryDrawerProps> = ({
  sessions,
  filteredSessions,
  selectedSessionId,
  onSelect,
  onDelete,
  onToggle,
  open,
  searchFilter,
  onSearchChange,
}) => {
  const DRAWER_WIDTH = 210;
  const COLLAPSED_WIDTH = 28;
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);

  const handleMouseEnter = useCallback(() => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    collapseTimerRef.current = setTimeout(() => {
      setHovered(false);
    }, 300);
  }, []);

  const effectiveOpen = open || hovered;

  const drawerStyle: React.CSSProperties = {
    width: effectiveOpen ? DRAWER_WIDTH : COLLAPSED_WIDTH,
    minWidth: effectiveOpen ? DRAWER_WIDTH : COLLAPSED_WIDTH,
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
    <div style={drawerStyle} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {/* Collapsed state */}
      {!effectiveOpen && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '10px 0', gap: 6,
        }}>
          <button
            onClick={onToggle}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0, color: '#6366f1',
            }}
            title="Show sessions"
          >
            <LuHistory size={14} />
          </button>
          {sessions.length > 0 && (
            <span style={{
              fontSize: 9, background: '#6366f133', color: '#6366f1',
              borderRadius: 3, padding: '1px 4px', fontWeight: 700,
            }}>
              {sessions.length}
            </span>
          )}
        </div>
      )}

      {/* Expanded content */}
      {effectiveOpen && (
        <>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 10px 6px',
            borderBottom: '1px solid #1e1e3a', flexShrink: 0,
          }}>
            <LuHistory size={12} color="#6366f1" />
            <span style={{
              fontSize: 10, fontWeight: 700, color: '#6366f1',
              letterSpacing: '0.08em', textTransform: 'uppercase', flex: 1,
            }}>
              Sessions
            </span>
            <button
              onClick={onToggle}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: 2, color: '#4b5563', display: 'flex',
              }}
              title="Close"
            >
              <LuChevronLeft size={13} />
            </button>
          </div>

          {/* Search input */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '6px 8px', borderBottom: '1px solid #1e1e3a',
          }}>
            <LuSearch size={11} color="#4b5563" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Filter sessions..."
              style={{
                flex: 1,
                background: '#0a0a18',
                border: '1px solid #1e1e3a',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: 10,
                color: '#e2e8f0',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
          </div>

          {/* Session list */}
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {filteredSessions.map((session) => {
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
                    <div style={{
                      fontSize: 10,
                      color: isSelected ? '#a5b4fc' : '#94a3b8',
                      fontWeight: isSelected ? 600 : 400,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {session.label}
                    </div>
                    <div style={{ display: 'flex', gap: 5, marginTop: 2, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: '#4b5563' }}>
                        {session.deliveryCount} deliveries
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(session.sessionId); }}
                    style={{
                      background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                      flexShrink: 0, display: 'flex', alignItems: 'center', opacity: 0.35,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.35')}
                    title="Delete session"
                  >
                    <LuTrash2 size={11} color="#ef4444" />
                  </button>
                </div>
              );
            })}

            {filteredSessions.length === 0 && (
              <div style={{ padding: '16px 10px', fontSize: 10, color: '#374151', textAlign: 'center' }}>
                {searchFilter ? 'No matching sessions' : 'No sessions yet'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
