/**
 * #2826 — App-grid de-dup by feature `id`.
 *
 * Pins the two artifacts the de-dup fix ships:
 *   1. `dedupeByFeatureId` — a PURE, first-wins, stable-order, single-pass
 *      helper keyed by feature `id` (never by name/label).
 *   2. Launcher grid + keyboard-nav alignment — with duplicate ids in the
 *      registry, the launcher renders EXACTLY ONE tile per distinct id and the
 *      `entryCount` / `safeSelectedIndex` / `activeTileId` indices collapse in
 *      lockstep (no ghost tiles, no nav-sequence gaps).
 *
 * The regression also pins the NON-GOAL: the grid (`LauncherAppGrid`) is
 * PRESENTATIONAL and does NOT de-dup internally — it renders one tile per
 * entry it is given. De-dup MUST happen upstream at `SHOWABLE_FEATURES`
 * (Home.tsx), so the consumer-side grid, its map, and the host's index math
 * all operate on the SAME deduped array.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { LuAppWindow } from 'react-icons/lu';
import type { ReactElement } from 'react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { dedupeByFeatureId } from '../featureRegistry';
import { FredoFeatureClass } from '@/shared/classes/FredoFeatureClass';
import { LauncherAppGrid } from '../home/components/launcher/LauncherAppGrid';
import { LauncherShell } from '../home/components/launcher/LauncherShell';

// LauncherShell reads the live connection flag via useConnectionStatus, which
// requires a StreamProvider at runtime — not present in this isolated test.
// Mock the (only) StreamContext consumer it uses so the shell renders standalone.
vi.mock('@/shared/contexts/StreamContext', () => ({
  useConnectionStatus: () => ({ isConnected: true }),
}));

// #2853 ST-4: LauncherShell also consumes useCompanion to gate the desktop
// mascot on designated presence; CompanionProvider is not present in this
// isolated harness either. Stub the hook (same idiom as the StreamContext mock
// above) so the shell renders standalone — the presence gate itself is covered
// by the companion suite. No assertion in this file is changed or weakened.
vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => ({ state: { isVisible: false, isAutoHidden: false } }),
}));

// ── Fixture feature ──────────────────────────────────────────────────────────

/** Minimal concrete FredoFeatureClass; `id`/`name` are the de-dup keys. */
class FakeFeature extends FredoFeatureClass {
  constructor(readonly id: string, readonly name: string) {
    super();
  }
  readonly icon = LuAppWindow;
  render(): ReactElement {
    return <div />;
  }
}

/** The #2826 wireframe fail-state feature list (repeated-app.png): Mission
 *  Monitor is registered 3× (double registration), so the raw registry carries
 *  6 entries for 4 distinct ids. */
function duplicateLadenList(): FakeFeature[] {
  return [
    new FakeFeature('mission-monitor', 'Mission Monitor'),
    new FakeFeature('query-viewer', 'Query Viewer'),
    new FakeFeature('run-cli', 'Run CLI'),
    new FakeFeature('stepper-probe', 'Stepper Probe'),
    new FakeFeature('mission-monitor', 'Mission Monitor'), // dup id
    new FakeFeature('mission-monitor', 'Mission Monitor'), // dup id
  ];
}

// ── dedupeByFeatureId: pure helper semantics ─────────────────────────────────

describe('dedupeByFeatureId (features/featureRegistry)', () => {
  it('is first-wins — keeps the FIRST occurrence of each id and drops later duplicates', () => {
    const list = duplicateLadenList();
    const deduped = dedupeByFeatureId(list);

    // The first 'mission-monitor' (install order) survives; the two later
    // pushes are dropped. The 4 distinct ids each appear exactly once.
    expect(deduped).toHaveLength(4);
    expect(deduped.map((f) => f.id)).toEqual([
      'mission-monitor',
      'query-viewer',
      'run-cli',
      'stepper-probe',
    ]);
    // FIRST occurrence is kept BY REFERENCE (not a later duplicate object).
    expect(deduped[0]).toBe(list[0]);
    expect(deduped).not.toContain(list[4]);
    expect(deduped).not.toContain(list[5]);
  });

  it('preserves input order (stable-order projection)', () => {
    const shuffled = [
      new FakeFeature('stepper-probe', 'Stepper Probe'),
      new FakeFeature('mission-monitor', 'Mission Monitor'),
      new FakeFeature('query-viewer', 'Query Viewer'),
      new FakeFeature('mission-monitor', 'Mission Monitor'), // dup
    ];
    expect(dedupeByFeatureId(shuffled).map((f) => f.id)).toEqual([
      'stepper-probe',
      'mission-monitor',
      'query-viewer',
    ]);
  });

  it('returns one entry per distinct id (no duplicates survive)', () => {
    const deduped = dedupeByFeatureId(duplicateLadenList());
    const ids = deduped.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is pure — NEVER mutates the input array or its elements', () => {
    const list = duplicateLadenList();
    const before = [...list];
    const v1 = before[0];
    const v4 = before[4];

    dedupeByFeatureId(list);

    expect(list).toHaveLength(before.length);
    expect(list[0]).toBe(v1);
    expect(list[4]).toBe(v4);
  });

  it('no-duplicate input → output-equal, same length, same order', () => {
    const list = [
      new FakeFeature('mission-monitor', 'Mission Monitor'),
      new FakeFeature('query-viewer', 'Query Viewer'),
    ];
    const deduped = dedupeByFeatureId(list);
    expect(deduped).toHaveLength(list.length);
    expect(deduped.map((f) => f.id)).toEqual(list.map((f) => f.id));
    // Same element references (no new objects, no removed entries).
    expect(deduped[0]).toBe(list[0]);
    expect(deduped[1]).toBe(list[1]);
  });

  it('de-dupes by id — NEVER by name/label, so distinct ids sharing a label BOTH render', () => {
    // Two DISTINCT ids with the SAME display label (the id is the identity).
    const list = [
      new FakeFeature('mission-monitor', 'Mission Monitor'),
      new FakeFeature('mission-monitor-2', 'Mission Monitor'),
    ];
    const deduped = dedupeByFeatureId(list);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((f) => f.name)).toEqual(['Mission Monitor', 'Mission Monitor']);
  });
});

