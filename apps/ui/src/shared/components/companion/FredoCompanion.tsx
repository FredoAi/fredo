import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCompanion } from '../../contexts/CompanionContext';
import {
  ANIM_DURATION,
  CompanionEntity,
  IS_TAURI,
  MY_WINDOW,
  computeTeleportTarget,
  getActiveCompanionEntity,
} from './CompanionEntity';

// ── Component ────────────────────────────────────────────────────────────────

export const FredoCompanion: React.FC = () => {
  const { state, confirmAutoReturn, setHosting, markAway, notifyInteraction, teleport } = useCompanion();
  const { isAway, isAutoHidden, isAutoReturning, position } = state;

  // The interactive body lives in CompanionEntity. The host keeps every
  // window-level concern exactly once per window (never per surface): the
  // cross-window `companion-teleport` listener, the Ctrl+right-click gesture
  // handler, the auto-return settle, and the hosting report — driving whichever
  // entity surface is currently active through the module-scoped registry
  // (`getActiveCompanionEntity`). At home that is the launcher SEAT; while away
  // it is this host's OVERLAY.
  const isInThisWindowRef = useRef(MY_WINDOW === 'main');
  const [isInThisWindow, setIsInThisWindow] = useState(MY_WINDOW === 'main');
  // Pending teleport-in destination — applied once the overlay becomes active
  const pendingTeleportInRef = useRef<{ x: number; y: number } | null>(null);
  // Bumped on every cross-window arrival so the arrive effect fires even when
  // `isInThisWindow` was already true (rapid leave→return within one settle).
  const [arrivalSeq, setArrivalSeq] = useState(0);

  // Auto-return settle timer (distinct from the teleport sequence timer):
  // observed from `isAutoReturning`, cleared on cancel/unmount.
  const autoReturnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #2853 ST-2 / #2870 ST-2b: report host identity to the context so ONLY the
  // webview that currently displays the companion arms the host-owned idle
  // auto-return timer. Hosting now also requires Fredo to be AWAY from the home
  // seat, so the #2853 timer arms only for an out Fredo (never while he sits at
  // the seat).
  useEffect(() => { setHosting(isAway && isInThisWindow); }, [isAway, isInThisWindow, setHosting]);

  // Once this window becomes active (cross-window arrival), fire the queued
  // teleport-in. Keyed on `arrivalSeq` (not `isInThisWindow`) so a return leg
  // whose state was already true still plays the in motion; the overlay mounts in
  // this commit and registers its handle before the host's effect runs (child
  // passive effects run first), so `getActiveCompanionEntity()` is the overlay.
  useEffect(() => {
    if (!pendingTeleportInRef.current) return;
    const dest = pendingTeleportInRef.current;
    pendingTeleportInRef.current = null;
    getActiveCompanionEntity()?.arrive(dest);
  }, [arrivalSeq]);

  // Cross-window teleport via Tauri global events
  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | null = null;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ toWindow: string; x: number; y: number }>('companion-teleport', (ev) => {
        const { toWindow, x, y } = ev.payload;

        if (toWindow === MY_WINDOW) {
          if (isInThisWindowRef.current) {
            // Same-window teleport: the active entity (seat at home, overlay when
            // away) plays out → in at the clicked point. No entity mounted (e.g.
            // a window with no surface yet) → settle directly on the context.
            const entity = getActiveCompanionEntity();
            if (entity) entity.teleportTo({ x, y });
            else teleport(x, y);
          } else {
            // Cross-window arrival: mark Fredo AWAY + set the landing position
            // NOW so the overlay is eligible to mount at `{x,y}` (ST-2b gates it
            // on `isAway`); the queued teleport-in then fires via the effect.
            // `teleport` also broadcasts the away presence — this window is the
            // authoritative destination.
            isInThisWindowRef.current = true;
            pendingTeleportInRef.current = { x, y };
            teleport(x, y);
            setIsInThisWindow(true);
            setArrivalSeq((n) => n + 1);
          }
        } else if (isInThisWindowRef.current) {
          // Companion is leaving this window.
          isInThisWindowRef.current = false;
          const entity = getActiveCompanionEntity();
          if (entity?.surface === 'overlay') {
            // Away overlay: play the out motion, then hide on the preserved
            // settle (the overlay stays mounted through the out via the ref gate).
            entity.leaveWindow(() => setIsInThisWindow(false));
          } else {
            // Home seat (or no entity): the seat belongs to the launcher, not
            // this host, so `markAway` drops it immediately and there is no
            // overlay out-motion to await — settle this window synchronously
            // (never two Fredos, and `isAway && isInThisWindow` can not leave the
            // host idle timer armed).
            markAway();
            setIsInThisWindow(false);
          }
        }
      }).then(fn => { unlisten = fn; });
    });

    return () => { unlisten?.(); };
  }, [markAway, teleport]);

  // ── Idle auto-return (host-initiated, distinct from teleport) ──────────────
  // The context requests the return when the host idle timer fires. Play the
  // existing teleport-out leave motion, then settle to hidden after the
  // preserved +50 ms gap and let the provider broadcast the global presence.
  // NOT startTeleportOut — that path re-enters via startTeleportIn.
  useEffect(() => {
    if (!isAutoReturning) return;
    getActiveCompanionEntity()?.playLeave();
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
  // The gesture handler is registered exactly once per window; it dispatches to
  // the active entity surface. When NO entity is mounted in this window (e.g.
  // Fredo sits at the main-window seat and the gesture fires in the terminal
  // window), the host dispatches the request itself so the cross-window hand-off
  // still starts — the clamp uses the exact declared `AVATAR_SM` box.
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button !== 2 || !e.ctrlKey) return;
    e.preventDefault();
    const entity = getActiveCompanionEntity();
    if (entity) {
      entity.requestTeleport(e.clientX, e.clientY);
      return;
    }
    // #2853 ST-3: a teleport request is a companion interaction — reset the idle timer.
    notifyInteraction();
    const target = computeTeleportTarget(e.clientX, e.clientY);
    if (IS_TAURI) {
      // Broadcast to all webview windows (including this one) — the destination
      // arrival / source leave both run in the `companion-teleport` listener.
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('companion-teleport', { toWindow: MY_WINDOW, x: target.x, y: target.y });
      });
    } else {
      // Dev mode: no entity to animate — settle the context directly.
      isInThisWindowRef.current = true;
      setIsInThisWindow(true);
      teleport(target.x, target.y);
    }
  }, [notifyInteraction, teleport]);

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

  // #2870 ST-2b / ST-2c: the overlay is the AWAY representation only. It renders
  // when Fredo is away AND this window is the active destination. The gate reads
  // the synchronous `isInThisWindowRef` (not the state) so a same-tick `away` —
  // the local `markAway` on a cross-window leave, or the destination's
  // `companion-presence {away:true}` broadcast — can never re-mount an overlay in
  // the LEAVING window while its out motion is still playing. The state stays true
  // through the leave motion (so the out animation completes); the ref clears
  // immediately. At home the launcher renders the seat.
  if (!isAway || !isInThisWindowRef.current || isAutoHidden) return null;

  return (
    <CompanionEntity
      surface="overlay"
      x={position.x}
      y={position.y}
    />
  );
};
