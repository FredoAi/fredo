/**
 * AppDock — open-apps dock (Spec #2838 ST-1/ST-2/ST-3 + #2848 ST-3a).
 *
 * Positionable by the user: a LEFT-edge vertical rail (`position: 'sidebar'`,
 * the #2838/#2841 baseline) or a BOTTOM-center horizontal pill
 * (`position: 'bottom'`, Spec #2848). The chosen position comes from the
 * module-scoped `dockPositionStore` (`useDockPosition()`, default `'sidebar'`)
 * so a Settings → Appearance selection repositions the already-mounted dock on
 * the same tick.
 *
 * Replaces the #2821 minimize-triggered bottom drawer as the single open-apps
 * surface. A PURE CONSUMER of the shared window-system read surface:
 * `useWindows()` (store-order open list) + `useWindowActions()` (focus/close
 * dispatch). The window engine is READ-ONLY — this module never edits
 * `windowStore.ts` / `windowTypes.ts` / the window components.
 *
 * Dual visibility mode (Spec #2841 AC1): a single derived `coveredByWindow`
 * boolean (`windows.some(w => !w.isMinimized)`, mirroring LauncherShell) gates
 * clean-vs-covered. On a CLEAN desktop (`restingVisible`) the dock is
 * RESTING-VISIBLE — `visibility:visible`, `pointer-events:auto`, at its docking
 * position, no edge gesture, no pointer listener, in the tab order + a11y tree
 * (AC1: the user sees open apps without moving the pointer). When a window
 * covers the desktop the dock reverts to the #2838 transient edge-peek model:
 * OFF-CANVAS + `pointer-events:none` + `visibility:hidden` (out of tab order and
 * the a11y tree — D-9), revealed on a passive document-`pointermove` over the
 * docked edge zone (left edge `clientX <= EDGE_ZONE_PX` for Sidebar), slid away
 * after a hide-delay grace. No pinning, no full-height hover strip, no global
 * CSS. (The #2848 bottom-edge reveal/keep predicates + roving keys are a
 * FOLLOW-UP slice — ST-3a renders the bottom orientation only.)
 *
 * No re-render loop (NFR-2): `revealed` is a single transition-only boolean;
 * the pointer handler only calls `setRevealed` on an actual boolean transition
 * and never reads/writes array `.length` or freshly created object refs in
 * effect deps. Timers live in refs and are cleared on re-entry/unmount. The
 * entry list is `useWindows()` store order (NFR-3) — no z-sort, no second
 * registry, no list-length-driven effects.
 *
 * Geometry is module-level named constants (NFR-4 / testability).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box } from '@chakra-ui/react';
import { useReducedMotion } from 'framer-motion';
import { useWindows } from '../../../../shared/window-system/useWindows';
import { useWindowActions } from '../../../../shared/window-system/useWindowActions';
import { tint } from '../../../../shared/utils/colorTint';
import { DockEntry } from './DockEntry';
import { useDockPosition } from './dockPositionStore';
import type { WindowEntry } from '../../../../shared/window-system/windowTypes';

// ── Geometry + timing constants (module-level, named) ────────────────────────

/** Reveal zone: pointer `clientX <= EDGE_ZONE_PX` at the left edge reveals (D-2). */
export const EDGE_ZONE_PX = 6;
/** Keep zone: revealed stays while the pointer is within the dock + this margin. */
export const DOCK_KEEP_MARGIN_PX = 24;
/** Hide grace: slide away after the pointer leaves dock+zone for this long. */
export const HIDE_DELAY_MS = 350;
/** Stacking: above the window stack (z=1) + resting launcher (z=1100); below
 *  the Ctrl+Space overlay (z=1300); co-equal with the chrome band (z=1200,
 *  which is `pointer-events: none` and never steals dock input). */
export const DOCK_Z_INDEX = 1200;

/** Rail footprint width (px). */
export const DOCK_WIDTH_PX = 52;
/** Rail corner radius (px). */
export const DOCK_RAIL_RADIUS_PX = 14;
/** Top/bottom clearances when the rail is at max height. */
export const DOCK_VERTICAL_INSET_PX = 88;
/** Rail max height before the entry list scrolls (≥6 apps state). */
export const DOCK_MAX_HEIGHT_PX = 480;
/** Rail list entry gap (px). */
export const DOCK_GAP_PX = 4;
/** List padding (px) — right reserves the scrollbar gutter so the 36px wells
 *  never clip when the rail scrolls (≥6 apps). */
