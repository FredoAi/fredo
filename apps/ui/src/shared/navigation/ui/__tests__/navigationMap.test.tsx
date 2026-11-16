/**
 * Spec #3118 (P4), ST-3 — `NavigationMap` (QA Q2-01 … Q2-06, plus the map legs of Q7-01).
 *
 * The map is a pure render of ONE `NavigationMapModel` (ST-1). These cases build the model
 * through its real builder over the controlled fixture (D1) and assert the DOM contract:
 *
 *   - Q2-01 open/close, the `filteredTo` seed (null / a place / an unknown id) and no leaked node;
 *   - Q2-02 the whole tree in tree order — per-place verbs/keys/availability/risk, exactly ONE
 *           current place, and the three distinct key sections (place keys inside blocks,
 *           aliases after every block, globals with their glyphs and bindings);
 *   - Q2-03 arrows move + wrap, Enter runs the active ENABLED verb once, Escape closes once,
 *           and the module adds no document-level keydown listener (source scan);
 *   - Q2-04 focus restore on Escape / backdrop / a ran verb, never `body` (incl. a detached
 *           invoker);
 *   - Q2-05 the Tab wrap stays inside the dialog and is released on close;
 *   - Q2-06 case-insensitive search over the model rows (never a second list) and the no-match
 *           state with focus kept.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { deriveMap } from '@/shared/navigation';
import { getFocusableElements } from '@/shared/window-system/traversal';
import {
  NAV_GLYPH_ACCESSIBLE_NAME,
  NAV_MAP_ALIASES_HEADING,
  NAV_MAP_ALIAS_TESTID,
  NAV_MAP_ARIA_LABEL,
  NAV_MAP_CURRENT_LABEL,
  NAV_MAP_EMPTY_COPY,
  NAV_MAP_EMPTY_TESTID,
  NAV_MAP_GLOBAL_TESTID,
  NAV_MAP_GLOBALS_HEADING,
  NAV_MAP_HINT_COPY,
  NAV_MAP_KEY_TESTID,
  NAV_MAP_PLACE_TESTID,
  NAV_MAP_ROW_TESTID,
  NAV_MAP_SEARCH_LABEL,
  NAV_MAP_SEARCH_TESTID,
  NAV_MAP_TESTID,
  NAV_RISK_LABELS,
  NAV_UNAVAILABLE_REASON,
} from '@/shared/navigation/ui/constants';
import { NavigationMap, type NavigationMapProps } from '@/shared/navigation/ui/NavigationMap';
import { buildNavigationMapModel } from '@/shared/navigation/ui/models';
import type { NavigationMapModel } from '@/shared/navigation/ui/types';
import { FIXTURE_PLACES, fixtureSnapshot, navTestSurface } from './fixtures';

const SOURCE_PATH = 'src/shared/navigation/ui/NavigationMap.tsx';

/** vitest runs with cwd = apps/ui (the package root). */
function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const ROOT_PATH = [FIXTURE_PLACES.canvas];
const EDIT_PATH = [FIXTURE_PLACES.canvas, FIXTURE_PLACES.edit];

function mapAt(
  placePath: readonly string[] = ROOT_PATH,
  filteredTo: string | null = null,
): NavigationMapModel {
  return buildNavigationMapModel(navTestSurface(), fixtureSnapshot(placePath), { filteredTo });
}

function placeBlocks(): HTMLElement[] {
  return screen.queryAllByTestId(NAV_MAP_PLACE_TESTID);
}

function verbRows(): HTMLElement[] {
  return screen.queryAllByTestId(NAV_MAP_ROW_TESTID);
}

interface HarnessOptions {
  readonly model?: NavigationMapModel;
  readonly reducedMotion?: boolean;
  readonly onRunVerb?: (verbId: string) => void;
}

/**
 * An interactive owner of `open`: the invoker must be focused BEFORE the flip so the map can
 * capture it (R-2.4). `sibling` gives the detached-invoker fallback somewhere to land.
 */
