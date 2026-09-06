import React, { useEffect, useState } from 'react';
import { Box, Text, Tooltip, Portal } from '@chakra-ui/react';
import { tint } from '../../../../shared/utils/colorTint';

/**
 * Launcher chrome frame — the fixed chrome around the launcher grid.
 *
 * Renders (matching desktop-light.png / AC1 / AC3):
 *  - the thin rounded desktop frame (inset ~12px, `border.default`);
 *  - the left side-tick ruler (a faint column of ~12 short measuring ticks in
 *    the mid band, x≈4%);
 *  - the right side-tick ruler (mirror, x≈96%) with a `+` glyph above it,
 *    plus an engaged-only accent scroll-thumb aligned to the selected tile;
 *  - the FREDO header notch (top-center) — a notched tab/banner silhouette
 *    (shoulder steps + neck stem + downward notch, via clip-path) acting as the
 *    launcher trigger (role="button" / aria-label="Fredo launcher");
 *  - the online clock (top-right) — the large HH:MM on a 60s interval timer
 *    (never a per-render `Date`), with a single consolidated status LED
 *    (below the clock) that reveals a connection-status tooltip on hover/focus;
 *  - the keyboard-hints row (bottom, engaged-only) — ↑↓ NAVIGATE · ←→ SELECT ·
 *    ESC CLOSE, decorative labels whose behavior the host (ST-1) implements.
 *
 * Token-native (AC5): every color is a theme CSS var, a semantic token, or a
 * `tint()` color-mix — no hardcoded hex/rgba, no `var(--x)NN` alpha-append.
 * The key glyphs (↑↓ / ←→ / ESC) are `currentColor` monoweight SVGs.
 *
 * The open/engaged state, the connection flag and the selected tile are
 * HOST-owned: ST-1 passes `isOnline` (live connection flag), `engaged` (grid +
 * hints revealed → drives the notch aria-expanded, the hint row and the
 * dot-grid accent thumb), `selectedIndex` (thumb position) and `onToggle` (the
 * notch trigger). `entryCount` gates the navigational hints so an empty
 * feature set (AC4) never shows nav hints for tiles that do not exist.
 *
 * The top-right status LED (Spec #2830) is the SINGLE consolidated connection
 * readout: a 12px visual dot inside a 16px focusable trigger that carries the
 * accessible state (`role="status"` / `aria-label`) and reveals a Chakra v3
 * tooltip (`Connected` / `Disconnected` + detail) on hover/focus. The former
 * bottom-center `StreamStatus` LED pair is removed, so this is the only status
 * LED on the desktop.
 */

export interface LauncherChromeProps {
  /** Number of grid entries — gates the ↑↓ NAVIGATE / ←→ SELECT hints (AC4: no nav hints when empty). */
  entryCount: number;
  /** Live stream/connection flag from the host — drives the ONLINE label + dot state. */
  isOnline: boolean;
  /** Host-owned engaged state (#2819) — grid + hints revealed; drives the hint row + the dot-grid accent thumb. */
  engaged?: boolean;
  /** Host-owned selected tile index — positions the engaged dot-grid accent scroll-thumb. */
  selectedIndex?: number;
  /** Host-owned toggle callback → notch click (optional; notch is a controlled visual when omitted). */
  onToggle?: () => void;
  /** Window-presence signal (host-owned) — a non-minimized feature window covers the
   *  desktop (Spec #2825 R-1/R-2/R-3). When true, the whole chrome band (logo plate +
   *  clock + ONLINE readout + frame + side ticks) sinks BELOW the z=1 window stack
   *  exactly as the launcher surface sinks to `SURFACE_Z_COVERED` (R-4 lockstep),
   *  so it never paints over a feature window or its titlebar controls. When false
   *  (desktop uncovered), the band rests at its desktop z (1200). */
  coveredByWindow?: boolean;
}

const pad2 = (n: number): string => n.toString().padStart(2, '0');

const formatTime = (date: Date): string => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

