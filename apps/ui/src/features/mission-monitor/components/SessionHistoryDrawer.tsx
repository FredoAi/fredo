import React, { useState, useCallback, useRef, useEffect } from 'react';
import { LuHistory, LuTrash2, LuChevronLeft, LuSearch, LuPencil } from 'react-icons/lu';
import type { MissionMonitorSession } from '../lib/graph';
import { deriveDisplayName } from '../lib/sessionMeta';

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
  /**
   * #2748 ST-4 (AC2 R-2.4): rename a session — the panel wires the session
   * hook's `renameSession` here (ST-6). Optional so the drawer stays
   * self-contained; a no-op default keeps un-wired consumers compiling.
   */
  onRename?: (sessionId: string, name: string) => void;
}

/** Deterministic short-month names for the compact start-time line (AC-1). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * #2748 AC-1 line 2 — compact start date-time: `MMM D, HH:MM`, with the year
 * appended when it differs from the current year. Local time (the persisted
 * start_time was captured in local time — persistence.ts rowToSession), 9px
 * secondary in the row.
 */
function formatStartTime(startTime: number): string {
  const d = new Date(startTime);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
  return d.getFullYear() !== new Date().getFullYear()
    ? `${base}, ${d.getFullYear()}`
    : base;
}

/**
 * #2748 AC-2 a11y NFR — `:focus-visible` outlines for the row / edit / delete /
 * rename input. Rows are focusable divs (tabIndex=0) so the outline is the
 * keyboard affordance. The search input's `outline:none` (existing debt) is
 * deliberately NOT copied.
 *
 * #2748 FIX-2 (AC2-4 / NFR-2 keyboard-operable rename): the edit button must
 * be keyboard-reachable WITHOUT hovering — present in the tab order AND the
 * a11y tree at rest. `visibility:hidden` fails by construction (it removes the
 * element from both). Instead the resting state uses `opacity: 0` + `pointer-
 * events: none` (which keep the element in the tab order + a11y tree — QA Q-3
 * contract: `getByRole('button', {name: 'Rename session'})` succeeds without
 * hover), and the button is revealed to full opacity on row `:hover` OR
 * `:focus-within` (UI/UX spec AC-2: "hidden by default, revealed on row hover
 * or :focus-within"). `pointer-events: auto` on reveal restores mouse
 * activation; at rest the invisible control cannot steal accidental clicks.
 * When the focused element is inside the row (the row itself, the edit/delete
 * buttons, or the open rename input) `:focus-within` holds the button visible,
 * so a keyboard user who Tabs onto the button sees it appear with its
 * `:focus-visible` outline.
 */
