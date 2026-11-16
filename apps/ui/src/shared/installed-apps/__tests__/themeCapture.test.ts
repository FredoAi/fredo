/**
 * Spec #3147 ST-5 — the theme producer (`themeCapture.ts`).
 *
 * The capture rule is fed a STUBBED value source (never a real browser): the
 * point of these pins is the returned token list and the `light`/`dark`
 * derivation from two different `--body-bg` values, i.e. the contract the
 * backend mirror and the served document depend on (G-413's producing side).
 *
 * `documentThemeSource` is also driven against a stubbed `getComputedStyle` so
 * the DOM reader — the only impure part — is covered by the same shape.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FREDO_THEME_PUSH_COMMAND,
  LIGHT_SURFACE_LUMINANCE,
  MAX_CAPTURED_TOKENS,
  captureDocumentTheme,
  captureTheme,
  deriveColorScheme,
  documentThemeSource,
  isThemeTokenName,
  pushCapturedTheme,
  resetThemePushSchedule,
  scheduleThemePush,
  type ThemeCaptureSource,
} from '../themeCapture';
import { adapterBridge } from '../../utils/adapterBridge';

function sourceOf(entries: Record<string, string>): ThemeCaptureSource {
  return {
    tokenNames: Object.keys(entries),
    resolve: (name: string) => entries[name] ?? '',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetThemePushSchedule();
});

describe('themeCapture — the token list', () => {
  it('returns every declared token in document order, with its resolved value', () => {
    const captured = captureTheme(
      sourceOf({
        '--body-bg': 'rgb(17, 17, 17)',
        '--card-bg': 'color-mix(in srgb, rgb(30, 30, 30) 90%, rgb(50, 50, 50))',
        '--accent-primary': 'rgb(147, 51, 234)',
        '--accent-contrast': '#ffffff',
        '--status-on-solids': '#0c1117',
      }),
    );

    expect(captured.tokens).toEqual([
      { name: '--body-bg', value: 'rgb(17, 17, 17)' },
      {
        name: '--card-bg',
        value: 'color-mix(in srgb, rgb(30, 30, 30) 90%, rgb(50, 50, 50))',
      },
      { name: '--accent-primary', value: 'rgb(147, 51, 234)' },
      { name: '--accent-contrast', value: '#ffffff' },
      { name: '--status-on-solids', value: '#0c1117' },
    ]);
    // Derived tokens cross as their RESOLVED strings — the whole reason the
    // producer reads the DOM instead of re-enumerating SEMANTIC_TOKENS.
    expect(captured.tokens.some((token) => token.value.startsWith('color-mix('))).toBe(true);
  });

  it('drops invalid names and empty values, and resolves duplicates first-wins', () => {
    const captured = captureTheme({
      tokenNames: [
        '--body-bg',
        'body-bg',
        '--',
        '--card-bg',
        '--text-primary',
        '--body-bg',
        '--blank',
      ],
      resolve: (name) =>
        ({
          '--body-bg': '  #111111  ',
          '--card-bg': '   ',
          '--text-primary': '#eeeeee',
          '--blank': '',
        })[name] ?? '',
    });

    expect(captured.tokens).toEqual([
      { name: '--body-bg', value: '#111111' },
      { name: '--text-primary', value: '#eeeeee' },
    ]);
  });

  it('caps the token list at MAX_CAPTURED_TOKENS', () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < MAX_CAPTURED_TOKENS + 20; index += 1) {
      entries[`--token-${index}`] = 'value';
    }
    expect(captureTheme(sourceOf(entries)).tokens).toHaveLength(MAX_CAPTURED_TOKENS);
  });

  it('accepts only plain custom-property names', () => {
    for (const valid of ['--body-bg', '--accent-strong', '--status-on-solids', '--a1']) {
      expect(isThemeTokenName(valid)).toBe(true);
    }
    for (const invalid of ['body-bg', '--', '-x', '--a b', '--a;b', '--a{b}', '--a_b']) {
      expect(isThemeTokenName(invalid)).toBe(false);
    }
  });
});

describe('themeCapture — the light/dark derivation', () => {
  it('derives LIGHT from a light --body-bg and DARK from a dark one', () => {
    // `light-default` (#ffffff) and `dark` (#0c1117) from `types/theme.ts`, plus
    // the base classic bodyBg. The two schemes must differ for the SAME capture
    // rule — that is the positive discriminator R-1.3/T-1.5 rests on.
    const light = captureTheme(sourceOf({ '--body-bg': '#ffffff', '--text-primary': '#111111' }));
    const dark = captureTheme(sourceOf({ '--body-bg': '#0c1117', '--text-primary': '#f5f5f5' }));
    const hexLight = captureTheme(sourceOf({ '--body-bg': '#fdf6e3' }));
    const rgbDark = captureTheme(sourceOf({ '--body-bg': 'rgb(10, 14, 26)' }));

    expect(light.colorScheme).toBe('light');
    expect(dark.colorScheme).toBe('dark');
    expect(hexLight.colorScheme).toBe('light');
    expect(rgbDark.colorScheme).toBe('dark');
    expect(light.colorScheme).not.toBe(dark.colorScheme);
    // The SAME token value travels unchanged alongside the scheme.
    expect(dark.tokens).toContainEqual({ name: '--text-primary', value: '#f5f5f5' });
  });

  it('falls back to light for an unparseable or missing --body-bg', () => {
    expect(deriveColorScheme('')).toBe('light');
    expect(deriveColorScheme('Canvas')).toBe('light');
    expect(deriveColorScheme('color-mix(in srgb, Canvas 90%, GrayText)')).toBe('light');
    // No --body-bg at all: the scheme is the documented default, not random.
    expect(captureTheme(sourceOf({ '--card-bg': '#222222' })).colorScheme).toBe('light');
  });

  it('sits far from the luminance boundary on the shipped presets', () => {
    // A guard on the declared threshold: white and near-black are the two
    // extremes the presets actually use, so neither can be misclassified.
    expect(deriveColorScheme('#ffffff')).toBe('light');
    expect(deriveColorScheme('#000000')).toBe('dark');
    expect(LIGHT_SURFACE_LUMINANCE).toBeGreaterThan(0);
    expect(LIGHT_SURFACE_LUMINANCE).toBeLessThan(1);
  });
});

describe('themeCapture — the DOM reader', () => {
  it('reads the declarations off documentElement and resolves values through getComputedStyle', () => {
    const root = document.createElement('div');
    root.style.setProperty('--body-bg', '#ffffff');
    root.style.setProperty('--accent-primary', 'rgb(147, 51, 234)');
    root.style.setProperty('--blank', '');

    const stubbed = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) =>
        ({
          '--body-bg': ' rgb(255, 255, 255)',
          '--accent-primary': 'rgb(147, 51, 234)',
          '--blank': '',
        })[name] ?? '',
    } as unknown as CSSStyleDeclaration);

    const captured = captureDocumentTheme(root);
    expect(stubbed).toHaveBeenCalledWith(root);
    expect(captured.tokens).toEqual([
      { name: '--body-bg', value: 'rgb(255, 255, 255)' },
      { name: '--accent-primary', value: 'rgb(147, 51, 234)' },
    ]);
    expect(captured.colorScheme).toBe('light');
  });

  it('falls back to the inline declaration when computed style omits the property', () => {
    const root = document.createElement('div');
    root.style.setProperty('--body-bg', '#0c1117');

    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);

    const source = documentThemeSource(root);
    expect(source.tokenNames).toContain('--body-bg');
    expect(source.resolve('--body-bg')).toBe('#0c1117');
    expect(captureTheme(source).colorScheme).toBe('dark');
  });
});

describe('themeCapture — the push', () => {
  it('invokes the one backend command with the exact camelCase payload', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    adapterBridge.setInvoke(invoke as never);

    // Pretend to be the desktop host (Tauri's internal marker on `window`).
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const root = document.documentElement;
    const capturedNames = ['--body-bg', '--accent-primary'] as const;
    const previous = capturedNames.map((name) => root.style.getPropertyValue(name));
    root.style.setProperty('--body-bg', '#ffffff');
    root.style.setProperty('--accent-primary', 'rgb(147, 51, 234)');

    try {
      await pushCapturedTheme();
    } finally {
      capturedNames.forEach((name, index) => root.style.setProperty(name, previous[index]));
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }

    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe(FREDO_THEME_PUSH_COMMAND);
    expect(command).toBe('installed_apps_push_theme');
    const payload = (args as { payload: { colorScheme: string; tokens: unknown[] } }).payload;
    expect(payload.colorScheme).toBe('light');
    expect(payload.tokens).toContainEqual({ name: '--body-bg', value: '#ffffff' });
    // No `color_scheme`/snake_case key ever crosses the boundary.
    expect(Object.keys(payload).sort()).toEqual(['colorScheme', 'tokens']);
  });

  it('is a no-op outside the desktop host, and never throws when the backend fails', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('denied'));
    adapterBridge.setInvoke(invoke as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // No `__TAURI_INTERNALS__`: the browser build pushes nothing.
    await pushCapturedTheme();
    expect(invoke).not.toHaveBeenCalled();

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    document.documentElement.style.setProperty('--body-bg', '#ffffff');
    try {
      // A refused backend is logged and dropped — it must never reach the
      // host's own theme change (which has already been applied).
      await expect(pushCapturedTheme()).resolves.toBeUndefined();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      document.documentElement.style.removeProperty('--body-bg');
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it('coalesces concurrent schedules into ONE push', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    adapterBridge.setInvoke(invoke as never);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    document.documentElement.style.setProperty('--body-bg', '#0c1117');

    try {
      scheduleThemePush();
      scheduleThemePush();
      scheduleThemePush();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(invoke).toHaveBeenCalledTimes(1);
      const payload = (invoke.mock.calls[0][1] as { payload: { colorScheme: string } }).payload;
      expect(payload.colorScheme).toBe('dark');
    } finally {
      document.documentElement.style.removeProperty('--body-bg');
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});
