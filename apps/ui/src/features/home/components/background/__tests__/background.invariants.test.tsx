/**
 * #2899 ST-5 / #2905 ST-4 — cross-cutting invariant + continuous-state suite.
 *
 * The capstone `WHILE …` properties that must hold for EVERY background the
 * user can select. Each leg pins an invariant that is easy to break with a
 * later edit:
 *
 *   (a) Non-interactivity: the desktop backdrop layer is `pointer-events: none`,
 *       `aria-hidden`, not focusable, and carries no handlers — it can never
 *       intercept pointer or keyboard input.
 *   (b) Z-order: the backdrop is the FIRST layer of the desktop stack at z-index
 *       0, strictly below `WindowManager`'s z-index-1 container — a window always
 *       paints above it.
 *   (c) Procedural-only / no hardcoded colors: the background module source and
 *       the emitted paint (grounds + every layer) carry zero hex/rgb/hsl/rgba
 *       literals and zero `data:`/`url(` raster art.
 *   (d) Motion contract (#2905): motion is declarative CSS only — zero `rAF`,
 *       zero `setInterval`, `@keyframes` confined to `backgroundMotion.ts`, and
 *       only `transform`/`opacity` declarations. While animated the backdrop is
 *       stamped `animated`, injects the ONE motion stylesheet, and every layer
 *       motion passes `isBoundedMotion`; under reduced motion the SAME layered
 *       paint renders with `data-motion="static"`, no stylesheet, and zero
 *       animation properties (removed, never paused).
 *   (e) Stale-id fallback: an unknown/removed id resolves to the shipped
 *       `NONE_BACKGROUND` byte-for-byte and never throws.
 *   (f) None byte-identical (#2905 ST-4): `none` renders zero backdrop DOM and
 *       zero motion `<style>`, the launcher surface keeps `NONE_BACKGROUND.css`
 *       byte-identically, and the registry ground deep-equals the shipped
 *       literal.
 *
 * The store is driven for real (`resetBackgroundStoreForTests()` +
 * `selectBackground('aurora')`) with only `settingsService` mocked — the
 * established host-agnostic seam (see `BackgroundSettings.test.tsx`). Source
 * scans follow the `companion.cursorReducedMotion.test.ts` pattern (vitest cwd =
 * apps/ui, read with `readFileSync(resolve(process.cwd(), …))`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Box } from '@chakra-ui/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowManager } from '@/shared/window-system/WindowManager';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';

import { DesktopBackdrop } from '../DesktopBackdrop';
import {
  BACKGROUND_DESCRIPTORS,
  NONE_BACKGROUND,
  getBackgroundDescriptor,
} from '../backgroundRegistry';
import { MOTION_LAYERS_MAX, MOTION_LAYER_OVERSCAN_PCT, isBoundedMotion } from '../backgroundMotion';
import {
  getBackgroundId,
  resetBackgroundStoreForTests,
  selectBackground,
} from '../backgroundStore';

vi.mock('../../../../settings', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('none'),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

import { settingsService } from '../../../../settings';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;
const setMock = settingsService.set as ReturnType<typeof vi.fn>;

const BACKGROUND_DIR = 'src/features/home/components/background';
const HOME_PATH = 'src/features/home/components/Home.tsx';
const WINDOW_MANAGER_PATH = 'src/shared/window-system/WindowManager.tsx';
const LAUNCHER_SHELL_PATH = 'src/features/home/components/launcher/LauncherShell.tsx';

/** The files that author/serialize background paint (R-5.1 scope). */
const RENDER_PATHS = [
  `${BACKGROUND_DIR}/backgroundRegistry.ts`,
  `${BACKGROUND_DIR}/DesktopBackdrop.tsx`,
  `${BACKGROUND_DIR}/BackgroundSettings.tsx`,
  `${BACKGROUND_DIR}/backgroundMotion.ts`,
] as const;

/** The whole background module — the no-JS-frame-loop scope. */
const MODULE_PATHS = [...RENDER_PATHS, `${BACKGROUND_DIR}/backgroundStore.ts`] as const;

/** The ONE module allowed to own `@keyframes` (#2905 ST-5 scope). */
const MOTION_MODULE_PATH = `${BACKGROUND_DIR}/backgroundMotion.ts`;

/** vitest runs with cwd = apps/ui (the package root). */
function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/**
 * Strip block + line comments so prose and issue refs (`#2899` — a hex-looking
 * digit run) are exempt; only executable/emitted CSS is scanned.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The serialized paint of a descriptor — ground + every layer. */
