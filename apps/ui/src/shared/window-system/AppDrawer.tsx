/**
 * AppDrawer — bottom-docked "open applications" tray (Spec #2821 ST-6 / AC6).
 *
 * The desktop launcher defect #6 ("when I minimize the windows there's no app
 * drawer or nothing to check which apps I have opened") is corrected by a
 * token-native tray that appears DOWN-DOCKED whenever at least one feature
 * window is minimized, listing every open window (minimized OR floating) with
 * Restore / Focus / Close actions so a user can always find and reach any open
 * app.
 *
 * Ownership & boundaries (unchanged): this is a PURE CONSUMER of the window
 * kernel. It reads the open-window list via `useWindows()` and dispatches via
 * `useWindowActions()` — it NEVER reshapes the store contract
 * (`windowStore.ts` / `windowTypes.ts` / `useWindowActions.ts`) and never
 * touches `isMinimized`/`focused`/`zIndex` semantics. It is NOT search-driven:
 * the `| APPS` grid (`LauncherAppGrid`) is a separate surface, and AC6 is
 * deliberately decoupled from the launcher's `engaged` state so AC5
 * (persistent search) and AC6 never couple.
 *
 * Behavior
 *   - Trigger: minimize-driven only. The drawer is visible when at least one
 *     window has `isMinimized === true`; ESC dismisses it (a fresh minimize
 *     event re-shows it). Zero open windows never render (hidden), satisfying
 *     the "Empty → hidden" state.
 *   - Ordering: last-focused on top — entries are sorted by `zIndex` descending
 *     (the store's monotonic top-z is the recency signal).
 *   - One app → single card; many apps → vertical list (scrolls past ~6 rows).
 *
 * Appearance / theming (token-native, AC3)
 *   - `bg.surface` (var(--card-bg)) tray with a `border.default`
 *     (var(--border-color)) top border and a top shadow via
 *     `tint('var(--border-color)', 25)`. Slides in from the bottom, disabled
 *     under `prefers-reduced-motion`.
 *   - Entry hover `bg.muted` (`var(--card-hover-bg)`); the roving-active entry
 *     gets the `tint('var(--accent-primary)', 12)` accent. No raw hex/rgba, no
 *     `var(--x)NN` alpha-append.
 *
 * A11y
 *   - `role="region"` + `aria-label="Open applications"`.
 *   - Each action is a real `<button>` with an accessible name
 *     (`Restore <title>` / `Focus <title>` / `Close <title>`).
 *   - Keyboard: ArrowUp/ArrowDown move between entries (roving focus on each
 *     entry's primary action), Tab navigates into the action buttons, ESC
 *     closes the drawer and returns focus to the launcher via `onClose`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, HStack, Text } from '@chakra-ui/react';
import { motion, useReducedMotion } from 'framer-motion';
import { useWindows } from './useWindows';
import { useWindowActions } from './useWindowActions';
import { tint } from '../utils/colorTint';
import type { WindowEntry } from './windowTypes';

/** Rows rendered before the tray's list scrolls (many-apps state). */
const MAX_ROWS = 6;

/**
 * Stacking: the status LED pair (`StreamStatus`) sits at z-index 1210. The
 * AppDrawer sits BELOW it (QA T4.3 draw-order) so the LEDs are never
 * occluded, yet above the window stack (z=1) and the launcher surface
 * (z=1100/0).
 */
const DRAWER_Z_INDEX = 1200;

/** Wireframe scrollbar — theme CSS vars only (thumb `var(--card-hover-bg)`). */
const DRAWER_SCROLLBAR_CSS = {
  '&::-webkit-scrollbar': { width: '8px', height: '8px' },
  '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
};

/** Human-readable status subtitle for an entry (fg.muted line). */
function statusLabel(win: WindowEntry): string {
  if (win.isMinimized) return 'Minimized';
  if (win.focused) return 'Active';
  if (win.isMaximized) return 'Maximized';
  return 'Open';
}

/** Clamp a value to [0, len-1] (len===0 → 0). */
const clampIndex = (value: number, len: number): number =>
  Math.min(Math.max(0, value), Math.max(0, len - 1));

export interface AppDrawerProps {
  /** Called when the drawer closes (ESC) so the host can return focus to the launcher. */
  onClose?: () => void;
}