/** Monoweight SVG glyphs — all `currentColor`, decorative (`aria-hidden`). */
const UpDownGlyph: React.FC = () => (
  <svg viewBox="0 0 12 16" width="12" height="16" fill="none" aria-hidden="true">
    <path d="M6 1.5 V14.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path
      d="M1.5 5 L6 1 L10.5 5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M1.5 11 L6 15 L10.5 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const LeftRightGlyph: React.FC = () => (
  <svg viewBox="0 0 16 12" width="16" height="12" fill="none" aria-hidden="true">
    <path d="M1.5 6 H14.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path
      d="M5 1.5 L1 6 L5 10.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11 1.5 L15 6 L11 10.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Decorative ESC keycap badge — a small, padded, rounded token-native badge
 *  (replaces the previous cramped outlined-SVG glyph; fg.default border +
 *  bg.surface fill so the `ESC` text keeps a clear inset from its outline and
 *  re-tints through token → var → theme in light/dark). */
const EscKeycap: React.FC = () => (
  <Box
    as="span"
    p="3px 7px"
    borderRadius="5px"
    border="1px solid var(--text-primary)"
    bg="var(--card-bg)"
    aria-hidden="true"
  >
    <Text
      as="span"
      display="block"
      fontFamily="var(--font-primary)"
      fontWeight={500}
      fontSize="9px"
      lineHeight={1}
      letterSpacing="0.08em"
      color="var(--text-primary)"
    >
      ESC
    </Text>
  </Box>
);

/** A decorative key-cap glyph + muted label (fg.muted, Space Grotesk Light 11px). */
const Hint: React.FC<{ label: string; glyph: React.ReactNode; gap?: number }> = ({
  label,
  glyph,
  gap = 6,
}) => (
  <Box display="flex" alignItems="center" gap={`${gap}px`} color="var(--text-secondary)">
    {glyph}
    <Text
      fontFamily="var(--font-primary)"
      fontWeight={300}
      fontSize="11px"
      lineHeight="1"
      color="var(--text-secondary)"
      letterSpacing="0.08em"
    >
      {label}
    </Text>
  </Box>
);

// Decorative desktop chrome (#2819). Aesthetic: faint "measuring ruler" long/short
// ticks on both edges + a `+` on the right. All are token/tint-native (a faint
// text-primary color-mix via `tint()`), aria-hidden, pointerEvents:none, and
// non-informational (decorative → exempt from 3:1).

/** Number of short measuring ticks per side ruler (Asset 1.4/1.5 ≈ 10-12). */
const SIDE_TICK_COUNT = 12;
/** Tick ruler vertical band (Asset 1.4: ~28%–68% of the surface height). */
const TICK_BAND_TOP = '28%';
const TICK_BAND_HEIGHT = '40%';

// Engaged accent thumb geometry (match the compare image's teal scroll marker).
const TRACK_HEIGHT = 120;
const THUMB_HEIGHT = 16;

/** Thin `+` marker above the right side-tick ruler (decorative, currentColor -> var(--text-secondary)). */
const PlusGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M7 1 V13 M1 7 H13"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
    />
  </svg>
);

/** One faint short tick (`border.default` at low opacity — Asset 1.4/1.5). */
const SideTick: React.FC<{ alignEnd?: boolean }> = ({ alignEnd }) => (
  <Box
    width="8px"
    height="1px"
    borderRadius="1px"
    bg="var(--border-color)"
    opacity="0.35"
    alignSelf={alignEnd ? 'flex-end' : 'flex-start'}
  />
);

/** The FREDO notched top plate silhouette (Asset 1.1): shoulder steps step down
 *  from the top edge toward center, a short neck descends, and a downward notch
 *  hangs below the banner. Geometry via clip-path (NOT color), width 176,
 *  height 58, centered. */
const FREDO_NOTCH_CLIP =
  'polygon(0 0, 176 0, 176 18, 140 18, 140 28, 120 28, 120 40, 100 40, 100 48, 96 56, 88 56, 80 56, 76 48, 76 40, 56 40, 56 28, 36 28, 36 18, 0 18)';

