/**
 * DesktopBackdrop tests (Spec #2899 ST-3).
 *
 * Pins the two load-bearing properties of the shell layer:
 *   - `none` renders NO DOM at all (the default/no-opt-in path is unchanged);
 *   - a procedural id renders the registry descriptor's paint on a full-bleed,
 *     inert layer (`pointer-events: none`, `aria-hidden`, z=0, not focusable).
 * Also pins that the shell mount effect requests store hydration exactly once.
 *
 * The store module is mocked so the test drives the id directly and stays
 * host-agnostic (no settingsService / Tauri dependency).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import { DesktopBackdrop } from '../DesktopBackdrop';
import { getBackgroundDescriptor } from '../backgroundRegistry';

vi.mock('../backgroundStore', () => ({
  useBackgroundId: vi.fn(),
  hydrateBackground: vi.fn(() => Promise.resolve()),
}));

import { hydrateBackground, useBackgroundId } from '../backgroundStore';

const useBackgroundIdMock = vi.mocked(useBackgroundId);
const hydrateBackgroundMock = vi.mocked(hydrateBackground);

describe('#2899 ST-3 — DesktopBackdrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders zero DOM for the `none` default', () => {
    useBackgroundIdMock.mockReturnValue('none');
    const { container } = renderWithChakra(<DesktopBackdrop />);

    expect(container.querySelector('[data-testid="desktop-backdrop"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders an inert, full-bleed z=0 layer for a procedural id', () => {
    useBackgroundIdMock.mockReturnValue('aurora');
    const { container } = renderWithChakra(<DesktopBackdrop />);

    const layer = container.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    expect(layer).not.toBeNull();

    // AT + input contract (R-4.2): hidden from AT, pointer-transparent, and not
    // reachable through the tab order.
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.hasAttribute('tabindex')).toBe(false);

    const style = getComputedStyle(layer);
    expect(style.pointerEvents).toBe('none');
    expect(style.position).toBe('absolute');
    expect(style.zIndex).toBe('0');
  });

  it('paints the selected descriptor css (registry is the single source)', () => {
    useBackgroundIdMock.mockReturnValue('aurora');
    const { container } = renderWithChakra(<DesktopBackdrop />);

    const layer = container.querySelector('[data-testid="desktop-backdrop"]') as HTMLElement;
    const expected = getBackgroundDescriptor('aurora').css;
    const style = getComputedStyle(layer);

    // The layer's paint is the descriptor's paint — not a re-derived literalless copy.
    expect(style.backgroundImage).toContain(String(expected.backgroundImage).split(',')[0].trim());
  });

  it('requests persisted hydration once on shell mount (idempotent store)', () => {
    useBackgroundIdMock.mockReturnValue('none');
    renderWithChakra(<DesktopBackdrop />);

    expect(hydrateBackgroundMock).toHaveBeenCalledTimes(1);
  });
});
