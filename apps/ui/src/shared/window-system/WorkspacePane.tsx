/**
 * WorkspacePane — one tiled window pane (Spec #2949 ST-2; move-to-region
 * gestures ST-3).
 *
 * The render half of the tiled workspace: a `WindowEntry` that has an
 * `activeSlots` placement (and is neither maximized nor minimized) renders as a
 * pane at its `slot.rect` (workspace-local px) instead of a freeform
 * `WindowFrame`. The pane reuses the `WindowChrome` header PATTERN — icon tile,
 * title, right-aligned control cluster — but carries the pane-specific controls
 * the tiled workspace needs (move grip / float / minimize / close) with the
 * binding `workspace-pane-*` DOM hooks.
 *
 * Scope: R1/R2/R13 (ST-2) + R3 (ST-3 move-to-region). Pressing the move grip
 * enters move mode and portals a workspace-aligned overlay of the nine region
 * drop targets (`pane-region-${region}`); hover/Arrow selects a region and
 * Enter/click commits through `movePane(windowId, region)`; Escape cancels. The
 * move-mode session is wrapped in `beginLayoutGesture()`/`endLayoutGesture()` so
 * no durable write happens until the gesture ends (R5 / G-123).
 *
 * This pane also renders the shared-edge dividers for which it is the `a`
 * (before) pane — exactly one `<PaneDivider>` per `computeDividers(activeSlots)`
 * entry — positioned at the shared edge (R4; the divider owns the drag gesture).
 *
 * Token-native: every colour is a theme CSS var (`var(--header-bg)`,
 * `var(--card-hover-bg)`, `var(--border-color)`), a Chakra semantic token
 * (`bg.surface`, `accent.default`, `border.default`, `fg.*`), or a `tint()`
 * color-mix. No hardcoded hex/rgba and no `var(--x)NN` alpha-append.
 */

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, IconButton, Text, chakra, type SystemStyleObject } from '@chakra-ui/react';

import { tint } from '../utils/colorTint';
import { closeWindow, focusWindow } from './windowStore';
import { useWindowTraversal } from './useWindowActions';
import { useWindows } from './useWindows';
import type { WindowEntry } from './windowTypes';
import {
  beginLayoutGesture,
  endLayoutGesture,
  getLayoutWorkspace,
  movePane,
  removePane,
  resizeViaDivider,
  useWorkspaceLayout,
} from './workspaceLayoutStore';
import {
  computeDividers,
  FALLBACK_WORKSPACE,
  findPaneNeighbor,
  PANE_REGIONS,
  type PaneDirection,
  type PaneDividerSpec,
  type PaneRegion,
  type PaneSlot,
} from './paneLayout';
import { PaneDivider } from './PaneDivider';
import type { Geometry } from './windowGeometry';

export interface WorkspacePaneProps {
  /** The open window joined to this slot (`entry.id === slot.windowId`). */
  window: WindowEntry;
  /** The placement to render at (workspace-local px). */
  slot: PaneSlot;
  /**
   * Optional external move-mode hook. The pane always enters its own move mode
   * on grip press (ST-3); a parent callback is additionally invoked if provided.
   */
  onMoveGrip?: () => void;
}

/** Hit-strip thickness of a divider (px), flush inside the `a` pane's edge. */
const DIVIDER_HIT_WIDTH = 8;

/** The 3×3 region grid — the Arrow-key navigation model. */
const REGION_GRID: readonly (readonly PaneRegion[])[] = [
  ['top-left', 'top', 'top-right'],
  ['left', 'center', 'right'],
  ['bottom-left', 'bottom', 'bottom-right'],
];

