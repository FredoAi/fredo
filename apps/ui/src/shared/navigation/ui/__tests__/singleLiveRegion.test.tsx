/**
 * Spec #3118 (P4), ST-5 — R-4.6: exactly ONE navigation polite live region;
 * Spec #3122 (P8), ST-2 — the legacy forwarding channel is retired.
 *
 * The fixture is the shipped navigation tree: the ONE `<NavigationAnnouncer />` plus the
 * three navigation surfaces. The invariant is scoped to the navigation announcement CHANNEL
 * (U-1): exactly one navigation region, zero legacy `hotkeys-announcer`. `countActiveLiveRegions`
 * stays a FIXTURE-scoped counter over the navigation tree (other shipped surfaces own their own
 * polite regions and are never in this fixture).
 *
 * Non-vacuity control: two `NavigationAnnouncer` mounts yield 2 (documented defect signal,
 * never silently deduped).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  NavigationAnnouncer,
  announceNavigation,
  countActiveLiveRegions,
  resetNavigationAnnouncer,
} from '../announce';
import { buildActivityTrailModel, buildCommandRailModel, buildNavigationMapModel } from '../models';
import { FIXTURE_PLACES, fixtureSnapshot, navTestSurface, seedEntries } from './fixtures';

/* ───────────────────── the navigation surfaces (sibling slices) ───────────────────── */

type SurfaceComponent = React.ComponentType<Record<string, unknown>>;

const surfaceModules = import.meta.glob(
  '../{CommandRail,NavigationMap,ActivityTrail}.tsx',
  { eager: true },
) as Record<string, Record<string, unknown>>;

function surfaceComponent(fileName: string, exportName: string): SurfaceComponent | null {
  const loaded = surfaceModules[`../${fileName}`];
  const candidate = loaded?.[exportName];
  return typeof candidate === 'function' ? (candidate as SurfaceComponent) : null;
}

const CommandRail = surfaceComponent('CommandRail.tsx', 'CommandRail');
const NavigationMap = surfaceComponent('NavigationMap.tsx', 'NavigationMap');
const ActivityTrail = surfaceComponent('ActivityTrail.tsx', 'ActivityTrail');

/** The three surfaces rendered from the SAME controlled declaration (D1). */
function NavigationSurfaces() {
  const surface = navTestSurface();
  const context = fixtureSnapshot([FIXTURE_PLACES.canvas, FIXTURE_PLACES.create]);
  const railModel = buildCommandRailModel(surface, context);
  const mapModel = buildNavigationMapModel(surface, context);
  const trailModel = buildActivityTrailModel(surface, seedEntries(2));
  const noop = () => undefined;

  return (
    <>
      {CommandRail === null ? null : (
        <CommandRail model={railModel} onRunVerb={noop} onOpenMap={noop} />
      )}
      {NavigationMap === null ? null : (
        <NavigationMap model={mapModel} open onClose={noop} onRunVerb={noop} />
      )}
      {ActivityTrail === null ? null : (
        <ActivityTrail model={trailModel} onUndo={noop} />
      )}
    </>
  );
}

beforeEach(() => {
  resetNavigationAnnouncer();
});

afterEach(() => {
  cleanup();
  resetNavigationAnnouncer();
});

describe('R-4.6 — ONE navigation announcer, zero legacy announcer', () => {
  it('the announcer + all navigation surfaces yields ONE navigation region', () => {
    const { getByTestId, queryByTestId } = renderWithChakra(
      <>
        <NavigationAnnouncer />
        <NavigationSurfaces />
      </>,
    );

    expect(countActiveLiveRegions()).toBe(1);
    expect(queryByTestId('hotkeys-announcer')).toBeNull();

    const region = getByTestId('navigation-announcer');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('role', 'status');

    act(() => announceNavigation('Undid Rectangle'));
    expect(region).toHaveTextContent('Undid Rectangle');
  });

  it('two NavigationAnnouncer mounts yield 2 (never silently deduped)', () => {
    renderWithChakra(
      <>
        <NavigationAnnouncer />
        <NavigationAnnouncer />
      </>,
    );

    expect(countActiveLiveRegions()).toBe(2);
  });
});
