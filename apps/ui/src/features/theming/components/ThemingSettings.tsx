import React from 'react';
import { Box, Text, HStack, VStack, IconButton, chakra } from '@chakra-ui/react';
import { LuRotateCcw } from 'react-icons/lu';
import { useTheme } from '../../../app/providers/ThemeProvider';
import { themePresets } from '../../../app/types/theme';
import type { ThemeOverrides } from '../../../app/types/theme';

// ── Fonts available (all loaded via Google Fonts in index.html) ───────────────
const FONT_OPTIONS = [
  { label: 'Inter', value: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { label: 'Lexend', value: "'Lexend', sans-serif" },
  { label: 'Orbitron', value: "'Orbitron', sans-serif" },
  { label: 'Fira Mono', value: "'Fira Mono', 'Courier New', monospace" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert any CSS color string to a #rrggbb hex string for <input type="color">. */
function toHex(color: string): string {
  if (!color) return '#888888';
  const s = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const [, r, g, b] = s;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const m = s.match(/rgb[a]?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n).toString(16).padStart(2, '0')).join('');
  return '#888888';
}

/** Match a font CSS value against FONT_OPTIONS by primary family name. */
function matchFont(value: string): string {
  const v = value.toLowerCase();
  for (const opt of FONT_OPTIONS) {
    const family = opt.value.split(',')[0].replace(/'/g, '').trim().toLowerCase();
    if (v.includes(family)) return opt.value;
  }
  // Fallback: generic monospace hint
  if (v.includes('mono') || v.includes('courier')) return "'Fira Mono', 'Courier New', monospace";
  return FONT_OPTIONS[0].value;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

const selectStyles = {
  width: '100%',
  p: 2,
  borderRadius: 'md',
  bg: 'var(--card-bg)',
  border: '1px solid',
  borderColor: 'var(--border-color)',
  color: 'var(--text-primary)',
  fontSize: 'sm',
  fontWeight: '500',
  cursor: 'pointer',
  transition: 'all 0.2s',
  _hover: { borderColor: 'var(--accent-primary)' },
  _focus: { outline: 'none', borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' },
} as const;

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontSize="xs"
    fontWeight="700"
    color="var(--text-secondary)"
    letterSpacing="wider"
    textTransform="uppercase"
    mb={2}
  >
    {children as React.ReactNode}
  </Text>
);

/**
 * ThemePresetSelector — a `chakra.select` over the 18 curated `themePresets` plus a
 * "Default / None" option that clears the preset (returns to the stock base theme).
 * Wired to `setPreset`/`selectedPreset` from `useTheme()`. Token/vars only (AC3/AC5).
 */
const ThemePresetSelector: React.FC = () => {
  const { selectedPreset, setPreset } = useTheme();
  return (
    <chakra.select
      {...selectStyles}
      value={selectedPreset}
      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPreset(e.target.value)}
      aria-label="Theme presets"
    >
      <option value="">Default / None</option>
      {themePresets.map((preset) => (
        <option key={preset.id} value={preset.id}>
          {preset.name}
        </option>
      ))}
    </chakra.select>
  );
};

type ColorKey =
  | 'accentPrimary' | 'accentSecondary' | 'borderColor'
  | 'bodyBg' | 'cardBg' | 'headerBg'
  | 'textPrimary' | 'textSecondary'
  | 'statusSuccess' | 'statusWarning' | 'statusError' | 'statusInfo';
type FontKey = 'fontPrimary' | 'fontSecondary' | 'fontBase';

/** Map a ThemeOverrides key to the corresponding Theme.colors key. */
const THEME_COLOR_MAP: Record<ColorKey, keyof import('../../../app/types/theme').Theme['colors']> = {
  accentPrimary: 'accentPrimary',
  accentSecondary: 'accentSecondary',
  borderColor: 'borderColor',
  bodyBg: 'bodyBg',
  cardBg: 'cardBg',
  headerBg: 'headerBg',
  textPrimary: 'textPrimary',
  textSecondary: 'textSecondary',
  statusSuccess: 'statusSuccess',
  statusWarning: 'statusWarning',
  statusError: 'statusError',
  statusInfo: 'statusInfo',
};

interface ColorRowProps {
  label: string;
  value: string;
  hasOverride: boolean;
  onChange: (val: string) => void;
  onReset: () => void;
}

const ColorRow: React.FC<ColorRowProps> = ({ label, value, hasOverride, onChange, onReset }) => (
  <HStack justify="space-between" gap={3}>
    <Text fontSize="sm" color="var(--text-primary)" minW="80px">
      {label}
    </Text>
    <HStack gap={2} flex={1} justify="flex-end">
      {/* Color swatch — click opens native color picker */}
      <Box
        position="relative"
        w="36px"
        h="28px"
        borderRadius="md"
        overflow="hidden"
        border="1px solid"
        borderColor="var(--border-color)"
        flexShrink={0}
        cursor="pointer"
        title={`Pick ${label} color`}
      >
        <Box position="absolute" inset={0} bg={value} />
        <chakra.input
          type="color"
          position="absolute"
          inset={0}
          opacity={0}
          w="full"
          h="full"
          cursor="pointer"
          value={value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        />
      </Box>

      {/* Hex display field — read-only, updated by color picker */}
      <chakra.input
        value={value}
        readOnly
        fontFamily="mono"
        fontSize="xs"
        w="88px"
        px={2}
        py={1}
        borderRadius="md"
        border="1px solid"
        borderColor="var(--border-color)"
        bg="var(--card-bg)"
        color="var(--text-primary)"
        cursor="default"
        _focus={{ outline: 'none' }}
      />

      {/* Reset individual override */}
      <Box w="24px" flexShrink={0}>
        {hasOverride && (
          <IconButton
            size="xs"
            variant="ghost"
            aria-label={`Reset ${label}`}
            color="var(--text-secondary)"
            _hover={{ color: 'var(--status-error)' }}
            onClick={onReset}
          >
            <LuRotateCcw size={11} />
          </IconButton>
        )}
      </Box>
    </HStack>
  </HStack>
);

// ── Main component ─────────────────────────────────────────────────────────────

export const ThemingSettings: React.FC = () => {
  const { theme, overrides, setOverride, selectedPreset, setPreset, resetTheme } = useTheme();

  const colorValue = (key: ColorKey): string =>
    overrides[key] ?? toHex(theme.colors[THEME_COLOR_MAP[key]]);

  const fontValue = (key: FontKey): string =>
    matchFont(overrides[key] ?? theme.colors[key]);

  const hasAnyOverride = (Object.keys(overrides) as (keyof ThemeOverrides)[]).some((k) => !!overrides[k]);

  const ACCENT_ROWS: { label: string; key: ColorKey }[] = [
    { label: 'Primary', key: 'accentPrimary' },
    { label: 'Secondary', key: 'accentSecondary' },
    { label: 'Border', key: 'borderColor' },
  ];

  const BG_ROWS: { label: string; key: ColorKey }[] = [
    { label: 'App background', key: 'bodyBg' },
    { label: 'Surface / cards', key: 'cardBg' },
    { label: 'Header / sidebar', key: 'headerBg' },
  ];

  const TEXT_ROWS: { label: string; key: ColorKey }[] = [
    { label: 'Primary', key: 'textPrimary' },
    { label: 'Muted', key: 'textSecondary' },
  ];

  const STATUS_ROWS: { label: string; key: ColorKey }[] = [
    { label: 'Success', key: 'statusSuccess' },
    { label: 'Warning', key: 'statusWarning' },
    { label: 'Error', key: 'statusError' },
    { label: 'Info', key: 'statusInfo' },
  ];

  const FONT_ROWS: { label: string; key: FontKey }[] = [
    { label: 'Heading', key: 'fontPrimary' },
    { label: 'Subheading', key: 'fontSecondary' },
    { label: 'Body', key: 'fontBase' },
  ];

  return (
    <Box p={6}>
      <VStack gap={6} align="stretch">

        {/* ── Theme Presets ───────────────────────────── */}
        <Box>
          <SectionLabel>Theme Presets</SectionLabel>
          <ThemePresetSelector />
        </Box>

        {/* ── Accent Colors ──────────────────────────── */}
        <Box>
          <SectionLabel>Accent Colors</SectionLabel>
          <VStack gap={3} align="stretch">
            {ACCENT_ROWS.map(({ label, key }) => (
              <ColorRow key={key} label={label} value={colorValue(key)} hasOverride={!!overrides[key]}
                onChange={(val) => setOverride(key, val)} onReset={() => setOverride(key, '')} />
            ))}
          </VStack>
        </Box>

        {/* ── Backgrounds ────────────────────────────── */}
        <Box>
          <SectionLabel>Backgrounds</SectionLabel>
          <VStack gap={3} align="stretch">
            {BG_ROWS.map(({ label, key }) => (
              <ColorRow key={key} label={label} value={colorValue(key)} hasOverride={!!overrides[key]}
                onChange={(val) => setOverride(key, val)} onReset={() => setOverride(key, '')} />
            ))}
          </VStack>
        </Box>

        {/* ── Text ───────────────────────────────────── */}
        <Box>
          <SectionLabel>Text</SectionLabel>
          <VStack gap={3} align="stretch">
            {TEXT_ROWS.map(({ label, key }) => (
              <ColorRow key={key} label={label} value={colorValue(key)} hasOverride={!!overrides[key]}
                onChange={(val) => setOverride(key, val)} onReset={() => setOverride(key, '')} />
            ))}
          </VStack>
        </Box>

        {/* ── Status ─────────────────────────────────── */}
        <Box>
          <SectionLabel>Status</SectionLabel>
          <VStack gap={3} align="stretch">
            {STATUS_ROWS.map(({ label, key }) => (
              <ColorRow key={key} label={label} value={colorValue(key)} hasOverride={!!overrides[key]}
                onChange={(val) => setOverride(key, val)} onReset={() => setOverride(key, '')} />
            ))}
          </VStack>
        </Box>

        {/* ── Fonts ──────────────────────────────────── */}
        <Box>
          <SectionLabel>Fonts</SectionLabel>
          <VStack gap={3} align="stretch">
            {FONT_ROWS.map(({ label, key }) => (
              <Box key={key}>
                <Text fontSize="xs" color="var(--text-secondary)" mb={1}>
                  {label}
                </Text>
                <chakra.select
                  {...selectStyles}
                  value={fontValue(key)}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setOverride(key, e.target.value)}
                >
                  {FONT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </chakra.select>
              </Box>
            ))}
          </VStack>
        </Box>

        {/* ── Reset ──────────────────────────────────── */}
        {(hasAnyOverride || selectedPreset !== '') && (
          <Box pt={2} borderTop="1px solid" borderColor="var(--border-color)">
            <chakra.button
              w="full"
              py={2}
              px={4}
              borderRadius="md"
              border="1px solid"
              borderColor="var(--border-color)"
              bg="transparent"
              color="var(--text-secondary)"
              fontSize="sm"
              cursor="pointer"
              transition="all 0.2s"
              onClick={resetTheme}
              _hover={{ borderColor: 'var(--status-error)', color: 'var(--status-error)' }}
            >
              Reset to theme defaults
            </chakra.button>
          </Box>
        )}

      </VStack>
    </Box>
  );
};
