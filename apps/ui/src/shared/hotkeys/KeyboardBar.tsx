/**
 * Spec #2959 ST-3 — the persistent keyboard key bar (EARS R-2.1, R-2.2, R-3.1,
 * R-4.1…R-4.5, R-5.3, R-5.4; supports R-5.5).
 *
 * While keyboard mode is ON (ST-1 `keyboardMode.ts`) and terminal passthrough is
 * not active (R-5.3) this full-bleed strip at the BOTTOM edge continuously lists
 * the active interaction context's resolved bindings — each with its key — plus a
 * pinned exit chord, the context title, depth pips and unavailable-with-reason
 * rows (R-5.1/R-5.2) or a defined empty state (R-5.4). Rows come from the SAME
 * listing the engine dispatches from (`resolveActiveBindings`) and availability
 * from the SAME pure decision (`buildKeyboardBarModel`, ST-2) — the bar can never
 * disagree with the engine (R-5.5).
 *
 * Read-only / non-intrusive (R-4.1): the root is `aria-hidden="true"` and
 * `pointerEvents: 'none'`, there is NO focusable descendant, and NO live region of
 * its own. Every announcement goes through the ONE shared `announce()` channel
 * (`announcer.tsx`): entry digest (R-4.2) and context-change digest (R-4.3) from
 * ST-2's `keyboardBarAnnouncement`; exit is the distinct `Keyboard mode off.` so a
 * re-entry is never de-duped away. While mode is ON `contextStack.commit()`
 * suppresses its own context announcement, so this bar is the ONE write per change.
 *
 * Geometry (G-253): the bottom inset is DERIVED from the ACTUAL rendered dock via
 * the shared `measureBottomOffsetPx()` (`bottomStack.ts`) + the pure
 * `resolveKeyboardBarLayout` (`keyboardBarGeometry.ts`) — never a nominal sum; no
 * hide rule and no min-width clamp.
 *
 * Reactivity (#523 loop rule): the model recomputes ONLY when a stable primitive
 * changes — mode, context snapshot identity, keymap `revision`, focus snapshot
 * identity, macro-recording boolean and passthrough boolean. It never subscribes
 * to the transient pending candidate list and is NOT on the keydown path.
 *
 * Colour is theme-token / CSS-var / the shared `tint()` helper only — zero
 * hex/rgba/hsl, zero `var(--x)NN` alpha-append; any fade is `KEYBOARD_BAR_FADE_MS`
 * (opacity/transform only) and disabled under `prefers-reduced-motion` (R-4.5).
 */

import React, { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Icon, Text } from '@chakra-ui/react';
import { LuCircleSlash, LuKeyboard } from 'react-icons/lu';

import { Keycap } from '../components/hotkeys/Keycap';
import { tint } from '../utils/colorTint';
import { announce } from './announcer';
import { measureBottomOffsetPx } from './bottomStack';
import { getHotkeyContext } from './contexts';
import { useActiveHotkeyContext } from './contextStack';
import { resolveActiveBindings, useFocusSnapshot } from './engine';
import {
  KEYBOARD_BAR_FADE_MS,
  KEYBOARD_BAR_HEIGHT_PX,
  resolveKeyboardBarLayout,
} from './keyboardBarGeometry';
import {
  buildKeyboardBarModel,
  keyboardBarAnnouncement,
  type KeyboardBarRow,
} from './keyboardBarModel';
import {
  KEYBOARD_MODE_CHORD,
  useKeyboardMode,
} from './keyboardMode';
import { isMacroRecording, isPassthroughActive, subscribeHotkeys, useHotkeyRevision } from './store';
import type { Platform } from './types';

// ── Contract testids / stacking (plan binding block) ─────────────────────────

/** Above the dock/launcher-rest (1200); below launcher-open (1300), context
 *  indicator (1350), which-key (1400) and the cheat sheet (1500). */
