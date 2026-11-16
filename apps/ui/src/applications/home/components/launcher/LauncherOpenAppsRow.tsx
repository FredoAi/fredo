/**
 * LauncherOpenAppsRow — the in-launcher "Open apps" shelf (Spec #2954 ST-1).
 *
 * A presentational, token-native row listing the currently-open windows inside
 * the engaged launcher, immediately above the APPS grid (the host in
 * `LauncherShell` positions it). It echoes the retired dock's active-window
 * language (icon well + accent underline + close-on-hover) but carries NO
 * persistent chrome and NO window-engine writes: it receives `onActivate` /
 * `onClose` dispatches as props and never touches `windowStore`.
 *
 * Contract:
 *   - returns `null` when its (already query-filtered) `windows` prop is empty —
 *     an all-filtered-out query is an ABSENCE, never an empty `| OPEN APPS`
 *     container (R-1 edge / R-4).
 *   - no keyboard roving: entries are ordinary tab stops, never part of the
 *     grid's roving order.
 *   - token-native: every colour is a theme CSS var or a `tint()` color-mix —
 *     zero hex/rgba, zero `var(--x)NN` alpha-append.
 *   - does NOT own the arrange entry — the host injects it via `headingAccessory`
 *     (ST-2).
 */

import React from 'react';
import { Box, chakra, Flex, Text } from '@chakra-ui/react';

import { tint } from '../../../../shared/utils/colorTint';
import type { WindowEntry } from '../../../../shared/window-system/windowTypes';
import { openAppEntryLabel } from './launcherOpenApps';

/** The row's decorative heading label (the region's `aria-label` is the accessible name). */
export const OPEN_APPS_HEADING = '| OPEN APPS';

/** Icon-well size — the registered feature icon re-rendered at this size. */
const OPEN_APP_ICON_PX = 20;

/** Bottom accent underline thickness on the active entry (px). */
const ACTIVE_BAR_PX = 3;

export interface LauncherOpenAppsRowProps {
  /** ALREADY query-filtered by the host (see `filterOpenWindows`). */
  windows: WindowEntry[];
  /** Focus/restore dispatch (host applies the top-window no-op guard). */
  onActivate: (win: WindowEntry) => void;
  /** Close dispatch — closes ONLY this app. */
  onClose: (win: WindowEntry) => void;
  /**
   * ST-2 slot: the relocated arrange control rendered at the heading's right
   * edge (opposite `| OPEN APPS`). Optional — the row renders fine without it.
   */
  headingAccessory?: React.ReactNode;
}

/**
 * Re-render the registered feature icon at row size. `win.icon` is primed at
 * open time from the registered feature's icon component, so cloning its element
 * re-renders the SAME registered icon — no cross-feature import, no second
 * registry. Falls back to the primed node when it is not a cloneable element.
 */
function OpenAppGlyph({ icon }: { icon: React.ReactNode }): React.ReactElement {
  if (React.isValidElement(icon)) {
    const el = icon as React.ReactElement<{ size?: number | string }>;
    return React.cloneElement(el, { size: OPEN_APP_ICON_PX });
  }
  return <>{icon}</>;
}

/** Non-colour state encoding — derived from the SAME booleans as `openAppEntryLabel`. */
function openAppStatus(win: WindowEntry): 'minimized' | 'active' | 'background' {
  if (win.isMinimized) return 'minimized';
  if (win.focused) return 'active';
  return 'background';
}

