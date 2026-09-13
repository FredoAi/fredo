import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCompanion } from '../../contexts/CompanionContext';
import { ANIM_DURATION, CompanionEntity, IS_TAURI, MY_WINDOW } from './CompanionEntity';
import type { CompanionEntityHandle } from './CompanionEntity';

// ── Component ────────────────────────────────────────────────────────────────

export const FredoCompanion: React.FC = () => {
  const { state, confirmAutoReturn, setHosting } = useCompanion();
  const { isAutoReturning, position } = state;

  // The interactive body lives in CompanionEntity. The host keeps every
  // window-level concern exactly once per window (never per surface): the
  // cross-window `companion-teleport` listener, the Ctrl+right-click gesture
  // handler, the auto-return settle, and the hosting report — driving the
  // entity through its imperative handle.
  const entityRef = useRef<CompanionEntityHandle | null>(null);

  // Cross-window: companion starts in main, hidden in terminal
  const isInThisWindowRef = useRef(MY_WINDOW === 'main');
  const [isInThisWindow, setIsInThisWindow] = useState(MY_WINDOW === 'main');
  // Pending teleport-in destination — applied once the component becomes visible
  const pendingTeleportInRef = useRef<{ x: number; y: number } | null>(null);

  // Auto-return settle timer (distinct from the teleport sequence timer):
  // observed from `isAutoReturning`, cleared on cancel/unmount.
  const autoReturnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #2853 ST-2: report host identity to the context so ONLY the webview that
  // currently displays the companion arms the host-owned idle auto-return timer.
  useEffect(() => { setHosting(isInThisWindow); }, [isInThisWindow, setHosting]);

  // Once this window becomes active (cross-window arrival), fire the queued teleport-in
  useEffect(() => {
    if (isInThisWindow && pendingTeleportInRef.current) {
      const dest = pendingTeleportInRef.current;
      pendingTeleportInRef.current = null;
      entityRef.current?.arrive(dest);
    }
  }, [isInThisWindow]);

  // Cross-window teleport via Tauri global events
  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | null = null;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ toWindow: string; x: number; y: number }>('companion-teleport', (ev) => {
        const { toWindow, x, y } = ev.payload;

        if (toWindow === MY_WINDOW) {
          if (isInThisWindowRef.current) {
            // Same-window teleport: companion is already here, just move it
            entityRef.current?.teleportTo({ x, y });
          } else {
            // Cross-window arrival: make component visible, then teleport-in fires via effect
            isInThisWindowRef.current = true;
            pendingTeleportInRef.current = { x, y };
            setIsInThisWindow(true);
          }
        } else if (isInThisWindowRef.current) {
          // Companion is leaving this window — play teleport-out, THEN hide
          isInThisWindowRef.current = false;
          entityRef.current?.leaveWindow(() => setIsInThisWindow(false));
        }
      }).then(fn => { unlisten = fn; });
    });

    return () => { unlisten?.(); };
  }, []);

  // ── Idle auto-return (host-initiated, distinct from teleport) ──────────────
  // The context requests the return when the host idle timer fires. Play the
  // existing teleport-out leave motion, then settle to hidden after the
  // preserved +50 ms gap and let the provider broadcast the global presence.
  // NOT startTeleportOut — that path re-enters via startTeleportIn.
  useEffect(() => {
    if (!isAutoReturning) return;
    entityRef.current?.playLeave();
    autoReturnTimerRef.current = setTimeout(() => {
      autoReturnTimerRef.current = null;
      confirmAutoReturn();
    }, ANIM_DURATION['teleport-out'] + 50);
    return () => {
      if (autoReturnTimerRef.current) {
        clearTimeout(autoReturnTimerRef.current);
        autoReturnTimerRef.current = null;
      }
    };
  }, [isAutoReturning, confirmAutoReturn]);

  // Ctrl+right-click — teleport companion to THIS window at clicked position.
  // The gesture handler is registered exactly once per window; the entity owns
  // the request dispatch (clamp + emit / local teleport).
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button !== 2 || !e.ctrlKey) return;
    e.preventDefault();
    entityRef.current?.requestTeleport(e.clientX, e.clientY);
  }, []);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    if (e.ctrlKey) e.preventDefault();
  }, []);

  useEffect(() => {
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('contextmenu', handleContextMenu);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [handleMouseDown, handleContextMenu]);

  useEffect(() => () => {
    if (autoReturnTimerRef.current) clearTimeout(autoReturnTimerRef.current);
  }, []);

  return (
    <CompanionEntity
      ref={entityRef}
      surface="overlay"
      x={position.x}
      y={position.y}
    />
  );
};
