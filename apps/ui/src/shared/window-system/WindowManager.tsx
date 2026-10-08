/**
 * Own window manager (Spec #2807 ST-1 + ST-3; zoned partition Spec #2980 ST-4).
 *
 * The manager stays a thin pivoter: it reads the kernel store via
 * `useSyncExternalStore`, sorts by z-order (focused/topmost last so it stacks on
 * top), and partitions the open windows against the ST-1 zone model:
 *
 *   - **zoned** — an open window holding an assignment in the ACTIVE layout
 *     (layout management enabled, active layout with that zone) and neither
 *     maximized nor minimized renders as a `<WorkspacePane>` at
 *     `resolveZoneRect` (R-4.3);
 *   - **rest** — every other entry (no assignment, layout disabled, maximized
 *     full-bleed, or minimized) renders as the existing `<WindowFrame>` (R-5.2 —
 *     the freeform float and the full-bleed default are preserved untouched).
 *
 * The `ZoneLayoutStore` owns the zone model; this component only joins it
 * against `useWindows()` by `assignment.windowId === win.id` and reports the
 * measured workspace rect via `setZoneLayoutWorkspace` (the drag gesture's
 * pointer conversion source of truth — not part of the snapshot, so reporting
 * never re-renders the store). Geometry is never added to `WindowEntry` /
 * `windowStore`.
 *
 * While `dragActive` (ST-5's chord-drag), the `<ZoneOverlay>` sibling renders
 * the zone targets + the single `zone-announcer` (R-3.1).
 *
 * Re-render discipline (AGENTS.md #523): the partition derives in render from
 * the stable store snapshots (`useWindows()` + `useZoneLayout()`); the measured
 * workspace is a `useState` primitive pair updated only when the px size
 * actually changes (by-value guard), and the only layout effect has `[]` deps.
 * No effect depends on an array `.length` or a freshly-created object reference.
 */

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box } from '@chakra-ui/react';

import { WindowFrame } from './WindowFrame';
import { ZoneDegradedSlot, WorkspaceEmptySlot, WorkspacePane } from './WorkspacePane';
import { ZoneOverlay } from './ZoneOverlay';
import { setZoneLayoutWorkspace, useZoneLayout } from './zoneLayoutStore';
import { getWindowSnapshot, subscribeWindows } from './windowStore';
import type { WorkspaceSize, Zone } from './zoneLayout';
import type { WindowEntry } from './windowTypes';

interface ZonedWindow {
  win: WindowEntry;
  zoneId: string;
  layoutId: string;
  zone: Zone;
}