export const LauncherOpenAppsRow: React.FC<LauncherOpenAppsRowProps> = ({
  windows,
  onActivate,
  onClose,
  headingAccessory,
}) => {
  // An all-filtered-out query is an ABSENCE, not an empty container.
  if (windows.length === 0) return null;

  return (
    <Box
      role="region"
      aria-label="Open apps"
      data-testid="launcher-open-apps"
      width="100%"
      display="flex"
      flexDirection="column"
      gap={3}
    >
      <Flex justify="space-between" align="center">
        <Text
          as="div"
          data-testid="launcher-open-apps-heading"
          aria-hidden="true"
          color="fg.muted"
          fontSize="11px"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          {OPEN_APPS_HEADING}
        </Text>
        {headingAccessory}
      </Flex>

      <Box role="list" display="flex" flexWrap="wrap" gap={3} width="100%">
        {windows.map((win) => {
          const minimized = win.isMinimized;
          const active = win.focused && !minimized;
          return (
            <Box
              key={win.id}
              role="listitem"
              position="relative"
              display="flex"
              css={{
                // Close affordance reveal — only on row hover / row focus-within.
                // The close stays in the tab order while visually hidden
                // (opacity-hidden, NOT display:none) so keyboard users reach it.
                '&:hover .launcher-open-app-close, &:focus-within .launcher-open-app-close': {
                  opacity: 1,
                  pointerEvents: 'auto',
                },
              }}
            >
              <chakra.button
                type="button"
                data-testid={`launcher-open-app-entry-${win.id}`}
                aria-label={openAppEntryLabel(win)}
                aria-current={win.focused ? 'step' : undefined}
                onClick={() => onActivate(win)}
                display="flex"
                alignItems="center"
                gap={2.5}
                textAlign="left"
                // G-274: the ONLY per-entry clamp; the title is the sole ellipsizing child.
                maxWidth="200px"
                paddingX={3}
                paddingY={2}
                borderRadius="8px"
                borderWidth="1px"
                borderStyle="solid"
                cursor="pointer"
                bg={active ? tint('var(--accent-primary)', 12) : 'var(--card-bg)'}
                borderColor={active ? 'var(--accent-primary)' : 'var(--border-color)'}
                color={minimized ? 'var(--text-secondary)' : 'var(--text-primary)'}
                boxShadow={active ? `inset 0 -${ACTIVE_BAR_PX}px 0 0 var(--accent-primary)` : undefined}
                transition="background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease"
                _hover={{
                  bg: active ? 'var(--card-hover-bg)' : tint('var(--accent-primary)', 14),
                }}
                _active={{ transform: 'translateY(1px)' }}
              >
                <Box as="span" display="flex" flexShrink={0} aria-hidden="true">
                  <OpenAppGlyph icon={win.icon} />
                </Box>
                <Box display="flex" flexDirection="column" minWidth={0}>
                  {/* The ONE ellipsizing child (G-274). */}
                  <Text fontSize="12px" lineHeight="tight" lineClamp={1} color="fg.default">
                    {win.title}
                  </Text>
                  {/* Non-colour state label — exempt from clamp (G-274). */}
                  <Text
                    fontSize="10px"
                    color="fg.subtle"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                  >
                    {openAppStatus(win)}
                  </Text>
                </Box>
              </chakra.button>

              {win.canClose && (
                <chakra.button
                  type="button"
                  className="launcher-open-app-close"
                  data-testid={`launcher-open-app-close-${win.id}`}
                  aria-label={`Close ${win.title}`}
                  onClick={(e) => {
                    // stopPropagation so close never double-fires the row's
                    // focus dispatch (sibling handler safety).
                    e.stopPropagation();
                    onClose(win);
                  }}
                  position="absolute"
                  top="1px"
                  right="1px"
                  width="16px"
                  height="16px"
                  borderRadius="50%"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  padding={0}
                  border="1px solid"
                  borderColor="var(--border-color)"
                  bg="var(--card-bg)"
                  color="var(--text-secondary)"
                  cursor="pointer"
                  opacity={0}
                  pointerEvents="none"
                  transition="opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease"
                  _hover={{
                    bg: tint('var(--status-error)', 14),
                    color: 'var(--status-error)',
                  }}
                >
                  <Box as="span" aria-hidden="true" fontSize="13px" lineHeight="1" transform="translateY(-1px)">
                    ×
                  </Box>
                </chakra.button>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
