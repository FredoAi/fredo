/**
 * DockEntry — one open-app row in the left-edge AppDock (Spec #2838 ST-2).
 *
 * A pure consumer row rendered from the shared window-system read surface: it
 * displays the window's registered feature icon re-rendered at dock size,
 * exposes a click-to-focus/restore primary button and a hover/focus-reachable
 * close affordance that closes ONLY that app. The window engine is READ-ONLY —
 * this row never writes lifecycle state except through the supplied
 * `onActivate`/`onClose` dispatches (`focusWindow`/`closeWindow` in AppDock).
 *
 * Token-native (D-8): every surface is a theme CSS var or a `tint()` color-mix
 * (never hardcoded hex/rgba, never `var(--x)NN` alpha-append). Chakra v3 props
 * only. Accessible names live on the real buttons (D-3 / NFR-6) — the tooltip
 * is never the sole label.
 */

import React from 'react';
import { Box, chakra, Tooltip, Portal } from '@chakra-ui/react';
import { tint } from '../../../../shared/utils/colorTint';
import type { WindowEntry } from '../../../../shared/window-system/windowTypes';
import type { DockPosition } from './dockPositionStore';

/** Icon-well geometry (module-level named constants — testability). */
const DOCK_WELL_WIDTH_PX = 36;
const DOCK_WELL_HEIGHT_PX = 40;
const DOCK_WELL_RADIUS_PX = 10;
const DOCK_ICON_PX = 20;
const DOCK_ACTIVE_BAR_PX = 3;
const DOCK_MIN_DOT_PX = 8;

/** Glyph colour — normal rows carry `fg.default`, minimized `fg.muted`. */
const WELL_COLOR = 'var(--text-primary)';
const WELL_COLOR_MUTED = 'var(--text-secondary)';

export interface DockEntryProps {
  win: WindowEntry;
  /** Focus/restore dispatch (consumer-side top-window no-op guard applied in AppDock). */
  onActivate: (win: WindowEntry) => void;
  /** Close dispatch — closes ONLY this app. */
  onClose: (win: WindowEntry) => void;
  /** Layout orientation (Spec #2848 ST-2). Defaults to `'sidebar'` so the
   *  existing left-rail call site compiles unchanged and ST-3 lands
   *  independently. Only the tooltip placement is orientation-aware here. */
  orientation?: DockPosition;
}

/** Accessible name = app name + window state (D-3). */
export function dockEntryLabel(win: WindowEntry): string {
  if (win.isMinimized) return `${win.title} (minimized)`;
  if (win.focused) return `${win.title} (active)`;
  return `${win.title} (background)`;
}

/**
 * Re-render the registered feature icon at dock size. `win.icon` is primed at
 * open time from the registered feature's icon component (`feature.icon`), so
 * cloning its element re-renders the SAME registered feature icon at
 * `DOCK_ICON_PX` — no cross-feature import, no second registry. Falls back to
 * the primed node when it is not a cloneable element.
 */
function DockGlyph({ icon }: { icon: React.ReactNode }): React.ReactElement {
  if (React.isValidElement(icon)) {
    const el = icon as React.ReactElement<{ size?: number | string }>;
    return React.cloneElement(el, { size: DOCK_ICON_PX });
  }
  return <>{icon}</>;
}

