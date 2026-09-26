/**
 * Own window manager (Spec #2807 ST-1 + ST-3, tiling layer Spec #2949 ST-2) —
 * renders the window stack.
 *
 * The manager stays a thin pivoter: it reads the kernel store via
 * `useSyncExternalStore`, sorts by z-order (focused/topmost last so it stacks on
 * top), and partitions the open windows:
 *
 *   - **tiled** — an entry with an `activeSlots` placement AND neither
 *     maximized nor minimized renders as a `<WorkspacePane>` at its
 *     workspace-local rect (R1/R2);
 *   - **rest** — every other entry (no placement, maximized full-bleed, or
 *     minimized) renders as the existing `<WindowFrame>` (R13 — the freeform
 *     float and the full-bleed default are preserved untouched).
 *
 * The `WorkspaceLayoutStore` owns the arrangement; this component only joins it
 * against `useWindows()` by `entry.id === slot.windowId` and reports the
 * measured tiling region via `setLayoutWorkspace` (region resolution's source of
 * truth — not part of the snapshot, so reporting never re-renders). Geometry is
 * never added to `WindowEntry`/`windowStore`.
 *
 * Re-render discipline (AGENTS.md #523): the partition derives in render from
 * the two stable snapshots (`useWindows()` + `useWorkspaceLayout()`); no effect
 * depends on an array `.length` or a freshly-created object reference.
 */

import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Box, Button, Text } from '@chakra-ui/react';

import { tint } from '../utils/colorTint';
import { WindowFrame } from './WindowFrame';
import { WorkspacePane } from './WorkspacePane';
import { addPane, setLayoutWorkspace, useWorkspaceLayout } from './workspaceLayoutStore';
import { focusWindow, getWindowSnapshot, subscribeWindows } from './windowStore';
import type { WindowEntry } from './windowTypes';

/** Height of the (ST-2 placeholder) arrangement toolbar strip. */
const TOOLBAR_HEIGHT = 36;

export function WindowManager() {
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
  const layout = useWorkspaceLayout();
  const layerRef = useRef<HTMLDivElement>(null);

  // Report the measured tiling region (the strip below the toolbar) to the
  // layout store. `setLayoutWorkspace` is intentionally outside the snapshot —
  // it changes the metric used by `addPane`/`movePane` without a re-render, so
  // this effect can never loop.
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return undefined;
    const report = () => {
      const rect = el.getBoundingClientRect();
      setLayoutWorkspace(
        rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null,
      );
    };
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Render lowest z-order first so a focused (higher-z) window stacks on top.
  const ordered = [...windows].sort((a, b) => a.zIndex - b.zIndex);

  // One partition pass: tiled entries keep their placement; everything else
  // (no slot, maximized, minimized) is a freeform frame.
  const slotByWindowId = new Map(layout.activeSlots.map((slot) => [slot.windowId, slot] as const));
  const tiled: WindowEntry[] = [];
  const floating: WindowEntry[] = [];
  for (const win of ordered) {
    const slot = slotByWindowId.get(win.id);
    if (slot && !win.isMaximized && !win.isMinimized) tiled.push(win);
    else floating.push(win);
  }

  const showToolbar = windows.length > 0;

  /**
   * Enter tiling (R2): place every open non-minimized window as a pane and
   * clear full-bleed so the arrangement is actually visible. `addPane` is
   * idempotent per window id and reflows overlapping placements.
   */
  function arrangeOpenWindows(): void {
    for (const win of windows) {
      if (win.isMinimized) continue;
      if (win.isMaximized) focusWindow(win.id, { maximize: false });
      addPane(win.id);
    }
  }

  return (
    <Box
      data-testid="window-manager"
      position="absolute"
      inset="0"
      overflow="hidden"
      zIndex={1}
      bg="transparent"
    >
      <Box data-testid="workspace-layout" position="absolute" inset="0" pointerEvents="none">
        {showToolbar && (
          <Box
            data-testid="workspace-toolbar"
            role="toolbar"
            aria-label="Workspace layout"
            position="absolute"
            top="0"
            left="0"
            right="0"
            zIndex={1}
            display="flex"
            alignItems="center"
            gap="2"
            h={`${TOOLBAR_HEIGHT}px`}
            px="2"
            bg="var(--header-bg)"
            borderBottom="1px solid"
            borderBottomColor="var(--border-color)"
            fontFamily="var(--font-primary)"
            pointerEvents="auto"
          >
            <Text
              color="fg.muted"
              fontSize="11px"
              fontWeight="700"
              letterSpacing="0.08em"
              textTransform="uppercase"
            >
              Workspace
            </Text>
            <Button
              data-testid="workspace-arrange"
              type="button"
              size="xs"
              variant="ghost"
              color="fg.default"
              bg="var(--card-hover-bg)"
              borderRadius="4px"
              fontFamily="var(--font-primary)"
              _hover={{ bg: tint('var(--accent-primary)', 12) }}
              onClick={arrangeOpenWindows}
            >
              Arrange windows
            </Button>
          </Box>
        )}

        <Box
          ref={layerRef}
          data-testid="workspace-tiles"
          position="absolute"
          top={showToolbar ? `${TOOLBAR_HEIGHT}px` : '0'}
          left="0"
          right="0"
          bottom="0"
        >
          {tiled.map((win) => {
            const slot = slotByWindowId.get(win.id);
            if (!slot) return null;
            return <WorkspacePane key={win.id} window={win} slot={slot} />;
          })}
        </Box>
      </Box>

      {/* Un-slotted / maximized / minimized windows keep the freeform-frame
          path. Rendered last so a float/full-bleed window paints above the
          tiling layer. */}
      {floating.map((win) => (
        <WindowFrame key={win.id} window={win} />
      ))}
    </Box>
  );
}
