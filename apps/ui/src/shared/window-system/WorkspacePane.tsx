/**
 * WorkspacePane — one tiled window pane (Spec #2949 ST-2).
 *
 * The render half of the tiled workspace: a `WindowEntry` that has an
 * `activeSlots` placement (and is neither maximized nor minimized) renders as a
 * pane at its `slot.rect` (workspace-local px) instead of a freeform
 * `WindowFrame`. The pane reuses the `WindowChrome` header PATTERN — icon tile,
 * title, right-aligned control cluster — but carries the pane-specific controls
 * the tiled workspace needs (move grip / float / minimize / close) with the
 * binding `workspace-pane-*` DOM hooks.
 *
 * Scope (ST-2): R1 (pane is a real, simultaneously-visible region), R2 (a pane
 * is placed/wrapped here), R13 (float/maximize leaves the tiling layer and goes
 * full-bleed via the unchanged `isMaximized` kernel path). The move grip is a
 * seam — ST-3 wires the drop-overlay gesture; this wave only renders the hook.
 *
 * Token-native: every colour is a theme CSS var (`var(--header-bg)`,
 * `var(--card-hover-bg)`, `var(--border-color)`), a Chakra semantic token
 * (`bg.surface`, `accent.default`, `border.default`, `fg.*`), or a `tint()`
 * color-mix. No hardcoded hex/rgba and no `var(--x)NN` alpha-append.
 */

import type { ReactNode } from 'react';
import { Box, IconButton, Text } from '@chakra-ui/react';

import { tint } from '../utils/colorTint';
import { closeWindow, focusWindow } from './windowStore';
import { useWindowTraversal } from './useWindowActions';
import type { WindowEntry } from './windowTypes';
import { removePane } from './workspaceLayoutStore';
import type { PaneSlot } from './paneLayout';

export interface WorkspacePaneProps {
  /** The open window joined to this slot (`entry.id === slot.windowId`). */
  window: WindowEntry;
  /** The placement to render at (workspace-local px). */
  slot: PaneSlot;
  /**
   * Enter move mode from the pane's grip (R3). Wired by ST-3; omitted this wave
   * leaves the grip rendered but inert.
   */
  onMoveGrip?: () => void;
}

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

export function WorkspacePane({ window: win, slot, onMoveGrip }: WorkspacePaneProps) {
  // Keep keyboard window traversal armed while a pane (not a WindowFrame) is
  // the only rendered window surface — idempotent + reference-counted.
  useWindowTraversal();

  const focused = win.focused;

  function focusIfNeeded(): void {
    if (!win.focused) focusWindow(win.id);
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

  const boxShadow = focused
    ? `0 0 0 1px ${tint('var(--accent-primary)', 40)}, 0 8px 24px ${tint('var(--accent-primary)', 12)}`
    : `0 2px 10px ${tint('var(--accent-primary)', 10)}`;

  return (
    <Box
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
            aria-label={`Move ${win.title}`}
            data-testid={`workspace-pane-move-${win.id}`}
            hoverBg="var(--card-hover-bg)"
            onClick={onMoveGrip}
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
        tabIndex={-1}
      >
        {win.component}
      </Box>
    </Box>
  );
}