export const KEYBOARD_BAR_Z_INDEX = 1250;
export const KEYBOARD_BAR_TESTID = 'hotkeys-keyboard-bar';
export const KEYBOARD_BAR_HEADER_TESTID = 'hotkeys-keyboard-bar-header';
export const KEYBOARD_BAR_CONTEXT_TESTID = 'hotkeys-keyboard-bar-context';
/** The exit-chord keycap — NON-interactive (the way out is the chord). */
export const KEYBOARD_BAR_EXIT_TESTID = 'hotkeys-keyboard-bar-exit';
export const KEYBOARD_BAR_LIST_TESTID = 'hotkeys-keyboard-bar-list';
export const KEYBOARD_BAR_ROW_TESTID = 'hotkeys-keyboard-bar-row';
export const KEYBOARD_BAR_ROW_REASON_TESTID = 'hotkeys-keyboard-bar-row-unavailable';
export const KEYBOARD_BAR_EMPTY_TESTID = 'hotkeys-keyboard-bar-empty';
/** One non-colour depth pip; `count === depth` (base = 1). */
export const KEYBOARD_BAR_PIP_TESTID = 'hotkeys-keyboard-bar-pip';
/** The defined empty-state copy (R-5.4) — never a blank bar. */
export const KEYBOARD_BAR_EMPTY_TEXT = 'No actions in this context';

/**
 * `document.body` — the number of rows the bar is currently showing. OWNER ST-3
 * (the bar). ST-1 owns the sibling `data-fredo-keyboard-mode` ("true" | absent).
 */
export const BODY_KEYBOARD_MODE_COUNT_ATTR = 'data-fredo-keyboard-mode-count';

/**
 * The distinct exit announcement (never de-duped against the entry digest).
 * Owned here because the bar is the surface that appears on entry (G-266).
 */
export const KEYBOARD_BAR_EXIT_ANNOUNCEMENT = 'Keyboard mode off.';

// ── Motion (≤150 ms, opacity/transform only) ─────────────────────────────────

const FADE_KEYFRAMES = {
  '@keyframes hotkeys-keyboard-bar-fade': {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
} as const;

const MOTION_STYLE: React.CSSProperties = {
  animation: `hotkeys-keyboard-bar-fade ${KEYBOARD_BAR_FADE_MS}ms ease`,
  transition: `opacity ${KEYBOARD_BAR_FADE_MS}ms ease`,
};
const NO_MOTION_STYLE: React.CSSProperties = { animation: 'none', transition: 'none' };

// ── Stable primitive subscriptions (never the transient candidate list) ──────

function usePassthroughActive(): boolean {
  return useSyncExternalStore(subscribeHotkeys, isPassthroughActive, isPassthroughActive);
}

function useMacroRecording(): boolean {
  return useSyncExternalStore(subscribeHotkeys, isMacroRecording, isMacroRecording);
}

/** Resolve the OS `prefers-reduced-motion` flag without adding a dependency. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

// ── One action chip ──────────────────────────────────────────────────────────

function ActionChip({ row, platform }: { readonly row: KeyboardBarRow; readonly platform?: Platform }) {
  const unavailable = row.availability === 'unavailable';
  return (
    <Box
      data-testid={KEYBOARD_BAR_ROW_TESTID}
      data-hotkey-action={row.actionId}
      data-availability={row.availability}
      display="flex"
      alignItems="center"
      gap="1.5"
      paddingX="1.5"
      paddingY="0.5"
      borderRadius="sm"
      bg={unavailable ? 'bg.muted' : undefined}
      flexShrink={0}
    >
      {unavailable ? <Icon as={LuCircleSlash} boxSize="3.5" color="fg.subtle" /> : null}
      <Keycap sequence={row.sequence} platform={platform} />
      <Text fontSize="xs" color={unavailable ? 'fg.muted' : 'fg.default'} whiteSpace="nowrap">
        {row.title}
      </Text>
      {unavailable ? (
        <>
          <Text fontSize="xs" color="fg.subtle" whiteSpace="nowrap">
            unavailable
          </Text>
          <Text
            data-testid={KEYBOARD_BAR_ROW_REASON_TESTID}
            fontSize="xs"
            color="fg.muted"
            whiteSpace="nowrap"
          >
            {row.unavailableReason ?? 'Not available right now'}
          </Text>
        </>
      ) : null}
    </Box>
  );
}

export interface KeyboardBarProps {
  /** Layout override so keycap display is deterministic in tests. */
  readonly platform?: Platform;
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
}

