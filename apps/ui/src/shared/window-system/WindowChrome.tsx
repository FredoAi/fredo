/**
 * Fredo brand window chrome — header (Spec #2807 ST-3).
 *
 * The single brand-guidelines chrome header: brand cap (accent), window icon
 * tile, title, and the min/max/close control cluster. Pure presentational —
 * every interaction dispatches to the passed-in callbacks (which the owning
 * `WindowFrame` routes to the kernel store). Cross-feature imports are
 * forbidden, so this lives in `shared/window-system/` and reads only theme
 * semantic tokens + the shared `tint()` helper.
 *
 * Token-native contract (AC3): every color is a theme CSS var referenced
 * DIRECTLY (`var(--header-bg)`, `var(--card-hover-bg)`, `var(--border-color)`),
 * a Chakra semantic token (`fg.default`, `fg.muted`, `accent.default`,
 * `bg.canvas`), or a `tint()` color-mix hover. There is NO hardcoded hex/rgba
 * and NO `var(--x)NN` alpha-append anywhere in this file.
 *
 * NOTE (round-3 fix, AC3): the header bar and icon tile reference the theme
 * vars directly rather than the `bg.subtle` / `bg.muted` semantic tokens.
 * Those two keys are Chakra v3 `defaultConfig` built-ins that carry their own
 * conditional (`_light`/`_dark`) definition, so a bare `{ value: 'var(..)' }`
 * redefinition in `system.ts` does NOT inline the var mapping — on a dark
 * header the tokens rendered light-on-light (the AC3 failure). Referencing the
 * vars directly (the app-wide established pattern) is the correct, token-native
 * fix.
 *
 * Known-pitfall applied: the close control uses `variant="ghost"` with an
 * explicit `tint()` hover bg (NOT `variant="outline" colorPalette="red"`) —
 * the global `button[data-variant="outline"]` rule (#431) forces the border
 * to `var(--border-color)` and swallows any prescribed status color.
 */

import type { ReactNode } from 'react';
import { Box, IconButton, Text } from '@chakra-ui/react';
import { tint } from '../utils/colorTint';

/** Brand-logotype mono-weight glyphs (minimal, geometric, currentColor only). */
function MinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MaxIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.8" y="2.8" width="6.4" height="6.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.8" y="4.4" width="4.8" height="4.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.4 2.8h4.8v4.8" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.8 2.8 L9.2 9.2 M9.2 2.8 L2.8 9.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export interface WindowChromeProps {
  /** Window-header label and the frame's aria-label. */
  title: string;
  /** Feature brand icon rendered inside the icon tile. */
  icon: ReactNode;
  /** Top-of-z-order signal — drives title + border emphasis. */
  focused: boolean;
  canClose: boolean;
  canMaximize: boolean;
  canMinimize: boolean;
  isMaximized: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  /** Header pointer-down — the owning frame starts the drag gesture. */
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  /** Header double-click — maximize/restore toggle. */
  onHeaderDoubleClick: () => void;
}

type ControlHoverBg = string;

interface ChromeControlProps {
  'aria-label': string;
  'aria-expanded'?: boolean;
  disabled: boolean;
  hoverBg: ControlHoverBg;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
  children: ReactNode;
}

/** A 28px ghost chrome control — it never swallows the status border (#431). */
function ChromeControl(props: ChromeControlProps) {
  const { children, hoverBg, onPointerDown, onClick } = props;
  return (
    <IconButton
      aria-label={props['aria-label']}
      aria-expanded={props['aria-expanded']}
      disabled={props.disabled}
      variant="ghost"
      boxSize="28px"
      minWidth="28px"
      padding="0"
      borderRadius="4px"
      color="fg.muted"
      borderColor="transparent"
      fontFamily="var(--font-primary)"
      onPointerDown={onPointerDown}
      onClick={onClick}
      _hover={{ bg: hoverBg, color: 'fg.default' }}
      _active={{ bg: hoverBg }}
    >
      {children}
    </IconButton>
  );
}

export function WindowChrome(props: WindowChromeProps) {
  const {
    title,
    icon,
    focused,
    canClose,
    canMaximize,
    canMinimize,
    isMaximized,
    onClose,
    onMinimize,
    onMaximize,
    onHeaderPointerDown,
    onHeaderDoubleClick,
  } = props;

  const stopPointer = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <Box
      as="header"
      className="fredo-window__header"
      display="flex"
      alignItems="center"
      gap="2"
      h="40px"
      px="2"
      bg="var(--header-bg)"
      borderBottom="1px solid"
      borderBottomColor="var(--border-color)"
      fontFamily="var(--font-primary)"
      onPointerDown={onHeaderPointerDown}
      onDoubleClick={onHeaderDoubleClick}
    >
      {/* Brand cap — low-key accent square with the monogram. */}
      <Box
        aria-hidden="true"
        display="flex"
        alignItems="center"
        justifyContent="center"
        w="16px"
        h="16px"
        flexShrink="0"
        borderRadius="4px"
        bg="accent.default"
        color="bg.canvas"
        fontFamily="var(--font-primary)"
        fontSize="10px"
        fontWeight="700"
        lineHeight="1"
      >
        F
      </Box>

      {/* Window icon tile. */}
      <Box
        aria-hidden="true"
        display="flex"
        alignItems="center"
        justifyContent="center"
        w="24px"
        h="24px"
        flexShrink="0"
        borderRadius="4px"
        bg="var(--card-hover-bg)"
        border="1px solid"
        borderColor="var(--border-color)"
        color="fg.default"
        fontSize="16px"
      >
        {icon}
      </Box>

      {/* Window title — Space Grotesk, recedes when unfocused. */}
      <Text
        flex="1"
        minWidth="0"
        color={focused ? 'fg.default' : 'fg.muted'}
        fontFamily="var(--font-primary)"
        fontSize="13px"
        fontWeight="medium"
        overflow="hidden"
        whiteSpace="nowrap"
        textOverflow="ellipsis"
      >
        {title}
      </Text>

      {/* Control cluster — 28px ghost controls, right-aligned. */}
      <Box display="flex" alignItems="center" gap="1" flexShrink="0">
        {canMinimize && (
          <ChromeControl
            aria-label={`Minimize ${title}`}
            disabled={!canMinimize}
            hoverBg="var(--card-hover-bg)"
            onPointerDown={stopPointer}
            onClick={onMinimize}
          >
            <MinIcon />
          </ChromeControl>
        )}
        {canMaximize && (
          <ChromeControl
            aria-label={isMaximized ? `Restore ${title}` : `Maximize ${title}`}
            aria-expanded={isMaximized}
            disabled={!canMaximize}
            hoverBg="var(--card-hover-bg)"
            onPointerDown={stopPointer}
            onClick={onMaximize}
          >
            {isMaximized ? <RestoreIcon /> : <MaxIcon />}
          </ChromeControl>
        )}
        {canClose && (
          <ChromeControl
            aria-label={`Close ${title}`}
            disabled={!canClose}
            hoverBg={tint('var(--status-error)', 18)}
            onPointerDown={stopPointer}
            onClick={onClose}
          >
            <CloseIcon />
          </ChromeControl>
        )}
      </Box>
    </Box>
  );
}
