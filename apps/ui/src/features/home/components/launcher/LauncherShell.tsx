import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useBreakpointValue } from '@chakra-ui/react';

// Own-kernel window list (Spec #2807 ST-1) — AC1: never the third-party toolbar.
import { useWindows } from '../../../../shared/window-system/useWindows';
// Live stream/connection flag — mirrors StreamStatus.tsx (ONLINE dot).
import { useConnectionStatus } from '../../../../shared/contexts/StreamContext';
import { tint } from '../../../../shared/utils/colorTint';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';

import { LauncherChrome } from './LauncherChrome';
import { LauncherAppGrid } from './LauncherAppGrid';
import { LauncherCommandBar } from './LauncherCommandBar';
import { PixelButler } from './PixelButler';

/**
 * LauncherShell — the Fredo-owned launcher host (Spec #2808 ST-1).
 *
 * Replaces the third-party `Toolbar` (`DesktopToolbar.tsx`). This is a
 * full-screen launchpad overlay (Start/Launchpad): the FREDO notch trigger +
 * online clock are always visible (closed state); opening via the notch reveals
 * the pixel-butler avatar, `>` search-or-command bar, the `| APPS` feature grid
 * and the keyboard nav hints. Opening a feature collapses the shell so the
 * freshly opened window is visible; ESC closes and restores focus to the notch.
 *
 * The host owns the shared state (open/closed, query, selected tile index) and
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

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const prevWindowCountRef = useRef(currentWindows.length);

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

  // On open, focus the command bar (the grid-navigation anchor).
  useEffect(() => {
    if (!open) return;
    const input = overlayRef.current?.querySelector<HTMLInputElement>(SEARCHBOX_SELECTOR);
    input?.focus();
  }, [open]);

  // Keep the keyboard-selected tile scrolled into view within the grid's scroll region.
  useEffect(() => {
    if (!open) return;
    const container = overlayRef.current;
    if (!container) return;
    const cells = container.querySelectorAll<HTMLElement>('[role="grid"] [role="gridcell"]');
    cells[safeSelectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, safeSelectedIndex]);

  const closeLauncher = useCallback((refocusNotch: boolean) => {
    setOpen(false);
    if (!refocusNotch) return;
    // Restore focus to the FREDO notch trigger on close (Esc / toggle-off).
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(NOTCH_SELECTOR)?.focus();
    });
  }, []);

  const toggleOpen = useCallback(() => {
    // Pure toggle. Focus handling is split: opening focuses the command bar (the
    // `open` effect), and closing via Escape restores focus to the notch
    // (`closeLauncher(true)`). Clicking the notch to close leaves focus on the
    // notch, which already holds it — no restore needed.
    setOpen((o) => !o);
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
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLauncher(true);
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
    [closeLauncher, columns, entryCount, openSelected],
  );

  return (
    <>
      {/* Chrome is always visible: FREDO notch trigger + online clock (closed state
          = notch + clock only). It sits ABOVE the open overlay (zIndex 1200 vs 1100)
          and is pointerEvents:none except the notch, so the overlay stays interactive. */}
      <LauncherChrome
        entryCount={entryCount}
        isOnline={isConnected}
        open={open}
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
          bg={tint('var(--body-bg)', 55)}
          onKeyDown={handleKeyDown}
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
              gridOpen={open}
              ariaActivedescendant={activeTileId}
            />
            <LauncherAppGrid
              entries={filteredEntries}
              selectedIndex={safeSelectedIndex}
              onSelect={handleSelect}
            />
          </Box>
        </Box>
      )}
    </>
  );
};
