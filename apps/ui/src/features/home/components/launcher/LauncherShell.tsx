import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useBreakpointValue } from '@chakra-ui/react';

// Own-kernel window list (Spec #2807 ST-1) — AC1: never the third-party toolbar.
import { useWindows } from '../../../../shared/window-system/useWindows';
// Live stream/connection flag — mirrors StreamStatus.tsx (ONLINE dot).
import { useConnectionStatus } from '../../../../shared/contexts/StreamContext';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';

import { LauncherChrome } from './LauncherChrome';
import { LauncherAppGrid } from './LauncherAppGrid';
import { LauncherCommandBar } from './LauncherCommandBar';
import { PixelButler } from './PixelButler';

/**
 * LauncherShell — the Fredo-owned launcher host (Spec #2808 ST-1).
 *
 * Replaces the third-party `Toolbar` (`DesktopToolbar.tsx`). This is a
 * full-screen launchpad overlay (Start/Launchpad). It uses a 3-state model
 * (#2819, replacing the old single `open` boolean that was closed by default):
 *
 *   - Collapsed  (`open=false`): bare chrome only — FREDO notch + online clock
 *     + decorative desktop frame / side-ticks / dot-grid; NO avatar/bar/grid.
 *   - Idle       (`open=true, engaged=false`): chrome + pixel-butler avatar +
 *     `>` search-or-command bar; NO app grid, NO keyboard hints. This is the
 *     default at launch (fixes the blank-desktop first impression).
 *   - Engaged    (`open=true, engaged=true`): idle surface + the `| APPS` grid
 *     and the keyboard-nav hints (revealed when the command bar is focused or a
 *     query is present).
 *
 * `open` is the surface-visible gate (TRUE by default at launch). `engaged`
 * (grid + hints) is managed as explicit state: reached when the command bar is
 * focused or a query is typed; returned to idle on ESC, on focus leaving the
 * launcher surface with an empty query (a `:focus-within` guard on the launcher
 * root, NOT a raw input `onBlur`), and on query-free blur-to-outside. ESC
 * returns to idle (surface stays) — it no longer closes the shell; the shell
 * collapses to bare chrome only on window-open or the `—` minimize control.
 *
 * The host owns the shared state (open/engaged, query, selected tile index) and
 * the keyboard-nav orchestration (↑↓ / ←→ / Enter / Space / Esc). It reads the
 * live own-kernel window list via `useWindows()` (used to collapse the shell
 * when a feature window opens through any path) and dispatches every tile open
 * through `onOpenFeature` → Home's full-lifecycle opener (never raw
 * `openWindow`), preserving feature close-on-unmount / self-open / rerender
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

export const LauncherShell: React.FC<LauncherShellProps> = ({ showableFeatures, onOpenFeature }) => {
  const currentWindows = useWindows();
  const { isConnected } = useConnectionStatus();

  // #2819 FIXED: the shell surface is visible by default at launch (idle), so a
  // fresh launch shows the avatar + command bar instead of a blank desktop.
  const [open, setOpen] = useState(true);
  // Grid + keyboard-hints sub-state: reached when the command bar is focused or a
  // query is present; returns to idle on ESC / focus-leaving-the-surface (empty query).
  const [engaged, setEngaged] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const prevWindowCountRef = useRef(currentWindows.length);
  // Suppresses re-engaging when focus is moved programmatically (ESC → refocus the
  // command bar) so the grid stays hidden while the surface returns to idle.
  const skipNextFocusEngageRef = useRef(false);

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

  // Collapse the shell whenever a feature window opens through ANY path (launcher
  // tile, self-open, Konami, setup wizard) so the freshly opened window is not
  // obscured by the full-screen launchpad overlay. useSyncExternalStore returns a
  // stable array reference per mutation, so this effect runs only on real changes.
  useEffect(() => {
    const prev = prevWindowCountRef.current;
    prevWindowCountRef.current = currentWindows.length;
    if (currentWindows.length > prev) setOpen(false);
  }, [currentWindows]);

  // Any path that collapses the surface (window open, `—` minimize, notch
  // toggle-off) resets `engaged` so re-opening via the notch always lands idle.
  useEffect(() => {
    if (!open) setEngaged(false);
  }, [open]);

  // Keep the keyboard-selected tile scrolled into view within the grid's scroll
  // region — only meaningful while the grid is revealed (engaged).
  useEffect(() => {
    if (!engaged) return;
    const container = overlayRef.current;
    if (!container) return;
    const cells = container.querySelectorAll<HTMLElement>('[role="grid"] [role="gridcell"]');
    cells[safeSelectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [engaged, safeSelectedIndex]);

  const toggleOpen = useCallback(() => {
    // Pure surface visibility toggle (#2819). Opening via the notch restores the
    // IDLE surface (engaged reset by the `[open]` effect when collapsed), never
    // the engaged grid. Closing via the notch leaves focus on the notch, which
    // already holds it — no restore needed.
    setOpen((o) => !o);
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
        setEngaged(false);
      }
    },
    [query],
  );

  // `—` minimize control: collapse the launcher to bare chrome (notch + clock +
  // decorative frame) and land focus on the FREDO notch trigger.
  const handleMinimize = useCallback(() => {
    setOpen(false);
    setQuery('');
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(NOTCH_SELECTOR)?.focus();
    });
  }, []);

  const openSelected = useCallback(() => {
    const feature = filteredEntries[safeSelectedIndex];
    if (!feature) return;
    setOpen(false);
    onOpenFeature(feature.id, feature);
  }, [filteredEntries, safeSelectedIndex, onOpenFeature]);

  const handleSelect = useCallback(
    (index: number) => {
      const feature = filteredEntries[index];
      if (!feature) return;
      setOpen(false);
      onOpenFeature(feature.id, feature);
    },
    [filteredEntries, onOpenFeature],
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
        // #2819: ESC returns to IDLE (grid + hints hide), the surface stays.
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
          // Space opens only when a tile is focused (not while typing a query).
          if (!isFromInput) {
            e.preventDefault();
            openSelected();
          }
          break;
      }
    },
    [columns, entryCount, openSelected],
  );

  return (
    <>
      {/* Chrome is always visible: FREDO notch trigger + online clock + the
          decorative desktop frame / side-ticks / dot-grid (collapsed state = bare
          chrome). It sits ABOVE the open overlay (zIndex 1200 vs 1100) and is
          pointerEvents:none except the notch, so the overlay stays interactive.
          `engaged` + `selectedIndex` drive the engaged-only hint row + the
          dot-grid accent scroll-thumb. */}
      <LauncherChrome
        entryCount={entryCount}
        isOnline={isConnected}
        open={open}
        engaged={engaged}
        selectedIndex={safeSelectedIndex}
        onToggle={toggleOpen}
      />

      {open && (
        <Box
          ref={overlayRef}
          role="dialog"
          aria-label="Fredo launcher"
          position="fixed"
          inset="0"
          zIndex={1100}
          bg="var(--card-bg)"
          onKeyDown={handleKeyDown}
          onBlur={handleSurfaceBlur}
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
            paddingTop={16}
            paddingX={8}
            paddingBottom={10}
            overflowY="auto"
            css={{
              '&::-webkit-scrollbar': { width: '8px', height: '8px' },
              '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
            }}
          >
            <PixelButler visible />
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
      )}
    </>
  );
};