export const DOCK_LIST_PADDING = '6px 6px 6px 2px';

/** Slide-in / slide-out durations (ms) — Doherty-friendly motion band. */
export const REVEAL_DURATION_MS = 180;
export const HIDE_DURATION_MS = 160;

/** Keep-zone width measured from the viewport's left edge. */
export const DOCK_KEEP_ZONE_PX = DOCK_WIDTH_PX + DOCK_KEEP_MARGIN_PX;
/** Off-canvas rest shift: rail width (-100%) + an 8px shadow gap (UI/UX). */
export const DOCK_HIDDEN_GAP_PX = 8;

/** Rail max-height CSS (UI/UX: `min(480px, calc(100vh - 176px))`). */
export const DOCK_RAIL_MAX_HEIGHT = `min(${DOCK_MAX_HEIGHT_PX}px, calc(100vh - ${DOCK_VERTICAL_INSET_PX * 2}px))`;

// ── Bottom-bar geometry (Spec #2848 ST-3a) — the horizontal bottom-center pill.
//  These constants are the mirror-image of the Sidebar rail set above with the
//  x↔y axis swapped. The Sidebar values are UNCHANGED — the bottom pill introduces
//  its own named slots so the two orientations never share mutable geometry.

/** Pill height (px) — the bottom bar's track footprint (mirrors `DOCK_WIDTH_PX`). */
export const DOCK_BOTTOM_HEIGHT_PX = 52;
/** Pill corner radius (px) — mirrors `DOCK_RAIL_RADIUS_PX`. */
export const DOCK_BOTTOM_RADIUS_PX = 14;
/** Pill clearance above the viewport bottom edge (px). Keeps the resting pill
 *  clear of the OS/launcher bottom edge and the engaged keyboard-hints row
 *  (`LauncherChrome.tsx:448-468`). */
export const DOCK_BOTTOM_INSET_PX = 12;
/** Pill max width before the entry list scrolls horizontally (px). Clamped so
 *  the bottom-center pill clears the engaged-launcher clearance — the keyboard
 *  hints row renders along the full bottom edge (`LauncherChrome.tsx:448-468`)
 *  and the settings button sits bottom-right — see the CSS clamp below. */
export const DOCK_BOTTOM_MAX_WIDTH_PX = 560;
/** Pill list entry gap (px) — mirrors `DOCK_GAP_PX` for the row flow. */
export const DOCK_BOTTOM_GAP_PX = 4;
/** Keep-zone height measured from the viewport bottom edge (mirrors the
 *  Sidebar keep-zone measured from the left edge). */
export const DOCK_BOTTOM_KEEP_ZONE_PX = DOCK_BOTTOM_HEIGHT_PX + DOCK_KEEP_MARGIN_PX;
/** Pill list padding (px) — bottom reserves the horizontal scrollbar gutter so
 *  the 36px wells never clip when the pill scrolls (≥~9 apps). */
export const DOCK_BOTTOM_LIST_PADDING = '2px 6px 6px 6px';

/** Pill max-width CSS (`min(560px, calc(100vw - 176px))`). The 176px
 *  horizontal reserve (88px each side) clears the bottom-right settings button
 *  and the engaged keyboard-hints row when the pill rests centered. */
export const DOCK_BOTTOM_MAX_WIDTH = `min(${DOCK_BOTTOM_MAX_WIDTH_PX}px, calc(100vw - 176px))`;

/** Themed scrollbar (thumb `var(--card-hover-bg)`, track transparent). */
const DOCK_SCROLLBAR_CSS = {
  '&::-webkit-scrollbar': { width: '6px', height: '6px' },
  '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
};
/** Is a DOM element focusable (a11y focus-restore guard)? */
function isFocusableElement(el: HTMLElement | null): boolean {
  return !!el && el.isConnected && el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled;
}

