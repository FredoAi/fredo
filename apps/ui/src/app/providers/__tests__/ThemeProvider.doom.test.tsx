/**
 * Spec #2971 ST-4 — the `ThemeProvider` mode-scoped Doom layer.
 *
 * Pins the composition + exact-revert contract: while the module-scoped
 * `doomVisual` store is engaged, the Doom palette wins over base < preset <
 * override and the `<html>` QA hooks (`class="doom-mode"`,
 * `data-doom-mode="engaged"`) are present; on exit every inline CSS variable and
 * the body paint revert byte-exactly, with ZERO storage writes (the
 * `setOverride`/`setPreset`/`resetTheme` setter API is never touched).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { ThemeProvider, resolveAccentContrast, useTheme } from '../ThemeProvider';
import { themes, themePresets } from '../../types/theme';
import { DOOM_PALETTE } from '../../theme/doomTheme';
import { setDoomVisualEngaged } from '../../../shared/doom-mode';

// Same settings mock pattern as ThemeProvider.test.tsx — every persisted key
// resolves to its typed default, so the provider starts from the stock base.
vi.mock('../../../applications/settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
  serializeValue: (v: unknown) => JSON.stringify(v),
}));

import { settingsService } from '../../../applications/settings';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;
const setMock = settingsService.set as ReturnType<typeof vi.fn>;

/** Every CSS var the Doom layer must write, paired with its `DOOM_PALETTE` source. */
const DOOM_VAR_KEYS: Array<[string, string]> = [
  ['--body-bg', DOOM_PALETTE.bodyBg],
  ['--header-bg', DOOM_PALETTE.headerBg],
  ['--footer-bg', DOOM_PALETTE.footerBg],
  ['--card-bg', DOOM_PALETTE.cardBg],
  ['--card-hover-bg', DOOM_PALETTE.cardHoverBg],
  ['--text-primary', DOOM_PALETTE.textPrimary],
  ['--text-secondary', DOOM_PALETTE.textSecondary],
  ['--border-color', DOOM_PALETTE.borderColor],
  ['--accent-primary', DOOM_PALETTE.accentPrimary],
  ['--accent-secondary', DOOM_PALETTE.accentSecondary],
  ['--accent-subagent', DOOM_PALETTE.accentSubagent],
  ['--accent-nested-subagent', DOOM_PALETTE.accentNestedSubagent],
  ['--status-success', DOOM_PALETTE.statusSuccess],
  ['--status-warning', DOOM_PALETTE.statusWarning],
  ['--status-error', DOOM_PALETTE.statusError],
  ['--status-info', DOOM_PALETTE.statusInfo],
  ['--gradient-text', DOOM_PALETTE.gradientText],
  ['--gradient-button', DOOM_PALETTE.gradientButton],
  ['--node-bg', DOOM_PALETTE.nodeBg],
  ['--node-box-shadow', DOOM_PALETTE.nodeBoxShadow],
  ['--edge-gradient', DOOM_PALETTE.edgeGradient],
  ['--overlay-bg', DOOM_PALETTE.overlayBg],
  ['--shadow-dialog', DOOM_PALETTE.shadowDialog],
];

