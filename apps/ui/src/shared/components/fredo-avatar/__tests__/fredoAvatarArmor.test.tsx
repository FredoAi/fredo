import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { FredoAvatar } from '../FredoAvatar';
import { setDoomVisualEngaged } from '../../../doom-mode';

/**
 * Spec #2971 ST-5 — the orthogonal Doom armor overlay.
 *
 * The armor is a fourth `<path>`-only layer (`#fredo-armor`) drawn AFTER the
 * per-state expression `<g>`, plus `data-doom-armor="true"` on the `<svg>`.
 * It must NEVER add a member to the frozen 12-state vocabulary and must never
 * add a `<rect>` (the shipped `svg rect === 58` pin). Both the attribute and
 * the layer MUST be absent when Doom Mode is disengaged. (ST-6 owns the bulk of
 * the suite; this is the focused ST-5 pin.)
 */

afterEach(() => {
  cleanup();
  // Module-scoped store — reset so a test never leaks engagement into another.
  setDoomVisualEngaged(false);
});

const baseRectCount = (svg: Element): number => svg.querySelectorAll('rect').length;

describe('#2971 ST-5 armor overlay — engaged', () => {
  it('renders data-doom-armor + the #fredo-armor layer while engaged (idle state)', () => {
    setDoomVisualEngaged(true);
    const { container } = render(<FredoAvatar size="sm" state="idle" />);

    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('data-doom-armor')).toBe('true');

    const armor = svg.querySelector('#fredo-armor');
    expect(armor).not.toBeNull();
    expect(armor!.tagName.toLowerCase()).toBe('g');
    expect(armor!.getAttribute('data-layer')).toBe('armor');
    expect(armor!.getAttribute('aria-hidden')).toBe('true');
    expect(armor!.getAttribute('pointer-events')).toBe('none');
    expect(armor!.getAttribute('class')).toBe('fredo-armor');
  });

  it('keeps the frozen 58-rect contract with armor ON (paths only, zero rects)', () => {
    setDoomVisualEngaged(true);
    const { container } = render(<FredoAvatar size="sm" state="idle" />);
    const svg = container.querySelector('svg')!;

    expect(baseRectCount(svg)).toBe(58);
    expect(svg.querySelectorAll('#fredo-armor rect')).toHaveLength(0);
    // The armor is made of paths — 13 of them per the UI/UX geometry.
    expect(svg.querySelectorAll('#fredo-armor path')).toHaveLength(13);
  });

  it('draws the armor AFTER the per-state expression overlay (composes, never occludes the vocabulary)', () => {
    setDoomVisualEngaged(true);
    const { container } = render(<FredoAvatar size="sm" state="error" />);
    const svg = container.querySelector('svg')!;

    const expression = svg.querySelector('#fredo-expression');
    const armor = svg.querySelector('#fredo-armor');
    expect(expression).not.toBeNull();
    expect(armor).not.toBeNull();
    expect(armor!.getAttribute('data-state')).toBeNull();
    // `armor` must FOLLOW `expression` in document order.
    expect(
      expression!.compareDocumentPosition(armor!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('uses only existing token-contract vars — zero colour literals', () => {
    setDoomVisualEngaged(true);
    const { container } = render(<FredoAvatar size="sm" state="idle" />);
    const svg = container.querySelector('svg')!;

    for (const path of Array.from(svg.querySelectorAll('#fredo-armor path'))) {
      const fill = path.getAttribute('fill') ?? '';
      expect(fill.startsWith('var(--')).toBe(true);
    }
  });
});

describe('#2971 ST-5 armor overlay — disengaged', () => {
  it('omits data-doom-armor and #fredo-armor when Doom Mode is off', () => {
    setDoomVisualEngaged(false);
    const { container } = render(<FredoAvatar size="sm" state="idle" />);
    const svg = container.querySelector('svg')!;

    expect(svg.hasAttribute('data-doom-armor')).toBe(false);
    expect(svg.querySelector('#fredo-armor')).toBeNull();
    expect(baseRectCount(svg)).toBe(58);
  });

  it('returns to the unarmored DOM after engagement is turned off', () => {
    setDoomVisualEngaged(true);
    const first = render(<FredoAvatar size="sm" state="idle" />);
    expect(first.container.querySelector('#fredo-armor')).not.toBeNull();
    cleanup();

    setDoomVisualEngaged(false);
    const second = render(<FredoAvatar size="sm" state="idle" />);
    const svg = second.container.querySelector('svg')!;
    expect(svg.hasAttribute('data-doom-armor')).toBe(false);
    expect(svg.querySelector('#fredo-armor')).toBeNull();
  });
});