function MapHarness({ model, reducedMotion, onRunVerb }: HarnessOptions): React.ReactElement {
  const activeModel = model ?? mapAt();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="map-invoker"
        onClick={() => setOpen(true)}
      >
        Open map
      </button>
      <button type="button" data-testid="map-sibling">
        Sibling control
      </button>
      <NavigationMap
        model={activeModel}
        open={open}
        onClose={() => setOpen(false)}
        onRunVerb={onRunVerb ?? (() => {})}
        platform="windows"
        reducedMotion={reducedMotion}
      />
    </>
  );
}

/** Focus the invoker, activate it, and wait for the open focus contract (search first). */
async function openMap(): Promise<HTMLElement> {
  const invoker = screen.getByTestId('map-invoker');
  invoker.focus();
  expect(invoker).toHaveFocus();
  fireEvent.click(invoker);
  await waitFor(() => expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument());
  return invoker;
}

afterEach(() => {
  cleanup();
});

/* ─────────────────────────── Q2-01 — open / close / seed ─────────────────────────── */

describe('NavigationMap — open, close and the filteredTo seed (Q2-01 / R-2.1)', () => {
  it('renders nothing at all when closed and moves no focus', () => {
    const outside = renderWithChakra(
      <button type="button">outside the map</button>,
    );
    const control = outside.getByRole('button', { name: 'outside the map' });
    control.focus();
    expect(control).toHaveFocus();

    renderWithChakra(
      <NavigationMap model={mapAt()} open={false} onClose={vi.fn()} onRunVerb={vi.fn()} />,
    );

    expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull();
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(control).toHaveFocus();
  });

  it('opens as a labelled modal dialog with the map surface marker and focuses the search', async () => {
    renderWithChakra(<MapHarness />);
    await openMap();

    const dialog = screen.getByTestId(NAV_MAP_TESTID);
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', NAV_MAP_ARIA_LABEL);
    expect(dialog).toHaveAttribute('data-nav-surface', 'map');
    expect(screen.getByRole('dialog', { name: NAV_MAP_ARIA_LABEL })).toBe(dialog);

    await waitFor(() => expect(screen.getByTestId(NAV_MAP_SEARCH_TESTID)).toHaveFocus());
  });

  it('opens the FULL tree from a `? Map` trigger (filteredTo === null, empty search)', async () => {
    const model = mapAt(ROOT_PATH, null);
    expect(model.filteredTo).toBeNull();
    renderWithChakra(<MapHarness model={model} />);
    await openMap();

    expect(screen.getByTestId(NAV_MAP_SEARCH_TESTID)).toHaveValue('');
    expect(placeBlocks()).toHaveLength(model.places.length);
  });

  it('opens filtered from `more…` — the search is seeded with that place path label', async () => {
    const model = mapAt(ROOT_PATH, FIXTURE_PLACES.arrange);
    expect(model.filteredTo).toBe(FIXTURE_PLACES.arrange);
    renderWithChakra(<MapHarness model={model} />);
    await openMap();

    expect(screen.getByTestId(NAV_MAP_SEARCH_TESTID)).toHaveValue('Canvas › Arrange');

    const blocks = placeBlocks();
    expect(blocks.map((block) => block.getAttribute('data-nav-place-id'))).toEqual([
      FIXTURE_PLACES.arrange,
    ]);
  });

  it('shows the empty-result state when filteredTo names an unknown place', async () => {
    const model = mapAt(ROOT_PATH, 'test.missing');
    renderWithChakra(<MapHarness model={model} />);
    await openMap();

    expect(screen.getByTestId(NAV_MAP_EMPTY_TESTID).textContent).toBe(NAV_MAP_EMPTY_COPY);
    expect(placeBlocks()).toHaveLength(0);
  });

  it('closes, unmounts cleanly and re-opens without a leaked node', async () => {
    renderWithChakra(<MapHarness />);
    const invoker = await openMap();

    fireEvent.keyDown(screen.getByTestId(NAV_MAP_TESTID), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());
    expect(invoker).toHaveFocus();

    fireEvent.click(invoker);
    await waitFor(() => expect(screen.getAllByTestId(NAV_MAP_TESTID)).toHaveLength(1));
  });
});

