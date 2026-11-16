/**
 * Theme capture for the installed-application theme transport (Spec #3147, ST-5).
 *
 * # What this module is
 *
 * The **producer** half of the ONE theme transport. The host's `ThemeProvider`
 * effect is the single place that decides what the current theme IS; this module
 * reads the result back off the live DOM and hands it to the backend mirror,
 * which the `fredoapp` scheme handler inlines at document-serve time (ST-3) and
 * which `installed_apps_push_theme` pushes into every open `installed-*` window
 * (ST-5's Rust half).
 *
 * # Why it reads the DOM instead of the contract
 *
 * `SEMANTIC_TOKENS` describes *authored* tokens and the *rules* for derived ones.
 * It is deliberately NOT enumerated here. The host writes every token it owns
 * onto `document.documentElement` as a CSS custom property — authored values,
 * `color-mix(...)` expressions derived from the contract, the WCAG-computed
 * `--accent-contrast` / `--status-on-solids`, and the Doom layer while engaged.
 * Reading the declarations the DOM actually carries is what makes those derived
 * values cross as the strings the child will resolve, and it is what keeps this
 * module from drifting the day a token is added to (or removed from) the
 * contract. There is exactly ONE source of truth: the DOM the host painted.
 *
 * # `colorScheme`
 *
 * The host has no light/dark *mode* — a light appearance is a different set of
 * token VALUES from a preset (`types/theme.ts`, `light-default`). So the scheme
 * is DERIVED from the resolved `--body-bg`, using the shipped WCAG
 * relative-luminance rule (`ThemeProvider.tsx:174-187`'s `srgbToLinear` /
 * `relativeLuminance`, single-sourced in `app/theme/contrast/wcag.ts:43-52` by
 * #3033 — this module does NOT carry a second implementation). `colorScheme` is
 * the only field the child uses for a non-colour decision (native widget and
 * scrollbar rendering), so it must follow the values, never a stored mode.
 *
 * # Transport rules honoured here
 *
 * * No static `@tauri-apps/api` import — the call goes through
 *   `adapterBridge.invoke`, which owns the dynamic import (`utils/adapterBridge`).
 * * Nothing is polled and nothing subscribes: the ONE call site lives inside the
 *   existing `ThemeProvider` effect. `scheduleThemePush` coalesces that call into
 *   a single post-paint read, so a burst of effect runs produces one push.
 * * A failed push never touches the host's own theme: it is logged and dropped.
 */

import { luminance, parseColor } from '../../app/theme/contrast/wcag';
// ST-6 landed the ONE wire-type home (`types.ts`) and the typed command seam
// (`client.ts`) — imported here rather than redeclared, so the transport's shape
// and its invoke path each have exactly one owner.
import { pushTheme } from './client';
import type { FredoThemeToken, FredoThemeTokens } from './types';

/** The command the backend registers for the mirror write + live broadcast. */
export const FREDO_THEME_PUSH_COMMAND = 'installed_apps_push_theme';

/** The one derived appearance value the transport carries (`FredoThemeTokens`). */
export type ColorScheme = FredoThemeTokens['colorScheme'];

/**
 * WCAG relative luminance at which a surface stops reading as dark. `0.5` is the
 * perceptual midpoint of the 0..1 luminance range; every preset in
 * `types/theme.ts` sits far from it, so no preset is near the boundary.
 */
export const LIGHT_SURFACE_LUMINANCE = 0.5;

/**
 * Defensive bound on how many declarations a single push may carry. The host
 * declares a few dozen; the cap only stops a runaway DOM from turning one theme
 * change into an unbounded IPC payload.
 */
export const MAX_CAPTURED_TOKENS = 256;

/**
 * A theme value source: the token names a document declared, and the resolved
 * value for each. The seam exists so the capture rule is unit-testable without a
 * browser, and so the DOM reader below stays the only impure part.
 */
export interface ThemeCaptureSource {
  /** Declared custom-property names, in document order. */
  readonly tokenNames: readonly string[];
  /** The resolved value of one custom property ('' when it has none). */
  resolve: (name: string) => string;
}

/**
 * Is this a plain CSS custom-property name (`--body-bg`)? Mirrors the acceptance
 * rule the scheme handler applies before it inlines a token (`scheme.rs`
 * `sanitize_css_value` + the `--` / ascii-alphanumeric-or-dash check), so the
 * producer never offers a name the consumer would silently drop.
 */
export function isThemeTokenName(name: string): boolean {
  if (!name.startsWith('--') || name.length < 3) return false;
  for (const character of name.slice(2)) {
    const isAllowed =
      (character >= 'a' && character <= 'z') ||
      (character >= 'A' && character <= 'Z') ||
      (character >= '0' && character <= '9') ||
      character === '-';
    if (!isAllowed) return false;
  }
  return true;
}