const DRAWER_FOCUS_CSS = `
  .mm-session-row:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
  .mm-row-edit-btn:focus-visible,
  .mm-row-del-btn:focus-visible,
  .mm-rename-input:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -1px; }
  .mm-row-edit-btn { opacity: 0; pointer-events: none; }
  .mm-session-row:hover .mm-row-edit-btn,
  .mm-session-row:focus-within .mm-row-edit-btn { opacity: 1; pointer-events: auto; }
`;

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
  onRename,
}) => {
  const DRAWER_WIDTH = 210;
  const COLLAPSED_WIDTH = 28;
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);

  // #2748 ST-4 (AC2) — per-row interaction state. `interactingRow` is the row
  // currently hovered OR focus-within (reveals the edit button — keyboard
  // reachable without a mouse hover, mandatory). `editingId`/`renameValue`
  // drive the single inline rename field (one row edits at a time).
  const [interactingRow, setInteractingRow] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const editButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // Guard against a commit/cancel racing a trailing blur (Enter/Escape pressed
  // right before the input unmounts) — the save must fire exactly once.
  const finishGuardRef = useRef(false);

  // #2748 FIX-2 (AC2-4) — rename-input ref callback. It MUST be stable
  // (`useCallback`, empty deps): an inline arrow ref is a NEW function every
  // render, so React re-runs it on each keystroke's re-render — calling
  // `el.select()` after every onChange, which re-selects all text and makes
  // multi-character typing impossible (each keystroke replaced the previous
  // one — bug exposed by the round-2 end-to-end keyboard test). With a stable
  // callback React invokes it only when the input mounts (rename field opens),
  // which is exactly the AC2 "autofocus + select all" moment.
  const focusAndSelectRenameInput = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

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

  // #2748 ST-4 — if the session being renamed vanishes (deleted/cap-evicted),
  // drop the stale edit state so the next rename can open (the row's edit
  // button would otherwise be blocked by a non-null editingId).
  useEffect(() => {
    if (editingId !== null && !filteredSessions.some((s) => s.sessionId === editingId)) {
      setEditingId(null);
      setRenameValue('');
      finishGuardRef.current = false;
    }
  }, [editingId, filteredSessions]);

  const startRename = useCallback((session: MissionMonitorSession) => {
    if (editingId !== null) return; // one rename field at a time
    finishGuardRef.current = false;
    setEditingId(session.sessionId);
    setRenameValue(deriveDisplayName(session));
    // Focus + select-all happen in the input's callback ref on mount.
  }, [editingId]);

  const closeRename = useCallback((sid: string) => {
    setEditingId((cur) => (cur === sid ? null : cur));
    setRenameValue('');
    finishGuardRef.current = false;
    // Focus returns to the edit button after the re-render swaps the input
    // back to the name line (AC-2: no focus loss on commit/cancel).
    setTimeout(() => {
      editButtonRefs.current.get(sid)?.focus();
    }, 0);
  }, []);

  const commitRename = useCallback((sid: string) => {
    if (finishGuardRef.current) return; // already committed/cancelled
    const trimmed = renameValue.trim();
    finishGuardRef.current = true;
    // R-2.3: an empty/whitespace save CLEARS the custom name and falls back to
    // the derived name / timestamp label. The hook's renameSession maps '' →
    // customName undefined, and saveCustomName stores NULL (never an empty
    // string — persistence.ts:439-440), so the full clear path is safe to
    // trigger here.
    onRename?.(sid, trimmed);
    closeRename(sid);
  }, [renameValue, onRename, closeRename]);

  const cancelRename = useCallback((sid: string) => {
    if (finishGuardRef.current) return;
    finishGuardRef.current = true;
    closeRename(sid);
  }, [closeRename]);

  const effectiveOpen = open || hovered;

  const drawerStyle: React.CSSProperties = {
    width: effectiveOpen ? DRAWER_WIDTH : COLLAPSED_WIDTH,
    minWidth: effectiveOpen ? DRAWER_WIDTH : COLLAPSED_WIDTH,
    overflow: 'hidden',
    transition: 'width 0.22s ease, min-width 0.22s ease',
    background: '#0d0d1c',
    borderRight: '1px solid var(--border-color)',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    position: 'relative',
  };

  return (
    <div style={drawerStyle} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <style>{DRAWER_FOCUS_CSS}</style>

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
            borderBottom: '1px solid var(--border-color)', flexShrink: 0,
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
            padding: '6px 8px', borderBottom: '1px solid var(--border-color)',
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
                border: '1px solid var(--border-color)',
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
              const isCustom = session.customName !== undefined;
              const isFallback = !isCustom && session.derivedName === undefined;
              const displayName = deriveDisplayName(session);
              const isEditing = editingId === session.sessionId;
              const showEdit = interactingRow === session.sessionId || isEditing;

              return (
                <div
                  key={session.sessionId}
                  role="button"
                  tabIndex={0}
                  aria-label={displayName}
                  className="mm-session-row"
                  style={{
                    display: 'flex', alignItems: 'flex-start', padding: '6px 10px',
                    // Row hover / selected / editing — selected keeps its
                    // accent tint, hover applies the card-hover token (the
                    // editing row keeps whichever of the two it had).
                    background: isSelected
                      ? 'var(--accent-primary)15'
                      : interactingRow === session.sessionId
                        ? 'var(--card-hover-bg)'
                        : 'transparent',
                    borderLeft: isSelected ? '2px solid var(--accent-primary)' : '2px solid transparent',
                    borderBottom: '1px solid var(--border-color)',
                    cursor: 'pointer', gap: 6,
                  }}
                  onClick={() => {
                    if (editingId !== null) return; // row action suppressed while renaming
                    onSelect(session.sessionId);
                  }}
                  onKeyDown={(e) => {
                    if (editingId !== null) return; // row action suppressed while renaming
                    // Only respond to keys directly on the row — the edit/delete
                    // buttons handle their own activation. A bubbled keydown from
                    // a child button must NOT be preventDefault()ed here, or the
                    // button's native Enter/Space click would never fire (AC2-4
                    // keyboard rename would be unreachable).
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(session.sessionId);
                    }
                  }}
                  onMouseEnter={() => setInteractingRow(session.sessionId)}
                  onMouseLeave={() => setInteractingRow((cur) => (cur === session.sessionId ? null : cur))}
                  onFocusCapture={() => setInteractingRow(session.sessionId)}
                  onBlurCapture={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setInteractingRow((cur) => (cur === session.sessionId ? null : cur));
                    }
                  }}
                >
                  {/* Name block (line 1: name/rename, line 2: start date-time) */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Line 1 — fixed height so the row does not jump when the
                        name line swaps to the rename input and back (AC-2). */}
                    <div style={{ height: 18, minWidth: 0 }}>
                      {isEditing ? (
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitRename(session.sessionId);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelRename(session.sessionId);
                            }
                          }}
                          onBlur={() => commitRename(session.sessionId)}
                          ref={focusAndSelectRenameInput}
                          maxLength={120}
                          aria-label="Session name"
                          title="Enter to save, Esc to cancel"
                          className="mm-rename-input"
                          style={{
                            width: '100%', height: '100%', boxSizing: 'border-box',
                            background: 'var(--body-bg)',
                            border: '1px solid var(--accent-primary)',
                            borderRadius: 4,
                            padding: '0 4px',
                            fontSize: 10,
                            color: 'var(--text-primary)',
                            fontFamily: 'inherit',
                          }}
                        />
                      ) : (
                        <div
                          title={displayName}
                          style={{
                            fontSize: 10,
                            lineHeight: '18px',
                            // Custom names visibly outrank derived/fallback;
                            // fallback timestamp labels are demoted placeholders.
                            color: isSelected || isCustom ? 'var(--text-primary)' : 'var(--text-secondary)',
                            fontWeight: isSelected || isCustom ? 600 : 400,
                            fontStyle: isFallback ? 'italic' : 'normal',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          {displayName}
                        </div>
                      )}
                    </div>
                    {/* Line 2 — compact start date-time */}
                    <div style={{
                      fontSize: 9, lineHeight: '12px', marginTop: 2,
                      color: 'var(--text-secondary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {formatStartTime(session.startTime)}
                    </div>
                  </div>

                  {/* Edit button (#2748 AC-2 / FIX-2) — between the name block
                      and the trash; hidden by default, revealed on row hover
                      or :focus-within (keyboard reachable WITHOUT hover).
                      FIX-2: the resting state must keep the button in the tab
                      order + a11y tree — `visibility:hidden` was the defect
                      (removes both). The resting opacity 0 / pointer-events
                      none comes from the .mm-row-edit-btn CSS class; the JS
                      inline opacity below mirrors the reveal state so the
                      hover/focus-within behavior stays directly testable. */}
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) editButtonRefs.current.set(session.sessionId, el);
                      else editButtonRefs.current.delete(session.sessionId);
                    }}
                    aria-label="Rename session"
                    title="Rename session"
                    className="mm-row-edit-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(session);
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-primary)')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
                    style={{
                      background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                      flexShrink: 0, display: 'flex', alignItems: 'center',
                      color: 'var(--text-secondary)',
                      opacity: showEdit ? 1 : undefined,
                    }}
                  >
                    <LuPencil size={11} />
                  </button>

                  {/* Delete button — keeps its position + stopPropagation. */}
                  <button
                    type="button"
                    aria-label="Delete session"
                    title="Delete session"
                    className="mm-row-del-btn"
                    onClick={(e) => { e.stopPropagation(); onDelete(session.sessionId); }}
                    style={{
                      background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                      flexShrink: 0, display: 'flex', alignItems: 'center', opacity: 0.35,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.35')}
                  >
                    <LuTrash2 size={11} color="var(--status-error)" />
                  </button>
                </div>
              );
            })}

            {filteredSessions.length === 0 && (
              <div style={{ padding: '16px 10px', fontSize: 10, color: 'var(--text-secondary)', textAlign: 'center' }}>
                {searchFilter ? 'No matching sessions' : 'No sessions yet'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
