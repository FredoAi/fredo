import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useBreakpointValue } from '@chakra-ui/react';

// Own-kernel window list (Spec #2807 ST-1) — AC1: never the third-party toolbar.
import { useWindows } from '../../../../shared/window-system/useWindows';
// Live stream/connection flag — mirrors StreamStatus.tsx (ONLINE dot).
import { useConnectionStatus } from '../../../../shared/contexts/StreamContext';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import { tint } from '../../../../shared/utils/colorTint';

import { LauncherChrome } from './LauncherChrome';
import { LauncherAppGrid } from './LauncherAppGrid';
import { LauncherCommandBar } from './LauncherCommandBar';
import { PixelButler } from './PixelButler';

/**
 * LauncherShell — the Fredo-owned launcher host (Spec #2808 ST-1; Spec #2821
 * ST-5 structural hoist).
 *
 * Replaces the third-party `Toolbar` (`DesktopToolbar.tsx`). This is the
 * full-screen desktop surface. It uses a 2-state reveal model (#2819):
 *
 *   - Resting Main (`engaged=false`): chrome + pixel-butler avatar + `>`
 *     search-or-command bar; NO app grid, NO keyboard hints. This is the
 *     default at launch (fixes the blank-desktop first impression).
 *   - Engaged    (`engaged=true`): resting surface + the `| APPS` grid and the
 *     keyboard-nav hints (revealed when the command bar is focused or a query
 *     is present).
 *
 * AC5 (persistent search/command, Spec #2821 ST-5): the resting Main surface
 * is HOISTED to the shell ROOT and is ALWAYS mounted — it is never gated by an
 * `open` boolean, so closing a feature window never unmounts the search bar
 * (`bugs/launcher-disappears.png` is the fail state). Instead of collapsing on
 * window-open, the whole surface is placed BELOW the window stack (a maximized
 * feature window legitimately covers it — `Home.tsx:91`), and is simply
 * re-revealed when no non-minimized window covers it. The idle/engaged
 * grid-reveal model, keyboard-nav, and the `—` MINIMIZE control are preserved.
 *
 * The host owns the shared state (engaged, query, selected tile index) and the
 * keyboard-nav orchestration (↑↓ / ←→ / Enter / Space / Esc). It reads the
 * live own-kernel window list via `useWindows()` (used both to re-z the surface
 * behind maximized windows and to sink the grid when one opens) and dispatches
 * every tile open through `onOpenFeature` → Home's full-lifecycle opener (never
 * raw `openWindow`), preserving feature close-on-unmount / self-open / rerender
 * wiring (Home.tsx:77-129).
 *
 * The grid's empty guard (AC4) + the command-bar filter means arrows/Enter/
 * Space are NO-OPs whenever there is no selectable entry: `showableFeatures`
 * empty (AC4) OR the query filters every tile out — keyboard never opens a tile
 * that does not exist.
 */

export interface LauncherShellProps {
  /** Fredo's real showable features (Home.tsx:22 — SHOWABLE_FEATURES). */
  showableFeatures: FredoFeatureClass[];
  /** Routes a selected tile to the own-kernel full-lifecycle opener (Home.tsx). */
  onOpenFeature: (id: string, feature: FredoFeatureClass) => void;
}

const clampIndex = (value: number, len: number): number =>
  Math.min(Math.max(0, value), len - 1);

/** The command-bar `role="searchbox"` input is the grid-navigation focus anchor. */
const SEARCHBOX_SELECTOR = 'input[role="searchbox"]';
const NOTCH_SELECTOR = '[role="button"][aria-label="Fredo launcher"]';

/** Surface stacking: resting Main above the (transparent) window stack when it
 *  is not covered; dropped BELOW it once a maximized feature window covers the
 *  desktop (AC5 — a maximized window legitimately covers the surface). */
const SURFACE_Z_VISIBLE = 1100;
const SURFACE_Z_COVERED = 0;
/** #2823 open level: the shortcut-opened launcher MUST rise above the window
 *  stack (WindowManager z=1) AND above the chrome (z=1200) / StreamStatus
 *  (z=1210) so a maximized covering window never obscures it (AC1 "opens on
 *  top" over a maximized window). Only the SHORTCUT-open state uses this; the
 *  closed state preserves the resting z-sink (coveredByWindow). */
const SURFACE_Z_OPENED = 1300;

/** #2823 AC3: true for any text-editing control — the "another input" guard.
 *  The launcher's own searchbox is an `input`, so this predicate ALONE is not
 *  sufficient; it must be paired with an overlayRef containment check (NFR-7). */