/**
 * The persistent key bar. Mounted ONCE by `HotkeysProvider`, after
 * `<ContextIndicator />`. Renders `null` while mode is OFF (no DOM, no listeners)
 * and while terminal passthrough is active (R-5.3) — mode persists underneath.
 */
export function KeyboardBar({
  platform,
  reducedMotion,
}: KeyboardBarProps = {}): React.ReactElement | null {
  const mode = useKeyboardMode();
  const snapshot = useActiveHotkeyContext();
  const revision = useHotkeyRevision();
  const focus = useFocusSnapshot();
  const passthrough = usePassthroughActive();
  const macroRecording = useMacroRecording();

  const queryReduced = usePrefersReducedMotion();
  const reduceMotion = reducedMotion ?? queryReduced;

  const visible = mode && !passthrough;

  // The model recomputes only on a stable primitive change: the frozen context
  // snapshot, the monotonic keymap revision, the frozen focus snapshot, the
  // macro boolean and the platform. Never a per-keystroke dependency (#523 rule).
  const model = useMemo(
    () => {
      const contextId = snapshot.contextId;
      const contextTitle = getHotkeyContext(contextId)?.title ?? contextId;
      return buildKeyboardBarModel({
        bindings: resolveActiveBindings(),
        contextId,
        contextTitle,
        depth: snapshot.depth,
        focus,
        macroRecording,
        platform,
      });
    },
    // `revision` has no direct reference in the body; it is the keymap-mutation
    // invalidation key `resolveActiveBindings` depends on (R-3.2).
    [snapshot, revision, focus, macroRecording, platform],
  );

  // Geometry: DERIVED from the actual rendered dock stack (G-253), re-measured on
  // show and on resize. No async gate — the visual commits immediately.
  const [bottomInsetPx, setBottomInsetPx] = useState(
    () => resolveKeyboardBarLayout({ dockTopPx: measureBottomOffsetPx() }).bottomInsetPx,
  );

  useLayoutEffect(() => {
    if (!visible) return;
    const next = resolveKeyboardBarLayout({ dockTopPx: measureBottomOffsetPx() }).bottomInsetPx;
    setBottomInsetPx((previous) => (previous === next ? previous : next));
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onResize = (): void =>
      setBottomInsetPx(resolveKeyboardBarLayout({ dockTopPx: measureBottomOffsetPx() }).bottomInsetPx);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [visible]);

  // The ST-3-owned body hook: the number of rows the bar is currently showing
  // (absent while OFF or hidden under passthrough). Mirrors ST-1's own hook style.
  const rowCount = model.rows.length;
  useEffect(() => {
    if (typeof document === 'undefined' || !document.body) return;
    const body = document.body;
    if (!visible) {
      if (body.hasAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR)) {
        body.removeAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR);
      }
      return;
    }
    const value = String(rowCount);
    if (body.getAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR) !== value) {
      body.setAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR, value);
    }
  }, [visible, rowCount]);

  // The ONE announcement per change (R-4.2/R-4.3/R-4.4). Entry/exit on a mode
  // transition; the mode-aware digest on a real context change. While hidden under
  // passthrough nothing is announced (the bar is not on screen).
  const previousModeRef = React.useRef(false);
  const previousSnapshotRef = React.useRef(snapshot);
  useEffect(() => {
    const wasOn = previousModeRef.current;
    const previousSnapshot = previousSnapshotRef.current;
    previousModeRef.current = mode;
    previousSnapshotRef.current = snapshot;

    if (mode && !wasOn) {
      if (!passthrough) announce(keyboardBarAnnouncement(model, 'enter'));
      return;
    }
    if (!mode && wasOn) {
      announce(KEYBOARD_BAR_EXIT_ANNOUNCEMENT);
      return;
    }
    if (!passthrough && mode && snapshot !== previousSnapshot) {
      announce(keyboardBarAnnouncement(model, 'context'));
    }
  }, [mode, snapshot, model, passthrough]);

  if (!visible) return null;

  const pipCount = Math.max(1, model.depth);

  return (
    <Box
      data-testid={KEYBOARD_BAR_TESTID}
      aria-hidden="true"
      zIndex={KEYBOARD_BAR_Z_INDEX}
      css={FADE_KEYFRAMES}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        pointerEvents: 'none',
        bottom: `${bottomInsetPx}px`,
        ...(reduceMotion ? NO_MOTION_STYLE : MOTION_STYLE),
      }}
      display="flex"
      alignItems="center"
      gap="3"
      height={`${KEYBOARD_BAR_HEIGHT_PX}px`}
      paddingX="3"
      bg="bg.surface"
      borderTopWidth="1px"
      borderColor="border.default"
      boxShadow="var(--shadow-dialog)"
      overflow="hidden"
    >
      {/* Header: mode badge (word + icon shape) + context title + depth pips. */}
      <Box
        data-testid={KEYBOARD_BAR_HEADER_TESTID}
        display="flex"
        alignItems="center"
        gap="2"
        flexShrink={0}
      >
        <Box
          display="flex"
          alignItems="center"
          gap="1.5"
          paddingX="2"
          paddingY="0.5"
          borderRadius="sm"
          bg={tint('var(--accent-primary)', 14)}
        >
          <Icon as={LuKeyboard} boxSize="4" color="accent.default" />
          <Text fontSize="sm" color="fg.default" fontWeight="medium" whiteSpace="nowrap">
            Keyboard
          </Text>
        </Box>
        <Box
          data-testid={KEYBOARD_BAR_CONTEXT_TESTID}
          data-depth={model.depth}
          display="flex"
          alignItems="center"
          gap="1.5"
        >
          <Text fontSize="sm" color="fg.muted" whiteSpace="nowrap">
            {model.contextTitle}
          </Text>
          <Box display="flex" alignItems="center" gap="1">
            {Array.from({ length: pipCount }, (_unused, index) => (
              <Box
                key={index}
                as="span"
                data-testid={KEYBOARD_BAR_PIP_TESTID}
                boxSize="1.5"
                borderRadius="full"
                display="inline-block"
                bg={
                  index === pipCount - 1
                    ? tint('var(--accent-primary)', 80)
                    : tint('var(--accent-primary)', 35)
                }
              />
            ))}
          </Box>
        </Box>
      </Box>

      {/* Rows — the active context's actions, or the defined empty state. */}
      {model.empty ? (
        <Text
          data-testid={KEYBOARD_BAR_EMPTY_TESTID}
          fontSize="sm"
          color="fg.muted"
          whiteSpace="nowrap"
          flexShrink={0}
        >
          {KEYBOARD_BAR_EMPTY_TEXT}
        </Text>
      ) : (
        <Box
          data-testid={KEYBOARD_BAR_LIST_TESTID}
          display="flex"
          alignItems="center"
          gap="2"
          flex="1"
          minWidth="0"
          overflow="hidden"
        >
          {model.rows.map((row) => (
            <ActionChip key={`${row.actionId}:${row.sequence}`} row={row} platform={platform} />
          ))}
        </Box>
      )}

      {/* The pinned, non-interactive exit chord. */}
      <Box
        data-testid={KEYBOARD_BAR_EXIT_TESTID}
        display="flex"
        alignItems="center"
        gap="1.5"
        flexShrink={0}
        marginLeft="auto"
      >
        <Keycap sequence={KEYBOARD_MODE_CHORD} platform={platform} />
        <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">
          Exit
        </Text>
      </Box>
    </Box>
  );
}