/* ─────────────────────────── Q2-02 — tree + sections ─────────────────────────── */

describe('NavigationMap — the whole tree and its three key sections (Q2-02 / R-2.2)', () => {
  it('lists every place in deriveMap tree order (root first, declaration order within)', async () => {
    const surface = navTestSurface();
    const model = mapAt(EDIT_PATH);
    const declaredOrder = deriveMap(surface).map((row) => row.placePath[row.placePath.length - 1]);

    renderWithChakra(<MapHarness model={model} />);
    await openMap();

    expect(placeBlocks().map((block) => block.getAttribute('data-nav-place-id'))).toEqual(
      declaredOrder,
    );
    expect(declaredOrder).toHaveLength(7);
    expect(placeBlocks()[0]?.getAttribute('data-nav-place-id')).toBe(FIXTURE_PLACES.canvas);
  });

  it('marks exactly one current place, with a text chip and aria-current on the heading', async () => {
    renderWithChakra(<MapHarness model={mapAt(EDIT_PATH)} />);
    await openMap();

    const current = document.querySelectorAll('[data-nav-current]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('data-nav-place-id', FIXTURE_PLACES.edit);
    expect(within(current[0] as HTMLElement).getByText(NAV_MAP_CURRENT_LABEL)).toBeTruthy();
    expect(
      (current[0] as HTMLElement).querySelector('h3')?.getAttribute('aria-current'),
    ).toBe('true');
  });

  it('renders each place path label, its verbs with availability/risk, and its place keys', async () => {
    renderWithChakra(<MapHarness model={mapAt(EDIT_PATH)} />);
    await openMap();

    const create = placeBlocks().find(
      (block) => block.getAttribute('data-nav-place-id') === FIXTURE_PLACES.create,
    );
    expect(create).toBeDefined();
    expect(within(create!).getByText('Canvas › Create')).toBeTruthy();

    const createRows = within(create!).getAllByTestId(NAV_MAP_ROW_TESTID);
    expect(createRows.map((row) => row.getAttribute('data-nav-verb-id'))).toEqual([
      'test.rect',
      'test.ellipse',
    ]);
    expect(createRows[0]?.getAttribute('data-nav-availability')).toBe('available');
    expect(createRows[0]?.getAttribute('title')).toContain('Rectangle');

    // Place keys live INSIDE the block and are non-interactive (no tab stop).
    const createKeys = within(create!).getAllByTestId(NAV_MAP_KEY_TESTID);
    expect(createKeys.map((key) => key.getAttribute('data-testid'))).toEqual([
      NAV_MAP_KEY_TESTID,
      NAV_MAP_KEY_TESTID,
    ]);
    for (const key of createKeys) {
      expect(key).not.toHaveAttribute('tabindex');
      expect(key.querySelector('button')).toBeNull();
    }

    const edit = placeBlocks().find(
      (block) => block.getAttribute('data-nav-place-id') === FIXTURE_PLACES.edit,
    );
    const editRows = within(edit!).getAllByTestId(NAV_MAP_ROW_TESTID);
    const paste = editRows.find((row) => row.getAttribute('data-nav-verb-id') === 'test.paste');
    expect(paste).toBeDefined();
    expect(paste).toHaveAttribute('data-nav-availability', 'disabled');
    expect(paste).toHaveAttribute('aria-disabled', 'true');
    expect(paste!.getAttribute('title')).toContain(NAV_UNAVAILABLE_REASON);

    // The destructive verb conveys its class as TEXT, never colour only (R-7.2).
    expect(within(edit!).getByText(NAV_RISK_LABELS.destructive)).toBeTruthy();
  });

  it('keeps aliases in their own section AFTER every place block, and globals after them', async () => {
    renderWithChakra(<MapHarness model={mapAt(ROOT_PATH)} />);
    await openMap();

    const aliases = screen.getAllByTestId(NAV_MAP_ALIAS_TESTID);
    expect(aliases).toHaveLength(4);
    expect(aliases.map((alias) => alias.textContent)).toEqual([
      expect.stringContaining('Rectangle'),
      expect.stringContaining('Ellipse'),
      expect.stringContaining('journal.undo'),
      expect.stringContaining('journal.redo'),
    ]);

    // An alias row never lives inside a place block.
    for (const block of placeBlocks()) {
      expect(block.querySelector(`[data-testid="${NAV_MAP_ALIAS_TESTID}"]`)).toBeNull();
    }

    const lastPlaceBlock = placeBlocks()[placeBlocks().length - 1];
    expect(lastPlaceBlock).toBeDefined();
    expect(
      lastPlaceBlock!.compareDocumentPosition(aliases[0] as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(screen.getByText(NAV_MAP_ALIASES_HEADING)).toBeTruthy();
    expect(screen.getByText(NAV_MAP_GLOBALS_HEADING)).toBeTruthy();

    const globals = screen.getAllByTestId(NAV_MAP_GLOBAL_TESTID);
    expect(globals).toHaveLength(2);
    expect(globals[0]?.textContent).toContain('Map');
    expect(globals[0]?.textContent).toContain('(m)');
    expect(globals[1]?.textContent).toContain('Ask');
    expect(globals[1]?.textContent).toContain('(k)');
    expect(
      within(globals[0]!).getByRole('img', { name: NAV_GLYPH_ACCESSIBLE_NAME['?'] }),
    ).toBeTruthy();
    expect(
      within(globals[1]!).getByRole('img', { name: NAV_GLYPH_ACCESSIBLE_NAME['/'] }),
    ).toBeTruthy();

    // Aliases precede the globals; both follow every place block.
    expect(
      aliases[aliases.length - 1]!.compareDocumentPosition(globals[0] as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('lists a place with zero verbs and zero keys without dropping it', async () => {
    renderWithChakra(<MapHarness model={mapAt(ROOT_PATH)} />);
    await openMap();

    const view = placeBlocks().find(
      (block) => block.getAttribute('data-nav-place-id') === FIXTURE_PLACES.view,
    );
    expect(view).toBeDefined();
    expect(within(view!).queryAllByTestId(NAV_MAP_ROW_TESTID)).toHaveLength(0);
    expect(within(view!).queryAllByTestId(NAV_MAP_KEY_TESTID)).toHaveLength(0);
  });

  it('renders the bound keyboard-hint footer', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();
    expect(screen.getByText(NAV_MAP_HINT_COPY)).toBeTruthy();
  });
});

/* ─────────────────────────── Q2-03 — keyboard ─────────────────────────── */

describe('NavigationMap — arrows, Enter and Escape (Q2-03 / R-2.3)', () => {
  it('moves the active verb row with ArrowDown/ArrowUp and wraps at both ends', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    const rows = verbRows();
    expect(rows.length).toBeGreaterThan(2);
    const dialog = screen.getByTestId(NAV_MAP_TESTID);

    // From the search field, ArrowDown enters the row list at the first row.
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    expect(rows[0]).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    expect(rows[0]).toHaveFocus();

    // Wrap backwards off the first row to the last.
    fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    expect(rows[rows.length - 1]).toHaveFocus();

    // Wrap forwards off the last row to the first.
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    expect(rows[0]).toHaveFocus();
  });

  it('runs the active enabled verb exactly once on Enter and closes', async () => {
    const onRunVerb = vi.fn();
    renderWithChakra(<MapHarness model={mapAt()} onRunVerb={onRunVerb} />);
    const invoker = await openMap();

    const first = verbRows()[0];
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });

    expect(onRunVerb).toHaveBeenCalledTimes(1);
    expect(onRunVerb).toHaveBeenCalledWith('test.create');
    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());
    expect(invoker).toHaveFocus();
  });

  it('does not run or close when Enter hits a disabled verb row', async () => {
    const onRunVerb = vi.fn();
    renderWithChakra(<MapHarness model={mapAt(EDIT_PATH)} onRunVerb={onRunVerb} />);
    await openMap();

    const paste = verbRows().find(
      (row) => row.getAttribute('data-nav-verb-id') === 'test.paste',
    );
    expect(paste).toHaveAttribute('data-nav-availability', 'disabled');

    paste!.focus();
    fireEvent.keyDown(paste as HTMLElement, { key: 'Enter' });

    expect(onRunVerb).not.toHaveBeenCalled();
    expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument();
  });

  it('closes once on Escape', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    const dialog = screen.getByTestId(NAV_MAP_TESTID);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());
  });

  it('adds no document- or window-level keydown listener (handler scoped to the dialog)', () => {
    const code = stripComments(readSource(SOURCE_PATH));
    expect(code).not.toContain('document.addEventListener');
    expect(code).not.toContain('window.addEventListener');
    expect(code).not.toMatch(/addEventListener\(\s*['"]keydown/);
    // The handler is wired to the dialog content's own onKeyDown prop.
    expect(code).toContain('onKeyDown={handleKeyDown}');
  });
});

/* ─────────────────────────── Q2-04 — focus restore ─────────────────────────── */

describe('NavigationMap — focus returns to the invoker, never body (Q2-04 / R-2.4)', () => {
  it('restores focus after Escape', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    const invoker = await openMap();

    fireEvent.keyDown(screen.getByTestId(NAV_MAP_TESTID), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());
    expect(invoker).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('restores focus after a backdrop click', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    const invoker = await openMap();

    const backdrop = document.querySelector('[data-part="backdrop"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);

    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());
    expect(invoker).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('restores focus after a ran verb', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    const invoker = await openMap();

    const first = verbRows()[0];
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());
    expect(invoker).toHaveFocus();
  });

  it('lands on a still-rendered control when the invoker was detached before close', async () => {
    function DetachedHarness(): React.ReactElement {
      const [open, setOpen] = React.useState(false);
      const [showInvoker, setShowInvoker] = React.useState(true);
      return (
        <>
          {showInvoker ? (
            <button
              type="button"
              data-testid="map-invoker"
              onClick={() => setOpen(true)}
            >
              Open map
            </button>
          ) : null}
          <button
            type="button"
            data-testid="drop-invoker"
            onClick={() => setShowInvoker(false)}
          >
            Drop invoker
          </button>
          <button type="button" data-testid="map-sibling">
            Sibling control
          </button>
          <NavigationMap
            model={mapAt()}
            open={open}
            onClose={() => setOpen(false)}
            onRunVerb={() => {}}
            platform="windows"
          />
        </>
      );
    }

    renderWithChakra(<DetachedHarness />);
    const invoker = screen.getByTestId('map-invoker');
    invoker.focus();
    fireEvent.click(invoker);
    await waitFor(() => expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('drop-invoker'));
    expect(screen.queryByTestId('map-invoker')).toBeNull();

    fireEvent.keyDown(screen.getByTestId(NAV_MAP_TESTID), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());

    expect(document.activeElement).not.toBe(document.body);
    const active = document.activeElement;
    expect(active).toBeInstanceOf(HTMLElement);
    expect((active as HTMLElement).closest('[data-testid="map-invoker"]')).toBeNull();
  });

  it('calls onClose exactly once when Escape is pressed twice', async () => {
    const onClose = vi.fn();
    function CountingHarness(): React.ReactElement {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" data-testid="map-invoker" onClick={() => setOpen(true)}>
            Open map
          </button>
          <NavigationMap
            model={mapAt()}
            open={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            onRunVerb={() => {}}
          />
        </>
      );
    }

    renderWithChakra(<CountingHarness />);
    const invoker = screen.getByTestId('map-invoker');
    invoker.focus();
    fireEvent.click(invoker);
    await waitFor(() => expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument());

    const dialog = screen.getByTestId(NAV_MAP_TESTID);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/* ─────────────────────────── Q2-05 — focus trap ─────────────────────────── */

describe('NavigationMap — Tab wraps inside the dialog and releases on close (Q2-05 / R-2.5)', () => {
  it('wraps forward from the last focusable to the first, staying inside the map', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    const dialog = screen.getByTestId(NAV_MAP_TESTID);
    const focusables = getFocusableElements(dialog);
    expect(focusables.length).toBeGreaterThan(2);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last?.focus();
    expect(last).toHaveFocus();

    fireEvent.keyDown(last as HTMLElement, { key: 'Tab' });
    expect(first).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('wraps backward from the first focusable to the last', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    const dialog = screen.getByTestId(NAV_MAP_TESTID);
    const focusables = getFocusableElements(dialog);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    first?.focus();
    expect(first).toHaveFocus();

    fireEvent.keyDown(first as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('keeps a mid-walk Tab inside the dialog (the trap owns focus, never `body`)', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    const dialog = screen.getByTestId(NAV_MAP_TESTID);
    const search = screen.getByTestId(NAV_MAP_SEARCH_TESTID);
    search.focus();
    fireEvent.keyDown(search, { key: 'Tab' });

    // Whether the browser's native walk or the dialog's trap performs the move, the focused
    // element is always a descendant of the dialog — never an outside control or `body`.
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('releases the trap on close — focus is outside the (removed) dialog', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    const invoker = await openMap();

    fireEvent.keyDown(screen.getByTestId(NAV_MAP_TESTID), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());

    expect(document.activeElement).not.toBe(document.body);
    expect(invoker).toHaveFocus();
    expect(invoker.closest(`[data-testid="${NAV_MAP_TESTID}"]`)).toBeNull();
  });
});

/* ─────────────────────────── Q2-06 — search ─────────────────────────── */

describe('NavigationMap — search filters the SAME model (Q2-06 / R-2.6)', () => {
  it('exposes the bound accessible name and filters case-insensitively over verbs', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    const search = screen.getByTestId(NAV_MAP_SEARCH_TESTID);
    expect(search).toHaveAttribute('aria-label', NAV_MAP_SEARCH_LABEL);

    fireEvent.change(search, { target: { value: 'RECT' } });

    const renderedVerbs = verbRows().map((row) => row.getAttribute('data-nav-verb-id'));
    expect(renderedVerbs).toContain('test.rect');
    expect(renderedVerbs.every((id) => id !== 'test.ellipse')).toBe(true);

    // Filtering never builds a second list: every rendered row is a model row.
    const modelVerbIds = new Set(
      mapAt().places.flatMap((place) => place.verbs.map((verb) => verb.verbId)),
    );
    for (const id of renderedVerbs) expect(modelVerbIds.has(id as string)).toBe(true);

    // The alias section is filtered from the same model, not regenerated.
    expect(screen.getAllByTestId(NAV_MAP_ALIAS_TESTID)).toHaveLength(1);
  });

  it('matches a place path label and renders that whole block', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    fireEvent.change(screen.getByTestId(NAV_MAP_SEARCH_TESTID), {
      target: { value: 'Canvas › Create' },
    });

    const blocks = placeBlocks();
    expect(blocks.map((block) => block.getAttribute('data-nav-place-id'))).toEqual([
      FIXTURE_PLACES.create,
    ]);
    // The matching block renders WHOLE — both of its bound verbs.
    expect(verbRows()).toHaveLength(2);
  });

  it('matches an alias on its target label, leaving place blocks hidden', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    fireEvent.change(screen.getByTestId(NAV_MAP_SEARCH_TESTID), {
      target: { value: 'und' },
    });

    expect(placeBlocks()).toHaveLength(0);
    const aliases = screen.getAllByTestId(NAV_MAP_ALIAS_TESTID);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.textContent).toContain('journal.undo');
  });

  it('shows the bound no-match copy and keeps focus in the search field', async () => {
    renderWithChakra(<MapHarness model={mapAt()} />);
    await openMap();

    const search = screen.getByTestId(NAV_MAP_SEARCH_TESTID);
    search.focus();
    fireEvent.change(search, { target: { value: 'zzz-no-match' } });

    expect(screen.getByTestId(NAV_MAP_EMPTY_TESTID).textContent).toBe(NAV_MAP_EMPTY_COPY);
    expect(placeBlocks()).toHaveLength(0);
    expect(screen.queryAllByTestId(NAV_MAP_ALIAS_TESTID)).toHaveLength(0);
    expect(screen.queryAllByTestId(NAV_MAP_GLOBAL_TESTID)).toHaveLength(0);
    expect(search).toHaveFocus();
  });

  it('restores the full tree for an empty or whitespace-only query', async () => {
    const model = mapAt();
    renderWithChakra(<MapHarness model={model} />);
    await openMap();

    const search = screen.getByTestId(NAV_MAP_SEARCH_TESTID);
    fireEvent.change(search, { target: { value: 'rect' } });
    expect(placeBlocks().length).toBeLessThan(model.places.length);

    fireEvent.change(search, { target: { value: '   ' } });
    expect(placeBlocks()).toHaveLength(model.places.length);

    fireEvent.change(search, { target: { value: '' } });
    expect(placeBlocks()).toHaveLength(model.places.length);
  });
});

/* ─────────────────────────── Q5-01 (map leg) — motion ─────────────────────────── */

describe('NavigationMap — opacity/transform motion, gated by reducedMotion (R-5.1 / Q5-01)', () => {
  it('animates only opacity/transform and disables both layers under the prop', async () => {
    const source = stripComments(readSource(SOURCE_PATH));
    const motionLines = source.split('\n').filter((line) => /animation|transition/.test(line));
    expect(motionLines.length).toBeGreaterThan(0); // non-vacuity
    for (const line of motionLines) {
      expect(line).not.toMatch(
        /\b(?:width|height|left|top|right|bottom|margin|padding|filter|box-shadow)\b/,
      );
    }
    expect(source).toMatch(/reducedMotion/);
    expect(source).toContain('transform: scale(0.98)');
    expect(source).toContain('opacity');

    renderWithChakra(<MapHarness model={mapAt()} reducedMotion={false} />);
    await openMap();
    expect(screen.getByTestId(NAV_MAP_TESTID).style.animation).toBe(
      'navigation-map-in 150ms ease',
    );
    cleanup();

    renderWithChakra(<MapHarness model={mapAt()} reducedMotion />);
    await openMap();
    const content = screen.getByTestId(NAV_MAP_TESTID);
    expect(content.style.animation).toBe('none');
    expect(content.style.transition).toBe('none');
  });
});

/* ─────────────────────────── Q7-01 — map focus legs ─────────────────────────── */

describe('NavigationMap — keyboard reachability (Q7-01 map legs / R-7.1)', () => {
  it('exposes the search, close trigger and every verb row as named, focusable controls', async () => {
    renderWithChakra(<MapHarness model={mapAt(EDIT_PATH)} />);
    await openMap();

    expect(screen.getByRole('textbox', { name: NAV_MAP_SEARCH_LABEL })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();

    for (const row of verbRows()) {
      expect(row).toHaveAttribute('aria-label');
      expect((row.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    }

    // Place keys / aliases / globals are informational — never tab stops.
    for (const row of [
      ...screen.queryAllByTestId(NAV_MAP_KEY_TESTID),
      ...screen.queryAllByTestId(NAV_MAP_ALIAS_TESTID),
      ...screen.queryAllByTestId(NAV_MAP_GLOBAL_TESTID),
    ]) {
      expect(row).not.toHaveAttribute('tabindex');
    }
  });

  it('renders a visible token focus ring source on the verb rows (no outline: none)', () => {
    const code = stripComments(readSource(SOURCE_PATH));
    expect(code).toContain('var(--accent-strong)');
    expect(code).not.toMatch(/outline\s*:\s*['"]none['"]/);
  });
});
