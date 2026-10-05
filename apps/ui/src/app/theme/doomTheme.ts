import type { Theme } from '../types/theme';

/**
 * Doom Mode palette — the color-only subset of the theme token contract.
 *
 * Fonts are deliberately excluded: Doom Mode restyles color, never type. The
 * Omit keys match the four font tokens declared on `Theme['colors']`
 * (`apps/ui/src/app/types/theme.ts:89-93`): `fontFamily`, `fontPrimary`,
 * `fontSecondary`, `fontBase`.
 */
export type DoomPalette = Omit<
  Theme['colors'],
  'fontFamily' | 'fontPrimary' | 'fontSecondary' | 'fontBase'
>;

/**
 * The SINGLE Doom token record. Authored by UI/UX; consumed ONLY by
 * `ThemeProvider`, which writes it into the existing `--*` CSS-variable
 * contract while Doom Mode is engaged.
 *
 * SECRECY: this record is deliberately NOT added to `themePresets`
 * (`apps/ui/src/app/types/theme.ts`) or `allPresets`
 * (`apps/ui/src/app/providers/ThemeProvider.tsx`) — the Doom palette must
 * never appear in the appearance/theme settings.
 */
export const DOOM_PALETTE: DoomPalette = {
  // Grounds — near-black with a green/brown hell tint (Doom's hell ground)
  bodyBg: '#14170f',
  headerBg: '#1c2016',
  footerBg: '#1c2016',
  cardBg: '#20251a',
  cardHoverBg: '#2c3323',
  // Text — warm bone/phosphor + muted olive-grey
  textPrimary: '#e8e4d0',
  textSecondary: '#a3a68c',
  // Chrome — gunmetal-olive (clears 3:1 on every Doom surface)
  borderColor: '#67715a',
  // Accents — Doomguy armor green primary, blood-red secondary
  accentPrimary: '#8fbf3f',
  accentSecondary: '#e0463a',
  // Subagent identity — steel/plasma blue (distinct from green/red, soul-sphere echo)
  accentSubagent: '#6fb3c9',
  // Nested subagent — amber keycard (Doom HUD amber)
  accentNestedSubagent: '#e0a030',
  // Status — phosphor green / amber / blood red / plasma blue
  statusSuccess: '#6fbf3f',
  statusWarning: '#e0a030',
  statusError: '#e0463a',
  statusInfo: '#4f9fd4',
  // Gradients — armor-green → blood-red (mirrors the classic token format)
  gradientText: 'linear(to-r, #8fbf3f, #e0463a)',
  gradientButton: 'linear-gradient(135deg, #8fbf3f 0%, #d13b2e 100%)',
  // Node graph — Doom-green glow; color-mix keeps it live off the accent contract
  nodeBg: '#20251a',
  nodeBoxShadow:
    '0 0 16px color-mix(in srgb, var(--accent-primary) 38%, transparent), ' +
    '0 0 28px color-mix(in srgb, var(--accent-secondary) 22%, transparent)',
  edgeGradient: 'rgb(143, 191, 63)',
  // Overlays — deeper, green-tinted scrim + heavier dialog drop
  overlayBg: 'rgba(8, 10, 6, 0.72)',
  shadowDialog: '0 24px 80px rgba(0, 0, 0, 0.72)',
};