/** Percentage placement of each drop zone inside the workspace-aligned overlay. */
function regionStyle(region: PaneRegion): CSSProperties {
  switch (region) {
    case 'left':
      return { left: 0, top: '25%', width: '25%', height: '50%' };
    case 'right':
      return { right: 0, top: '25%', width: '25%', height: '50%' };
    case 'top':
      return { top: 0, left: '25%', width: '50%', height: '25%' };
    case 'bottom':
      return { bottom: 0, left: '25%', width: '50%', height: '25%' };
    case 'top-left':
      return { top: 0, left: 0, width: '25%', height: '25%' };
    case 'top-right':
      return { top: 0, right: 0, width: '25%', height: '25%' };
    case 'bottom-left':
      return { bottom: 0, left: 0, width: '25%', height: '25%' };
    case 'bottom-right':
      return { bottom: 0, right: 0, width: '25%', height: '25%' };
    case 'center':
    default:
      return { top: '25%', left: '25%', width: '50%', height: '50%' };
  }
}

/** The region one Arrow step away from `current` (null for a non-arrow key). */
function nextRegion(current: PaneRegion, key: string): PaneRegion | null {
  let row = 1;
  let col = 1;
  for (let r = 0; r < REGION_GRID.length; r += 1) {
    for (let c = 0; c < REGION_GRID[r].length; c += 1) {
      if (REGION_GRID[r][c] === current) {
        row = r;
        col = c;
      }
    }
  }
  if (key === 'ArrowLeft') col = Math.max(0, col - 1);
  else if (key === 'ArrowRight') col = Math.min(2, col + 1);
  else if (key === 'ArrowUp') row = Math.max(0, row - 1);
  else if (key === 'ArrowDown') row = Math.min(2, row + 1);
  else return null;
  return REGION_GRID[row][col];
}

/** The workspace-local hit strip for a divider, or null when there is no span. */
function dividerStrip(
  divider: PaneDividerSpec,
  byId: Map<string, PaneSlot>,
): Geometry | null {
  const a = byId.get(divider.aWindowId);
  const b = byId.get(divider.bWindowId);
  if (!a || !b) return null;
  if (divider.axis === 'vertical') {
    const edge = a.rect.x + a.rect.width;
    const top = Math.max(a.rect.y, b.rect.y);
    const bottom = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height);
    const height = bottom - top;
    if (height <= 0) return null;
    return { x: edge - DIVIDER_HIT_WIDTH, y: top, width: DIVIDER_HIT_WIDTH, height };
  }
  const edge = a.rect.y + a.rect.height;
  const left = Math.max(a.rect.x, b.rect.x);
  const right = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width);
  const width = right - left;
  if (width <= 0) return null;
  return { x: left, y: edge - DIVIDER_HIT_WIDTH, width, height: DIVIDER_HIT_WIDTH };
}

/** Focus the rendered pane for `windowId` (Arrow-key navigation — R12). */
function focusPaneElement(windowId: string): void {
  if (typeof document === 'undefined') return;
  const el = document.querySelector<HTMLElement>(`[data-pane-window-id="${windowId}"]`);
  el?.focus();
}

/** Token-first button chrome shared by the empty/degraded slot placeholders. */
const PLACEHOLDER_BUTTON_CSS: SystemStyleObject = {
  padding: '4px 10px',
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
};

