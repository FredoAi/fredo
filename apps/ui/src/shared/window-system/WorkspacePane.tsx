/**
 * WorkspacePane — one zoned window pane (Spec #2980 ST-4, rewritten from the
 * retired #2949 region pane).
 *
 * The render half of the zoned workspace: an OPEN window that holds an
 * assignment in the active layout (and is neither maximized nor minimized)
 * renders as a pane at `resolveZoneRect` instead of a freeform `WindowFrame`.
 * The pane reuses the `WindowChrome` header PATTERN — icon tile, title,
 * right-aligned float/minimize/close controls — with the binding
 * `workspace-pane-*` DOM hooks plus `data-zone-id` / `data-zone-layout-id`.
 *
 * The retired #2949 grip move-mode (`pane-region-*` nine-region overlay),
 * `PaneDivider` shared-edge handles and the `activeSlots` reflow are all gone;
 * this pane joins the ST-1 zone model only. Float leaves for the full-bleed
 * frame (kernel parity — the assignment is preserved), minimize keeps the
 * assignment and the manager renders `workspace-empty-slot-*`.
 *
 * Token-native: every colour is a Chakra semantic token (`bg.surface`,
 * `accent.default`, `border.default`, `fg.*`), a theme CSS var
 * (`var(--header-bg)`, `var(--card-hover-bg)`, `var(--border-color)`), or a
 * `tint()` color-mix. No hex/rgba and no `var(--x)NN` alpha-append (#2770).
 */

import { type ReactNode } from 'react';
import { Box, IconButton, Text, chakra, type SystemStyleObject } from '@chakra-ui/react';

import { tint } from '../utils/colorTint';
import { closeWindow, focusWindow } from './windowStore';
import { useWindowTraversal } from './useWindowActions';
import { clearWindowZone } from './zoneLayoutStore';
import { resolveZoneRect, type WorkspaceSize, type Zone } from './zoneLayout';
import type { WindowEntry } from './windowTypes';

/** Shared props for a rendered zoned surface. */
export interface ZonedSurfaceProps {
  /** The window's assignment zone id. */
  zoneId: string;
  /** The layout the assignment belongs to. */
  layoutId: string;
  /** The zone to render at. */
  zone: Zone;
  /** The measured workspace size (`null` ⇒ fallback). */
  workspace: WorkspaceSize | null;
  /** The configured px gap. */
  gap: number;
}

export interface WorkspacePaneProps extends ZonedSurfaceProps {
  /** The open window joined to the assignment (`entry.id === assignment.windowId`). */
  window: WindowEntry;
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
  onClick: () => void;
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

export function WorkspacePane({
  window: win,
  zoneId,
  layoutId,
  zone,
  workspace,
  gap,
}: WorkspacePaneProps) {
  // Keep keyboard window traversal armed while a pane (not a WindowFrame) is
  // the only rendered window surface — idempotent + reference-counted.
  useWindowTraversal();

  const rect = resolveZoneRect(workspace, zone, gap);
  const focused = win.focused;

  function focusIfNeeded(): void {
    if (!win.focused) focusWindow(win.id);
  }

  function handleFloat(): void {
    // Kernel parity (R-5.2): maximize leaves the zoned layer for the full-bleed
    // `WindowFrame`; the zone assignment is preserved so it can be re-zoned.
    focusWindow(win.id, { maximize: true });
  }

  function handleMinimize(): void {
    // Minimize keeps the assignment; the manager renders the empty-slot
    // restore affordance for the hidden window.
    focusWindow(win.id, { minimize: true });
  }

  function handleClose(): void {
    closeWindow(win.id);
    clearWindowZone(win.id);
  }

  const boxShadow = focused
    ? `0 0 0 1px ${tint('var(--accent-primary)', 40)}, 0 8px 24px ${tint('var(--accent-primary)', 12)}`
    : `0 2px 10px ${tint('var(--accent-primary)', 10)}`;

  return (
    <Box
      data-testid={`workspace-pane-${win.id}`}
      data-zone-id={zoneId}
      data-zone-layout-id={layoutId}
      data-zone-window-id={win.id}
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
        top: rect.y,
        left: rect.x,
        width: rect.width,
        height: rect.height,
      }}
      onPointerDown={focusIfNeeded}
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
        tabIndex={-1}
      >
        {win.component}
      </Box>
    </Box>
  );
}

/**
 * R-4.4 — the empty slot left behind by a MINIMIZED zoned pane. The assignment
 * is KEPT (never removed) and this affordance restores the pane by un-minimizing
 * the window through `focusWindow`. `WindowManager` renders it at the zone's
 * resolved rect so the layout's geometry is preserved.
 */
export function WorkspaceEmptySlot({
  window: win,
  zoneId,
  layoutId,
  zone,
  workspace,
  gap,
}: WorkspacePaneProps) {
  const rect = resolveZoneRect(workspace, zone, gap);
  return (
    <Box
      data-testid={`workspace-empty-slot-${win.id}`}
      data-zone-id={zoneId}
      data-zone-layout-id={layoutId}
      data-zone-window-id={win.id}
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
        top: rect.y,
        left: rect.x,
        width: rect.width,
        height: rect.height,
      }}
    >
      <Text color="fg.muted" fontWeight="500">
        {`${win.title} minimized`}
      </Text>
      <chakra.button
        type="button"
        data-testid={`workspace-slot-restore-${win.id}`}
        aria-label={`Restore ${win.title}`}
        onClick={() => focusWindow(win.id)}
        css={PLACEHOLDER_BUTTON_CSS}
      >
        Restore
      </chakra.button>
    </Box>
  );
}

export interface ZoneDegradedSlotProps extends ZonedSurfaceProps {
  /** The assignment's window id — open no longer / resolves to no feature. */
  windowId: string;
}

/**
 * R-4.4 — the DEGRADED zone: an active-layout assignment whose `windowId` no
 * longer matches an open window (closed / unregistered). It renders a
 * `role="status"` placeholder with a visible "App not available" message and a
 * token-first "Remove from zone" control that drops the assignment. Sibling
 * zones keep their exact rects; nothing throws.
 */
export function ZoneDegradedSlot({
  windowId,
  zoneId,
  layoutId,
  zone,
  workspace,
  gap,
}: ZoneDegradedSlotProps) {
  const rect = resolveZoneRect(workspace, zone, gap);
  return (
    <Box
      data-testid={`zone-degraded-${windowId}`}
      data-zone-id={zoneId}
      data-zone-layout-id={layoutId}
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
        top: rect.y,
        left: rect.x,
        width: rect.width,
        height: rect.height,
      }}
    >
      <Text color="fg.muted" fontWeight="500">
        App not available
      </Text>
      <chakra.button
        type="button"
        data-testid={`zone-degraded-remove-${windowId}`}
        aria-label={`Remove ${windowId} from zone`}
        onClick={() => clearWindowZone(windowId)}
        css={PLACEHOLDER_BUTTON_CSS}
      >
        Remove from zone
      </chakra.button>
    </Box>
  );
}