export const AppDock: React.FC = () => {
  const windows = useWindows();
  const actions = useWindowActions();
  const reducedMotion = useReducedMotion() ?? false;
  // Position (Spec #2848 ST-1/ST-3): module-scoped store shared with the
  // Settings → Appearance control, so a selection there repositions the
  // already-mounted dock on the same tick (AC1).
  const position = useDockPosition();
  // Bottom bar vs sidebar — only the geometry/axis of the render differs; the
  // visibility state machine below is position-agnostic (kept as-is for ST-3a).
  const isBottom = position === 'bottom';

  // Empty-dock gate (D-1/AC1): no listener and no dock when zero windows.
  const hasWindows = windows.length > 0;

  // A NON-minimized feature window covers the desktop (#2825 chrome-vs-window
  // rule). On a CLEAN desktop (no covering window) the rail rests VISIBLE (AC1
  // — no edge gesture, no pointer movement); when a window covers the desktop
  // it reverts to the #2838 transient edge-peek model. This mirrors the same
  // predicate LauncherShell uses (`LauncherShell.tsx:195`) so the clean-vs-
  // covered decision is byte-identical across the chrome surfaces.
  const coveredByWindow = windows.some((w) => !w.isMinimized);

  const [revealed, setRevealedState] = useState(false);
  const revealedRef = useRef(false);
  /** Whether the rail currently rests visible (clean desktop). Mirrored into a
   *  ref so the event handlers (which must stay render-stable) can read the
   *  latest resting-vs-covered decision without a stale closure. */
  const restingVisibleRef = useRef(!coveredByWindow);

  const dockRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const lastPointerXRef = useRef(-1);
  const focusInsideRef = useRef(false);
  /** Last input modality — determines whether dock focus suspends auto-hide. */
  const lastInputModeRef = useRef<'pointer' | 'keyboard'>('pointer');
  const lastFocusedOutsideRef = useRef<HTMLElement | null>(null);

  /** Transition-only reveal setter — React bail-out + ref guard (NFR-2). */
  const setRevealed = useCallback((next: boolean) => {
    if (revealedRef.current === next) return;
    revealedRef.current = next;
    setRevealedState(next);
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const armHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) return; // already armed
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setRevealed(false);
    }, HIDE_DELAY_MS);
  }, [setRevealed]);

  /** Document pointermove: reveal on left-edge zone; keep/hide by keep-zone. */
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const x = e.clientX;
      lastPointerXRef.current = x;

      if (!revealedRef.current) {
        // Hidden → reveal only when the pointer reaches the true left edge.
        if (x <= EDGE_ZONE_PX) {
          clearHideTimer();
          setRevealed(true);
        }
        return;
      }

      // Revealed: suspend auto-hide while keyboard focus is inside the dock.
      if (focusInsideRef.current) {
        clearHideTimer();
        return;
      }
      if (x <= DOCK_KEEP_ZONE_PX) {
        clearHideTimer();
      } else {
        armHideTimer();
      }
    },
    [clearHideTimer, armHideTimer, setRevealed],
  );

  // Listener + empty gate (D-1): attach only while ≥1 window is open. On a CLEAN
  // desktop (`restingVisible`) no pointer listener is attached (AC1 — the rail
  // rests visible with no edge gesture); the #2838 transient edge-peek state
  // machine mounts ONLY when a window covers the desktop (`coveredByWindow`).
  // `restingVisible` is a derived primitive boolean (never `.length`/fresh
  // object) so this effect stays a safe dependency (NFR-2).
  const restingVisible = !coveredByWindow;
  // Mirror for stable event handlers (read the LIVE decision, not a stale
  // closure captured at mount).
  restingVisibleRef.current = restingVisible;
  useEffect(() => {
    if (!hasWindows) {
      clearHideTimer();
      if (revealedRef.current) setRevealed(false);
      return;
    }
    if (restingVisible) {
      // Clean desktop → resting-visible: no hide timer, no edge listener.
      clearHideTimer();
      if (!revealedRef.current) setRevealed(true);
      return;
    }
    // Covered desktop → revert to the #2838 transient edge-peek model: the rail
    // starts OFF-CANVAS (revealed=false) so a maximized window stays full-bleed.
    if (revealedRef.current) setRevealed(false);
    const handlePointerDown = (): void => {
      lastInputModeRef.current = 'pointer';
      focusInsideRef.current = false;
    };
    const handleKeyDown = (): void => {
      lastInputModeRef.current = 'keyboard';
    };
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerdown', handlePointerDown, { passive: true });
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      clearHideTimer();
    };
  }, [hasWindows, restingVisible, handlePointerMove, clearHideTimer, setRevealed]);

  // When the dock hides (pointer-away, ESC, or last-app close), keyboard focus
  // can no longer be inside it — reset the suspension flag so a later reveal is
  // pointer-governed again (no stale focusInside stuck-visible dock).
  useEffect(() => {
    if (!revealed) {
      focusInsideRef.current = false;
      clearHideTimer();
    }
  }, [revealed, clearHideTimer]);

  // Hide when focus leaves the dock and the pointer is outside the keep zone.
  // Only applies in the covered/edge-peek branch — in the resting-visible
  // branch the rail's reveal is governed by `restingVisible` (derived above),
  // never by a hide timer.
  const handleRegionBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (restingVisibleRef.current) return;
      const next = e.relatedTarget as Node | null;
      const dock = dockRef.current;
      if (dock && next && dock.contains(next)) return; // focus stayed inside
      focusInsideRef.current = false;
      if (lastPointerXRef.current > DOCK_KEEP_ZONE_PX) armHideTimer();
    },
    [armHideTimer],
  );

  // Track focus entry (suspends auto-hide) + the outside focus origin (ESC restore).
  // Suspension applies only when focus arrived by KEYBOARD: a pointer click that
  // happens to leave DOM focus on a dock button must NOT pin the dock open once
  // the pointer leaves (pointer-governed hide). Modality is tracked by the
  // document-level pointerdown/keydown listeners.
  const handleRegionFocus = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const dock = dockRef.current;
      const prev = e.relatedTarget as HTMLElement | null;
      if (dock && (!prev || !dock.contains(prev))) {
        lastFocusedOutsideRef.current = prev;
      }
      focusInsideRef.current = lastInputModeRef.current === 'keyboard';
      clearHideTimer();
    },
    [clearHideTimer],
  );

  /** Roving keyboard model + ESC close on the revealed dock (NFR-6). */
  const handleRegionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Any keydown inside the dock is genuine keyboard use → suspend auto-hide
      // (keyboardOpen state). Roving keys below also require focus to be inside.
      focusInsideRef.current = true;
      if (e.key === 'Escape') {
        e.preventDefault();
        // Resting-visible rail stays persistently visible (AC1) — ESC restores
        // focus but never hides it. Only the covered/edge-peek branch hides.
        if (!restingVisibleRef.current) setRevealed(false);
        const origin = lastFocusedOutsideRef.current;
        if (isFocusableElement(origin)) {
          origin?.focus();
        } else {
          (document.activeElement as HTMLElement | null)?.blur();
        }
        return;
      }

      const dock = dockRef.current;
      if (!dock) return;
      const entries = Array.from(dock.querySelectorAll<HTMLButtonElement>('[data-dock-entry]'));
      if (entries.length === 0) return;

      let idx = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (idx === -1) {
        const active = document.activeElement;
        const row = active instanceof Element ? active.closest('[data-dock-item]') : null;
        const rowBtn = row?.querySelector<HTMLButtonElement>('[data-dock-entry]');
        idx = rowBtn ? entries.indexOf(rowBtn) : -1;
      }

      let nextIdx = idx;
      if (e.key === 'ArrowDown') nextIdx = idx < 0 ? 0 : Math.min(idx + 1, entries.length - 1);
      else if (e.key === 'ArrowUp') nextIdx = idx < 0 ? entries.length - 1 : Math.max(idx - 1, 0);
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = entries.length - 1;
      else return;

      e.preventDefault();
      entries[nextIdx]?.focus();
    },
    [setRevealed],
  );

  /** Consumer-side activation: top-window no-op guard + restore path (D-4). */
  const handleActivate = useCallback(
    (win: WindowEntry) => {
      if (win.focused && !win.isMinimized) return; // already top → no-op
      actions.focusWindow(win.id); // kernel clears minimize → restore
    },
    [actions],
  );

  const handleClose = useCallback(
    (win: WindowEntry) => {
      actions.closeWindow(win.id); // idempotent, re-entrancy-guarded
    },
    [actions],
  );

  // Empty gate: no dock, no listeners, no state when zero windows.
  if (!hasWindows) return null;

  const hidden = !revealed;
  // CSS-only motion: transform slides; visibility flips immediately on reveal
  // and after the slide-out on hide (transition-delay technique — no JS timer).
  const transition = reducedMotion
    ? 'none'
    : hidden
      ? `transform ${HIDE_DURATION_MS}ms ease-in, visibility 0s linear ${HIDE_DURATION_MS}ms`
      : `transform ${REVEAL_DURATION_MS}ms ease-out, visibility 0s linear 0s`;

  return (
    <Box
      ref={dockRef}
      role="region"
      aria-label="Open applications"
      data-testid="app-dock"
      position="fixed"
      zIndex={DOCK_Z_INDEX}
      {...(isBottom
        ? {
            // Bottom bar (Spec #2848 ST-3a): fixed to the bottom-center. The
            // dock slides Y off-canvas when hidden and centers horizontally via
            // translateX(-50%) when visible. `bottom` = the resting clearance
            // above the viewport's bottom edge.
            bottom: `${DOCK_BOTTOM_INSET_PX}px`,
            left: '50%',
          }
        : {
            // Sidebar (baseline #2838/#2841): fixed to the left edge,
            // vertically centered. Unchanged geometry.
            left: '0',
            top: '50%',
          })}
      onPointerEnter={() => clearHideTimer()}
      onKeyDown={handleRegionKeyDown}
      onFocus={handleRegionFocus}
      onBlur={handleRegionBlur}
      style={{
        transform: isBottom
          ? hidden
            ? `translate(-50%, calc(100% + ${DOCK_HIDDEN_GAP_PX}px))`
            : 'translate(-50%, 0)'
          : hidden
            ? `translate(calc(-100% - ${DOCK_HIDDEN_GAP_PX}px), -50%)`
            : 'translate(0px, -50%)',
        visibility: hidden ? 'hidden' : 'visible',
        pointerEvents: hidden ? 'none' : 'auto',
        transition,
      }}
    >
      <Box
        {...(isBottom
          ? {
              // Bottom-center pill: horizontal track, pill height.
              height: `${DOCK_BOTTOM_HEIGHT_PX}px`,
              display: 'flex',
              flexDirection: 'row' as const,
            }
          : {
              // Left-edge rail: vertical track, rail width.
              width: `${DOCK_WIDTH_PX}px`,
              display: 'flex',
              flexDirection: 'column' as const,
            })}
        overflow="hidden"
        borderRadius={`${isBottom ? DOCK_BOTTOM_RADIUS_PX : DOCK_RAIL_RADIUS_PX}px`}
        border="1px solid"
        borderColor="border.default"
        bg="bg.surface"
        backdropFilter="blur(10px)"
        // Soft layered pill (UI/UX Spec §2): a wide ambient tint + a tight
        // grounding tint — both via `tint()` color-mix, never a hardcoded
        // rgba shadow (#2770 / AC5).
        boxShadow={`0 8px 24px ${tint('var(--border-color)', 25)}, 0 1px 2px ${tint('var(--border-color)', 12)}`}
      >
        <Box
          role="list"
          {...(isBottom
            ? {
                // Bottom bar: horizontal entry flow that scrolls sideways past
                // the max-width clamp (overflowX auto, themed scrollbar).
                maxWidth: DOCK_BOTTOM_MAX_WIDTH,
                overflowX: 'auto' as const,
                display: 'flex',
                flexDirection: 'row' as const,
                gap: `${DOCK_BOTTOM_GAP_PX}px`,
                padding: DOCK_BOTTOM_LIST_PADDING,
              }
            : {
                // Sidebar: vertical entry flow that scrolls past the max-height
                // clamp (overflowY auto, themed scrollbar).
                maxHeight: DOCK_RAIL_MAX_HEIGHT,
                overflowY: 'auto' as const,
                display: 'flex',
                flexDirection: 'column' as const,
                gap: `${DOCK_GAP_PX}px`,
                padding: DOCK_LIST_PADDING,
              })}
          css={DOCK_SCROLLBAR_CSS}
        >
          {windows.map((win) => (
            <DockEntry
              key={win.id}
              win={win}
              onActivate={handleActivate}
              onClose={handleClose}
              orientation={position}
            />
          ))}
        </Box>
      </Box>
    </Box>
  );
};