const isTextControl = (el: Element | null): boolean =>
  !!el &&
  (el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el as HTMLElement).isContentEditable === true);

/** #2823 REQ-5 / NFR-4: connected AND focusable target for focus restore.
 *  Excludes `body` (tabIndex -1), disabled, aria-disabled and detached nodes so
 *  focus is never restored onto a stale/unmounted reference. */
const isFocusable = (el: HTMLElement | null): boolean =>
  !!el &&
  el.isConnected &&
  el.tabIndex >= 0 &&
  !(el as HTMLInputElement).disabled &&
  el.getAttribute('aria-disabled') !== 'true';

/** Subtle dot/tick grid texture (Asset 1.7) — faint border-color color-mix
 *  lines, token-native, behind every window (the overlay is z-gated below the
 *  window stack when covered). */
const DESKTOP_TEXTURE_CSS = {
  backgroundColor: 'var(--card-bg)',
  backgroundImage: [
    `linear-gradient(to right, ${tint('var(--border-color)', 12)} 1px, transparent 1px)`,
    `linear-gradient(to bottom, ${tint('var(--border-color)', 12)} 1px, transparent 1px)`,
  ].join(', '),
  backgroundSize: '28px 28px',
};

export const LauncherShell: React.FC<LauncherShellProps> = ({ showableFeatures, onOpenFeature }) => {
  const currentWindows = useWindows();
  const { isConnected } = useConnectionStatus();

  // #2819 FIXED: the shell surface is visible by default at launch (idle), so a
  // fresh launch shows the avatar + command bar instead of a blank desktop.
  // Grid + keyboard-hints sub-state: reached when the command bar is focused or a
  // query is present; returns to idle on ESC / focus-leaving-the-surface (empty query).
  const [engaged, setEngaged] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // #2823: shortcut-opened overlay state — DISTINCT from the #2819 `engaged`
  // grid-reveal. `open` is TRUE only when the launcher was summoned by Ctrl+Space
  // (it re-z's above the window stack + autofocuses the searchbox). When FALSE the
  // resting z-model (coveredByWindow) applies unchanged.
  const [open, setOpen] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const prevWindowCountRef = useRef(currentWindows.length);
  // Suppresses re-engaging when focus is moved programmatically (ESC → refocus the
  // command bar) so the grid stays hidden while the surface returns to idle.
  const skipNextFocusEngageRef = useRef(false);
  // #2823: synchronous `open` mirror so the document keydown handler (mounted once,
  // reads the LATEST value) sees current state without the one-render lag that would
  // turn a rapid Ctrl+Space double-press into a double-open (real AC-1 edge). We
  // assign it directly inside the open/close helpers (never via an effect).
  const openRef = useRef(false);
  // #2823: focus origin captured on (shortcut) open, restored on close (REQ-5).
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // #2823: NFR-2 idempotency guard — exactly ONE document keydown listener active.
  const globalKeydownMountedRef = useRef(false);

  // #2823: close the launcher overlay WITHOUT restoring focus — used when focus has
  // already left the surface (window-open, tile-open, minimize, natural blur) so the
  // overlay drops back to the resting z-model and the grid idles. `openRef` is set
  // synchronously so the global handler never observes a stale open state.
  const closeSurface = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setEngaged(false);
  }, []);

  // #2823: Ctrl+Space open — capture the pre-open focus origin (first-open only;
  // never re-captured on a toggle-close, so a Ctrl+Space in → Ctrl+Space out returns
  // to the element the user was on before the FIRST open, not the searchbox), raise
  // the overlay above the window stack and autofocus the command-bar searchbox.
  const openOverlay = useCallback(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    openRef.current = true;
    setOpen(true);
    setEngaged(true);
    window.requestAnimationFrame(() => {
      // Guard against a within-frame toggle-off (rapid double-press): only focus the
      // searchbox if the overlay is STILL open (openRef is read live, not captured).
      if (!openRef.current) return;
      const input = overlayRef.current?.querySelector<HTMLInputElement>(SEARCHBOX_SELECTOR);
      if (input && document.activeElement !== input) input.focus();
    });
  }, []);

  // #2823: close (ESC / toggle-off) — drop the overlay to resting (closeSurface) AND
  // restore focus to the pre-open element ONLY if focus was actually inside the
  // launcher surface at close time (UI/UX §3). If the user already moved focus out,
  // do NOT yank it back. Falls back to blur when the pre-open element is
  // stale/unfocusable (NFR-4) — never a focus-trap into a dead launcher.
  const closeOverlay = useCallback(() => {
    const active = document.activeElement;
    closeSurface();
    if (overlayRef.current?.contains(active)) {
      const prev = previousFocusRef.current;
      if (isFocusable(prev)) {
        window.requestAnimationFrame(() => {
          // Don't yank focus back if the launcher was re-opened before this frame ran
          // (rapid on→off→on): the re-open's own focus wins.
          if (!openRef.current) prev?.focus();
        });
      } else {
        (active as HTMLElement | null)?.blur();
      }
    }
  }, [closeSurface]);

  // A window covers the surface when it is shown (not minimized). Windows open
  // maximized (`Home.tsx:91`), so any open window covers the resting Main.
  const coveredByWindow = currentWindows.some((w) => !w.isMinimized);
  // Open override: the shortcut-opened overlay rises above the window stack / chrome
  // regardless of `coveredByWindow`. The CLOSED state preserves the #2821 z-sink
  // below a maximized window.
  const surfaceZ = open ? SURFACE_Z_OPENED : coveredByWindow ? SURFACE_Z_COVERED : SURFACE_Z_VISIBLE;

  // Command-bar query filters the grid by tile name (type-ahead highlight).
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return showableFeatures;
    return showableFeatures.filter((feature) => feature.name.toLowerCase().includes(q));
  }, [showableFeatures, query]);

  // Responsive column count — MUST mirror LauncherAppGrid's
  // `SimpleGrid columns={{ base: 2, sm: 3, md: 4, lg: 6 }}` so ↑↓ leaps a full row.
  const columns = useBreakpointValue({ base: 2, sm: 3, md: 4, lg: 6 }) ?? 2;

  const entryCount = filteredEntries.length;
  // Clamp the rendered selection to the (possibly filtered) entry set — 0 when empty
  // so the grid never receives an out-of-range index (the grid ignores it when empty).
  const safeSelectedIndex = entryCount === 0 ? 0 : Math.min(selectedIndex, entryCount - 1);
  const activeTileId = entryCount > 0 ? `fredo-launcher-tile-${safeSelectedIndex}` : undefined;

  // AC5: when a feature window opens through ANY path (launcher tile, self-open,
  // Konami, setup wizard), sink the ENGAGED grid so the freshly opened window is
  // not obscured — but DO NOT unmount the resting surface. The surface is always
  // mounted at the shell root and is simply re-z'd below the window stack
  // (`surfaceZ`), so the search/command access never disappears on window close.
  useEffect(() => {
    const prev = prevWindowCountRef.current;
    prevWindowCountRef.current = currentWindows.length;
    if (currentWindows.length > prev) {
      // #2823: a window opening (via ANY path) closes the shortcut overlay too, so
      // the freshly opened window is never obscured by a raised launcher surface.
      closeSurface();
      // Move focus out of the (now window-covered) launcher surface so keystrokes
      // are routed to the freshly opened window rather than the hidden search
      // input behind it (AC5 — the surface stays mounted, but is below the window).
      if (overlayRef.current?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement | null)?.blur();
      }
    }
  }, [currentWindows, closeSurface]);

  // Keep the keyboard-selected tile scrolled into view within the grid's scroll
  // region — only meaningful while the grid is revealed (engaged).
  useEffect(() => {
    if (!engaged) return;
    const container = overlayRef.current;
    if (!container) return;
    const cells = container.querySelectorAll<HTMLElement>('[role="grid"] [role="gridcell"]');
    cells[safeSelectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [engaged, safeSelectedIndex]);

  // FREDO notch trigger: toggles the grid reveal (idle <-> engaged). The surface
  // itself stays mounted (AC5) — the notch never collapses the search bar.
  const toggleOpen = useCallback(() => {
    setEngaged((e) => !e);
  }, []);

  // Reached-engaged: the command bar received real focus. Programmatic focus
  // (the post-ESC refocus) is suppressed so the grid stays hidden while idle.
  const handleBarFocus = useCallback(() => {
    if (skipNextFocusEngageRef.current) {
      skipNextFocusEngageRef.current = false;
      return;
    }
    setEngaged(true);
  }, []);

  // Leaves-engaged (`:focus-within` guard on the launcher root): collapse to
  // idle ONLY when focus leaves the launcher surface AND the query is empty. A
  // focus hop INTO a grid tile stays inside the surface, so it does not collapse
  // before the tile `onSelect` runs (the tile-click race). A non-empty query
  // keeps the grid engaged so ESC is the only exit.
  const handleSurfaceBlur = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      if (query.trim() !== '') return;
      const root = overlayRef.current;
      const next = e.relatedTarget as Node | null;
      if (root && (!next || !root.contains(next))) {
        // #2823: focus left the surface — collapse the grid AND drop the open overlay
        // back to the resting z-model (no focus-yank; the user moved focus deliberately).
        closeSurface();
      }
    },
    [query, closeSurface],
  );

  // `—` MINIMIZE control: collapse the ENGAGED grid back to the resting Main
  // (keep the search bar — AC5) and land focus on the FREDO notch trigger.
  const handleMinimize = useCallback(() => {
    // #2823: minimize closes a shortcut-opened overlay too (its z must drop).
    closeSurface();
    setQuery('');
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(NOTCH_SELECTOR)?.focus();
    });
  }, [closeSurface]);

  const openSelected = useCallback(() => {
    const feature = filteredEntries[safeSelectedIndex];
    if (!feature) return;
    // #2823: routing a tile through the own-kernel opener closes the overlay so the
    // freshly opened window is never obscured by a raised launcher surface.
    closeSurface();
    onOpenFeature(feature.id, feature);
  }, [filteredEntries, safeSelectedIndex, onOpenFeature, closeSurface]);

  const handleSelect = useCallback(
    (index: number) => {
      const feature = filteredEntries[index];
      if (!feature) return;
      closeSurface();
      onOpenFeature(feature.id, feature);
    },
    [filteredEntries, onOpenFeature, closeSurface],
  );

  const handleQueryChange = useCallback((q: string) => {
    setQuery(q);
    // A fresh filter restarts selection at the first tile.
    setSelectedIndex(0);
    // A present query reveals the grid (engaged) even without surface focus.
    if (q.trim() !== '') setEngaged(true);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (open) {
          // #2823: ESC on a shortcut-opened overlay closes the overlay (AC2) and
          // restores focus to the pre-open element (REQ-5). This is the ONLY action
          // — it does NOT co-fire the old idle-collapse branch (AC4).
          closeOverlay();
          return;
        }
        // #2819: ESC (mouse/idle, not shortcut-opened) returns to IDLE (grid +
        // hints hide), the surface stays. This pre-existing behavior is untouched.
        setEngaged(false);
        // Restore focus to the command-bar searchbox (idle affordance) WITHOUT
        // re-engaging — the programmatic refocus is suppressed so the grid stays
        // hidden until the user actually focuses/types again.
        window.requestAnimationFrame(() => {
          const input = overlayRef.current?.querySelector<HTMLInputElement>(SEARCHBOX_SELECTOR);
          if (input && document.activeElement !== input) {
            skipNextFocusEngageRef.current = true;
            input.focus();
          }
        });
        return;
      }

      // AC4: an empty / fully-filtered grid has no openable target — arrows,
      // Enter and Space are NO-OPs (keyboard never opens a tile that does not exist).
      if (entryCount === 0) return;

      const isFromInput = (e.target as HTMLElement).tagName === 'INPUT';

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => clampIndex(i + columns, entryCount));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => clampIndex(i - columns, entryCount));
          break;
        case 'ArrowRight':
          e.preventDefault();
          setSelectedIndex((i) => clampIndex(i + 1, entryCount));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setSelectedIndex((i) => clampIndex(i - 1, entryCount));
          break;
        case 'Enter':
          e.preventDefault();
          openSelected();
          break;
        case ' ':
          // Space opens only when a tile is focused (not while typing a query), AND
          // only when unmodified. Ctrl+Space is the global launcher toggle (handled by
          // the document listener) — a modified Space must NEVER be a plain-Space
          // tile-open (AC4: the chord triggers only the launcher toggle).
          if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isFromInput) {
            e.preventDefault();
            openSelected();
          }
          break;
      }
    },
    [columns, entryCount, openSelected, open, closeOverlay],
  );

  // #2823: the global Ctrl+Space shortcut — a bubble-phase `document` keydown
  // listener (the `useKonamiCode.ts:55-60` precedent) that works from anywhere
  // inside the Fredo window (no OS/Tauri global-shortcut plugin). It:
  //   - matches EXACTLY Ctrl+Space (physical `code === 'Space'`, no meta/alt/shift)
  //     so it is a distinct chord from plain Space (AC4 / NFR-5);
  //   - is a NO-OP while typing in a text-control OUTSIDE the launcher surface
  //     (AC3), treating the launcher's own searchbox as a valid toggle target (NFR-7);
  //   - only `preventDefault()` + `stopPropagation()` when the toggle actually fires
  //     so the chord NEVER reaches a second action (AC4);
  //   - toggles: closed → open (overlay on top + searchbox focused), open → close.
  const handleGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!(e.ctrlKey === true && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Space')) {
        return;
      }

      // AC3: typing in a text-editing control OUTSIDE the launcher surface → the
      // shortcut must NOT fire and MUST NOT steal focus (typing uninterrupted).
      const active = document.activeElement as HTMLElement | null;
      const activeInLauncher = !!active && !!overlayRef.current && overlayRef.current.contains(active);
      if (isTextControl(active) && !activeInLauncher) return;

      // AC4: only swallow the keydown when the launcher toggle actually fires.
      e.preventDefault();
      e.stopPropagation();

      // Toggle. "Active" = shortcut-open OR the launcher's own searchbox holds focus
      // (NFR-7 — the launcher input is a valid toggle target, so it is never the
      // AC3 "another input"). `openRef` is kept synchronous (no render lag).
      const searchbox = overlayRef.current?.querySelector<HTMLInputElement>(SEARCHBOX_SELECTOR);
      const launcherActive = openRef.current || (!!searchbox && document.activeElement === searchbox);

      if (launcherActive) {
        closeOverlay();
      } else {
        openOverlay();
      }
    },
    [closeOverlay, openOverlay],
  );

  // #2823: mount exactly ONE document listener (NFR-2). A ref-based guard keeps the
  // effect idempotent under React StrictMode; the cleanup removes the listener so it
  // never leaks across an unmount.
  useEffect(() => {
    if (globalKeydownMountedRef.current) return;
    globalKeydownMountedRef.current = true;
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      globalKeydownMountedRef.current = false;
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [handleGlobalKeyDown]);

  return (
    <>
      {/* Chrome is always visible: FREDO notch trigger + online clock + the
          decorative desktop frame / side-ticks / dot-grid. It sits ABOVE the
          open surface (zIndex 1200 vs 1100) and is pointerEvents:none except
          the notch, so the surface stays interactive. `engaged` +
          `selectedIndex` drive the engaged-only hint row + the dot-grid accent
          scroll-thumb. Spec #2825: when a non-minimized window covers the
          desktop (`coveredByWindow`), the whole chrome band sinks to z=0 —
          BELOW the z=1 window stack — in lockstep with the surface, so it
          never paints over a feature window or its titlebar controls (R-1/2/3). */}
      <LauncherChrome
        entryCount={entryCount}
        isOnline={isConnected}
        engaged={engaged}
        selectedIndex={safeSelectedIndex}
        onToggle={toggleOpen}
        coveredByWindow={coveredByWindow}
      />

      {/* Resting Main surface (AC5 structural hoist): ALWAYS mounted at the shell
          root so the search/command access NEVER disappears. When a feature
          window covers the desktop (`coveredByWindow`), the whole surface is
          z'd BELOW the window stack so a maximized window is not obscured —
          closing/minimizing the window re-reveals it (it was never unmounted). */}
      <Box
        ref={overlayRef}
        role="dialog"
        aria-label="Fredo launcher"
        position="fixed"
        inset="0"
        zIndex={surfaceZ}
        onKeyDown={handleKeyDown}
        onBlur={handleSurfaceBlur}
        css={DESKTOP_TEXTURE_CSS}
      >
        <Box
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="flex-start"
          gap={6}
          height="100%"
          width="100%"
          maxWidth="960px"
          marginX="auto"
          paddingTop="34vh"
          paddingX={8}
          paddingBottom={10}
          overflowY="auto"
          css={{
            '&::-webkit-scrollbar': { width: '8px', height: '8px' },
            '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
          }}
        >
          <Box mb="4">
            <PixelButler visible />
          </Box>
          <LauncherCommandBar
            query={query}
            onQueryChange={handleQueryChange}
            gridOpen={engaged}
            ariaActivedescendant={activeTileId}
            onFocus={handleBarFocus}
            onBlur={handleSurfaceBlur}
            onMinimize={handleMinimize}
          />
          {engaged && (
            <LauncherAppGrid
              entries={filteredEntries}
              selectedIndex={safeSelectedIndex}
              onSelect={handleSelect}
            />
          )}
        </Box>
      </Box>
    </>
  );
};