/** Brand-logotype mono-weight glyphs (minimal, geometric, currentColor only). */
function MoveGripIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      {[3.5, 6, 8.5].map((cy) => (
        <g key={cy}>
          <circle cx="4.5" cy={cy} r="0.9" fill="currentColor" />
          <circle cx="7.5" cy={cy} r="0.9" fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}

function FloatIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.8" y="2.8" width="6.4" height="6.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.8 2.8 L9.2 9.2 M9.2 2.8 L2.8 9.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface PaneControlProps {
  'aria-label': string;
  'data-testid': string;
  hoverBg: string;
  onClick: (() => void) | undefined;
  children: ReactNode;
}

/** A 26px ghost pane control — mirrors the `WindowChrome` control cluster. */
function PaneControl(props: PaneControlProps) {
  const { children, hoverBg, onClick } = props;
  return (
    <IconButton
      aria-label={props['aria-label']}
      data-testid={props['data-testid']}
      variant="ghost"
      boxSize="26px"
      minWidth="26px"
      padding="0"
      borderRadius="4px"
      color="fg.muted"
      borderColor="transparent"
      fontFamily="var(--font-primary)"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      _hover={{ bg: hoverBg, color: 'fg.default' }}
      _active={{ bg: hoverBg }}
    >
      {children}
    </IconButton>
  );
}

interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function WorkspacePane({ window: win, slot, onMoveGrip }: WorkspacePaneProps) {
  // Keep keyboard window traversal armed while a pane (not a WindowFrame) is
  // the only rendered window surface — idempotent + reference-counted.
  useWindowTraversal();

  const layout = useWorkspaceLayout();
  // The open-window list joins slots to rendered panes. Tiled-only slots gate
  // both the divider set (no divider into a degraded/empty slot — R9) and the
  // Arrow-key focus graph (R12). `useWindows` returns the stable store snapshot,
  // so this adds no effect/memo dep and cannot loop.
  const windows = useWindows();
  const [moving, setMoving] = useState(false);
  const [hoveredRegion, setHoveredRegion] = useState<PaneRegion>(slot.region);
  const [overlayRect, setOverlayRect] = useState<OverlayRect | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const movingRef = useRef(false);
  movingRef.current = moving;

  const focused = win.focused;

  // Measure the workspace-aligned overlay (workspace-local rects are relative to
  // the measured `[data-testid="workspace-tiles"]` region — the pane's viewport
  // origin minus its slot offset is that region's origin). Keyed on the `moving`
  // primitive only, so it can never loop on a fresh object reference.
  useEffect(() => {
    if (!moving) {
      setOverlayRect((prev) => (prev === null ? prev : null));
      return;
    }
    const workspace = getLayoutWorkspace() ?? FALLBACK_WORKSPACE;
    const pane = paneRef.current;
    const paneRect = pane ? pane.getBoundingClientRect() : null;
    setOverlayRect({
      left: paneRect ? paneRect.left - slot.rect.x : 0,
      top: paneRect ? paneRect.top - slot.rect.y : 0,
      width: workspace.width,
      height: workspace.height,
    });
  }, [moving]);

  // Primitive deps only — never a fresh object reference in an effect dep.
  const overlayReady = overlayRect !== null;
  useEffect(() => {
    if (moving && overlayReady) overlayRef.current?.focus();
  }, [moving, overlayReady]);

  // Safety net: a move gesture must never outlive the pane (or it would leave
  // persistence suppressed forever). The normal paths end it explicitly.
  useEffect(
    () => () => {
      if (movingRef.current) endLayoutGesture();
    },
    [],
  );

  function focusIfNeeded(): void {
    if (!win.focused) focusWindow(win.id);
  }

  function enterMoveMode(): void {
    setHoveredRegion(slot.region);
    beginLayoutGesture();
    setMoving(true);
    onMoveGrip?.();
  }

  function exitMoveMode(): void {
    setMoving(false);
    endLayoutGesture();
  }

  function commitMove(region: PaneRegion): void {
    movePane(win.id, region);
    setHoveredRegion(region);
    setMoving(false);
    endLayoutGesture();
  }

  function handleOverlayKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      exitMoveMode();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitMove(hoveredRegion);
      return;
    }
    const next = nextRegion(hoveredRegion, event.key);
    if (next) {
      event.preventDefault();
      setHoveredRegion(next);
    }
  }

  function handleFloat(): void {
    // R13: maximize leaves the tiling layer and covers it full-bleed — the
    // unchanged `isMaximized` kernel path (the slot is preserved intact).
    focusWindow(win.id, { maximize: true });
  }

  function handleMinimize(): void {
    // Minimize keeps the PaneSlot; the pane leaves the tiling render (ST-6 adds
    // the empty-slot restore affordance).
    focusWindow(win.id, { minimize: true });
  }

  function handleClose(): void {
    closeWindow(win.id);
    removePane(win.id);
  }

  /**
   * R12 — Arrow keys move focus to the neighbouring pane. Only the pane ROOT is
   * handled (`event.target === event.currentTarget`), so the divider (which
   * resizes on Arrow keys) and feature content keep their own key handling. At a
   * boundary there is no neighbour → no-op (never a focus trap).
   */
  function handlePaneKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    const direction: PaneDirection | null =
      event.key === 'ArrowLeft'
        ? 'left'
        : event.key === 'ArrowRight'
          ? 'right'
          : event.key === 'ArrowUp'
            ? 'up'
            : event.key === 'ArrowDown'
              ? 'down'
              : null;
    if (!direction) return;
    const neighbor = findPaneNeighbor(slot, direction, tiledSlots);
    if (!neighbor) return; // boundary — leave native behaviour untouched
    event.preventDefault();
    focusWindow(neighbor.windowId);
    focusPaneElement(neighbor.windowId);
  }

  const boxShadow = focused
    ? `0 0 0 1px ${tint('var(--accent-primary)', 40)}, 0 8px 24px ${tint('var(--accent-primary)', 12)}`
    : `0 2px 10px ${tint('var(--accent-primary)', 10)}`;

  // Dividers and the Arrow-key focus graph span only panes that are actually
  // rendered (open, neither maximized nor minimized) — a degraded or empty slot
  // therefore produces NO divider (R9) and is not a focus target.
  const tiledIds = new Set(
    windows.filter((entry) => !entry.isMaximized && !entry.isMinimized).map((entry) => entry.id),
  );
  const tiledSlots = layout.activeSlots.filter((entry) => tiledIds.has(entry.windowId));
  const slotById = new Map(tiledSlots.map((entry) => [entry.windowId, entry] as const));
  const ownDividers = computeDividers(tiledSlots).filter(
    (divider) => divider.aWindowId === win.id,
  );

  const overlay =
    moving && overlayRect ? (
      <Box
        ref={overlayRef}
        data-testid={`pane-move-overlay-${win.id}`}
        role="group"
        aria-label="Move pane"
        tabIndex={-1}
        position="fixed"
        zIndex={60}
        style={{
          left: overlayRect.left,
          top: overlayRect.top,
          width: overlayRect.width,
          height: overlayRect.height,
        }}
        onKeyDown={handleOverlayKeyDown}
      >
        <Box
          data-testid="workspace-announcer"
          role="status"
          aria-live="polite"
          position="absolute"
          width="1px"
          height="1px"
          overflow="hidden"
          style={{ clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}
        >
          {`Drop target: ${hoveredRegion} region`}
        </Box>
        {PANE_REGIONS.map((region) => {
          const hovered = hoveredRegion === region;
          return (
            <Box
              key={region}
              as="button"
              data-testid={`pane-region-${region}`}
              data-pane-drop-region={region}
              data-hovered={hovered ? 'true' : 'false'}
              aria-label={`Move to ${region} region`}
              position="absolute"
              display="flex"
              alignItems="center"
              justifyContent="center"
              border="1px solid"
              borderColor={hovered ? 'accent.default' : 'var(--border-color)'}
              borderRadius="4px"
              bg={hovered ? tint('var(--accent-primary)', 14) : tint('var(--accent-primary)', 8)}
              color={hovered ? 'fg.default' : 'fg.muted'}
              fontFamily="var(--font-primary)"
              fontSize="10px"
              fontWeight="600"
              textTransform="uppercase"
              letterSpacing="0.04em"
              cursor="pointer"
              style={regionStyle(region)}
              onMouseEnter={() => setHoveredRegion(region)}
              onFocus={() => setHoveredRegion(region)}
              onClick={() => commitMove(region)}
            >
              {region}
            </Box>
          );
        })}
      </Box>
    ) : null;

  return (
    <Box
      ref={paneRef}
      data-testid={`workspace-pane-${win.id}`}
      data-pane-region={slot.region}
      data-pane-window-id={win.id}
      data-focused={focused ? 'true' : 'false'}
      role="region"
      aria-label={win.title}
      tabIndex={0}
      position="absolute"
      display="flex"
      flexDirection="column"
      overflow="hidden"
      bg="bg.surface"
      border="1px solid"
      borderColor={focused ? 'accent.default' : 'border.default'}
      borderRadius="6px"
      boxShadow={boxShadow}
      pointerEvents="auto"
      style={{
        top: slot.rect.y,
        left: slot.rect.x,
        width: slot.rect.width,
        height: slot.rect.height,
      }}
      onPointerDown={focusIfNeeded}
      onKeyDown={handlePaneKeyDown}
    >
      {/* Pane header — the `WindowChrome` pattern with pane controls. Double
          click floats the pane (the tile-mode maximize affordance). */}
      <Box
        as="header"
        display="flex"
        alignItems="center"
        gap="1.5"
        h="36px"
        px="2"
        flexShrink="0"
        bg="var(--header-bg)"
        borderBottom="1px solid"
        borderBottomColor="var(--border-color)"
        fontFamily="var(--font-primary)"
        opacity={moving ? 0.6 : 1}
        onDoubleClick={handleFloat}
      >
        <Box
          aria-hidden="true"
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="22px"
          h="22px"
          flexShrink="0"
          borderRadius="4px"
          bg="var(--card-hover-bg)"
          border="1px solid"
          borderColor="var(--border-color)"
          color="fg.default"
          fontSize="14px"
        >
          {win.icon}
        </Box>

        <Text
          flex="1"
          minWidth="0"
          data-focused-title={focused ? 'true' : 'false'}
          color={focused ? 'fg.default' : 'fg.muted'}
          fontFamily="var(--font-primary)"
          fontSize="13px"
          fontWeight={focused ? '700' : '500'}
          overflow="hidden"
          whiteSpace="nowrap"
          textOverflow="ellipsis"
        >
          {win.title}
        </Text>

        <Box display="flex" alignItems="center" gap="1" flexShrink="0">
          <PaneControl
            aria-label={`Move ${win.title}`}
            data-testid={`workspace-pane-move-${win.id}`}
            hoverBg="var(--card-hover-bg)"
            onClick={enterMoveMode}
          >
            <MoveGripIcon />
          </PaneControl>
          <PaneControl
            aria-label={`Float ${win.title}`}
            data-testid={`workspace-pane-float-${win.id}`}
            hoverBg="var(--card-hover-bg)"
            onClick={handleFloat}
          >
            <FloatIcon />
          </PaneControl>
          {win.canMinimize && (
            <PaneControl
              aria-label={`Minimize ${win.title}`}
              data-testid={`workspace-pane-minimize-${win.id}`}
              hoverBg="var(--card-hover-bg)"
              onClick={handleMinimize}
            >
              <MinimizeIcon />
            </PaneControl>
          )}
          {win.canClose && (
            <PaneControl
              aria-label={`Close ${win.title}`}
              data-testid={`workspace-pane-close-${win.id}`}
              hoverBg={tint('var(--status-error)', 18)}
              onClick={handleClose}
            >
              <CloseIcon />
            </PaneControl>
          )}
        </Box>
      </Box>

      {/* Flush content region — mirrors `WindowFrame` (features own their inner
          spacing). */}
      <Box
        data-testid={`workspace-pane-content-${win.id}`}
        flex="1"
        minHeight="0"
        overflow="auto"
        bg="bg.surface"
        color="fg.default"
        opacity={moving ? 0.6 : 1}
        tabIndex={-1}
      >
        {win.component}
      </Box>

      {/* Shared-edge dividers for which this pane is the `a` (before) pane —
          exactly one handle per `computeDividers` entry. */}
      {ownDividers.map((divider) => {
        const rect = dividerStrip(divider, slotById);
        if (!rect) return null;
        return (
          <PaneDivider
            key={divider.dividerId}
            divider={divider}
            rect={rect}
            origin={{ x: slot.rect.x, y: slot.rect.y }}
            onResize={(deltaPx) => resizeViaDivider(divider.dividerId, deltaPx)}
          />
        );
      })}

      {/* Move-mode drop overlay — workspace-aligned, portalled to the document
          so the pane's `overflow: hidden` can never clip it. */}
      {overlay && typeof document !== 'undefined'
        ? createPortal(overlay, document.body)
        : overlay}
    </Box>
  );
}