export const AppDrawer: React.FC<AppDrawerProps> = ({ onClose }) => {
  const actions = useWindowActions();
  const windows = useWindows();
  const reducedMotion = useReducedMotion() ?? false;

  const hasMinimized = windows.some((w) => w.isMinimized);
  const [dismissed, setDismissed] = useState(false);

  // Auto-hide when no window is minimized; a fresh minimize event re-shows it
  // (the `hasMinimized` boolean transition resets the ESC dismissal).
  useEffect(() => {
    setDismissed(false);
  }, [hasMinimized]);

  const open = hasMinimized && !dismissed;

  // Last-focused on top: highest z-index first (the store's monotonic top-z is
  // the recency signal — see windowStore.focusWindow).
  const ordered = useMemo(() => [...windows].sort((a, b) => b.zIndex - a.zIndex), [windows]);

  const [activeIndex, setActiveIndex] = useState(0);
  // Holds each entry's PRIMARY action button (Restore if minimized, else Focus)
  // so arrow keys can rove focus between entries. Reset on every render so a
  // stale ref to an unmounted entry never receives focus.
  const primaryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  primaryRefs.current = [];

  // Roving index stays in range when the set shrinks.
  const safeActiveIndex = ordered.length === 0 ? 0 : clampIndex(activeIndex, ordered.length);

  // On open, move focus into the drawer (first entry's primary action).
  useEffect(() => {
    if (!open || ordered.length === 0) return;
    primaryRefs.current[0]?.focus();
  }, [open, ordered.length]);

  const handleRegionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        onClose?.();
        return;
      }
      if (ordered.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const next = clampIndex(safeActiveIndex + dir, ordered.length);
        setActiveIndex(next);
        primaryRefs.current[next]?.focus();
      }
    },
    [onClose, safeActiveIndex, ordered.length],
  );

  const setPrimaryRef = useCallback((index: number) => (el: HTMLButtonElement | null) => {
    primaryRefs.current[index] = el;
  }, []);

  // Always-mount the sticky drawer wrapper so it participates in layout; render
  // nothing when closed (gated by `open`).
  if (!open) return null;

  return (
    <motion.div
      role="region"
      aria-label="Open applications"
      initial={reducedMotion ? false : { y: '100%' }}
      animate={{ y: 0 }}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
      onKeyDown={handleRegionKeyDown}
      style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: DRAWER_Z_INDEX }}
    >
      <Box
        bg="bg.surface"
        borderTopWidth="1px"
        borderTopColor="border.default"
        boxShadow={`0 -8px 24px ${tint('var(--border-color)', 25)}`}
        px={4}
        pt={3}
        pb={4}
        maxHeight="50vh"
        overflowY="auto"
        css={DRAWER_SCROLLBAR_CSS}
      >
        <Box maxWidth="560px" marginX="auto">
          <Text
            as="div"
            color="fg.muted"
            fontSize="11px"
            textTransform="uppercase"
            letterSpacing="0.05em"
            mb={2}
          >
            Open applications
          </Text>
          <Box role="list" display="flex" flexDirection="column" gap={2}>
            {ordered.map((win, index) => {
              const active = index === safeActiveIndex;
              const minimized = win.isMinimized;
              const primary = minimized;
              return (
                <Box
                  key={win.id}
                  as="li"
                  role="listitem"
                  display="flex"
                  alignItems="center"
                  gap={3}
                  px={3}
                  py={2}
                  borderRadius="8px"
                  transition="background-color 0.15s ease"
                  bg={active ? tint('var(--accent-primary)', 12) : undefined}
                  _hover={{ bg: 'bg.muted' }}
                  css={{ '&:focus-within': { boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}` } }}
                >
                  <Box
                    width="32px"
                    height="32px"
                    borderRadius="8px"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    bg="bg.muted"
                    color="fg.default"
                    flexShrink={0}
                  >
                    {win.icon}
                  </Box>
                  <Box flex="1" minWidth="0">
                    <Text color="fg.default" fontSize="13px" fontWeight="600" lineClamp={1}>
                      {win.title}
                    </Text>
                    <Text color="fg.muted" fontSize="11px" lineClamp={1}>
                      {statusLabel(win)}
                    </Text>
                  </Box>
                  <HStack gap={2} flexShrink={0}>
                    <Button
                      ref={setPrimaryRef(index)}
                      size="xs"
                      variant="ghost"
                      color={primary ? 'accent.default' : 'fg.muted'}
                      onClick={() => actions.focusWindow(win.id, { minimize: false })}
                      aria-label={`Restore ${win.title}`}
                    >
                      Restore
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      color={primary ? 'fg.muted' : 'accent.default'}
                      onClick={() => actions.focusWindow(win.id)}
                      aria-label={`Focus ${win.title}`}
                    >
                      Focus
                    </Button>
                    {win.canClose && (
                      <Button
                        size="xs"
                        variant="ghost"
                        color="fg.muted"
                        onClick={() => actions.closeWindow(win.id)}
                        aria-label={`Close ${win.title}`}
                      >
                        Close
                      </Button>
                    )}
                  </HStack>
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>
    </motion.div>
  );
};
