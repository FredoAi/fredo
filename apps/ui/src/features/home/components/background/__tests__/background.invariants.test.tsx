/**
 * #2899 ST-5 — cross-cutting invariant + continuous-state suite.
 *
 * The capstone `WHILE …` properties that must hold for EVERY background the
 * user can select (all six procedural recipes are static — animation is out of
 * scope). Each leg pins an invariant that is easy to break with a later edit:
 *
 *   (a) Non-interactivity (R-4.2): the desktop backdrop layer is
 *       `pointer-events: none`, `aria-hidden`, not focusable, and carries no
 *       handlers — it can never intercept pointer or keyboard input.
 *   (b) Z-order (R-4.1): the backdrop is the FIRST layer of the desktop stack
 *       at z-index 0, strictly below `WindowManager`'s z-index-1 container
 *       (`WindowManager.tsx:25`) — a window always paints above it.
 *   (c) Procedural-only / no hardcoded colors (R-5.1): the background module
 *       source and the emitted paint carry zero hex/rgb/hsl/rgba literals and
 *       zero `data:`/`url(` raster art.
 *   (d) No continuous animation (R-5.2 / R-5.3): zero `requestAnimationFrame`,
 *       `setInterval`, `@keyframes`, `animation:` and `background-attachment`;
 *       reduced-motion, if consulted at all, may only gate the crossfade.
 *   (e) Stale-id fallback (R-3.3): an unknown/removed id resolves to the
 *       shipped `NONE_BACKGROUND` css byte-for-byte and never throws.
 *
 * Plus the default path: `none` renders NO DOM (R-1.3).
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

/** The three files that author/serialize background paint (R-5.1 scope). */
const RENDER_PATHS = [
  `${BACKGROUND_DIR}/backgroundRegistry.ts`,
  `${BACKGROUND_DIR}/DesktopBackdrop.tsx`,
  `${BACKGROUND_DIR}/BackgroundSettings.tsx`,
] as const;

/** The whole background module — the R-5.2/R-5.3 no-motion scope. */
const MODULE_PATHS = [
  ...RENDER_PATHS,
  `${BACKGROUND_DIR}/backgroundStore.ts`,
] as const;

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

/** Drive the real store to a non-`none` selection with a deterministic host seam. */
async function selectAurora(): Promise<void> {
  await selectBackground('aurora');
  expect(getBackgroundId()).toBe('aurora');
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  resetBackgroundStoreForTests();
  resetWindowStoreForTests();
  getMock.mockResolvedValue('none');
  setMock.mockResolvedValue(undefined);
});

describe('#2899 ST-5 (a) — backdrop non-interactivity (R-4.2)', () => {
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

    // No event-handler attributes at all.
    expect(layer.outerHTML).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe('#2899 ST-5 (b) — z-order contract (R-4.1)', () => {
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

describe('#2899 ST-5 (c) — no hardcoded literals / no raster (R-5.1)', () => {
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

  it('the emitted descriptor paint is theme-derived, never literal', () => {
    const emitted = JSON.stringify(
      [NONE_BACKGROUND, ...BACKGROUND_DESCRIPTORS].map((descriptor) => descriptor.css),
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
});

describe('#2899 ST-5 (d) — no continuous animation (R-5.2 / R-5.3)', () => {
  it('ships zero rAF / interval / @keyframes / animation: / background-attachment', () => {
    for (const path of MODULE_PATHS) {
      const code = stripComments(readSource(path));
      expect(code, `${path}: requestAnimationFrame`).not.toMatch(/requestAnimationFrame/);
      expect(code, `${path}: setInterval`).not.toMatch(/setInterval/);
      expect(code, `${path}: @keyframes`).not.toMatch(/@keyframes/);
      expect(code, `${path}: animation property`).not.toMatch(/animation\s*:/);
      expect(code, `${path}: background-attachment`).not.toMatch(/background-attachment/);
    }
  });

  it('reduced-motion, if consulted at all, only gates the selection crossfade (R-5.3)', () => {
    // All six descriptors are static, so the ONLY sanctioned motion is the
    // selection crossfade. A reduced-motion consultation anywhere else would
    // hide an animation behind the media query — reject that.
    for (const path of MODULE_PATHS) {
      const code = stripComments(readSource(path)).toLowerCase();
      if (/prefers-reduced-motion|usereducedmotion|prefersreducedmotion/.test(code)) {
        expect(code, `${path}: reduced-motion may only gate the crossfade`).toMatch(
          /crossfade|transition|opacity/,
        );
      }
    }
  });
});

describe('#2899 ST-5 (e) — stale-id fallback (R-3.3)', () => {
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
    }
  });
});

describe('#2899 ST-5 — default path', () => {
  it('renders NO DOM for the `none` default (R-1.3)', () => {
    const { container } = renderWithChakra(<DesktopBackdrop />);

    expect(container.querySelector('[data-testid="desktop-backdrop"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
