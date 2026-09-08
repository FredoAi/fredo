import React, { useMemo } from 'react';
import { Box, Text, VStack, chakra } from '@chakra-ui/react';
import type { ThemeOverrides, Theme, ThemePreset } from '../../../app/types/theme';
import { tint } from '../../../shared/utils/colorTint';

// ── The 12 user-overridable COLOR tokens tracked by the readout (color-only) ────
// (fontPrimary/fontSecondary/fontBase are NOT color swatches — excluded per AC1.)
type ColorTokenKey =
  | 'accentPrimary' | 'accentSecondary' | 'borderColor'
  | 'bodyBg' | 'cardBg' | 'headerBg'
  | 'textPrimary' | 'textSecondary'
  | 'statusSuccess' | 'statusWarning' | 'statusError' | 'statusInfo';

type ColorGroup = 'accent' | 'background' | 'text' | 'status';

type Source = 'override' | 'preset' | 'base';

interface PresetColorReadoutProps {
  /** The resolved active preset — guaranteed non-null by the caller. */
  preset: ThemePreset;
  /** useTheme().overrides */
  overrides: ThemeOverrides;
  /** useTheme().theme.colors (the locked 'classic' base theme). */
  baseColors: Theme['colors'];
}

interface ColorReadoutEntry {
  key: ColorTokenKey;
  label: string;
  group: ColorGroup;
  /** What is actually applied: `override ?? preset ?? base`, first truthy wins. */
  appliedValue: string;
  /** The layer that won — exactly one per chip, drives the badge word. */
  source: Source;
  /** AC2 mark: layer-membership — does the preset's colors layer set this token? */
  changedByPreset: boolean;
}

// ── Token taxonomy (one source of truth for label + group) ─────────────────────
// Grouping mirrors the existing editor rows (ThemingSettings.tsx Accent/BG/Text/Status).
interface TokenDef {
  key: ColorTokenKey;
  label: string;
  group: ColorGroup;
}

const TOKEN_TAXONOMY: TokenDef[] = [
  { key: 'accentPrimary', label: 'Accent Primary', group: 'accent' },
  { key: 'accentSecondary', label: 'Accent Secondary', group: 'accent' },
  { key: 'borderColor', label: 'Border', group: 'accent' },
  { key: 'bodyBg', label: 'Body', group: 'background' },
  { key: 'cardBg', label: 'Card', group: 'background' },
  { key: 'headerBg', label: 'Header', group: 'background' },
  { key: 'textPrimary', label: 'Text Primary', group: 'text' },
  { key: 'textSecondary', label: 'Text Muted', group: 'text' },
  { key: 'statusSuccess', label: 'Success', group: 'status' },
  { key: 'statusWarning', label: 'Warning', group: 'status' },
  { key: 'statusError', label: 'Error', group: 'status' },
  { key: 'statusInfo', label: 'Info', group: 'status' },
];

const GROUPS: { group: ColorGroup; title: string; cols: number }[] = [
  { group: 'accent', title: 'Accent', cols: 3 },
  { group: 'background', title: 'Backgrounds', cols: 3 },
  { group: 'text', title: 'Text', cols: 2 },
  { group: 'status', title: 'Status', cols: 4 },
];

// ── Hex caption helper ─────────────────────────────────────────────────────────
/** Normalize any CSS color string to a `#rrggbb` hex string for the mono caption. */
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

// ── Pure derivation (binding: override ?? preset ?? base, first-truthy wins) ────
// Mirrors ThemeProvider.tsx truthy guards: a layer value is applied only when it
// is a truthy string. `changedByPreset` is layer-membership (independent of any
// override), so it stays 'preset-changed' even when an override wins.
function deriveEntries(
  { preset, overrides, baseColors }: PresetColorReadoutProps,
): ColorReadoutEntry[] {
  return TOKEN_TAXONOMY.map(({ key, label, group }) => {
    const overrideValue = overrides[key];
    const presetValue = preset.colors[key];
    const baseValue = baseColors[key];

    let source: Source;
    if (overrideValue) source = 'override';
    else if (presetValue) source = 'preset';
    else source = 'base';

    const appliedValue = overrideValue || presetValue || baseValue;

    return { key, label, group, appliedValue, source, changedByPreset: !!presetValue };
  });
}