/**
 * R10 — the empty slot left behind by a MINIMIZED pane (ST-6). The `PaneSlot`
 * is KEPT (never removed) and this affordance restores the pane by un-minimizing
 * the window through `focusWindow`. `WindowManager` renders it at the slot's
 * rect so the arrangement's geometry is preserved.
 */
export function WorkspaceEmptySlot({ window: win, slot }: { window: WindowEntry; slot: PaneSlot }) {
  return (
    <Box
      data-testid={`workspace-empty-slot-${slot.windowId}`}
      data-pane-window-id={slot.windowId}
      data-pane-region={slot.region}
      data-empty-slot="true"
      position="absolute"
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap="2"
      bg="bg.surface"
      border="1px dashed"
      borderColor="border.default"
      borderRadius="6px"
      color="fg.muted"
      fontFamily="var(--font-primary)"
      fontSize="12px"
      pointerEvents="auto"
      style={{
        top: slot.rect.y,
        left: slot.rect.x,
        width: slot.rect.width,
        height: slot.rect.height,
      }}
    >
      <Text color="fg.muted" fontWeight="500">
        {`${win.title} minimized`}
      </Text>
      <chakra.button
        type="button"
        data-testid={`workspace-slot-restore-${slot.windowId}`}
        aria-label={`Restore ${win.title}`}
        onClick={() => focusWindow(slot.windowId)}
        css={PLACEHOLDER_BUTTON_CSS}
      >
        Restore
      </chakra.button>
    </Box>
  );
}

