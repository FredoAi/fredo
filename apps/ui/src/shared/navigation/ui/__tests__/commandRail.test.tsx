/**
 * Spec #3118 (P4), ST-2 — `CommandRail` (QA Q1-01 … Q1-08, Q7-02 rail legs).
 *
 * The rail is a pure render of ONE `CommandRailModel` (ST-1). These cases drive the model
 * through its real builder (`buildCommandRailModel`) over the controlled fixture (D1), then
 * assert the DOM contract the QA Plan scores:
 *   - Q1-01 breadcrumb / current place / transient chip;
 *   - Q1-02 declaration-ordered rows with a keycap hint and a risk WORD;
 *   - Q1-03 > 8 verbs ⇒ 8 rows + `more…`, click → `onOpenMap('test.arrange')` once;
 *   - Q1-04 an unavailable verb is still rendered, `data-nav-availability="disabled"`, reason
 *           in the accessible name/tooltip;
 *   - Q1-05 `/ Ask` enabled (P6) with no reason node, `? Map` enabled → `onOpenMap(null)`, no
 *           tooltip ever names the `?`/`/` glyph;
 *   - Q1-06 no padding of bound verbs, exact empty copy at 0 rows;
 *   - Q1-07 source scan: no horizontal scroll, root `overflow: hidden`, every flex container
 *           `minWidth: 0`;
 *   - Q1-08 props carry no key table, no `[aria-live]`, no positive tabindex, no focus steal.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  NAV_MORE_LABEL,
  NAV_RAIL_ARIA_LABEL,
  NAV_RAIL_ASK_TESTID,
  NAV_RAIL_BREADCRUMB_TESTID,
  NAV_RAIL_EMPTY_COPY,
  NAV_RAIL_LIST_TESTID,
  NAV_RAIL_MAP_TESTID,
  NAV_RAIL_MIN_WIDTH_PX,
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

/* ─────────────────────────── Q1-01 — place identity ─────────────────────────── */

describe('CommandRail — breadcrumb, current place and transient marker (Q1-01 / R-1.1)', () => {
  it('is a named region that declares the rail surface and the narrow-width floor', () => {
    renderRail(modelAt(ROOT_PATH));

    const root = screen.getByRole('region', { name: NAV_RAIL_ARIA_LABEL });
    expect(root).toBe(screen.getByTestId(NAV_RAIL_TESTID));
    expect(root).toHaveAttribute('data-nav-surface', 'rail');
    expect(root).toHaveStyle({ minWidth: `${NAV_RAIL_MIN_WIDTH_PX}px`, overflow: 'hidden' });
  });

  it('renders one breadcrumb segment per place and the current place label at the root', () => {
    renderRail(modelAt(ROOT_PATH));

    const breadcrumb = screen.getByTestId(NAV_RAIL_BREADCRUMB_TESTID);
    const segments = Array.from(breadcrumb.querySelectorAll('[data-nav-place-id]'));
    expect(segments.map((segment) => segment.getAttribute('data-nav-place-id'))).toEqual([
      FIXTURE_PLACES.canvas,
    ]);
    expect(screen.getByTestId(NAV_RAIL_PLACE_TESTID).textContent).toBe('Canvas');
    expect(screen.queryByTestId(NAV_RAIL_TRANSIENT_TESTID)).toBeNull();
  });

  it('renders the full path and the transient chip inside a transient place', () => {
    renderRail(modelAt(CREATE_PATH));

    const breadcrumb = screen.getByTestId(NAV_RAIL_BREADCRUMB_TESTID);
    const segments = Array.from(breadcrumb.querySelectorAll('[data-nav-place-id]'));
    expect(segments.map((segment) => segment.getAttribute('data-nav-place-id'))).toEqual([
      FIXTURE_PLACES.canvas,
      FIXTURE_PLACES.create,
    ]);
    expect(screen.getByTestId(NAV_RAIL_PLACE_TESTID).textContent).toBe('Create');
    expect(screen.getByTestId(NAV_RAIL_TRANSIENT_TESTID).textContent).toBe(
      `Create · ${NAV_TRANSIENT_MARKER_SUFFIX}`,
    );
  });
});

/* ─────────────────────────── Q1-02 — rows ─────────────────────────── */