export const LauncherChrome: React.FC<LauncherChromeProps> = ({
  entryCount,
  isOnline,
  engaged = false,
  selectedIndex = 0,
  onToggle,
  coveredByWindow = false,
}) => {
  // Live-updating clock — recompute on a 60s interval, NOT per-render `Date`.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const time = formatTime(now);

  // Keyboard-hints row + the dot-grid accent thumb reveal ONLY in the engaged state.
  const showNavHints = entryCount > 0 && engaged;
  // Proportional thumb position within the accent track (aligns to the selected tile).
  const thumbTop =
    entryCount > 1
      ? (selectedIndex / (entryCount - 1)) * (TRACK_HEIGHT - THUMB_HEIGHT)
      : 0;

  return (
    <Box position="fixed" inset="0" pointerEvents="none" zIndex={coveredByWindow ? 0 : 1200} aria-hidden={false}>
      {/* Thin rounded desktop frame — decorative, behind the notch (the notch's
          tab deliberately pokes through the top edge). Outer radius ~12px. */}
      <Box
        position="absolute"
        inset="12px"
        border="1px solid"
        borderColor="var(--border-color)"
        borderRadius="12px"
        aria-hidden="true"
      />

      {/* Left side-tick ruler — a faint column of ~12 short measuring ticks in
          the mid band (Asset 1.4, x≈4%). */}
      <Box
        position="absolute"
        left="4%"
        top={TICK_BAND_TOP}
        height={TICK_BAND_HEIGHT}
        display="flex"
        flexDirection="column"
        justifyContent="space-between"
        aria-hidden="true"
      >
        {Array.from({ length: SIDE_TICK_COUNT }, (_, i) => (
          <SideTick key={i} />
        ))}
      </Box>

      {/* Right side-tick ruler (mirror of the left, Asset 1.5, x≈96%). */}
      <Box
        position="absolute"
        right="4%"
        top={TICK_BAND_TOP}
        height={TICK_BAND_HEIGHT}
        display="flex"
        flexDirection="column"
        justifyContent="space-between"
        aria-hidden="true"
      >
        {Array.from({ length: SIDE_TICK_COUNT }, (_, i) => (
          <SideTick key={i} alignEnd />
        ))}
      </Box>

      {/* `+` glyph (fg.muted) sitting above the right ticks (Asset 1.5). */}
      <Box
        position="absolute"
        right="4%"
        top="26%"
        transform="translateY(-50%)"
        color="var(--text-secondary)"
        aria-hidden="true"
      >
        <PlusGlyph />
      </Box>

      {/* Engaged-only accent scroll-thumb on the right ruler (teal marker). */}
      {engaged && entryCount > 0 && (
        <Box
          position="absolute"
          right="calc(4% + 20px)"
          top="50%"
          transform="translateY(-50%)"
          width="3px"
          height={`${TRACK_HEIGHT}px`}
          borderRadius="999px"
          bg={tint('var(--accent-primary)', 22)}
          aria-hidden="true"
        >
          <Box
            position="absolute"
            left="0"
            top={`${thumbTop}px`}
            width="3px"
            height={`${THUMB_HEIGHT}px`}
            borderRadius="999px"
            bg="var(--accent-primary)"
          />
        </Box>
      )}

      {/* FREDO header notch — top-center notched tab/banner + downward tab */}
      <Box
        position="absolute"
        top="0"
        left="50%"
        transform="translateX(-50%)"
        width="176px"
        height="58px"
        bg="var(--card-bg)"
        borderTop="1px solid var(--border-color)"
        // Soft drop-shadow follows the clip-path silhouette (a box-shadow on a
        // clip-path element is clipped to the polygon — use filter instead).
        style={{ clipPath: FREDO_NOTCH_CLIP, filter: `drop-shadow(0 2px 8px ${tint('var(--border-color)', 25)})` }}
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="flex-start"
        pointerEvents="auto"
        cursor={onToggle ? 'pointer' : 'default'}
        role="button"
        tabIndex={0}
        aria-label="Fredo launcher"
        aria-expanded={engaged}
        onClick={onToggle}
      >
        <Text
          mt={6}
          fontFamily="var(--font-primary)"
          fontWeight={700}
          fontSize="13px"
          lineHeight="1"
          color="var(--text-primary)"
          letterSpacing="0.3em"
        >
          FREDO
        </Text>
      </Box>

      {/* Online READOUT CLUSTER — top-right; the large HH:MM clock + the single
          consolidated status LED (Spec #2830). The clock stays; the former
          ONLINE/OFFLINE text label and 6px dot are replaced by one enlarged 12px
          LED (below the clock, right-aligned) inside a 16px focusable trigger
          that re-enables pointer events on itself only and reveals a Chakra v3
          tooltip on hover/focus. The cluster wrapper + chrome root stay
          pointer-events:none (the #2825 covered-by-window z-sink still applies).
          Token-native: accent/status-error + tint() halo, never var(--x)NN. */}
      <Box position="absolute" top="16px" right="20px" textAlign="right" pointerEvents="none">
        <time aria-label={`${time}, ${isOnline ? 'online' : 'offline'}`}>
          <Box display="flex" flexDirection="column" alignItems="flex-end">
            <Text
              fontFamily="var(--font-base)"
              fontWeight={500}
              fontSize="16px"
              lineHeight="1"
              color="var(--text-secondary)"
            >
              {time}
            </Text>
            <Tooltip.Root positioning={{ placement: 'bottom' }} openDelay={150} closeDelay={0}>
              <Tooltip.Trigger asChild>
                <Box
                  as="span"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  aria-label={isOnline ? 'Online' : 'Offline'}
                  tabIndex={0}
                  data-testid="desktop-status-led"
                  width="16px"
                  height="16px"
                  display="inline-flex"
                  alignItems="center"
                  justifyContent="center"
                  pointerEvents="auto"
                  cursor="default"
                  mt="6px"
                >
                  <Box
                    as="span"
                    width="12px"
                    height="12px"
                    borderRadius="50%"
                    aria-hidden="true"
                    bg={isOnline ? 'var(--accent-primary)' : 'var(--status-error)'}
                    boxShadow={`0 0 0 4px ${tint(isOnline ? 'var(--accent-primary)' : 'var(--status-error)', 22)}`}
                  />
                </Box>
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content
                    padding="8px"
                    borderRadius="6px"
                    fontFamily="var(--font-base)"
                    css={{
                      '--tooltip-bg': 'var(--card-bg)',
                      '--tooltip-fg': 'var(--text-primary)',
                      border: '1px solid var(--border-color)',
                      boxShadow: `0 2px 8px ${tint('var(--border-color)', 30)}`,
                    }}
                  >
                    <Tooltip.Arrow>
                      <Tooltip.ArrowTip />
                    </Tooltip.Arrow>
                    <Text color="var(--text-primary)" fontWeight={500}>
                      {isOnline ? 'Connected' : 'Disconnected'}
                    </Text>
                    <Text color="var(--text-secondary)" fontWeight={300} mt="2px">
                      {isOnline ? 'Agent telemetry streaming' : 'Waiting for stream to reconnect'}
                    </Text>
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
          </Box>
        </time>
      </Box>

      {/* Keyboard-hints row — bottom; decorative labels (behavior is the host's) */}
      {showNavHints && (
        <Box
          position="absolute"
          left="0"
          right="0"
          bottom="0"
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          padding="0 24px 20px"
          pointerEvents="none"
          color="var(--text-secondary)"
        >
          <Box display="flex" alignItems="center" gap="20px">
            <Hint label="NAVIGATE" glyph={<UpDownGlyph />} />
            <Hint label="SELECT" glyph={<LeftRightGlyph />} />
          </Box>
          <Hint label="CLOSE" glyph={<EscKeycap />} gap={8} />
        </Box>
      )}
    </Box>
  );
};