// ── Provenance badge (tri-state; the TEXT word is the mandatory signal) ─────────
const BADGE_STYLES: Record<Source, { bg: string; color: string; border?: string }> = {
  override: { bg: tint('var(--accent-primary)', 18), color: 'var(--text-primary)' },
  preset: { bg: tint('var(--status-success)', 18), color: 'var(--text-primary)' },
  base: { bg: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' },
};

const SOURCE_WORD: Record<Source, string> = {
  override: 'overridden',
  preset: 'preset',
  base: 'base',
};

const ProvenanceBadge: React.FC<{ source: Source }> = ({ source }) => {
  const style = BADGE_STYLES[source];
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      px={1.5}
      py={0.5}
      borderRadius="sm"
      fontSize="xs"
      fontWeight="600"
      lineHeight="none"
      letterSpacing="wide"
      bg={style.bg}
      color={style.color}
      border={style.border}
    >
      {source === 'override' ? 'Override' : source === 'preset' ? 'Preset' : 'Base'}
    </chakra.span>
  );
};

/**
 * PresetColorReadout — an additive, read-only, presentational preview of which
 * color tokens a selected theme preset applies and which provenance layer wins
 * (`override ?? preset ?? base`). Purely derives from `preset`/`overrides`/`baseColors`
 * via `useMemo` — never `useEffect` + `setState`, so no re-render loop.
 */
export const PresetColorReadout: React.FC<PresetColorReadoutProps> = ({ preset, overrides, baseColors }) => {
  const entries = useMemo(
    () => deriveEntries({ preset, overrides, baseColors }),
    [preset, overrides, baseColors],
  );

  return (
    <Box
      mt={4}
      p={4}
      borderRadius="md"
      border="1px solid"
      borderColor="var(--border-color)"
      bg="bg.surface"
      aria-label={`Theme preset color preview for ${preset.name}`}
    >
      <VStack gap={4} align="stretch">
        {GROUPS.map(({ group, title, cols }) => {
          const groupEntries = entries.filter((e) => e.group === group);
          return (
            <Box key={group}>
              <Text
                fontSize="xs"
                fontWeight="700"
                color="var(--text-secondary)"
                letterSpacing="wider"
                textTransform="uppercase"
                mb={2}
              >
                {title}
              </Text>
              <chakra.ul
                role="list"
                listStyle="none"
                margin={0}
                padding={0}
                display="grid"
                columnGap={3}
                rowGap={3}
                gridTemplateColumns={{
                  base: 'repeat(2, 1fr)',
                  md: `repeat(${cols}, 1fr)`,
                }}
              >
                {groupEntries.map((entry) => {
                  const hex = toHex(entry.appliedValue);
                  const sentence = `${entry.label} — ${SOURCE_WORD[entry.source]} color ${hex}`;
                  return (
                    <chakra.li
                      key={entry.key}
                      aria-label={sentence}
                      title={sentence}
                      display="flex"
                      flexDirection="column"
                      gap={1.5}
                    >
                      {/* Swatch — reads the runtime data value, never a source literal */}
                      <Box
                        h="40px"
                        w="full"
                        borderRadius="md"
                        border="1px solid"
                        borderColor="var(--border-color)"
                        bg={entry.appliedValue}
                      />
                      <Text fontSize="sm" color="var(--text-primary)" lineHeight="tight">
                        {entry.label}
                      </Text>
                      <Text fontFamily="mono" fontSize="xs" color="var(--text-secondary)" lineHeight="normal">
                        {hex}
                      </Text>
                      <ProvenanceBadge source={entry.source} />
                    </chakra.li>
                  );
                })}
              </chakra.ul>
            </Box>
          );
        })}
      </VStack>
    </Box>
  );
};