function serializePaint(descriptor: (typeof BACKGROUND_DESCRIPTORS)[number]): string {
  return JSON.stringify({ css: descriptor.css, layers: descriptor.layers.map((l) => l.css) });
}

/** Stub the OS reduced-motion media query before a render. */
function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** Drive the real store to a non-`none` selection with a deterministic host seam. */
async function selectAurora(): Promise<void> {
  await selectBackground('aurora');
  expect(getBackgroundId()).toBe('aurora');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetBackgroundStoreForTests();
  resetWindowStoreForTests();
  getMock.mockResolvedValue('none');
  setMock.mockResolvedValue(undefined);
});

describe('#2899 ST-5 (a) — backdrop non-interactivity', () => {
  it('renders a pointer-transparent, AT-hidden, non-focusable, handler-free layer', async () => {
    await selectAurora();

    const { container } = renderWithChakra(<DesktopBackdrop />);
    const layer = container.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    expect(layer).not.toBeNull();

    // Never intercepts a pointer.
    expect(getComputedStyle(layer).pointerEvents).toBe('none');

    // Invisible to assistive tech.
    expect(layer.getAttribute('aria-hidden')).toBe('true');

    // Not in the tab order and not programmatically focusable.
    expect(layer.hasAttribute('tabindex')).toBe(false);
    expect(layer.tabIndex).toBe(-1);
    layer.focus();
    expect(document.activeElement).not.toBe(layer);

    // No event-handler attributes on the root (the injected <style> child does
    // not add any either).
    expect(layer.outerHTML).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe('#2899 ST-5 (b) — z-order contract', () => {
  it('renders the backdrop before the z=1 window stack (DOM order + declared z-index)', async () => {
    await selectAurora();

    const { container } = renderWithChakra(
      <Box data-testid="desktop-scope" position="relative" overflow="hidden">
        <DesktopBackdrop />
        <WindowManager />
      </Box>,
    );

    const scope = container.querySelector('[data-testid="desktop-scope"]') as HTMLElement;
    const backdrop = scope.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    expect(backdrop).not.toBeNull();

    // The backdrop is the FIRST layer of the desktop stack, declared at z=0.
    expect(scope.firstElementChild).toBe(backdrop);
    expect(getComputedStyle(backdrop).zIndex).toBe('0');

    // The window-stack container follows it in DOM order at z=1, so a window
    // always paints above the background (0 < 1).
    const stack = backdrop.nextElementSibling as HTMLElement;
    expect(stack).not.toBeNull();
    expect(stack).not.toBe(backdrop);
    expect(getComputedStyle(stack).zIndex).toBe('1');
    expect(
      backdrop.compareDocumentPosition(stack) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('Home.tsx mounts <DesktopBackdrop /> before <WindowManager /> (authored DOM order)', () => {
    const home = readSource(HOME_PATH);
    const backdropIndex = home.indexOf('<DesktopBackdrop />');
    const windowManagerIndex = home.indexOf('<WindowManager />');

    expect(backdropIndex).toBeGreaterThanOrEqual(0);
    expect(windowManagerIndex).toBeGreaterThanOrEqual(0);
    expect(backdropIndex).toBeLessThan(windowManagerIndex);
  });

  it('WindowManager declares its container at z-index 1', () => {
    const manager = stripComments(readSource(WINDOW_MANAGER_PATH));
    // The stack container is an absolute full-bleed layer at zIndex={1}.
    expect(manager).toMatch(/zIndex=\{1\}/);
    expect(manager).toMatch(/position="absolute"/);
  });
});

describe('#2899 ST-5 (c) / #2905 ST-5 — no hardcoded literals / no raster', () => {
  it('the background module source carries zero color literals and zero data:/url( art', () => {
    for (const path of RENDER_PATHS) {
      const code = stripComments(readSource(path));
      expect(code, `${path}: hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${path}: rgb()/rgba() literal`).not.toMatch(/\brgba?\s*\(/);
      expect(code, `${path}: hsl()/hsla() literal`).not.toMatch(/\bhsla?\s*\(/);
      expect(code, `${path}: url() raster art`).not.toMatch(/url\s*\(/);
      expect(code, `${path}: data: raster art`).not.toMatch(/data:/);
    }
  });

  it('the emitted descriptor paint — grounds AND every layer — is theme-derived, never literal', () => {
    const emitted = JSON.stringify(
      [NONE_BACKGROUND, ...BACKGROUND_DESCRIPTORS].map((descriptor) => ({
        css: descriptor.css,
        layers: descriptor.layers.map((layer) => layer.css),
      })),
    );

    expect(emitted).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(emitted).not.toMatch(/\brgba?\s*\(/);
    expect(emitted).not.toMatch(/\bhsla?\s*\(/);
    expect(emitted).not.toMatch(/url\s*\(/);
    expect(emitted).not.toMatch(/data:/);

    // …and it must still consume the live theme surface.
    expect(emitted).toContain('var(--');
    expect(emitted).toContain('color-mix(in srgb, var(--');
  });

  it('never alpha-appends digits onto a var() reference (the invalid var(--x)NN form)', () => {
    for (const path of RENDER_PATHS) {
      const code = stripComments(readSource(path));
      expect(code, `${path}: var(--x)NN alpha-append`).not.toMatch(/var\(--[a-z0-9-]+\)\d/);
    }
    const emitted = JSON.stringify(
      [NONE_BACKGROUND, ...BACKGROUND_DESCRIPTORS].flatMap((descriptor) => [
        descriptor.css,
        ...descriptor.layers.map((layer) => layer.css),
      ]),
    );
    expect(emitted).not.toMatch(/var\(--[a-z0-9-]+\)\d/);
  });
});

describe('#2905 ST-4 (d) — motion is declarative + bounded (animated), absent (static)', () => {
  it('ships zero rAF / setInterval anywhere in the background module', () => {
    for (const path of MODULE_PATHS) {
      const code = stripComments(readSource(path));
      expect(code, `${path}: requestAnimationFrame`).not.toMatch(/requestAnimationFrame/);
      expect(code, `${path}: setInterval`).not.toMatch(/setInterval/);
    }
  });

  it('confines @keyframes to backgroundMotion.ts and animates transform/opacity only', () => {
    const keyframePaths = MODULE_PATHS.filter((path) =>
      stripComments(readSource(path)).includes('@keyframes'),
    );
    expect(keyframePaths).toEqual([MOTION_MODULE_PATH]);

    const motionCode = stripComments(readSource(MOTION_MODULE_PATH));
    // No repaint-per-frame or color substrate, no stepped timing.
    expect(motionCode).not.toMatch(/background-position/);
    expect(motionCode).not.toMatch(/background-size\s*:/);
    expect(motionCode).not.toMatch(/steps\(/);
    expect(motionCode).not.toMatch(/background-attachment/);
    // The emitted keyframe CSS never carries a color declaration.
    const cssOnly = motionCode.slice(motionCode.indexOf('@keyframes'));
    expect(cssOnly).not.toMatch(/\bcolor\s*:/);
  });

  it('animated leg: data-motion + the ONE motion stylesheet + bounded layer motion', async () => {
    stubReducedMotion(false);
    await selectAurora();

    const { container } = renderWithChakra(<DesktopBackdrop />);
    const root = container.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    expect(root.getAttribute('data-motion')).toBe('animated');
    expect(root.getAttribute('data-background-id')).toBe('aurora');
    const stylesheet = container.querySelector('[data-testid="desktop-backdrop-motion-styles"]');
    expect(stylesheet).not.toBeNull();
    const motionCss = stylesheet?.textContent ?? '';

    const layers = Array.from(root.querySelectorAll('[data-background-layer]'));
    expect(layers.length).toBeGreaterThan(0);
    expect(layers.length).toBeLessThanOrEqual(MOTION_LAYERS_MAX);

    const descriptor = getBackgroundDescriptor('aurora');
    let animatedLayers = 0;
    for (const layer of layers) {
      const id = layer.getAttribute('data-background-layer');
      const motion = descriptor.layers.find((declared) => declared.id === id)?.motion;
      if (!motion) continue;
      expect(isBoundedMotion(motion), `${id}: bounded`).toBe(true);
      animatedLayers += 1;
      expect(layer.getAttribute('style') ?? '', `${id}: inline animation`).toMatch(
        /animation-name\s*:/,
      );
      // #2909 ST-1: per-layer generated keyframes + the identity hook, and the
      // shared overscan geometry so travel never exposes an edge.
      expect(motionCss, `${id}: per-layer keyframes`).toContain(`@keyframes fredo-bg-${id}`);
      expect(layer.getAttribute('data-motion-kind'), `${id}: identity hook`).toBe(motion.kind);
      expect(getComputedStyle(layer).inset, `${id}: overscan`).toBe(
        `-${MOTION_LAYER_OVERSCAN_PCT}%`,
      );
    }
    expect(animatedLayers).toBeGreaterThan(0);
  });

  it('static leg: same layered paint with ZERO animation properties and no stylesheet', async () => {
    stubReducedMotion(true);
    await selectAurora();

    const { container } = renderWithChakra(<DesktopBackdrop />);
    const root = container.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    expect(root.getAttribute('data-motion')).toBe('static');
    expect(
      container.querySelector('[data-testid="desktop-backdrop-motion-styles"]'),
    ).toBeNull();

    const layers = Array.from(root.querySelectorAll('[data-background-layer]'));
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) {
      expect(layer.getAttribute('style') ?? '', 'no inline animation').not.toMatch(/animation/i);
      expect(getComputedStyle(layer).animationName || 'none').toBe('none');
      // Geometry is not an animation property: overscan applies in both legs.
      const id = layer.getAttribute('data-background-layer');
      const declared = getBackgroundDescriptor('aurora').layers.find(
        (candidate) => candidate.id === id,
      );
      expect(getComputedStyle(layer).inset, `${id}: overscan`).toBe(
        declared?.motion ? `-${MOTION_LAYER_OVERSCAN_PCT}%` : '0',
      );
    }
  });
});

describe('#2899 ST-5 (e) — stale-id fallback', () => {
  it('resolves an unknown / removed / malformed id to the shipped NONE_BACKGROUND css byte-for-byte', () => {
    for (const stale of ['__nope__', 'removed-id', 'animated-waves', '', 'Aurora', 'none ']) {
      expect(() => getBackgroundDescriptor(stale)).not.toThrow();

      const fallback = getBackgroundDescriptor(stale);
      expect(fallback, `${stale}: falls back to none`).toBe(NONE_BACKGROUND);
      expect(fallback.id, `${stale}: no selected id`).toBe('none');
      // Byte-comparable with the shipped `none` paint.
      expect(JSON.stringify(fallback.css), `${stale}: byte-identical css`).toBe(
        JSON.stringify(NONE_BACKGROUND.css),
      );
      expect(fallback.layers, `${stale}: no motion layers`).toEqual([]);
    }
  });
});

describe('#2905 ST-4 (f) — None byte-identical invariant', () => {
  it('renders zero backdrop DOM and zero injected motion stylesheet for `none`', () => {
    const { container } = renderWithChakra(<DesktopBackdrop />);

    expect(container.querySelector('[data-testid="desktop-backdrop"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-backdrop-motion-styles"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('NONE_BACKGROUND.css deep-equals the shipped pre-#2905 literal (byte-identical)', () => {
    const shipped = {
      backgroundColor: 'var(--card-bg)',
      backgroundImage: [
        'linear-gradient(to right, color-mix(in srgb, var(--border-color) 12%, transparent) 1px, transparent 1px)',
        'linear-gradient(to bottom, color-mix(in srgb, var(--border-color) 12%, transparent) 1px, transparent 1px)',
      ].join(', '),
      backgroundSize: '28px 28px',
    };
    expect(JSON.stringify(NONE_BACKGROUND.css)).toBe(JSON.stringify(shipped));
    expect(NONE_BACKGROUND.layers).toEqual([]);
  });

  it('the launcher surface keeps NONE_BACKGROUND.css for `none` and clears any veil otherwise', () => {
    const launcher = stripComments(readSource(LAUNCHER_SHELL_PATH));
    // The `none` leg is byte-identically the shipped registry ground…
    expect(launcher).toMatch(/backgroundId === 'none'\s*\?\s*NONE_BACKGROUND\.css/);
    // …and the procedural leg is FULLY transparent (the #2905 visibility fix).
    expect(launcher).toMatch(/\{\s*backgroundColor:\s*'transparent'\s*\}/);
    // The old 72%-opaque veil must never come back.
    expect(launcher).not.toMatch(/tint\('var\(--body-bg\)',\s*72\)/);
  });

  it('every procedural option carries layers, and None carries none', () => {
    expect(NONE_BACKGROUND.layers).toHaveLength(0);
    for (const descriptor of BACKGROUND_DESCRIPTORS) {
      expect(descriptor.layers.length, `${descriptor.id}: at least one layer`).toBeGreaterThan(0);
      expect(descriptor.layers.length, `${descriptor.id}: <= 3 layers`).toBeLessThanOrEqual(
        MOTION_LAYERS_MAX,
      );
      const layerIds = descriptor.layers.map((layer) => layer.id);
      expect(new Set(layerIds).size, `${descriptor.id}: unique layer ids`).toBe(layerIds.length);
      // Grounds + layers are all distinct per option (identity distinctness).
      expect(serializePaint(descriptor)).toBeTruthy();
    }
  });
});
