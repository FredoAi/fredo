import React, { useEffect, useState } from 'react';
import { Box, Text } from '@chakra-ui/react';

/**
 * Launcher chrome frame — the fixed chrome around the launcher grid.
 *
 * Renders (matching desktop.png / AC3):
 *  - the FREDO header notch (top-center) — tab-shaped banner + downward
 *    trapezoid tab (geometry via clip-path, NOT color), acting as the launcher
 *    trigger (role="button" / aria-label="Fredo launcher" / aria-expanded);
 *  - the online clock (top-right) — HH:MM + ONLINE • on a 60s interval timer
 *    (never a per-render `Date`);
 *  - the keyboard-hints row (bottom) — ↑↓ NAVIGATE · ←→ SELECT · ESC CLOSE,
 *    decorative labels whose behavior the host (ST-1) implements.
 *
 * Token-native (AC5): every color is a theme CSS var, a semantic token, or a
 * `tint()` color-mix — no hardcoded hex/rgba, no `var(--x)NN` alpha-append.
 * The key glyphs (↑↓ / ←→ / ESC) are `currentColor` monoweight SVGs.
 *
 * The open/close state and the connection flag are HOST-owned: ST-1 passes
 * `isOnline` (live connection flag) and, when it has the open state, `open` +
 * `onToggle`. When `onToggle` is omitted the notch renders as a controlled
 * visual (per spec). `entryCount` gates the navigational hints so an empty
 * feature set (AC4) never shows nav hints for tiles that do not exist.
 */

export interface LauncherChromeProps {
  /** Number of grid entries — gates the ↑↓ NAVIGATE / ←→ SELECT hints (AC4: no nav hints when empty). */
  entryCount: number;
  /** Live stream/connection flag from the host — drives the ONLINE label + dot state. */
  isOnline: boolean;
  /** Host-owned open state → notch aria-expanded + hints visibility (optional). */
  open?: boolean;
  /** Host-owned toggle callback → notch click (optional; notch is a controlled visual when omitted). */
  onToggle?: () => void;
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

const EscGlyph: React.FC = () => (
  <svg viewBox="0 0 30 16" width="30" height="16" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="28" height="14" rx="3" stroke="currentColor" strokeWidth="1.1" />
    <text
      x="15"
      y="8.5"
      textAnchor="middle"
      dominantBaseline="central"
      fill="currentColor"
      fontFamily="var(--font-primary)"
      fontSize="7.5"
      fontWeight="500"
      letterSpacing="0.06em"
    >
      ESC
    </text>
  </svg>
);

/** A decorative key-cap glyph + muted label (fg.muted, Space Grotesk Light 11px). */
const Hint: React.FC<{ label: string; glyph: React.ReactNode }> = ({ label, glyph }) => (
  <Box display="flex" alignItems="center" gap="6px" color="var(--text-secondary)">
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

export const LauncherChrome: React.FC<LauncherChromeProps> = ({
  entryCount,
  isOnline,
  open,
  onToggle,
}) => {
  // Live-updating clock — recompute on a 60s interval, NOT per-render `Date`.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const time = formatTime(now);

  const showNavHints = entryCount > 0 && open !== false;
  const onlineLabel = isOnline ? 'ONLINE' : 'OFFLINE';

  return (
    <Box position="fixed" inset="0" pointerEvents="none" zIndex={1200} aria-hidden={false}>
      {/* FREDO header notch — top-center tab-shaped banner + downward trapezoid tab */}
      <Box
        position="absolute"
        top="0"
        left="50%"
        transform="translateX(-50%)"
        width="160px"
        height="52px"
        bg="var(--header-bg)"
        borderTop="1px solid var(--border-color)"
        style={{ clipPath: 'polygon(0 0, 160 0, 160 30, 84 30, 82 52, 78 52, 72 30, 0 30)' }}
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="flex-start"
        pointerEvents="auto"
        cursor={onToggle ? 'pointer' : 'default'}
        role="button"
        tabIndex={0}
        aria-label="Fredo launcher"
        aria-expanded={open ?? false}
        onClick={onToggle}
      >
        <Text
          mt={6}
          fontFamily="var(--font-primary)"
          fontWeight={700}
          fontSize="13px"
          lineHeight="1"
          color="var(--text-primary)"
          letterSpacing="0.2em"
        >
          FREDO
        </Text>
      </Box>

      {/* Online clock — top-right; HH:MM + ONLINE • */}
      <Box position="absolute" top="16px" right="20px" textAlign="right" pointerEvents="none">
        <time aria-label={`${time}, ${isOnline ? 'online' : 'offline'}`}>
          <Box display="flex" flexDirection="column" alignItems="flex-end">
            <Text
              fontFamily="var(--font-primary)"
              fontWeight={500}
              fontSize="14px"
              lineHeight="1"
              color="var(--text-primary)"
            >
              {time}
            </Text>
            <Box display="flex" alignItems="center" gap="5px" mt="5px">
              <Text
                fontFamily="var(--font-primary)"
                fontWeight={300}
                fontSize="11px"
                lineHeight="1"
                color="var(--text-secondary)"
                letterSpacing="0.08em"
              >
                {onlineLabel}
              </Text>
              <Box
                as="span"
                width="6px"
                height="6px"
                borderRadius="50%"
                bg={isOnline ? 'var(--accent-primary)' : 'var(--text-secondary)'}
              />
            </Box>
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
          padding="0 24px 18px"
          pointerEvents="none"
          color="var(--text-secondary)"
        >
          <Box display="flex" alignItems="center" gap="20px">
            <Hint label="NAVIGATE" glyph={<UpDownGlyph />} />
            <Hint label="SELECT" glyph={<LeftRightGlyph />} />
          </Box>
          <Hint label="CLOSE" glyph={<EscGlyph />} />
        </Box>
      )}
    </Box>
  );
};
