/**
 * #2899 ST-3 / #2905 ST-2/ST-3/ST-6 — DesktopBackdrop tests.
 *
 * Pins the shell layer:
 *   - `none` renders NO DOM at all (the default/no-opt-in path is unchanged) and
 *     injects no motion stylesheet;
 *   - a procedural id renders the descriptor's GROUND + one
 *     `[data-background-layer]` child per layer (≤3) on a full-bleed, inert
 *     layer (`pointer-events: none`, `aria-hidden`, z=0, not focusable);
 *   - the animated leg stamps `data-motion="animated"` + injects the ONE motion
 *     stylesheet and per-layer inline animation;
 *   - the static leg (OS reduced motion) renders the SAME layered paint with
 *     `data-motion="static"`, no stylesheet, and zero animation properties.
 *
 * The store module is mocked so the test drives the id directly; the OS
 * reduced-motion preference is stubbed on `matchMedia` (host-agnostic seam).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import { DesktopBackdrop } from '../DesktopBackdrop';
import { getBackgroundDescriptor } from '../backgroundRegistry';
import { MOTION_LAYERS_MAX } from '../backgroundMotion';

vi.mock('../backgroundStore', () => ({
  useBackgroundId: vi.fn(),
  hydrateBackground: vi.fn(() => Promise.resolve()),
}));

import { hydrateBackground, useBackgroundId } from '../backgroundStore';

const useBackgroundIdMock = vi.mocked(useBackgroundId);
const hydrateBackgroundMock = vi.mocked(hydrateBackground);

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

describe('#2899 ST-3 / #2905 ST-6 — DesktopBackdrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders zero DOM for the `none` default', () => {
    useBackgroundIdMock.mockReturnValue('none');
    const { container } = renderWithChakra(<DesktopBackdrop />);

    expect(container.querySelector('[data-testid="desktop-backdrop"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-backdrop-motion-styles"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders an inert, full-bleed z=0 layer for a procedural id', () => {
    useBackgroundIdMock.mockReturnValue('aurora');
    const { container } = renderWithChakra(<DesktopBackdrop />);

    const layer = container.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    expect(layer).not.toBeNull();

    // AT + input contract: hidden from AT, pointer-transparent, and not
    // reachable through the tab order.
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.hasAttribute('tabindex')).toBe(false);

    const style = getComputedStyle(layer);
    expect(style.pointerEvents).toBe('none');
    expect(style.position).toBe('absolute');
    expect(style.zIndex).toBe('0');
  });

  it('paints the selected descriptor layers (registry is the single source)', () => {
    useBackgroundIdMock.mockReturnValue('aurora');
    const { container } = renderWithChakra(<DesktopBackdrop />);

    const descriptor = getBackgroundDescriptor('aurora');
    const layers = Array.from(
      container.querySelectorAll('[data-testid="desktop-backdrop"] [data-background-layer]'),
    );
    expect(layers.length).toBe(descriptor.layers.length);
    expect(layers.length).toBeLessThanOrEqual(MOTION_LAYERS_MAX);

    for (const declared of descriptor.layers) {
      const painted = container.querySelector(
        `[data-background-layer="${declared.id}"]`,
      ) as HTMLElement;
      expect(painted, `${declared.id}: rendered`).not.toBeNull();
      if (declared.css.backgroundImage) {
        const expected = String(declared.css.backgroundImage).split(',')[0].trim();
        expect(getComputedStyle(painted).backgroundImage).toContain(expected);
      }
    }
  });

  it('requests persisted hydration once on shell mount (idempotent store)', () => {
    useBackgroundIdMock.mockReturnValue('none');
    renderWithChakra(<DesktopBackdrop />);

    expect(hydrateBackgroundMock).toHaveBeenCalledTimes(1);
  });

  it('animated leg stamps data-motion + injects the ONE motion stylesheet with bounded inline animation', () => {
    stubReducedMotion(false);
    useBackgroundIdMock.mockReturnValue('mesh');
    const { container } = renderWithChakra(<DesktopBackdrop />);

    const root = container.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    expect(root.getAttribute('data-background-id')).toBe('mesh');
    expect(root.getAttribute('data-motion')).toBe('animated');
    expect(
      container.querySelector('[data-testid="desktop-backdrop-motion-styles"]'),
    ).not.toBeNull();

    const layers = Array.from(root.querySelectorAll('[data-background-layer]'));
    expect(layers.length).toBe(getBackgroundDescriptor('mesh').layers.length);
    expect(layers.length).toBeLessThanOrEqual(MOTION_LAYERS_MAX);
    for (const layer of layers) {
      expect(layer.getAttribute('style') ?? '').toMatch(/animation-name\s*:/);
    }
  });

  it('static leg keeps the layered paint but removes all animation + the stylesheet', () => {
    stubReducedMotion(true);
    useBackgroundIdMock.mockReturnValue('mesh');
    const { container } = renderWithChakra(<DesktopBackdrop />);

    const root = container.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    expect(root.getAttribute('data-motion')).toBe('static');
    expect(
      container.querySelector('[data-testid="desktop-backdrop-motion-styles"]'),
    ).toBeNull();

    const layers = Array.from(root.querySelectorAll('[data-background-layer]'));
    expect(layers.length).toBe(getBackgroundDescriptor('mesh').layers.length);
    for (const layer of layers) {
      expect(layer.getAttribute('style') ?? '').not.toMatch(/animation/i);
    }
  });
});
