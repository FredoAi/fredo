/**
 * Spec #3118 (P4), ST-2 — reduced motion for the rail + keycap (QA Q5-01 / R-5.1).
 *
 * jsdom has no media engine, so the LIVE OS flip cannot be driven here (a named limitation —
 * QA GAP 7). This suite proves the three decidable legs:
 *   (a) `useNavReducedMotion()` answers from a stubbed `matchMedia` (`true` / `false`) and
 *       FAILS SAFE to `false` when the query is unavailable;
 *   (b) every motion declaration in the ST-2 sources animates opacity/transform only;
 *   (c) every animated element is gated by the `reducedMotion` branch — the rail's list
 *       animation is `none` under `reducedMotion` (prop OR hook) and the keycap has no motion.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { NAV_RAIL_LIST_TESTID } from '@/shared/navigation/ui/constants';
import { CommandRail } from '@/shared/navigation/ui/CommandRail';
import { buildCommandRailModel } from '@/shared/navigation/ui/models';
import { useNavReducedMotion } from '@/shared/navigation/ui/useReducedMotion';
import { fixtureSnapshot, navTestSurface } from './fixtures';

const SOURCE_PATH = 'src/shared/navigation/ui/CommandRail.tsx';
const KEYCAP_SOURCE_PATH = 'src/shared/navigation/ui/Keycap.tsx';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** D5 — a dependency-free `matchMedia` stub (the shipped precedent). */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function HookProbe(): React.ReactElement {
  const reduced = useNavReducedMotion();
  return <span data-testid="nav-reduced-probe">{reduced ? 'true' : 'false'}</span>;
}

function railModel() {
  const surface = navTestSurface();
  return buildCommandRailModel(surface, fixtureSnapshot([surface.tree.root]));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useNavReducedMotion — the hook (Q5-01a)', () => {
  it('returns true while the media query matches', () => {
    stubMatchMedia(true);
    renderWithChakra(<HookProbe />);
    expect(screen.getByTestId('nav-reduced-probe').textContent).toBe('true');
  });

  it('returns false when the media query does not match', () => {
    stubMatchMedia(false);
    renderWithChakra(<HookProbe />);
    expect(screen.getByTestId('nav-reduced-probe').textContent).toBe('false');
  });

  it('fails safe to false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    renderWithChakra(<HookProbe />);
    expect(screen.getByTestId('nav-reduced-probe').textContent).toBe('false');
  });
});

describe('CommandRail — the animated list is gated by the reducedMotion branch (Q5-01c)', () => {
  it('animates the verb list when motion is allowed', () => {
    renderWithChakra(
      <CommandRail
        model={railModel()}
        reducedMotion={false}
        onRunVerb={vi.fn()}
        onOpenMap={vi.fn()}
      />,
    );
    expect(screen.getByTestId(NAV_RAIL_LIST_TESTID).style.animation).toBe(
      'navigation-rail-in 150ms ease',
    );
  });

  it('disables the list animation when the reducedMotion prop is set', () => {
    renderWithChakra(
      <CommandRail
        model={railModel()}
        reducedMotion
        onRunVerb={vi.fn()}
        onOpenMap={vi.fn()}
      />,
    );
    const list = screen.getByTestId(NAV_RAIL_LIST_TESTID);
    expect(list.style.animation).toBe('none');
    expect(list.style.transition).toBe('none');
  });

  it('follows the HOOK when no prop override is supplied', () => {
    stubMatchMedia(true);
    const first = renderWithChakra(
      <CommandRail model={railModel()} onRunVerb={vi.fn()} onOpenMap={vi.fn()} />,
    );
    expect(screen.getByTestId(NAV_RAIL_LIST_TESTID).style.animation).toBe('none');
    first.unmount();

    stubMatchMedia(false);
    renderWithChakra(
      <CommandRail model={railModel()} onRunVerb={vi.fn()} onOpenMap={vi.fn()} />,
    );
    expect(screen.getByTestId(NAV_RAIL_LIST_TESTID).style.animation).toBe(
      'navigation-rail-in 150ms ease',
    );
  });
});

describe('ST-2 source: motion declarations and gating (Q5-01b/c)', () => {
  const railSource = stripComments(readSource(SOURCE_PATH));
  const keycapSource = stripComments(readSource(KEYCAP_SOURCE_PATH));

  it('animates opacity/transform only — no layout/colour property in a motion declaration', () => {
    const motionLines = railSource
      .split('\n')
      .filter((line) => /animation|transition/.test(line));
    expect(motionLines.length).toBeGreaterThan(0); // non-vacuity
    for (const line of motionLines) {
      expect(line).not.toMatch(
        /\b(?:width|height|left|top|right|bottom|margin|padding|filter|box-shadow)\b/,
      );
    }

    const keyframeStart = railSource.indexOf('@keyframes navigation-rail-in');
    expect(keyframeStart).toBeGreaterThanOrEqual(0);
    const keyframeBlock = railSource.slice(keyframeStart, railSource.indexOf('} as const', keyframeStart));
    expect(keyframeBlock).toContain('opacity');
    expect(keyframeBlock).toContain('transform');
    expect(keyframeBlock).not.toMatch(
      /\b(?:width|height|left|right|bottom|margin|padding|filter|box-shadow)\b/,
    );
  });

  it('gates the animated element on the reducedMotion value', () => {
    expect(railSource).toMatch(/reducedMotion/);
    expect(railSource).toMatch(/motionReduced\s*\?\s*RAIL_NO_MOTION_STYLE\s*:\s*RAIL_MOTION_STYLE/);
  });

  it('the keycap renders no motion of its own', () => {
    expect(keycapSource).not.toMatch(/\banimation\b|\btransition\b/);
  });
});
