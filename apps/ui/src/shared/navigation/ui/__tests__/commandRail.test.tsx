/**
 * Spec #3118 (P4), ST-2; reworked by Spec #3120 (P6 rescope, ST-5) — `CommandRail` is now the
 * **bottom command bar**.
 *
 * The bar is a pure render of ONE `CommandRailModel` (ST-1). These cases drive the model
 * through its real builder (`buildCommandRailModel`) over the controlled fixture (D1), then
 * assert the DOM contract the QA Plan scores:
 *   - F-N25 (R-1.1): breadcrumb left, verbs centre, `? Map` / `Ask` right, `data-nav-surface="bar"`,
 *     horizontal root, `overflowX: hidden`, no horizontal scrollbar anywhere in the subtree;
 *   - F-N26 (R-1.2): declaration-ordered rows, the 8-row cap unchanged, never padded/sorted/sliced;
 *   - F-N27 (R-1.3): no horizontal auto/scroll, the row title is the one ellipsizing child, rows
 *     keep the 96 px floor and the cluster wraps (vertical growth);
 *   - F-N28 (R-1.4): NO rendered child-place list; the last breadcrumb segment is the current-place
 *     anchor (`tabIndex={-1}`, `aria-current="page"`), never a duplicate heading;
 *   - F-N29 (R-1.5): `more…` inline at the end of the cluster opens the map filtered to the place;
 *   - F-N35/F-N39 (R-6.1/R-6.5): one model, no key table, no `aria-live`, no positive tabindex.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  NAV_BAR_MIN_HEIGHT_PX,
  NAV_BAR_ROW_MIN_WIDTH_PX,
  NAV_MORE_LABEL,
  NAV_RAIL_ARIA_LABEL,
  NAV_RAIL_ASK_TESTID,
  NAV_RAIL_BREADCRUMB_TESTID,
  NAV_RAIL_EMPTY_COPY,
  NAV_RAIL_LIST_TESTID,
  NAV_RAIL_MAP_TESTID,
  NAV_RAIL_MORE_TESTID,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_RISK_TESTID,
  NAV_RAIL_ROW_TESTID,
  NAV_RAIL_TESTID,
  NAV_RAIL_TRANSIENT_TESTID,
  NAV_KEYCAP_GROUP_TESTID,
  NAV_RISK_LABELS,
  NAV_TRANSIENT_MARKER_SUFFIX,
  NAV_UNAVAILABLE_REASON,
} from '@/shared/navigation/ui/constants';
import { CommandRail, type CommandRailProps } from '@/shared/navigation/ui/CommandRail';
import { buildCommandRailModel } from '@/shared/navigation/ui/models';
import type { CommandRailModel } from '@/shared/navigation/ui/types';
import { FIXTURE_PLACES, fixtureSnapshot, navTestSurface } from './fixtures';

const SOURCE_PATH = 'src/shared/navigation/ui/CommandRail.tsx';

/** vitest runs with cwd = apps/ui (the package root). */
function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/** Strip comments so prose cannot satisfy or defeat a source scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function modelAt(placePath: readonly string[]): CommandRailModel {
  return buildCommandRailModel(navTestSurface(), fixtureSnapshot(placePath));
}

const ROOT_PATH = [FIXTURE_PLACES.canvas];
const CREATE_PATH = [FIXTURE_PLACES.canvas, FIXTURE_PLACES.create];
const EDIT_PATH = [FIXTURE_PLACES.canvas, FIXTURE_PLACES.edit];
const ARRANGE_PATH = [FIXTURE_PLACES.canvas, FIXTURE_PLACES.arrange];
const VIEW_PATH = [FIXTURE_PLACES.canvas, FIXTURE_PLACES.view];
const FILE_PATH = [FIXTURE_PLACES.canvas, FIXTURE_PLACES.file];

function renderRail(
  model: CommandRailModel,
  overrides: Partial<Omit<CommandRailProps, 'model'>> = {},
): {
  onRunVerb: ReturnType<typeof vi.fn>;
  onOpenMap: ReturnType<typeof vi.fn>;
  onAsk: ReturnType<typeof vi.fn>;
  unmount: () => void;
} {
  const onRunVerb = vi.fn();
  const onOpenMap = vi.fn();
  const onAsk = vi.fn();
  const { unmount } = renderWithChakra(
    <CommandRail
      model={model}
      onRunVerb={onRunVerb}
      onOpenMap={onOpenMap}
      onAsk={onAsk}
      {...overrides}
    />,
  );
  return { onRunVerb, onOpenMap, onAsk, unmount };
}

function rows(): HTMLElement[] {
  return screen.getAllByTestId(NAV_RAIL_ROW_TESTID);
}

afterEach(() => {
  cleanup();
});

/* ─────────────────── F-N25 — bottom-bar horizontal layout ─────────────────── */

