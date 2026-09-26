/**
 * Own window manager (Spec #2807 ST-1 + ST-3, tiling layer Spec #2949 ST-2,
 * workspace toolbar ST-5) — renders the window stack.
 *
 * The manager stays a thin pivoter: it reads the kernel store via
 * `useSyncExternalStore`, sorts by z-order (focused/topmost last so it stacks on
 * top), and partitions the open windows:
 *
 *   - **tiled** — an entry with an `activeSlots` placement AND neither
 *     maximized nor minimized renders as a `<WorkspacePane>` at its
 *     workspace-local rect (R1/R2);
 *   - **rest** — every other entry (no slot, maximized full-bleed, or
 *     minimized) renders as the existing `<WindowFrame>` (R13 — the freeform
 *     float and the full-bleed default are preserved untouched).
 *
 * The `WorkspaceLayoutStore` owns the arrangement; this component only joins it
 * against `useWindows()` by `entry.id === slot.windowId` and reports the
 * measured tiling region via `setLayoutWorkspace` (region resolution's source of
 * truth — not part of the snapshot, so reporting never re-renders). Geometry is
 * never added to `WindowEntry`/`windowStore`.
 *
 * ST-5 replaces the placeholder toolbar with the real `WorkspaceToolbar`: a slim
 * strip rendered ONLY while ≥1 pane is tiled (hidden at 0, R1) that hosts the
 * arrangement presets (`resolveRegionRect`/`addPane`/`movePane` — no separate
 * persisted preset shape), the named-layout `LayoutMenu` (R6/R7), the arrange
 * entry (R2), and the single `aria-live` announcer.
 *
 * Re-render discipline (AGENTS.md #523): the partition derives in render from
 * the two stable snapshots (`useWindows()` + `useWorkspaceLayout()`); no effect
 * depends on an array `.length` or a freshly-created object reference. The
 * announcer is a `useState` string primitive; the outside-click effect's only
 * dep is the `open` boolean inside `LayoutMenu`.
 */

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, chakra } from '@chakra-ui/react';

import { tint } from '../utils/colorTint';
import { LayoutMenu } from './LayoutMenu';
import { WindowFrame } from './WindowFrame';
import { WorkspacePane } from './WorkspacePane';
import {
  addPane,
  getLayoutSnapshot,
  movePane,
  setLayoutWorkspace,
  useWorkspaceLayout,
} from './workspaceLayoutStore';
import { focusWindow, getWindowSnapshot, subscribeWindows } from './windowStore';
import type { PaneRegion, PaneSlot } from './paneLayout';
import type { WindowEntry } from './windowTypes';

/** Height of the arrangement toolbar strip. */
const TOOLBAR_HEIGHT = 36;

/** Built-in arrangement presets (no separate persisted shape). */
export type WorkspacePreset =
  | 'single'
  | 'columns-2'
  | 'columns-3'
  | 'grid-2x2'
  | 'main-side';

/** Preset display order (the segment group). */
const PRESET_ORDER: WorkspacePreset[] = [
  'single',
  'columns-2',
  'columns-3',
  'grid-2x2',
  'main-side',
];

const PRESET_LABEL: Record<WorkspacePreset, string> = {
  single: 'Single',
  'columns-2': '2 Columns',
  'columns-3': '3 Columns',
  'grid-2x2': '2×2 Grid',
  'main-side': 'Main + Side',
};