export function WindowManager() {
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
  const zone = useZoneLayout();
  const layerRef = useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSize | null>(null);

  // Report the measured workspace (position + size) to the zone store for the
  // drag gesture's pointer conversion, and mirror its px size into local state
  // for `resolveZoneRect`. `setZoneLayoutWorkspace` is intentionally outside the
  // snapshot (no re-render); the local state update is by-value guarded, so an
  // unchanged ResizeObserver tick is a no-op and this effect can never loop.
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return undefined;
    const report = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setZoneLayoutWorkspace({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        });
        setWorkspace((prev) =>
          prev && prev.width === rect.width && prev.height === rect.height
            ? prev
            : { width: rect.width, height: rect.height },
        );
      } else {
        setZoneLayoutWorkspace(null);
        setWorkspace((prev) => (prev === null ? prev : null));
      }
    };
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Render lowest z-order first so a focused (higher-z) window stacks on top.
  const ordered = [...windows].sort((a, b) => a.zIndex - b.zIndex);

  // The active layout only takes effect while management is enabled (R-3.3).
  const activeLayout =
    zone.enabled && zone.activeLayoutId !== null
      ? (zone.layouts.find((layout) => layout.id === zone.activeLayoutId) ?? null)
      : null;
  const zoneById = new Map((activeLayout?.zones ?? []).map((entry) => [entry.id, entry] as const));
  const assignments = activeLayout
    ? zone.assignments.filter(
        (entry) => entry.layoutId === activeLayout.id && zoneById.has(entry.zoneId),
      )
    : [];
  const assignmentByWindowId = new Map(
    assignments.map((entry) => [entry.windowId, entry] as const),
  );

  // One partition pass: an assigned open window renders zoned; everything else
  // (unassigned, disabled, maximized, minimized) takes the frame path.
  const panes: ZonedWindow[] = [];
  const emptySlots: ZonedWindow[] = [];
  const frames: WindowEntry[] = [];
  for (const win of ordered) {
    const assignment = assignmentByWindowId.get(win.id);
    const zoned = assignment ? zoneById.get(assignment.zoneId) : undefined;
    if (assignment && zoned && !win.isMaximized && !win.isMinimized) {
      panes.push({ win, zoneId: assignment.zoneId, layoutId: assignment.layoutId, zone: zoned });
    } else {
      // A minimized zoned pane KEEPS its assignment and renders an empty-slot
      // restore affordance (the hidden frame stays the kernel's minimized window).
      if (assignment && zoned && win.isMinimized) {
        emptySlots.push({
          win,
          zoneId: assignment.zoneId,
          layoutId: assignment.layoutId,
          zone: zoned,
        });
      }
      frames.push(win);
    }
  }

  // R-4.4: assignments whose window is no longer open render a degraded zone.
  const openIds = new Set(windows.map((win) => win.id));
  const degraded = assignments
    .filter((entry) => !openIds.has(entry.windowId))
    .map((entry) => ({
      windowId: entry.windowId,
      zoneId: entry.zoneId,
      layoutId: entry.layoutId,
      zone: zoneById.get(entry.zoneId) as Zone,
    }));

  return (
    <Box
      data-testid="window-manager"
      position="absolute"
      inset="0"
      overflow="hidden"
      zIndex={1}
      bg="transparent"
    >
      <Box ref={layerRef} data-testid="workspace-layout" position="absolute" inset="0" pointerEvents="none">
        <Box data-testid="workspace-tiles" position="absolute" inset="0" pointerEvents="none">
          {panes.map(({ win, zoneId, layoutId, zone: paneZone }) => (
            <WorkspacePane
              key={win.id}
              window={win}
              zoneId={zoneId}
              layoutId={layoutId}
              zone={paneZone}
              workspace={workspace}
              gap={zone.gap}
            />
          ))}

          {/* R-4.4: minimized zoned panes keep their zone as an empty restore slot. */}
          {emptySlots.map(({ win, zoneId, layoutId, zone: paneZone }) => (
            <WorkspaceEmptySlot
              key={`empty-${win.id}`}
              window={win}
              zoneId={zoneId}
              layoutId={layoutId}
              zone={paneZone}
              workspace={workspace}
              gap={zone.gap}
            />
          ))}

          {/* R-4.4: assignments with no matching open window render degraded. */}
          {degraded.map(({ windowId, zoneId, layoutId, zone: paneZone }) => (
            <ZoneDegradedSlot
              key={`degraded-${windowId}`}
              windowId={windowId}
              zoneId={zoneId}
              layoutId={layoutId}
              zone={paneZone}
              workspace={workspace}
              gap={zone.gap}
            />
          ))}
        </Box>

        {/* R-3.1: the zone drop layer renders only while a chord-drag is live. */}
        {zone.dragActive && (
          <ZoneOverlay
            zones={activeLayout?.zones ?? []}
            workspace={workspace}
            gap={zone.gap}
            hoveredZoneId={zone.hoveredZoneId}
          />
        )}
      </Box>

      {/* Un-assigned / maximized / minimized windows keep the freeform-frame
          path. Rendered last so a float/full-bleed window paints above the
          zoned layer. */}
      {frames.map((win) => (
        <WindowFrame key={win.id} window={win} />
      ))}
    </Box>
  );
}