describe('CommandRail — the command bar is a horizontal row (F-N25 / R-1.1)', () => {
  it('is a named region declaring the BAR surface, a row layout and a hidden horizontal axis', () => {
    renderRail(modelAt(ROOT_PATH));

    const root = screen.getByRole('region', { name: NAV_RAIL_ARIA_LABEL });
    expect(root).toBe(screen.getByTestId(NAV_RAIL_TESTID));
    expect(NAV_RAIL_ARIA_LABEL).toBe('Command bar');
    expect(root).toHaveAttribute('data-nav-surface', 'bar');
    expect(root.style.overflowX).toBe('hidden');
    expect(root.style.minHeight).toBe(`${NAV_BAR_MIN_HEIGHT_PX}px`);
    // The root is a horizontal flex row (breadcrumb | verbs | globals), never a column.
    expect(root.style.flexDirection).not.toBe('column');
    expect(root.firstElementChild?.tagName.toLowerCase()).toBe('ol');
    const code = stripComments(readSource(SOURCE_PATH));
    const rootBlock = code.slice(code.indexOf('data-nav-surface="bar"')).slice(0, 800);
    expect(rootBlock).toContain('display="flex"');
    expect(rootBlock).toContain('alignItems="center"');
    expect(rootBlock).not.toContain('flexDirection="column"');
  });

  it('keeps breadcrumb left, verbs centre and the two globals at the right edge', () => {
    renderRail(modelAt(ROOT_PATH));

    const root = screen.getByTestId(NAV_RAIL_TESTID);
    const breadcrumb = screen.getByTestId(NAV_RAIL_BREADCRUMB_TESTID);
    const cluster = screen.getByTestId(NAV_RAIL_LIST_TESTID);
    const map = screen.getByTestId(NAV_RAIL_MAP_TESTID);
    const ask = screen.getByTestId(NAV_RAIL_ASK_TESTID);

    // DOM order: breadcrumb → cluster → globals. In a row that is left → centre → right.
    expect(breadcrumb.compareDocumentPosition(cluster) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(cluster.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(map.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(root).getByTestId(NAV_RAIL_ASK_TESTID)).toBe(ask);
    // The cluster is the flexible middle: it grows and wraps (see the wrap pin below).
    expect(cluster.getAttribute('role')).toBe('list');
    expect(cluster.tagName.toLowerCase()).toBe('ul');
  });

  it('never declares or renders a horizontal auto/scroll overflow in the bar subtree', () => {
    renderRail(modelAt(ARRANGE_PATH));

    const root = screen.getByTestId(NAV_RAIL_TESTID);
    for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
      expect(element.style.overflowX).not.toMatch(/auto|scroll/);
      expect(element.style.overflow).not.toMatch(/auto|scroll/);
    }

    const code = stripComments(readSource(SOURCE_PATH));
    expect(code).not.toMatch(/overflowX\s*:\s*['"](?:auto|scroll)['"]/);
    expect(code).not.toMatch(/overflow\s*:\s*['"](?:auto|scroll)['"]/);
    expect(code).toContain("overflowX: 'hidden'");
  });

  it('gives every verb row the 96 px floor and lets the cluster wrap (vertical growth)', () => {
    // The cluster wraps rather than scrolls, and every row keeps its floor (UIUX-D6). jsdom
    // does not resolve Chakra's class-based styles, so the source is the deterministic oracle.
    renderRail(modelAt(ARRANGE_PATH));
    expect(screen.getByTestId(NAV_RAIL_LIST_TESTID)).toBeInTheDocument();
    expect(rows()).toHaveLength(8);

    const code = stripComments(readSource(SOURCE_PATH));
    expect(code).toMatch(/NAV_BAR_ROW_MIN_WIDTH_PX/);
    expect(NAV_BAR_ROW_MIN_WIDTH_PX).toBe(96);
    expect(code).toMatch(/flexWrap="wrap"/);
    expect(code).toMatch(/minWidth="0"/);
    expect(code).toMatch(/ROW_MAX_WIDTH_PX\s*=\s*168/);
  });
});

/* ─────────────────── F-N28 — no child-place list, breadcrumb anchor ─────────────────── */

describe('CommandRail — no child-place list and the breadcrumb is the current-place anchor (F-N28 / R-1.4)', () => {
  it('renders NO child-place list or place rows anywhere in the bar', () => {
    renderRail(modelAt(ROOT_PATH));

    expect(screen.queryByTestId('navigation-rail-places')).toBeNull();
    expect(screen.queryByTestId('navigation-rail-place-row')).toBeNull();
    expect(screen.queryByTestId('navigation-bar-places')).toBeNull();
    expect(document.querySelectorAll('[data-nav-place-id]').length).toBeGreaterThan(0);

    const root = screen.getByTestId(NAV_RAIL_TESTID);
    // The bar holds only the breadcrumb, the verb cluster and the two globals.
    expect(root.children).toHaveLength(3);
  });

  it('makes the LAST breadcrumb segment the current place (the ONLY ellipsis + focus anchor)', () => {
    renderRail(modelAt(CREATE_PATH));

    const breadcrumb = screen.getByTestId(NAV_RAIL_BREADCRUMB_TESTID);
    const place = screen.getByTestId(NAV_RAIL_PLACE_TESTID);
    const segments = Array.from(breadcrumb.querySelectorAll('[data-nav-place-id]'));

    expect(place.textContent).toBe('Create');
    expect(place).toHaveAttribute('tabindex', '-1');
    expect(place).toHaveAttribute('aria-current', 'page');
    // It IS the last segment, not a duplicate heading below the breadcrumb.
    expect(segments[segments.length - 1]?.contains(place)).toBe(true);
    expect(segments.map((segment) => segment.getAttribute('data-nav-place-id'))).toEqual([
      FIXTURE_PLACES.canvas,
      FIXTURE_PLACES.create,
    ]);
    // No duplicate current-place heading anywhere.
    expect(screen.queryByRole('heading', { name: 'Create' })).toBeNull();
    expect(place.tagName.toLowerCase()).toBe('span');
  });

  it('renders the transient marker inline without a child-place list', () => {
    renderRail(modelAt(CREATE_PATH));

    expect(screen.getByTestId(NAV_RAIL_TRANSIENT_TESTID).textContent).toBe(
      `Create · ${NAV_TRANSIENT_MARKER_SUFFIX}`,
    );
    expect(screen.queryByTestId('navigation-rail-places')).toBeNull();
  });
});

/* ─────────────────── F-N26 — rows, order, cap ─────────────────── */

describe('CommandRail — declaration-ordered rows, the eight-row cap and risk words (F-N26 / R-1.2)', () => {
  it('renders the six root verbs in declaration order with their key hints', () => {
    renderRail(modelAt(ROOT_PATH));

    expect(rows().map((row) => row.getAttribute('data-nav-verb-id'))).toEqual([
      'test.create',
      'test.edit',
      'test.arrange',
      'test.style',
      'test.view',
      'test.file',
    ]);
    for (const row of rows()) {
      expect(row.getAttribute('data-nav-availability')).toBe('available');
      expect(within(row).getByTestId(NAV_KEYCAP_GROUP_TESTID)).toBeTruthy();
    }
    expect(
      within(rows()[0]).getByTestId(NAV_KEYCAP_GROUP_TESTID).getAttribute('aria-label'),
    ).toBe('C');
  });

  it('renders the risk WORD (not just colour) for every non-safe verb and nothing for safe', () => {
    renderRail(modelAt(EDIT_PATH));

    const rowsById = new Map(rows().map((row) => [row.getAttribute('data-nav-verb-id'), row]));

    const destructive = rowsById.get('test.delete');
    expect(destructive).toBeDefined();
    expect(within(destructive!).getByTestId(NAV_RAIL_RISK_TESTID).textContent).toContain(
      NAV_RISK_LABELS.destructive,
    );
    expect((destructive?.getAttribute('aria-label') ?? '').toLowerCase()).toContain(
      NAV_RISK_LABELS.destructive.toLowerCase(),
    );

    const safe = rowsById.get('test.duplicate');
    expect(safe).toBeDefined();
    expect(within(safe!).queryByTestId(NAV_RAIL_RISK_TESTID)).toBeNull();
  });

  it('renders the external risk word on an external verb', () => {
    renderRail(modelAt(FILE_PATH));

    const exportRow = rows().find(
      (row) => row.getAttribute('data-nav-verb-id') === 'test.exportPng',
    );
    expect(exportRow).toBeDefined();
    expect(within(exportRow!).getByTestId(NAV_RAIL_RISK_TESTID).textContent).toContain(
      NAV_RISK_LABELS.external,
    );
  });

  it('runs an enabled row through the supplied handler exactly once', () => {
    const { onRunVerb } = renderRail(modelAt(ROOT_PATH));

    fireEvent.click(rows()[0]);
    expect(onRunVerb).toHaveBeenCalledTimes(1);
    expect(onRunVerb).toHaveBeenCalledWith('test.create');
  });

  it('renders exactly 8 rows plus `more…` when the place binds 9 verbs', () => {
    const model = modelAt(ARRANGE_PATH);
    expect(model.rows).toHaveLength(8);
    expect(model.overflow).toBe(1);

    renderRail(model);

    expect(rows()).toHaveLength(8);
    expect(rows().map((row) => row.getAttribute('data-nav-verb-id'))).toEqual(
      model.rows.map((row) => row.verbId),
    );
    expect(new Set(rows().map((row) => row.getAttribute('data-nav-verb-id'))).size).toBe(8);
  });

  it('renders no `more…` when the model reports no overflow', () => {
    renderRail(modelAt(EDIT_PATH));
    expect(screen.queryByTestId(NAV_RAIL_MORE_TESTID)).toBeNull();
  });
});

/* ─────────────────── F-N29 — `more…` inline opens the filtered map ─────────────────── */

describe('CommandRail — `more…` sits inline at the cluster end and opens the seeded map (F-N29 / R-1.5)', () => {
  it('keeps `more…` inside the verb cluster (inline, after the rows) and opens the place filter', () => {
    const { onOpenMap } = renderRail(modelAt(ARRANGE_PATH));

    const cluster = screen.getByTestId(NAV_RAIL_LIST_TESTID);
    const more = screen.getByTestId(NAV_RAIL_MORE_TESTID);
    expect(cluster.contains(more)).toBe(true);
    expect(more.textContent).toBe(NAV_MORE_LABEL);
    // Inline at the END of the cluster: it follows every rendered row.
    const lastRow = rows()[rows().length - 1];
    expect(
      lastRow.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.click(more);
    expect(onOpenMap).toHaveBeenCalledTimes(1);
    expect(onOpenMap).toHaveBeenCalledWith(ARRANGE_PATH[1]);
  });
});

/* ─────────────────── F-N27 — unavailable rows stay reachable ─────────────────── */

describe('CommandRail — unavailable verbs stay present, aria-disabled and explained (R-1.3)', () => {
  it('keeps an unavailable verb in place with the generic reason in name + tooltip', () => {
    const { onRunVerb } = renderRail(modelAt(EDIT_PATH));

    const paste = rows().find((row) => row.getAttribute('data-nav-verb-id') === 'test.paste');
    expect(paste).toBeDefined();
    expect(rows()).toHaveLength(3); // never removed, never reordered

    expect(paste!).toHaveAttribute('data-nav-availability', 'disabled');
    expect(paste!).toHaveAttribute('aria-disabled', 'true');
    expect(paste!).not.toHaveAttribute('disabled');
    expect(paste!.getAttribute('aria-label')).toContain(NAV_UNAVAILABLE_REASON);
    expect(paste!.getAttribute('title')).toContain(NAV_UNAVAILABLE_REASON);

    fireEvent.click(paste!);
    expect(onRunVerb).not.toHaveBeenCalled();
  });

  it('renders every row disabled (Map still enabled) when all verbs are unavailable', () => {
    const base = modelAt(EDIT_PATH);
    const allDisabled: CommandRailModel = {
      ...base,
      rows: base.rows.map((row) => ({
        ...row,
        enabled: false,
        reason: NAV_UNAVAILABLE_REASON,
        tooltip: `${row.title} — ${NAV_UNAVAILABLE_REASON}`,
      })),
    };
    renderRail(allDisabled);

    expect(rows()).toHaveLength(3);
    for (const row of rows()) {
      expect(row).toHaveAttribute('data-nav-availability', 'disabled');
      expect(row.getAttribute('aria-label')).toContain(NAV_UNAVAILABLE_REASON);
    }
    expect(screen.getByTestId(NAV_RAIL_MAP_TESTID)).not.toHaveAttribute('aria-disabled');
  });
});

/* ─────────────────── globals ─────────────────── */

describe('CommandRail — `Ask` and `? Map` globals (R-1.1 / R-3.11)', () => {
  it('renders `Ask` enabled with no reason node and activates it', () => {
    const { onAsk } = renderRail(modelAt(ROOT_PATH));

    const ask = screen.getByTestId(NAV_RAIL_ASK_TESTID);
    expect(ask).not.toHaveAttribute('aria-disabled');
    expect(ask).not.toHaveAttribute('disabled');
    expect(ask.getAttribute('title')).toBe('Ask (k)');
    expect(ask).not.toHaveAttribute('aria-describedby');

    fireEvent.click(ask);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it('opens the unfiltered map from `? Map` and never names the glyph in a tooltip', () => {
    const { onOpenMap } = renderRail(modelAt(ROOT_PATH));

    const map = screen.getByTestId(NAV_RAIL_MAP_TESTID);
    expect(map).not.toHaveAttribute('aria-disabled');
    fireEvent.click(map);
    expect(onOpenMap).toHaveBeenCalledTimes(1);
    expect(onOpenMap).toHaveBeenCalledWith(null);

    const root = screen.getByTestId(NAV_RAIL_TESTID);
    const titled = Array.from(root.querySelectorAll('[title]'));
    expect(titled.length).toBeGreaterThan(0);
    for (const element of titled) {
      const title = element.getAttribute('title') ?? '';
      expect(title).not.toContain('?');
      expect(title).not.toContain('/');
    }
  });

  it('names the glyph chips from NAV_GLYPH_ACCESSIBLE_NAME', () => {
    renderRail(modelAt(ROOT_PATH));

    expect(
      within(screen.getByTestId(NAV_RAIL_MAP_TESTID)).getByRole('img', { name: 'Question mark' }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId(NAV_RAIL_ASK_TESTID)).getByRole('img', { name: 'Slash' }),
    ).toBeTruthy();
  });
});

/* ─────────────────── empty copy ─────────────────── */

describe('CommandRail — never pads and renders the exact empty copy (R-1.5)', () => {
  it('renders exactly the model rows (no padding to a 4-row floor)', () => {
    renderRail(modelAt(ROOT_PATH));
    expect(rows()).toHaveLength(6);

    cleanup();
    renderRail(modelAt(CREATE_PATH));
    expect(rows()).toHaveLength(2);
  });

  it('renders the bound empty copy when the place binds zero verbs', () => {
    renderRail(modelAt(VIEW_PATH));

    expect(screen.queryAllByTestId(NAV_RAIL_ROW_TESTID)).toHaveLength(0);
    expect(screen.getByText(NAV_RAIL_EMPTY_COPY).textContent).toBe(NAV_RAIL_EMPTY_COPY);
  });
});

/* ─────────────────── F-N35 — one projection only ─────────────────── */

describe('CommandRail — renders one projection only (F-N35 / R-6.1)', () => {
  const code = stripComments(readSource(SOURCE_PATH));

  it('declares exactly the bound prop surface (no key table, no verb list, no surface)', () => {
    const propsBlock = code.match(/export interface CommandRailProps \{([\s\S]*?)\n\}/)?.[1] ?? '';
    for (const prop of ['model', 'platform', 'reducedMotion', 'onRunVerb', 'onOpenMap', 'onAsk']) {
      expect(propsBlock).toContain(prop);
    }
    expect(propsBlock).not.toMatch(/\breadonly\s+(?:keys|verbs|surface)\b/);
    expect(propsBlock).not.toContain('VerbDescriptor');
  });

  it('imports no second binding derivation (no registry, no Surface)', () => {
    expect(code).not.toMatch(/createRegistry|keysByVerb|type Surface\b|VerbDescriptor/);
    expect(code).toContain("from './types'");
  });

  it('declares no aria-live region and no positive tabindex', () => {
    renderRail(modelAt(ROOT_PATH));

    const root = screen.getByTestId(NAV_RAIL_TESTID);
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(root).not.toHaveAttribute('aria-live');

    for (const element of Array.from(root.querySelectorAll('[tabindex]'))) {
      expect(Number(element.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
    }
  });

  it('does not move focus when mounted while another control is focused', () => {
    const external = renderWithChakra(
      <button type="button">
        outside the bar
      </button>,
    );
    const outside = external.getByRole('button', { name: 'outside the bar' });
    outside.focus();
    expect(outside).toHaveFocus();

    renderWithChakra(
      <CommandRail
        model={modelAt(ROOT_PATH)}
        onRunVerb={vi.fn()}
        onOpenMap={vi.fn()}
        onAsk={vi.fn()}
      />,
    );

    expect(outside).toHaveFocus();
  });

  it('supports two bars mounted at once without a live region or duplicate id clash', () => {
    const model = modelAt(ROOT_PATH);
    renderWithChakra(
      <>
        <CommandRail model={model} onRunVerb={vi.fn()} onOpenMap={vi.fn()} />
        <CommandRail model={model} onRunVerb={vi.fn()} onOpenMap={vi.fn()} />
      </>,
    );

    expect(screen.getAllByRole('region', { name: NAV_RAIL_ARIA_LABEL })).toHaveLength(2);
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(0);
  });
});

describe('CommandRail — list region is the animated element (reduced-motion exercised)', () => {
  it('animates the list unless motion is reduced', () => {
    const model = modelAt(ROOT_PATH);

    const animated = renderRail(model, { reducedMotion: false });
    expect(screen.getByTestId(NAV_RAIL_LIST_TESTID).style.animation).toBe('navigation-rail-in 150ms ease');
    animated.unmount();

    renderRail(model, { reducedMotion: true });
    expect(screen.getByTestId(NAV_RAIL_LIST_TESTID).style.animation).toBe('none');
  });
});