/** Thirds approximated by the region model (center resolves to the free band). */
const COLUMN_REGIONS: PaneRegion[] = ['left', 'center', 'right'];
/** The four region quarters = a clean 2×2. */
const GRID_REGIONS: PaneRegion[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Target regions for `preset` over `count` panes, in slot order. Where a
 * pattern needs more panes than the region model can express, the mapping
 * cycles and `movePane`'s overlap reflow resolves the remainder. Pure and
 * deterministic.
 */
export function presetRegions(preset: WorkspacePreset, count: number): PaneRegion[] {
  const regions: PaneRegion[] = [];
  for (let index = 0; index < count; index += 1) {
    switch (preset) {
      case 'single':
        regions.push('center');
        break;
      case 'columns-2':
        regions.push(index % 2 === 0 ? 'left' : 'right');
        break;
      case 'columns-3':
        regions.push(COLUMN_REGIONS[index % COLUMN_REGIONS.length]);
        break;
      case 'grid-2x2':
        regions.push(GRID_REGIONS[index % GRID_REGIONS.length]);
        break;
      case 'main-side':
        if (count <= 1) regions.push('center');
        else if (count === 2) regions.push(index === 0 ? 'left' : 'right');
        else {
          regions.push(
            index === 0 ? 'left' : index % 2 === 1 ? 'top-right' : 'bottom-right',
          );
        }
        break;
    }
  }
  return regions;
}

/** True when the current arrangement already sits on `preset`'s regions. */
function matchesPreset(slots: PaneSlot[], preset: WorkspacePreset): boolean {
  if (slots.length === 0) return false;
  const regions = presetRegions(preset, slots.length);
  return slots.every((slot, index) => slot.region === regions[index]);
}

export function WindowManager() {
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
  const layout = useWorkspaceLayout();
  const layerRef = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');

  const announce = useCallback((message: string) => setAnnouncement(message), []);

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

  // ST-5: the toolbar belongs to an ACTIVE tiling — hidden at 0 tiled panes
  // (the dock / launcher entry is the way in before any pane exists).
  const showToolbar = tiled.length > 0;

  /**
   * Enter / extend tiling (R2): place every open non-minimized window as a pane
   * and clear full-bleed so the arrangement is actually visible. `addPane` is
   * idempotent per window id and reflows overlapping placements.
   */
  function arrangeOpenWindows(): void {
    const before = getLayoutSnapshot().activeSlots.length;
    for (const win of windows) {
      if (win.isMinimized) continue;
      if (win.isMaximized) focusWindow(win.id, { maximize: false });
      addPane(win.id);
    }
    const after = getLayoutSnapshot().activeSlots.length;
    const added = after - before;
    announce(
      added > 0
        ? `Added ${added} pane${added === 1 ? '' : 's'}`
        : 'All open windows are already panes',
    );
  }

  /** Apply a built-in preset over the currently tiled panes. */
  function applyPreset(preset: WorkspacePreset): void {
    const slots = layout.activeSlots;
    if (slots.length === 0) return;
    const regions = presetRegions(preset, slots.length);
    // Apply from the LAST pane backwards: a later pane moving out of the way
    // first keeps the intermediate arrangement from clamping into an overlap
    // (which would trigger a full `reflowSlots` and lose the target pattern).
    for (let index = slots.length - 1; index >= 0; index -= 1) {
      const region = regions[index];
      if (region) movePane(slots[index].windowId, region);
    }
    announce(`Applied ${PRESET_LABEL[preset]} preset`);
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
            <LayoutMenu
              savedLayouts={layout.savedLayouts}
              activeLayoutId={layout.activeLayoutId}
              onAnnounce={announce}
            />

            <Box
              role="radiogroup"
              aria-label="Pane arrangement presets"
              display="flex"
              alignItems="center"
              gap="1"
            >
              {PRESET_ORDER.map((preset) => {
                const active = matchesPreset(layout.activeSlots, preset);
                return (
                  <chakra.button
                    key={preset}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={`${PRESET_LABEL[preset]} arrangement`}
                    data-testid={`workspace-preset-${preset}`}
                    data-active={active ? 'true' : 'false'}
                    onClick={() => applyPreset(preset)}
                    css={{
                      padding: '3px 8px',
                      borderRadius: '4px',
                      border: '1px solid',
                      borderColor: active ? 'var(--accent-primary)' : 'var(--border-color)',
                      background: active ? tint('var(--accent-primary)', 14) : 'transparent',
                      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontFamily: 'var(--font-primary)',
                      fontSize: '11px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      '&:hover': { background: tint('var(--accent-primary)', 8) },
                      '&:focus-visible': {
                        outline: 'none',
                        boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
                      },
                    }}
                  >
                    {PRESET_LABEL[preset]}
                  </chakra.button>
                );
              })}
            </Box>

            <chakra.button
              type="button"
              data-testid="workspace-arrange"
              onClick={arrangeOpenWindows}
              css={{
                padding: '3px 8px',
                borderRadius: '4px',
                border: '1px solid',
                borderColor: 'var(--border-color)',
                background: 'transparent',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-primary)',
                fontSize: '11px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                '&:hover': { background: 'var(--card-hover-bg)' },
                '&:focus-visible': {
                  outline: 'none',
                  boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
                },
              }}
            >
              Arrange windows
            </chakra.button>

            {/*
              ONE announcer per workspace. ST-3's move overlay owns the announcer
              while a move/resize gesture is live (`dragging`); the toolbar owns it
              otherwise. They are mutually exclusive, so the DOM never carries two
              `workspace-announcer` status regions.
            */}
            {!layout.dragging && (
              <Box
                data-testid="workspace-announcer"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                ml="auto"
                minWidth="0"
                maxWidth="40%"
                fontSize="11px"
                color="fg.muted"
                whiteSpace="nowrap"
                overflow="hidden"
                textOverflow="ellipsis"
              >
                {announcement}
              </Box>
            )}
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
