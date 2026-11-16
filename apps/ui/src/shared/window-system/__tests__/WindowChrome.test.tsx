/**
 * WindowChrome header-composition tests — Spec #2924 ST-3 (REQ-4, REQ-5).
 *
 * Pins the post-change header contract: the header renders exactly ONE feature
 * icon tile + ONE title + ONE control cluster, with ZERO Fredo monogram /
 * brand-cap nodes. The `F` cap box was deleted (the brand manual §02 LOGO
 * defines PRIMARY / WORDMARK / LOCKUP only — there is no monogram), so the icon
 * tile is the header's FIRST child and the 24px the cap consumed is returned to
 * the title.
 *
 * The a11y surface is frozen unchanged: the three control labels
 * (`Minimize <title>` / `Maximize|Restore <title>` / `Close <title>`), the
 * maximize control's `aria-expanded === isMaximized`, the decorative tile's
 * `aria-hidden`, and the min → max/restore → close tab order.
 *
 * Scope note: the token-native source scan (REQ-9) is owned by ST-5's
 * `WindowFrame.test.tsx`; this file asserts the rendered DOM contract only.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowChrome, type WindowChromeProps } from '../WindowChrome';

const TITLE = 'Mission Monitor';

/** A stand-in feature glyph — carries a testid so the tile can be located. */
function featureIcon() {
  return <svg data-testid="feature-icon" width="16" height="16" aria-hidden="true" />;
}

function chromeProps(overrides: Partial<WindowChromeProps> = {}): WindowChromeProps {
  return {
    title: TITLE,
    icon: featureIcon(),
    focused: true,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    isMaximized: false,
    onClose: () => {},
    onMinimize: () => {},
    onMaximize: () => {},
    onHeaderPointerDown: () => {},
    onHeaderDoubleClick: () => {},
    ...overrides,
  };
}

function renderChrome(overrides: Partial<WindowChromeProps> = {}) {
  const { container } = renderWithChakra(<WindowChrome {...chromeProps(overrides)} />);
  const header = container.querySelector<HTMLElement>('.fredo-window__header');
  if (!header) throw new Error('window header did not render');
  return { container, header };
}

/**
 * Leaf elements whose own text is exactly `needle` — the exact shape of the
 * removed `F` brand cap (a childless box carrying the monogram character).
 * Deliberately structural: a title that merely CONTAINS the letter "F" is not
 * a monogram node.
 */
function monogramNodes(root: HTMLElement, needle = 'F'): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
    (el) => el.children.length === 0 && el.textContent?.trim() === needle,
  );
}

afterEach(() => cleanup());

describe('WindowChrome header composition (Spec #2924 ST-3 — REQ-4)', () => {
  it('renders exactly one icon tile + one title + one control cluster', () => {
    const { header } = renderChrome();
    const children = Array.from(header.children);
    expect(children).toHaveLength(3);

    // [0] icon tile, [1] title, [2] control cluster.
    expect(children[0]).toContainElement(screen.getByTestId('feature-icon'));
    expect(children[1].textContent).toBe(TITLE);
    expect(children[2].querySelectorAll('button')).toHaveLength(3);
  });

  it('makes the icon tile the header’s FIRST child — no leading brand cap', () => {
    const { header } = renderChrome();
    const tile = header.firstElementChild as HTMLElement;
    expect(tile).toContainElement(screen.getByTestId('feature-icon'));
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    // Exactly one decorative glyph box in the whole header (the tile).
    expect(header.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(1);
  });

  it('renders ZERO monogram / brand-cap nodes (no leaf “F” box)', () => {
    const { header } = renderChrome();
    expect(monogramNodes(header)).toHaveLength(0);
  });

  it('does not mistake a title containing “F” for a monogram node', () => {
    const { header } = renderChrome({ title: 'Flags For Fredo' });
    expect(monogramNodes(header)).toHaveLength(0);
    // The title is still the header's sole text identity.
    expect(header.children[1].textContent).toBe('Flags For Fredo');
  });

  it('keeps the tile (never collapses it, never substitutes a monogram) when the feature has no icon', () => {
    const { header } = renderChrome({ icon: undefined });
    expect(header.children).toHaveLength(3);
    const tile = header.firstElementChild as HTMLElement;
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(monogramNodes(header)).toHaveLength(0);
  });

  it('renders exactly one header element (no duplicate chrome)', () => {
    const { container } = renderChrome();
    expect(container.querySelectorAll('.fredo-window__header')).toHaveLength(1);
  });
});

describe('WindowChrome controls + a11y (Spec #2924 ST-3 — REQ-5)', () => {
  it('labels all three controls and exposes aria-expanded=false while floating', () => {
    renderChrome({ isMaximized: false });

    const minimize = screen.getByRole('button', { name: `Minimize ${TITLE}` });
    const maximize = screen.getByRole('button', { name: `Maximize ${TITLE}` });
    const close = screen.getByRole('button', { name: `Close ${TITLE}` });

    expect(minimize).toBeEnabled();
    expect(maximize).toBeEnabled();
    expect(close).toBeEnabled();
    expect(maximize).toHaveAttribute('aria-expanded', 'false');
  });

  it('flips the maximize control to Restore + aria-expanded=true when maximized', () => {
    renderChrome({ isMaximized: true });

    const restore = screen.getByRole('button', { name: `Restore ${TITLE}` });
    expect(restore).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: `Maximize ${TITLE}` })).toBeNull();
  });

  it('keeps the min → max/restore → close order inside a single control cluster', () => {
    const { header } = renderChrome();
    const cluster = header.children[2];
    const labels = Array.from(cluster.querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label'),
    );

    expect(labels).toEqual([`Minimize ${TITLE}`, `Maximize ${TITLE}`, `Close ${TITLE}`]);
  });

  it('keeps every control glyph aria-hidden (the icons are decorative)', () => {
    const { header } = renderChrome();
    const cluster = header.children[2];

    for (const button of Array.from(cluster.querySelectorAll('button'))) {
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('omits only the unavailable control when a capability is false', () => {
    renderChrome({ canMaximize: false });

    expect(screen.queryByRole('button', { name: `Maximize ${TITLE}` })).toBeNull();
    expect(screen.getByRole('button', { name: `Minimize ${TITLE}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Close ${TITLE}` })).toBeInTheDocument();
  });
});
