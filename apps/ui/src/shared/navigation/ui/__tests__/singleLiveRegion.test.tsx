/**
 * Spec #3118 (P4), ST-5 — R-4.6: exactly ONE polite live region in the migration shape.
 *
 * The fixture is the bound migration tree: the shipped `<HotkeyAnnouncer />` (the
 * `hotkeys-announcer` `role="status" aria-live="polite"` region) plus
 * `<NavigationAnnouncer channel="legacy" />` plus the three navigation surfaces. The nav
 * announcer renders nothing and FORWARDS every message to the legacy region, so the document
 * keeps exactly one live region — and the forwarded text is readable THERE (forwarding, not
 * mere absence of a second node).
 *
 * Non-vacuity control: the identical tree with the DEFAULT channel yields exactly 2 —
 * otherwise a counter that always returns 1 would pass. Two `NavigationAnnouncer` mounts
 * yield 2 (documented, never silently deduped).
 *
 * The surface components are owned by sibling slices (ST-2…ST-4, same wave). They are mounted
 * through `import.meta.glob`, so the live tree includes every surface that has landed and the
 * count assertion tightens automatically as they do — the fixture never has to be edited.
 * The Q4-06 count/property assertions do not depend on the surface count (the non-vacuity
 * control pins the counter at 2 independently).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  HotkeyAnnouncer,
  resetHotkeyAnnouncer,
} from '@/shared/hotkeys/announcer';
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
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
});

afterEach(() => {
  cleanup();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
});

describe('R-4.6 — one polite live region while the legacy and new layers coexist', () => {
  it('Q4-06 legacy announcer + all surfaces yields ONE region and forwards into it', () => {
    const { getByTestId } = renderWithChakra(
      <>
        <HotkeyAnnouncer />
        <NavigationAnnouncer channel="legacy" />
        <NavigationSurfaces />
      </>,
    );

    expect(countActiveLiveRegions()).toBe(1);

    const region = getByTestId('hotkeys-announcer');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('role', 'status');

    act(() => announceNavigation('Undid Rectangle'));
    expect(region).toHaveTextContent('Undid Rectangle');
  });

  it('Q4-06 non-vacuity control: the DEFAULT channel plus the legacy region yields 2', () => {
    renderWithChakra(
      <>
        <HotkeyAnnouncer />
        <NavigationAnnouncer />
        <NavigationSurfaces />
      </>,
    );

    expect(countActiveLiveRegions()).toBe(2);
  });

  it('channel="legacy" with the legacy region alone yields 1', () => {
    renderWithChakra(
      <>
        <HotkeyAnnouncer />
        <NavigationAnnouncer channel="legacy" />
      </>,
    );

    expect(countActiveLiveRegions()).toBe(1);
  });

  it('the default channel with no HotkeyAnnouncer yields 1', () => {
    renderWithChakra(
      <>
        <NavigationAnnouncer />
        <NavigationSurfaces />
      </>,
    );

    expect(countActiveLiveRegions()).toBe(1);
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
