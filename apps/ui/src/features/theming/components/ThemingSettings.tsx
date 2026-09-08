import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, HStack, VStack, IconButton, chakra } from '@chakra-ui/react';
import { LuRotateCcw } from 'react-icons/lu';
import { useTheme } from '../../../app/providers/ThemeProvider';
import type { ThemeOverrides } from '../../../app/types/theme';
import { NewPresetPrompt } from './NewPresetPrompt';

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
 * ThemePresetSelector — a `chakra.select` over `allPresets` (user presets first, then
 * the 18 curated built-ins) plus a "Default / None" option that clears the preset
 * (returns to the stock base theme). Wired to `setPreset`/`selectedPreset` from
 * `useTheme()`. Token/vars only (AC3/AC5).
 */
const ThemePresetSelector: React.FC = () => {
  const { selectedPreset, setPreset, allPresets } = useTheme();
  return (
    <chakra.select
      {...selectStyles}
      value={selectedPreset}
      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPreset(e.target.value)}
      aria-label="Theme presets"
    >
      <option value="">Default / None</option>
      {allPresets.map((preset) => (
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
      {/* Color swatch — click opens native color picker.
          `_focusWithin` draws a token ring around the swatch so the opacity-0 native
          color input has a visible focus indicator (AC5 a11y / R-5). */}
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
        _focusWithin={{ boxShadow: '0 0 0 2px var(--accent-primary)' }}
      >
        <Box position="absolute" inset={0} bg={value} />
        <chakra.input
          type="color"
          aria-label={`${label} color`}
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
  const {
    theme,
    overrides,
    setOverride,
    selectedPreset,
    resetTheme,
    getPreset,
    createUserPresetFromCurrent,
  } = useTheme();

  // Resolve the active preset through the provider's `getPreset` (user first, then
  // built-in) — the SAME resolver the provider uses for `activePreset`, so the
  // inputs stay in lockstep with the applied preset. A stale/unmatched id resolves
  // to null → base theme (AC3, #2758 clamp preserved).
  const activePreset = getPreset(selectedPreset);

  // R-2 (AC2): resolve the INPUT to the effective `override ?? preset ?? base` value.
  // `override` still wins; a preset token (or the base value when the preset omits it)
  // feeds `toHex`/`matchFont` so the visible control value matches the selected preset.
  const colorValue = (key: ColorKey): string =>
    toHex(
      overrides[key]
        ?? (activePreset?.colors as Partial<ThemeOverrides>)[key]
        ?? theme.colors[THEME_COLOR_MAP[key]],
    );

  const fontValue = (key: FontKey): string =>
    matchFont(
      (overrides[key] as string)
        ?? (activePreset?.colors as Partial<ThemeOverrides>)[key]
        ?? (theme.colors as Record<FontKey, string>)[key],
    );

  // ── Dirty-edit prompt (AC3/AC4) ────────────────────────────────────────────────
  // Track the tokens the user has actively edited while a preset is selected. A
  // token is "dirty" only on a TRUE divergence: the edited value !== the preset's
  // token value (base when the preset omits it). "Default / None" (no preset) never
  // arms the prompt — there is no preset to diverge from.
  const [dirtyTokens, setDirtyTokens] = useState<Set<keyof ThemeOverrides>>(new Set());
  const [promptOpen, setPromptOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Preset token value for a given key: the preset's literal, else the base value
  // (matching the engine's `override ?? preset ?? base` truthy fall-through).
  const presetValueOf = (key: keyof ThemeOverrides): string =>
    (activePreset?.colors as Partial<ThemeOverrides>)[key]
      ?? (theme.colors as Record<keyof ThemeOverrides, string>)[key];

  const resolvePromptFor = (key: keyof ThemeOverrides, nextValue: string) => {
    if (!activePreset) return; // no preset → plain override, never prompt (AC3 negative)
    // Resolve the target the preset would apply: its literal, or the base value when
    // it omits the token. Only a TRUE divergence (the edit !== that target) prompts.
    const presetValue = presetValueOf(key);
    if (!nextValue || nextValue === presetValue) return; // not a true divergence
    // Divergence — count the token as dirty and arm the debounced prompt.
    setDirtyTokens((prev) => new Set(prev).add(key));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPromptOpen(true);
    }, 400);
  };

  const handleColorChange = (key: ColorKey, val: string) => {
    setOverride(key, val);
    resolvePromptFor(key, val);
  };

  const handleFontChange = (key: FontKey, val: string) => {
    setOverride(key, val);
    resolvePromptFor(key, val);
  };

  // R-3 Discard: clear every dirty token override back to the preset (its value, or
  // base when it omits the token), then disarm. Esc / X routes here too.
  const handleDiscard = () => {
    dirtyTokens.forEach((key) => setOverride(key, ''));
    setDirtyTokens(new Set());
    setPromptOpen(false);
  };

  // R-4 Save: persist the current effective palette as a new user preset (the provider
  // captures `override ?? preset ?? base`, selects it, and clears overrides so the
  // applied palette is byte-preserved). Re-arm the prompt on the next diverging edit.
  const handleSave = (name: string) => {
    createUserPresetFromCurrent(name);
    setDirtyTokens(new Set());
    setPromptOpen(false);
  };

  // A preset switch (or a reset) is a context change — clear any pending prompt +
  // dirty set. Prompt state may also reset on section switch (existing remount).
  useEffect(() => {
    setDirtyTokens(new Set());
    setPromptOpen(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, [selectedPreset]);

  const dirtyCount = dirtyTokens.size;

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
                onChange={(val) => handleColorChange(key, val)} onReset={() => setOverride(key, '')} />
            ))}
          </VStack>
        </Box>

        {/* ── Backgrounds ────────────────────────────── */}
        <Box>
          <SectionLabel>Backgrounds</SectionLabel>
          <VStack gap={3} align="stretch">
            {BG_ROWS.map(({ label, key }) => (
              <ColorRow key={key} label={label} value={colorValue(key)} hasOverride={!!overrides[key]}
                onChange={(val) => handleColorChange(key, val)} onReset={() => setOverride(key, '')} />
            ))}
          </VStack>
        </Box>

        {/* ── Text ───────────────────────────────────── */}
        <Box>
          <SectionLabel>Text</SectionLabel>
          <VStack gap={3} align="stretch">
            {TEXT_ROWS.map(({ label, key }) => (
              <ColorRow key={key} label={label} value={colorValue(key)} hasOverride={!!overrides[key]}
                onChange={(val) => handleColorChange(key, val)} onReset={() => setOverride(key, '')} />
            ))}
          </VStack>
        </Box>

        {/* ── Status ─────────────────────────────────── */}
        <Box>
          <SectionLabel>Status</SectionLabel>
          <VStack gap={3} align="stretch">
            {STATUS_ROWS.map(({ label, key }) => (
              <ColorRow key={key} label={label} value={colorValue(key)} hasOverride={!!overrides[key]}
                onChange={(val) => handleColorChange(key, val)} onReset={() => setOverride(key, '')} />
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
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleFontChange(key, e.target.value)}
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

      {/* ── Dirty-edit prompt (AC3/AC4) ───────────────────────────── */}
      <NewPresetPrompt
        isOpen={promptOpen}
        presetName={activePreset?.name ?? ''}
        dirtyCount={dirtyCount}
        onSave={handleSave}
        onDiscard={handleDiscard}
        onClose={handleDiscard}
      />
    </Box>
  );
};