export const DockEntry: React.FC<DockEntryProps> = ({ win, onActivate, onClose, orientation = 'sidebar' }) => {
  const minimized = win.isMinimized;
  const active = win.focused && !minimized;
  const label = dockEntryLabel(win);
  // Tooltip placement is orientation-aware (Spec #2848 ST-2): the sidebar rail
  // sits on the left edge so the title reads to the RIGHT; the bottom bar sits
  // at the viewport's bottom edge so a right/left placement would clip — the
  // title reads ABOVE. Accessible names live on the real buttons (D-3) — the
  // tooltip is never the sole label.
  // Round-2 FD-3 (F-12): the BOTTOM pill trigger sits at the viewport's bottom
  // edge inside a `backdropFilter`/`overflow:hidden` track, so the Ark/floating-ui
  // resolver collision-flipped the requested `top` to `right` (the live
  // `data-placement="right"` defect). Make the requested placement robust:
  //  - `strategy: 'fixed'` — the positioner is already portaled to
  //    `document.body`, so a fixed strategy removes any transform /
  //    containing-block (backdrop-filter) ancestor influence on the coordinate
  //    space and lets the popper measure against the true viewport;
  //  - `flip: false` — disables the fallback re-aim so a bottom-edge trigger
  //    can never be flipped to `right` (zag-js popper only adds the flip
  //    middleware when `opts.flip` is truthy — get-placement.js:77-85);
  //  - `gutter` stays on the shared default (8px) — verified the emitted
  //    box-shadow + offset path is untouched for the sidebar leg.
  // The `right` fallback for the sidebar leg keeps its default flip: true so
  // title placement there is unchanged baseline behavior.
  const tooltipPositioning =
    orientation === 'bottom'
      ? ({ placement: 'top' as const, strategy: 'fixed' as const, flip: false } as const)
      : ({ placement: 'right' as const } as const);

  return (
    <Box
      role="listitem"
      data-dock-item
      width="100%"
      height={`${DOCK_WELL_HEIGHT_PX}px`}
      display="flex"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
      position="relative"
      css={{
        // Close affordance reveal — only on row hover / row focus-within. The
        // close stays in the tab order while visually hidden (opacity-hidden,
        // NOT display:none) so keyboard users can always reach it.
        '&:hover .dock-close, &:focus-within .dock-close': {
          opacity: 1,
          pointerEvents: 'auto',
        },
      }}
    >
      <Tooltip.Root positioning={tooltipPositioning} openDelay={150} closeDelay={0}>
        <Tooltip.Trigger asChild>
          <chakra.button
            type="button"
            data-dock-entry
            aria-label={label}
            aria-current={win.focused ? 'step' : undefined}
            onClick={() => onActivate(win)}
            css={{
              width: `${DOCK_WELL_WIDTH_PX}px`,
              height: `${DOCK_WELL_HEIGHT_PX}px`,
              borderRadius: `${DOCK_WELL_RADIUS_PX}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              position: 'relative',
              cursor: 'pointer',
              border: 'none',
              padding: 0,
              background: active ? tint('var(--accent-primary)', 12) : 'transparent',
              color: minimized ? WELL_COLOR_MUTED : WELL_COLOR,
              // Active/focused window: 3px accent bar + accent-tinted well fill.
              // The bar's axis is orientation-aware (Spec #2848 round-2 FD-2 /
              // E-9): the sidebar is a LEFT-edge rail so the bar sits on the
              // well's left edge (`inset 3px 0 0 0`); the bottom bar is a
              // horizontal pill so the bar is a bottom-edge underline
              // (`inset 0 -3px 0 0`) — matching the dock-bar wireframe.
              boxShadow: active
                ? orientation === 'bottom'
                  ? `inset 0 -${DOCK_ACTIVE_BAR_PX}px 0 0 var(--accent-primary)`
                  : `inset ${DOCK_ACTIVE_BAR_PX}px 0 0 0 var(--accent-primary)`
                : undefined,
              transition: 'background-color 0.15s ease, color 0.15s ease',
              '&:hover': { background: minimized ? 'transparent' : 'var(--card-hover-bg)' },
              '&:focus-visible': {
                outline: 'none',
                boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
              },
            }}
          >
            <DockGlyph icon={win.icon} />
            {minimized && (
              <Box
                aria-hidden="true"
                position="absolute"
                bottom="2px"
                left="50%"
                transform="translateX(-50%)"
                width={`${DOCK_MIN_DOT_PX}px`}
                height={`${DOCK_MIN_DOT_PX}px`}
                borderRadius="50%"
                border="1px solid"
                borderColor="var(--border-color)"
                background="transparent"
              />
            )}
          </chakra.button>
        </Tooltip.Trigger>
        <Portal>
          <Tooltip.Positioner>
            <Tooltip.Content
              padding="8px"
              borderRadius="6px"
              css={{
                '--tooltip-bg': 'var(--card-bg)',
                '--tooltip-fg': 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                background: 'var(--card-bg)',
                color: 'var(--text-primary)',
                boxShadow: `0 2px 8px ${tint('var(--border-color)', 30)}`,
                fontFamily: 'var(--font-base)',
                fontSize: '12px',
                lineHeight: 1,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              {win.title}
            </Tooltip.Content>
          </Tooltip.Positioner>
        </Portal>
      </Tooltip.Root>

      {win.canClose && (
        <chakra.button
          type="button"
          className="dock-close"
          aria-label={`Close ${win.title}`}
          onClick={(e) => {
            // stopPropagation so close never double-fires the row's focus
            // dispatch (sibling handler safety).
            e.stopPropagation();
            onClose(win);
          }}
          css={{
            position: 'absolute',
            top: '1px',
            right: '1px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            border: '1px solid',
            borderColor: 'var(--border-color)',
            background: 'var(--card-bg)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            opacity: 0,
            pointerEvents: 'none',
            transition: 'opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease',
            '&:hover': {
              background: tint('var(--status-error)', 14),
              color: 'var(--status-error)',
            },
            '&:focus-visible': {
              outline: 'none',
              boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
            },
          }}
        >
          <Box as="span" aria-hidden="true" fontSize="13px" lineHeight="1" transform="translateY(-1px)">
            ×
          </Box>
        </chakra.button>
      )}
    </Box>
  );
};
