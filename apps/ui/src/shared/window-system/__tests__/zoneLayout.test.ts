/**
 * Zone layout pure-math tests (Spec #2980 ST-1).
 *
 * Pins the shared, DOM-free rules every later capsule consumes: template
 * builders, `splitZone`, `resolveZoneRect` (fraction × workspace, gap inset,
 * MIN clamp), `zoneAtPoint` (hover + gap → null), `matchesZoneChord`
 * (platform-neutral primary, exact modifier set) and `clampZoneGap`.
 */

import { describe, it, expect } from 'vitest';

import {
  buildTemplateZones,
  clampZoneGap,
  matchesZoneChord,
  resolveZoneRect,
  splitZone,
  zoneAtPoint,
  DEFAULT_ZONE_GAP,
  DEFAULT_ZONE_CHORD,
  MAX_ZONE_GAP,
  MIN_ZONE_GAP,
  ZONE_ACTIVATION_CHORDS,
  type Zone,
} from '../zoneLayout';

const WS = { width: 1000, height: 800 };

/** A full-workspace zone helper. */
function fullZone(id: string): Zone {
  return { id, rect: { x: 0, y: 0, width: 1, height: 1 } };
}

describe('zoneLayout — constants', () => {
  it('exposes the documented defaults and chord vocabulary', () => {
    expect(DEFAULT_ZONE_GAP).toBe(8);
    expect(DEFAULT_ZONE_CHORD).toBe('alt');
    expect(MIN_ZONE_GAP).toBe(0);
    expect(MAX_ZONE_GAP).toBe(32);
    expect(ZONE_ACTIVATION_CHORDS).toEqual([
      'alt',
      'primary',
      'primary+alt',
      'primary+shift',
      'alt+shift',
    ]);
  });
});

describe('zoneLayout — clampZoneGap', () => {
  it('clamps to the accepted range and rejects non-finite input to the default', () => {
    expect(clampZoneGap(-5)).toBe(0);
    expect(clampZoneGap(0)).toBe(0);
    expect(clampZoneGap(16)).toBe(16);
    expect(clampZoneGap(32)).toBe(32);
    expect(clampZoneGap(100)).toBe(32);
    expect(clampZoneGap(Number.NaN)).toBe(DEFAULT_ZONE_GAP);
    expect(clampZoneGap(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZONE_GAP);
  });
});

describe('zoneLayout — buildTemplateZones', () => {
  it('builds a default 2-column split', () => {
    const zones = buildTemplateZones('columns');
    expect(zones.map((zone) => zone.id)).toEqual(['zone-0', 'zone-1']);
    expect(zones[0].rect).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
    expect(zones[1].rect).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  });

  it('builds N columns with exact fractions', () => {
    const zones = buildTemplateZones('columns', { columns: 3 });
    expect(zones).toHaveLength(3);
    expect(zones.map((zone) => zone.rect.width)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(zones[2].rect.x).toBeCloseTo(2 / 3);
  });

  it('builds a default 2-row split', () => {
    const zones = buildTemplateZones('rows');
    expect(zones.map((zone) => zone.rect)).toEqual([
      { x: 0, y: 0, width: 1, height: 0.5 },
      { x: 0, y: 0.5, width: 1, height: 0.5 },
    ]);
  });

  it('builds a row-major grid', () => {
    const zones = buildTemplateZones('grid');
    expect(zones.map((zone) => zone.id)).toEqual(['zone-0', 'zone-1', 'zone-2', 'zone-3']);
    expect(zones.map((zone) => zone.rect)).toEqual([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ]);
  });

  it('builds a main-side split with the requested main fraction', () => {
    const zones = buildTemplateZones('main-side', { mainFraction: 0.6 });
    expect(zones[0].rect).toEqual({ x: 0, y: 0, width: 0.6, height: 1 });
    expect(zones[1].rect).toEqual({ x: 0.6, y: 0, width: 0.4, height: 1 });
  });

  it('clamps the main fraction into the supported bounds', () => {
    const zones = buildTemplateZones('main-side', { mainFraction: 5 });
    expect(zones[0].rect.width).toBe(0.9);
    expect(zones[1].rect.width).toBeCloseTo(0.1);
  });

  it('starts a custom layout empty', () => {
    expect(buildTemplateZones('custom')).toEqual([]);
  });
});

describe('zoneLayout — splitZone', () => {
  it('splits horizontally into side-by-side children, replacing in place', () => {
    const zones = buildTemplateZones('columns');
    const next = splitZone(zones, 'zone-0', 'horizontal', 0.5);
    expect(next.map((zone) => zone.id)).toEqual(['zone-0-a', 'zone-0-b', 'zone-1']);
    expect(next[0].rect).toEqual({ x: 0, y: 0, width: 0.25, height: 1 });
    expect(next[1].rect).toEqual({ x: 0.25, y: 0, width: 0.25, height: 1 });
    // The untouched sibling is preserved.
    expect(next[2]).toEqual(zones[1]);
  });

  it('splits vertically into stacked children', () => {
    const next = splitZone([fullZone('zone-0')], 'zone-0', 'vertical', 0.5);
    expect(next.map((zone) => zone.id)).toEqual(['zone-0-a', 'zone-0-b']);
    expect(next[0].rect).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });
    expect(next[1].rect).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
  });

  it('returns the same array reference for an unknown zone id', () => {
    const zones = buildTemplateZones('columns');
    expect(splitZone(zones, 'nope', 'horizontal', 0.5)).toBe(zones);
  });

  it('clamps the split fraction so both children stay non-degenerate', () => {
    const zones = buildTemplateZones('columns');
    const next = splitZone(zones, 'zone-0', 'horizontal', 2);
    expect(next[0].rect.width).toBeCloseTo(0.5 * 0.95);
    expect(next[1].rect.width).toBeCloseTo(0.5 * 0.05);
  });
});