describe('ThemeProvider Doom layer (#2971 ST-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-scoped store — reset between tests so engagement never leaks.
    setDoomVisualEngaged(false);
    document.documentElement.removeAttribute('style');
    document.documentElement.classList.remove('doom-mode');
    document.documentElement.removeAttribute('data-doom-mode');
    document.body.removeAttribute('style');
  });

  afterEach(() => {
    setDoomVisualEngaged(false);
  });

  const flush = async () => {
    await act(async () => {});
  };

  const readVar = (name: string) => document.documentElement.style.getPropertyValue(name);
  const readClass = () => document.documentElement.classList.contains('doom-mode');
  // jsdom's cssstyle normalizes a body shorthand color to `rgb(r, g, b)`; the
  // custom properties on `<html>` stay literal. Normalize the expected hex here.
  const hexToRgb = (hex: string): string => {
    const h = hex.replace('#', '');
    return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
  };

  it('applies the Doom palette while engaged and reverts byte-exactly on exit', async () => {
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    // Pre-mode snapshot (stock classic base, no Doom residue).
    const styleBefore = document.documentElement.getAttribute('style');
    // jsdom re-serializes the body `background` shorthand on every write, so
    // compare the individual body paint properties (byte-equal per property).
    const bodyPaintBefore = {
      background: document.body.style.background,
      color: document.body.style.color,
      fontFamily: document.body.style.fontFamily,
    };
    expect(readClass()).toBe(false);
    expect(document.documentElement.getAttribute('data-doom-mode')).toBeNull();

    // ── Enter: the module-scoped store is the SINGLE trigger ──
    const setCallsBefore = setMock.mock.calls.length;
    act(() => {
      setDoomVisualEngaged(true);
    });
    await flush();

    for (const [name, expected] of DOOM_VAR_KEYS) {
      expect(readVar(name), name).toBe(expected);
    }
    // On-accent foreground is recomputed from the Doom accent (never stale).
    expect(readVar('--accent-contrast')).toBe(resolveAccentContrast(DOOM_PALETTE.accentPrimary));
    // QA seams on <html> only.
    expect(readClass()).toBe(true);
    expect(document.documentElement.getAttribute('data-doom-mode')).toBe('engaged');
    // Body paint mirrors the Doom ground/ink.
    expect(document.body.style.background).toBe(hexToRgb(DOOM_PALETTE.bodyBg));
    expect(document.body.style.color).toBe(hexToRgb(DOOM_PALETTE.textPrimary));

    // ── Exit: byte-exact revert, ZERO storage writes ──
    act(() => {
      setDoomVisualEngaged(false);
    });
    await flush();

    expect(document.documentElement.getAttribute('style')).toBe(styleBefore);
    expect(document.body.style.background).toBe(bodyPaintBefore.background);
    expect(document.body.style.color).toBe(bodyPaintBefore.color);
    expect(document.body.style.fontFamily).toBe(bodyPaintBefore.fontFamily);
    expect(readClass()).toBe(false);
    expect(document.documentElement.getAttribute('data-doom-mode')).toBeNull();
    // The setter API was never called by the Doom layer (AC3/R-6).
    expect(setMock.mock.calls.length).toBe(setCallsBefore);
  });

  it('wins over a non-default preset + per-token override and restores the user palette exactly (AC5/R-6)', async () => {
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    const matrix = themePresets.find((p) => p.id === 'matrix')!;
    act(() => result.current.setPreset('matrix'));
    await flush();
    act(() => result.current.setOverride('accentPrimary', '#123456'));
    await flush();

    // The user's effective palette: override wins over the preset.
    const userAccent = readVar('--accent-primary');
    const userBody = readVar('--body-bg');
    const userContrast = readVar('--accent-contrast');
    expect(userAccent).toBe('#123456');
    expect(userBody).toBe(matrix.colors.bodyBg);

    // ── Enter: Doom wins over BOTH lower layers ──
    act(() => {
      setDoomVisualEngaged(true);
    });
    await flush();
    expect(readVar('--accent-primary')).toBe(DOOM_PALETTE.accentPrimary);
    expect(readVar('--body-bg')).toBe(DOOM_PALETTE.bodyBg);
    expect(readVar('--accent-contrast')).toBe(resolveAccentContrast(DOOM_PALETTE.accentPrimary));
    // The lower layers remain intact underneath (context still holds the user's choices).
    expect(result.current.selectedPreset).toBe('matrix');
    expect(result.current.overrides).toEqual({ accentPrimary: '#123456' });

    // ── Exit: the user's exact palette returns — never the stock default ──
    act(() => {
      setDoomVisualEngaged(false);
    });
    await flush();
    expect(readVar('--accent-primary')).toBe(userAccent);
    expect(readVar('--body-bg')).toBe(userBody);
    expect(readVar('--accent-contrast')).toBe(userContrast);
    expect(readVar('--accent-primary')).not.toBe(themes.classic.colors.accentPrimary);
  });

  it('leaves no Doom residue while disengaged (R-5 negative)', async () => {
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    expect(readClass()).toBe(false);
    expect(document.documentElement.getAttribute('data-doom-mode')).toBeNull();
    expect(readVar('--body-bg')).toBe(themes.classic.colors.bodyBg);
    expect(readVar('--accent-primary')).toBe(themes.classic.colors.accentPrimary);
    // Explicitly not a Doom value.
    expect(readVar('--body-bg')).not.toBe(DOOM_PALETTE.bodyBg);
    expect(readVar('--accent-primary')).not.toBe(DOOM_PALETTE.accentPrimary);
  });
});
