/**
 * ZoneOverlay tests — Spec #2980 ST-4 (R-3.1 overlay render, G-266 ownership).
 *
 * Pins the overlay's sole-owned hooks:
 *   - `zone-overlay`, the full-workspace layer (`pointer-events: none`);
 *   - one `zone-target-<zoneId>` per zone (`data-zone-id`, `data-hovered`) at
 *     its `resolveZoneRect` px rect;
 *   - the SINGLE `zone-announcer` status region (role/aria + visually hidden);
 *   - the non-colour hover cue (grid glyph + "Zone k" label) so hover never
 *     reads by colour alone (G-235).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { ZoneOverlay } from '../ZoneOverlay';
import { buildTemplateZones, resolveZoneRect } from '../zoneLayout';

const WS = { width: 1000, height: 800 };
const GAP = 8;
const ZONES = buildTemplateZones('columns', { columns: 2 });

afterEach(() => {
  cleanup();
});

describe('ZoneOverlay — layer + zone targets (R-3.1)', () => {
  it('renders the overlay layer with pointer-events: none', () => {
    renderWithChakra(<ZoneOverlay zones={ZONES} workspace={WS} gap={GAP} hoveredZoneId={null} />);

    const overlay = screen.getByTestId('zone-overlay');
    expect(getComputedStyle(overlay).pointerEvents).toBe('none');
  });

  it('renders exactly one target per zone, positioned at resolveZoneRect', () => {
    renderWithChakra(<ZoneOverlay zones={ZONES} workspace={WS} gap={GAP} hoveredZoneId={null} />);

    expect(screen.getAllByTestId(/^zone-target-/)).toHaveLength(ZONES.length);

    ZONES.forEach((zone) => {
      const target = screen.getByTestId(`zone-target-${zone.id}`);
      expect(target.getAttribute('data-zone-id')).toBe(zone.id);
      expect(target.getAttribute('data-hovered')).toBe('false');
      const rect = resolveZoneRect(WS, zone, GAP);
      expect(target.style.left).toBe(`${rect.x}px`);
      expect(target.style.top).toBe(`${rect.y}px`);
      expect(target.style.width).toBe(`${rect.width}px`);
      expect(target.style.height).toBe(`${rect.height}px`);
    });
  });

  it('marks only the hovered zone and shows a non-colour cue (G-235)', () => {
    renderWithChakra(
      <ZoneOverlay zones={ZONES} workspace={WS} gap={GAP} hoveredZoneId={ZONES[1].id} />,
    );

    expect(screen.getByTestId(`zone-target-${ZONES[0].id}`).getAttribute('data-hovered')).toBe(
      'false',
    );
    const hovered = screen.getByTestId(`zone-target-${ZONES[1].id}`);
    expect(hovered.getAttribute('data-hovered')).toBe('true');
    // Non-colour cue: a textual "Zone k" label (1-based) alongside the glyph.
    expect(hovered.textContent).toContain('Zone 2');
  });

  it('owns exactly one zone-announcer status region', () => {
    renderWithChakra(<ZoneOverlay zones={ZONES} workspace={WS} gap={GAP} hoveredZoneId={null} />);

    const announcers = screen.getAllByTestId('zone-announcer');
    expect(announcers).toHaveLength(1);
    const announcer = announcers[0];
    expect(announcer.getAttribute('role')).toBe('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.getAttribute('aria-atomic')).toBe('true');
    expect(announcer.textContent).toContain('2 zones');
  });

  it('announces the hovered target while a zone is highlighted', () => {
    renderWithChakra(
      <ZoneOverlay zones={ZONES} workspace={WS} gap={GAP} hoveredZoneId={ZONES[1].id} />,
    );

    expect(screen.getByTestId('zone-announcer').textContent).toBe('Over target: Zone 2.');
  });
});