// ── Launcher grid + keyboard-nav alignment (no ghost tiles / no nav gaps) ────

describe('LauncherAppGrid — one tile per distinct id (no ghost tiles)', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders EXACTLY one tile per distinct id after dedupe (6 dup entries → 4 tiles)', () => {
    // Same 6-entry duplicate-laden registry, passed through dedupeByFeatureId
    // exactly as Home.tsx derives SHOWABLE_FEATURES.
    const deduped = dedupeByFeatureId(duplicateLadenList());

    renderWithChakra(<LauncherAppGrid entries={deduped} selectedIndex={0} onSelect={() => {}} />);

    const grid = screen.getByRole('grid');
    const tiles = within(grid).getAllByRole('gridcell');
    expect(tiles).toHaveLength(4);

    // One tile per distinct feature id (no ghost duplicate label anywhere).
    const labels = tiles.map((t) => t.querySelector('[role="button"]')?.getAttribute('aria-label'));
    expect(labels.filter((l) => l === 'Mission Monitor')).toHaveLength(1);
    expect(new Set(labels).size).toBe(4);
  });

  it('is PRESENTATIONAL — the grid ALONE does not de-dup (raw dup entries → 6 ghost tiles)', () => {
    // Pins the NON-GOAL: de-dup must be upstream at SHOWABLE_FEATURES, never
    // "fixed" inside LauncherAppGrid (which would diverge the grid from the
    // nav index math in LauncherShell). Passing raw duplicate ids makes React
    // warn about non-unique keys — the WHOLE POINT. Silence it for this one
    // intentional render so the suite output stays clean.
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWithChakra(<LauncherAppGrid entries={duplicateLadenList()} selectedIndex={0} onSelect={() => {}} />);

      const grid = screen.getByRole('grid');
      expect(within(grid).getAllByRole('gridcell')).toHaveLength(6);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('nav index↔tile mapping stays in lockstep across every index (no gaps, no ghost selection)', () => {
    const deduped = dedupeByFeatureId(duplicateLadenList());
    const { rerender } = renderWithChakra(
      <LauncherAppGrid entries={deduped} selectedIndex={0} onSelect={() => {}} />,
    );

    // Every index in [0, distinctCount) selects exactly ONE real tile — no gap
    // between the host's `safeSelectedIndex` and a rendered tile. The selected
    // tile carries tabIndex=0; the others are tabIndex=-1 (roving tabindex).
    for (let i = 0; i < deduped.length; i += 1) {
      rerender(<LauncherAppGrid entries={deduped} selectedIndex={i} onSelect={() => {}} />);
      const grid = screen.getByRole('grid');
      const tiles = within(grid).getAllByRole('gridcell');
      const selectedTiles = tiles.filter(
        (t) => t.querySelector('[role="button"]')?.getAttribute('tabindex') === '0',
      );

      expect(selectedTiles).toHaveLength(1, `exactly one selected tile at index ${i}`);
      const selectedLabel = selectedTiles[0].querySelector('[role="button"]')?.getAttribute('aria-label');
      expect(selectedLabel).toBe(deduped[i].name);
    }
  });
});

// ── LauncherShell: entryCount / safeSelectedIndex / activeTileId collapse ─────

describe('LauncherShell — entryCount/safeSelectedIndex/activeTileId collapse in lockstep', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    // LauncherShell scrolls the selected gridcell into view inside a passive
    // effect (LauncherShell.tsx:246). jsdom does not implement Element#scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reveals ONE tile per distinct id and navigates within the deduped grid (no nav gaps)', () => {
    const onOpenFeature = vi.fn();
    // Home.tsx:22-23 derivation — SHOWABLE_FEATURES = dedupeByFeatureId(showables).
    const deduped = dedupeByFeatureId(duplicateLadenList());

    renderWithChakra(
      <LauncherShell showableFeatures={deduped} onOpenFeature={onOpenFeature} />,
    );

    // Engage the grid by focusing the command-bar searchbox (#2819).
    const searchbox = screen.getByRole('searchbox');
    act(() => {
      searchbox.focus();
      fireEvent.focus(searchbox);
    });

    const grid = screen.getByRole('grid');
    const tiles = within(grid).getAllByRole('gridcell');
    // entryCount (derived from filteredEntries) === distinct count → dedupe
    // collapsed the 6 dup entries to 4, so the grid reveals 4 tiles.
    expect(tiles).toHaveLength(4);

    // The selected index is bounded by the deduped grid (safeSelectedIndex
    // never points past the last real tile), and ArrowRight advances 0→1→2→3
    // without a gap (each step lands on a distinct, real tile).
    const selectedTile = () =>
      within(grid)
        .getAllByRole('gridcell')
        .find((t) => t.querySelector('[role="button"]')?.getAttribute('tabindex') === '0');

    expect(selectedTile()?.querySelector('[role="button"]')?.getAttribute('aria-label')).toBe('Mission Monitor');

    // ArrowRight → index 1 (Query Viewer), no gap onto a ghost tile.
    act(() => {
      fireEvent.keyDown(searchbox, { key: 'ArrowRight' });
    });
    expect(selectedTile()?.querySelector('[role="button"]')?.getAttribute('aria-label')).toBe('Query Viewer');
  });
});
