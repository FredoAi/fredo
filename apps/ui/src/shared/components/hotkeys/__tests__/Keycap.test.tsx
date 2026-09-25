/**
 * Spec #2946 ST-3 — `Keycap` render pins (R-1.3, R-3.2).
 *
 * The shared primitive renders a serialized sequence as one `<kbd>` chip per
 * chord step, with the fully-spelled accessible name on the group. No keycap is
 * ever a live region — the single shared announcer carries the speech (R-3.2).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { Keycap } from '../Keycap';

afterEach(cleanup);

function chips(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hotkeys-keycap"]'));
}

describe('Keycap — chips', () => {
  it('renders a single modifier chord as ONE chip with the serialized token', () => {
    const { container } = renderWithChakra(<Keycap sequence="primary+space" platform="win32" />);

    const rendered = chips(container);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toHaveTextContent('Ctrl + Space');
    expect(rendered[0]).toHaveAttribute('data-chord-token', 'primary+space');
  });

  it('renders a leader sequence as one chip per step', () => {
    const { container } = renderWithChakra(<Keycap sequence="@leader g" platform="win32" />);

    const rendered = chips(container);
    expect(rendered).toHaveLength(2);
    expect(rendered.map((chip) => chip.textContent)).toEqual(['Leader', 'G']);
    for (const chip of rendered) {
      expect(chip).toHaveAttribute('data-chord-token', '@leader g');
    }
  });

  it('renders `g g` as two chips carrying the serialized sequence', () => {
    const { container } = renderWithChakra(<Keycap sequence="g g" platform="win32" />);

    const rendered = chips(container);
    expect(rendered).toHaveLength(2);
    expect(rendered.map((chip) => chip.textContent)).toEqual(['G', 'G']);
    expect(rendered.every((chip) => chip.getAttribute('data-chord-token') === 'g g')).toBe(true);
  });

  it('spells named keys in the chip display', () => {
    const { container } = renderWithChakra(<Keycap sequence="ctrl+shift+f10" platform="win32" />);

    const rendered = chips(container);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toHaveTextContent('Ctrl + Shift + F10');
    expect(rendered[0]).toHaveAttribute('data-chord-token', 'ctrl+shift+f10');
  });

  it('renders nothing for an unrepresentable sequence', () => {
    const { container } = renderWithChakra(<Keycap sequence="bogus+nope" />);
    expect(chips(container)).toHaveLength(0);
    expect(container.querySelector('[data-testid="hotkeys-keycap-group"]')).toBeNull();
  });
});

describe('Keycap — accessibility contract', () => {
  it('exposes the fully-spelled chord as the group accessible name', () => {
    const { getByTestId } = renderWithChakra(
      <Keycap sequence="ctrl+shift+g" platform="win32" />,
    );

    const group = getByTestId('hotkeys-keycap-group');
    expect(group).toHaveAttribute('role', 'img');
    expect(group).toHaveAttribute('aria-label', 'Control plus Shift plus G');
  });

  it('spells a multi-step sequence in the accessible name', () => {
    const { getByTestId } = renderWithChakra(<Keycap sequence="g g" platform="win32" />);
    expect(getByTestId('hotkeys-keycap-group')).toHaveAttribute('aria-label', 'G then G');
  });

  it('marks every visual keycap aria-hidden (the announcer carries the speech)', () => {
    const { container } = renderWithChakra(<Keycap sequence="@leader g" platform="win32" />);
    for (const chip of chips(container)) {
      expect(chip).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('never renders a live region (the ONE announcer owns aria-live)', () => {
    const { container } = renderWithChakra(<Keycap sequence="g g" platform="win32" />);
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('uses a semantic <kbd> element for every chip', () => {
    const { container } = renderWithChakra(<Keycap sequence="g g" platform="win32" />);
    expect(container.querySelectorAll('kbd')).toHaveLength(2);
  });
});
