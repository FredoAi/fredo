/**
 * Spec #3118 (P4), ST-2 — `NavKeycap` (QA Q7-02).
 *
 * The keycap is the P4 declaration's key display: bindable tokens render through the shipped
 * `displayStroke` / `accessibleSequence` helpers, glyphs render from
 * `NAV_GLYPH_ACCESSIBLE_NAME`, and the ROOT carries the only accessible name (chips are
 * `aria-hidden`). `keys: []` with no glyph renders nothing — never an empty-named
 * `role="img"`.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  NAV_KEYCAP_GROUP_TESTID,
  NAV_KEYCAP_TESTID,
} from '@/shared/navigation/ui/constants';
import { NavKeycap } from '@/shared/navigation/ui/Keycap';

afterEach(() => {
  cleanup();
});

describe('NavKeycap — accessible name + hidden chips (Q7-02)', () => {
  it('renders a single stroke as a named img with one hidden chip', () => {
    renderWithChakra(<NavKeycap keys={['c']} />);

    const group = screen.getByTestId(NAV_KEYCAP_GROUP_TESTID);
    expect(group).toHaveAttribute('role', 'img');
    expect(group).toHaveAttribute('data-nav-keycap', 'true');
    expect(group).toHaveAttribute('aria-label', 'C');

    const chips = screen.getAllByTestId(NAV_KEYCAP_TESTID);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAttribute('aria-hidden', 'true');
    expect(chips[0].textContent).toBe('C');
  });

  it('renders a sequence binding as one chip per stroke with a "then" name', () => {
    renderWithChakra(<NavKeycap keys={['w n']} />);

    const group = screen.getByTestId(NAV_KEYCAP_GROUP_TESTID);
    expect(group).toHaveAttribute('aria-label', 'W then N');
    expect(screen.getAllByTestId(NAV_KEYCAP_TESTID).map((chip) => chip.textContent)).toEqual([
      'W',
      'N',
    ]);
  });

  it('names the display glyphs from NAV_GLYPH_ACCESSIBLE_NAME', () => {
    const { unmount } = renderWithChakra(<NavKeycap keys={[]} glyph="?" />);
    expect(screen.getByTestId(NAV_KEYCAP_GROUP_TESTID)).toHaveAttribute(
      'aria-label',
      'Question mark',
    );
    expect(screen.getByTestId(NAV_KEYCAP_TESTID).textContent).toBe('?');
    unmount();

    renderWithChakra(<NavKeycap keys={[]} glyph="/" />);
    expect(screen.getByTestId(NAV_KEYCAP_GROUP_TESTID)).toHaveAttribute('aria-label', 'Slash');
    expect(screen.getByTestId(NAV_KEYCAP_TESTID).textContent).toBe('/');
  });

  it('renders null for an empty binding (no empty-named role="img")', () => {
    renderWithChakra(<NavKeycap keys={[]} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByTestId(NAV_KEYCAP_GROUP_TESTID)).toBeNull();
  });

  it('routes modifier strokes through platform-resolved display + speech', () => {
    const { unmount } = renderWithChakra(<NavKeycap keys={['primary+g']} platform="win32" />);
    expect(screen.getByTestId(NAV_KEYCAP_GROUP_TESTID)).toHaveAttribute(
      'aria-label',
      'Control plus G',
    );
    // A modifier chord is ONE stroke → ONE chip (the shipped `displayStroke` label).
    expect(screen.getAllByTestId(NAV_KEYCAP_TESTID).map((chip) => chip.textContent)).toEqual([
      'Ctrl + G',
    ]);
    unmount();

    renderWithChakra(<NavKeycap keys={['primary+g']} platform="darwin" />);
    expect(screen.getByTestId(NAV_KEYCAP_GROUP_TESTID)).toHaveAttribute(
      'aria-label',
      'Command plus G',
    );
    expect(screen.getAllByTestId(NAV_KEYCAP_TESTID).map((chip) => chip.textContent)).toEqual([
      'Cmd + G',
    ]);
  });

  it('displays only the FIRST binding when a verb is bound to several strokes', () => {
    renderWithChakra(<NavKeycap keys={['c', 'x']} />);
    // The first binding is the visible hint (matching `CommandRailRow.keyHint`).
    expect(screen.getByTestId(NAV_KEYCAP_GROUP_TESTID)).toHaveAttribute('aria-label', 'C');
    expect(screen.getAllByTestId(NAV_KEYCAP_TESTID)).toHaveLength(1);
  });
});