/**
 * Derive the transport's `colorScheme` from a resolved `--body-bg` value.
 *
 * Unparseable input (a `color-mix(...)` that never resolved, a system-colour
 * keyword, an empty string) falls back to `'light'` — the same default the
 * backend's documented fallback payload uses, so a degraded capture is
 * deterministic instead of random.
 */
export function deriveColorScheme(bodyBg: string): ColorScheme {
  const rgb = parseColor(bodyBg);
  if (!rgb) return 'light';
  return luminance(rgb) >= LIGHT_SURFACE_LUMINANCE ? 'light' : 'dark';
}

/**
 * Capture the theme from a value source: every valid, non-empty, first-seen
 * declaration in document order, plus the scheme derived from `--body-bg`.
 *
 * Duplicates resolve FIRST-WINS: the DOM enumerates a custom property once, so a
 * repeat can only come from a caller-supplied source, and the first declaration
 * is the one the cascade painted.
 */
export function captureTheme(source: ThemeCaptureSource): FredoThemeTokens {
  const seen = new Set<string>();
  const tokens: FredoThemeToken[] = [];

  for (const rawName of source.tokenNames) {
    if (tokens.length >= MAX_CAPTURED_TOKENS) break;
    const name = rawName.trim();
    if (!isThemeTokenName(name) || seen.has(name)) continue;
    const value = source.resolve(name).trim();
    if (value.length === 0) continue;
    seen.add(name);
    tokens.push({ name, value });
  }

  const bodyBg = tokens.find((token) => token.name === '--body-bg')?.value ?? '';
  return { tokens, colorScheme: deriveColorScheme(bodyBg) };
}

/**
 * The live-document source: names from the inline declarations the host wrote
 * onto `documentElement`, values from `getComputedStyle` (which resolves
 * `var(...)` references inside a derived `color-mix(...)` token).
 *
 * The computed value is preferred and the inline declaration is the documented
 * fallback: a custom property's computed value is the specified token stream, so
 * a browser returns it; a minimal style implementation that omits custom
 * properties from computed style still carries the declaration the host wrote.
 */
export function documentThemeSource(root: HTMLElement = document.documentElement): ThemeCaptureSource {
  const computed = getComputedStyle(root);
  const tokenNames: string[] = [];
  for (let index = 0; index < root.style.length; index += 1) {
    const name = root.style.item(index);
    if (name && name.startsWith('--')) tokenNames.push(name);
  }
  return {
    tokenNames,
    resolve: (name: string) => computed.getPropertyValue(name) || root.style.getPropertyValue(name),
  };
}

/** Capture the theme currently painted on the host document. */
export function captureDocumentTheme(root: HTMLElement = document.documentElement): FredoThemeTokens {
  return captureTheme(documentThemeSource(root));
}

/** Is this the desktop host (i.e. is there a backend to push to)? */
function isDesktopHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Capture the painted theme and hand it to the backend: it becomes the mirror the
 * scheme handler serves from (R-1.4) and is broadcast into every open
 * `installed-*` window (R-1.5).
 *
 * Best-effort by design. The host's own theme has already been applied by the
 * caller before this runs, so a refused or missing backend must not surface as a
 * failed theme change — it is logged and dropped. A document with no declarations
 * (or a browser-only build with no backend) is a no-op, never a warn.
 */
export async function pushCapturedTheme(): Promise<void> {
  if (!isDesktopHost()) return;
  const payload = captureDocumentTheme();
  if (payload.tokens.length === 0) return;
  try {
    // ST-6's typed seam — `adapterBridge.invoke('installed_apps_push_theme', …)`
    // lives there, so the command name has ONE owner in the frontend.
    await pushTheme(payload);
  } catch (error) {
    console.warn('[installed-apps] the theme push failed; the host theme is unaffected', error);
  }
}

/** The pending post-paint push, so a second schedule coalesces and tests can cancel. */
let pendingPush: { cancel: () => void } | null = null;

/**
 * Schedule ONE post-paint theme push (the producer's only entry point).
 *
 * The `ThemeProvider` effect runs after the DOM mutation but before the browser
 * paints, so the read is deferred one frame: that is when the computed values
 * the child will consume are final. Concurrent schedules in the same frame
 * collapse into a single push — no new effect, no subscription, no polling.
 */
export function scheduleThemePush(): void {
  if (pendingPush) return;

  const run = () => {
    pendingPush = null;
    void pushCapturedTheme();
  };

  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(run);
    pendingPush = {
      cancel: () => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
      },
    };
  } else {
    const handle = setTimeout(run, 0);
    pendingPush = { cancel: () => clearTimeout(handle) };
  }
}

/** Test support: cancel a scheduled-but-not-yet-run push. */
export function resetThemePushSchedule(): void {
  pendingPush?.cancel();
  pendingPush = null;
}