/**
 * R9 — the DEGRADED slot: an `activeSlots` placement whose `windowId` no longer
 * matches an open window (removed/closed/unregistered). It renders a
 * `role="status"` placeholder with a visible "App not available" message and a
 * Close-slot control that drops the placement (`removePane`). Sibling panes keep
 * their exact rects; no divider is produced for it; it never throws.
 */
export function WorkspaceDegradedSlot({ slot }: { slot: PaneSlot }) {
  return (
    <Box
      data-testid={`workspace-pane-degraded-${slot.windowId}`}
      data-pane-window-id={slot.windowId}
      data-pane-region={slot.region}
      data-degraded="true"
      role="status"
      position="absolute"
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap="2"
      bg="bg.surface"
      border="1px dashed"
      borderColor="border.default"
      borderRadius="6px"
      color="fg.muted"
      fontFamily="var(--font-primary)"
      fontSize="12px"
      pointerEvents="auto"
      style={{
        top: slot.rect.y,
        left: slot.rect.x,
        width: slot.rect.width,
        height: slot.rect.height,
      }}
    >
      <Text color="fg.muted" fontWeight="500">
        App not available
      </Text>
      <chakra.button
        type="button"
        data-testid={`workspace-degraded-close-${slot.windowId}`}
        aria-label={`Close slot ${slot.windowId}`}
        onClick={() => removePane(slot.windowId)}
        css={PLACEHOLDER_BUTTON_CSS}
      >
        Close slot
      </chakra.button>
    </Box>
  );
}