describe('zoneLayout — resolveZoneRect', () => {
  it('applies the half-gap inset and insets the size by one gap', () => {
    const rect = resolveZoneRect(WS, buildTemplateZones('columns')[0], 8);
    expect(rect).toEqual({ x: 4, y: 4, width: 492, height: 792 });
  });

  it('places the second column to the right of the first', () => {
    const rect = resolveZoneRect(WS, buildTemplateZones('columns')[1], 8);
    expect(rect).toEqual({ x: 504, y: 4, width: 492, height: 792 });
  });

  it('clamps a small zone up to MIN_WIDTH × MIN_HEIGHT', () => {
    const zone: Zone = { id: 'tiny', rect: { x: 0, y: 0, width: 0.1, height: 0.1 } };
    const rect = resolveZoneRect(WS, zone, 8);
    expect(rect.width).toBe(320);
    expect(rect.height).toBe(200);
  });

  it('uses a positive fallback workspace for a null measurement', () => {
    const rect = resolveZoneRect(null, fullZone('z'), 0);
    expect(rect).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });
});

describe('zoneLayout — zoneAtPoint', () => {
  const zones = buildTemplateZones('columns');

  it('resolves the zone under a point', () => {
    expect(zoneAtPoint(WS, zones, 8, 250, 400)).toBe('zone-0');
    expect(zoneAtPoint(WS, zones, 8, 750, 400)).toBe('zone-1');
  });

  it('returns null in the inter-zone gap and outside the workspace', () => {
    expect(zoneAtPoint(WS, zones, 8, 500, 400)).toBeNull();
    expect(zoneAtPoint(WS, zones, 8, 2, 2)).toBeNull();
    expect(zoneAtPoint(WS, zones, 8, 1000, 400)).toBeNull();
  });

  it('reports the topmost (last) zone when zones overlap', () => {
    const overlapping: Zone[] = [fullZone('under'), fullZone('over')];
    expect(zoneAtPoint(WS, overlapping, 0, 500, 400)).toBe('over');
  });
});

describe('zoneLayout — matchesZoneChord', () => {
  it('matches a bare alt chord and rejects extras', () => {
    expect(
      matchesZoneChord('alt', { alt: true, ctrl: false, meta: false, shift: false }, 'win32'),
    ).toBe(true);
    expect(
      matchesZoneChord('alt', { alt: true, ctrl: false, meta: false, shift: true }, 'win32'),
    ).toBe(false);
    expect(
      matchesZoneChord('alt', { alt: false, ctrl: false, meta: false, shift: false }, 'win32'),
    ).toBe(false);
  });

  it('folds the platform-neutral primary onto Ctrl (win32) / Meta (darwin)', () => {
    expect(
      matchesZoneChord('primary', { alt: false, ctrl: true, meta: false, shift: false }, 'win32'),
    ).toBe(true);
    expect(
      matchesZoneChord('primary', { alt: false, ctrl: false, meta: true, shift: false }, 'darwin'),
    ).toBe(true);
    // On darwin, an explicit Ctrl is NOT the primary modifier.
    expect(
      matchesZoneChord('primary', { alt: false, ctrl: true, meta: false, shift: false }, 'darwin'),
    ).toBe(false);
  });

  it('requires the exact modifier set (no extra primary/ctrl/meta)', () => {
    expect(
      matchesZoneChord('primary', { alt: false, ctrl: true, meta: true, shift: false }, 'win32'),
    ).toBe(false);
  });

  it('matches the combined chords', () => {
    expect(
      matchesZoneChord('primary+alt', { alt: true, ctrl: true, meta: false, shift: false }, 'win32'),
    ).toBe(true);
    expect(
      matchesZoneChord(
        'primary+shift',
        { alt: false, ctrl: true, meta: false, shift: true },
        'win32',
      ),
    ).toBe(true);
    expect(
      matchesZoneChord('alt+shift', { alt: true, ctrl: false, meta: false, shift: true }, 'win32'),
    ).toBe(true);
    // primary+aliases are distinct: primary does not match primary+alt.
    expect(
      matchesZoneChord('primary', { alt: true, ctrl: true, meta: false, shift: false }, 'win32'),
    ).toBe(false);
  });
});