describe('CommandRail — declaration-ordered rows with key hint and risk word (Q1-02 / R-1.2)', () => {
  it('renders the six root verbs in declaration order', () => {
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
      // Every row carries its keycap (the key hint) — the first root verb's name is 'C'.
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
});

/* ─────────────────────────── Q1-03 — overflow ─────────────────────────── */

describe('CommandRail — 8-row cap, `more…` and the filtered map trigger (Q1-03 / R-1.2, R-1.6)', () => {
  it('renders exactly 8 rows plus `more…` when the place binds 9 verbs', () => {
    const model = modelAt(ARRANGE_PATH);
    expect(model.rows).toHaveLength(8);
    expect(model.overflow).toBe(1);

    const { onOpenMap } = renderRail(model);

    expect(rows()).toHaveLength(8);
    const more = screen.getByTestId(NAV_RAIL_MORE_TESTID);
    expect(more.textContent).toBe(NAV_MORE_LABEL);

    fireEvent.click(more);
    expect(onOpenMap).toHaveBeenCalledTimes(1);
    expect(onOpenMap).toHaveBeenCalledWith(ARRANGE_PATH[1]);
  });

  it('renders no `more…` when the model reports no overflow (8 bound verbs)', () => {
    const full = modelAt(ARRANGE_PATH);
    const exact: CommandRailModel = { ...full, rows: full.rows.slice(0, 8), overflow: 0, more: null };
    renderRail(exact);

    expect(rows()).toHaveLength(8);
    expect(screen.queryByTestId(NAV_RAIL_MORE_TESTID)).toBeNull();
  });
});

/* ─────────────────────────── Q1-04 — unavailable ─────────────────────────── */

describe('CommandRail — unavailable verbs stay present, disabled and explained (Q1-04 / R-1.3)', () => {
  it('keeps an unavailable verb in place with the generic reason in name + tooltip', () => {
    const { onRunVerb } = renderRail(modelAt(EDIT_PATH));

    const paste = rows().find((row) => row.getAttribute('data-nav-verb-id') === 'test.paste');
    expect(paste).toBeDefined();
    expect(rows()).toHaveLength(3); // never removed, never reordered

    expect(paste!).toHaveAttribute('data-nav-availability', 'disabled');
    expect(paste!).toHaveAttribute('aria-disabled', 'true');
    // No native `disabled` — the row stays reachable (R-7.1).
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

/* ─────────────────────────── Q1-05 — globals ─────────────────────────── */

describe('CommandRail — `/ Ask` enabled, `? Map` enabled (Q1-05 / R-1.4 / R-7.1)', () => {
  it('renders `/ Ask` enabled with no reason node and activates it', () => {
    const { onAsk } = renderRail(modelAt(ROOT_PATH));

    const ask = screen.getByTestId(NAV_RAIL_ASK_TESTID);
    // Enabled: no aria-disabled, no native disabled (it stays focusable either way).
    expect(ask).not.toHaveAttribute('aria-disabled');
    expect(ask).not.toHaveAttribute('disabled');
    expect(ask.getAttribute('title')).toBe('Ask (k)');

    // The retired P4 reason node is gone (no aria-describedby, no second copy).
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

/* ─────────────────────────── Q1-06 — no padding ─────────────────────────── */

describe('CommandRail — never pads and renders the exact empty copy (Q1-06 / R-1.5)', () => {
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

/* ─────────────────────────── Q1-07 — no horizontal scroll ─────────────────────────── */

describe('CommandRail — structural no-horizontal-scroll proof (Q1-07 / R-1.5)', () => {
  const code = stripComments(readSource(SOURCE_PATH));

  it('never declares a horizontal auto/scroll overflow and clips the root', () => {
    expect(code).not.toMatch(/overflowX/);
    expect(code).not.toMatch(/overflow\s*[:=]\s*['"](?:auto|scroll)['"]/);
    expect(code).toContain("overflow: 'hidden'");
  });

  it('gives every flex container `minWidth: 0` (the row/wrap collapse guard)', () => {
    const chunks = code.split('display="flex"');
    expect(chunks.length).toBeGreaterThan(1); // non-vacuity: real flex containers exist
    for (const chunk of chunks.slice(1)) {
      expect(chunk.slice(0, 400)).toContain('minWidth="0"');
    }
  });

  it('caps the rendered column at 8 rows in the widest state (arrange)', () => {
    renderRail(modelAt(ARRANGE_PATH));
    expect(rows().length).toBeLessThanOrEqual(8);
  });
});

/* ─────────────────────────── Q1-08 — one model, no focus steal ─────────────────────────── */

describe('CommandRail — renders one projection only (Q1-08 / R-1.7)', () => {
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
    expect(root.querySelectorAll('[aria-live="polite"],[aria-live="assertive"]')).toHaveLength(0);
    expect(root).not.toHaveAttribute('aria-live');

    for (const element of Array.from(root.querySelectorAll('[tabindex]'))) {
      expect(Number(element.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
    }
  });

  it('does not move focus when mounted while another control is focused', () => {
    const external = renderWithChakra(
      <button type="button">
        outside the rail
      </button>,
    );
    const outside = external.getByRole('button', { name: 'outside the rail' });
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

  it('supports two rails mounted at once without a live region or duplicate id clash', () => {
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
