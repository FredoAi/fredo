/**
 * Wireframe rail parity (Spec #3119, ST-7 — R-3/AC3, R-3a, R-3b, R-4/AC4; shell
 * placement added by Spec #3120 ST-6 — R-1.7 / F-N31).
 *
 * The shell is the REAL `WireframeEditor` over the REAL navigation host and the REAL
 * P4 projections; only the Konva canvas implementation is replaced by a static host
 * element (the canvas is ST-5's surface, not this suite's subject). Every assertion
 * therefore reads either the rendered bar/map/trail DOM or the ONE declaration and
 * its projections — never a component-local key table or availability boolean.
 *
 * The bottom-bar placement cases pin the shell's column order: the workspace row
 * (canvas + details, exactly two children) → the command bar → the status bar; no
 * 266 px left column exists (R-8).
 *
 * Titles are authored to the QA Expert's literal manifest (G-419).
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  ENGINE_VERB_IDS,
  createJournalStore,
  type ContextSnapshot,
} from '@/shared/navigation';
import {
  NAV_MAP_SEARCH_TESTID,
  NAV_MAP_TESTID,
  NAV_RAIL_BREADCRUMB_TESTID,
  NAV_RAIL_MORE_TESTID,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_ROW_TESTID,
  NAV_RAIL_TESTID,
  NavigationProvider,
  buildCommandRailModel,
  buildNavigationMapModel,
  createNavigationHost,
  resetNavigationAnnouncer,
  resetNavigationKeyDispatchForTests,
} from '@/shared/navigation/ui';
import { WIREFRAME_ACTIONS } from '../actions/wireframeActions';
import { WireframeEditor } from '../components/WireframeEditor';
import {
  DEFAULT_ICON_ID,
  DEFAULT_SECTION_PRESET,
  DEFAULT_SHAPE_KIND,
  createDefaultElement,
} from '../model/elements';
import {
  applyDocumentPatch,
  dispatch,
  getNavigationJournal,
  getSnapshot,
  resetWireframeStoreForTests,
  select,
  type WireframeDocumentPatch,
} from '../store/wireframeDocumentStore';
import {
  WIREFRAME_MAP_DEFAULT_ARGS,
  WIREFRAME_ROOT_PLACE_ID,
  WIREFRAME_SURFACE_APP_ID,
  resetWireframeSurfaceForTests,
  wireframeSurface,
} from '../wireframeSurface';

// The Konva canvas is another sub-task's surface; this suite is the shell layout +
// rail/map parity. A static host element keeps the shell real without mounting Konva.
vi.mock('../components/WireframeCanvas', async () => {
  const ReactModule = await import('react');
  return {
    WireframeCanvas: () =>
      ReactModule.createElement('div', { 'data-testid': 'wireframe-canvas' }),
  };
});

/* ───────────────────────────── fixtures ───────────────────────────── */

/** Constructed so this file is not itself a legacy-attribute scan hit. */
const LEGACY_KEY_ATTR = ['data', 'hotkey'].join('-');

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';
const EDIT = 'wireframe.edit';
const ARRANGE = 'wireframe.arrange';
const STYLE = 'wireframe.style';
const VIEW = 'wireframe.view';
const FILE = 'wireframe.file';

const PLACES = [
  { key: 'c', id: CREATE, label: 'Create' },
  { key: 'e', id: EDIT, label: 'Edit' },
  { key: 'a', id: ARRANGE, label: 'Arrange' },
  { key: 's', id: STYLE, label: 'Style' },
  { key: 'v', id: VIEW, label: 'View' },
  { key: 'f', id: FILE, label: 'File' },
] as const;

/** The locked action counts (Q-7): `rows.length + overflow`, globals/place rows excluded. */
const PLACE_ACTION_COUNTS: Readonly<Record<string, number>> = {
  [CANVAS]: 2,
  [CREATE]: 9,
  [EDIT]: 5,
  [ARRANGE]: 8,
  [STYLE]: 5,
  [VIEW]: 5,
  [FILE]: 4,
};

function selectionOf(count: number, kinds: readonly string[]) {
  return {
    count,
    kinds,
    label: kinds[0] ?? null,
    ids: kinds.map((_kind, index) => `sel-${index}`),
  };
}

function context(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    appId: WIREFRAME_SURFACE_APP_ID,
    placePath: [WIREFRAME_ROOT_PLACE_ID],
    selection: selectionOf(0, []),
    dirty: false,
    ...overrides,
  };
}

function placeContext(placeId: string, overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return context({
    placePath: placeId === CANVAS ? [CANVAS] : [CANVAS, placeId],
    ...overrides,
  });
}

function renderShell(): void {
  renderWithChakra(React.createElement(WireframeEditor));
}

function root(): HTMLElement {
  return screen.getByTestId('wireframe-root');
}

/** Press one stroke on the REAL shell-root adapter. */
async function press(key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(root(), { key });
  });
}

/** Close the open navigation map through its own close trigger. */
async function closeMap(): Promise<void> {
  const map = screen.getByTestId(NAV_MAP_TESTID);
  const close = within(map).getByRole('button', { name: 'Close' });
  await act(async () => {
    fireEvent.click(close);
  });
}

function breadcrumbLabels(): string[] {
  const ol = screen.getByTestId(NAV_RAIL_BREADCRUMB_TESTID);
  return Array.from(ol.querySelectorAll('li')).map((li) => {
    const spans = li.querySelectorAll('span');
    return spans[spans.length - 1]?.textContent ?? '';
  });
}

function seedElement(type: 'text' | 'shape', id: string, x = 40): void {
  const { page } = getSnapshot().document;
  const element = createDefaultElement(type, { page, elements: [], id });
  dispatch('element.add', { element: { ...element, x, y: 20 } });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetNavigationAnnouncer();
  resetNavigationKeyDispatchForTests();
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetNavigationAnnouncer();
  resetNavigationKeyDispatchForTests();
  vi.restoreAllMocks();
});

/* ───────────────────────────── R-3 / AC3 ───────────────────────────── */

describe('rail + map replace the bar and the toolbar (R-3 / AC3)', () => {
  it('mounts the command rail and the navigation map and never the toolbar', async () => {
    renderShell();

    // The P4 surfaces + the shell's canvas region are mounted. Spec #3120: the rail testid
    // value is now `navigation-bar` (the bottom command bar).
    expect(screen.getByTestId(NAV_RAIL_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId('navigation-trail')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-canvas')).toBeInTheDocument();

    // The retired toolbar, hidden carrier and navigation announcer never mount.
    expect(screen.queryAllByTestId('wireframe-toolbar')).toHaveLength(0);
    expect(screen.queryAllByTestId('wireframe-hotkey-carrier')).toHaveLength(0);
    expect(screen.queryAllByTestId('navigation-announcer')).toHaveLength(0);
    expect(document.querySelectorAll(`[${LEGACY_KEY_ATTR}]`)).toHaveLength(0);

    // `?` opens the map at the root, through the declared `app.map` verb.
    await press('?');
    expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument();
    await closeMap();
    expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull();

    // `?` opens the map INSIDE Create too (never synthesised as `m`).
    await press('c');
    expect(root().getAttribute('data-wireframe-place')).toBe(CREATE);
    await press('?');
    expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument();
    await closeMap();

    // `m` stays place-scoped: inside Create it inserts an image and pops the transient place.
    const before = getSnapshot().document.elements.length;
    await press('m');
    const elements = getSnapshot().document.elements;
    expect(elements).toHaveLength(before + 1);
    expect(elements[elements.length - 1]?.type).toBe('image');
    expect(root().getAttribute('data-wireframe-place')).toBe(CANVAS);
    expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull();

    // `m` at the root opens the map; `/` is inert (dispatches nothing, opens nothing).
    await press('m');
    expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument();
    await closeMap();

    const entriesBefore = getNavigationJournal().entries().length;
    await press('/');
    expect(getNavigationJournal().entries().length).toBe(entriesBefore);
    expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull();
  });

  it('the rail breadcrumb reads Canvas then the current place', async () => {
    renderShell();

    expect(breadcrumbLabels()).toEqual(['Canvas']);
    expect(screen.getByTestId(NAV_RAIL_PLACE_TESTID).textContent).toBe('Canvas');

    for (const place of PLACES) {
      await press(place.key);
      expect(root().getAttribute('data-wireframe-place')).toBe(place.id);
      expect(breadcrumbLabels()).toEqual(['Canvas', place.label]);
      expect(screen.getByTestId(NAV_RAIL_PLACE_TESTID).textContent).toBe(place.label);

      await press('Escape');
      expect(breadcrumbLabels()).toEqual(['Canvas']);
      expect(root().getAttribute('data-wireframe-place')).toBe(CANVAS);
    }
  });

  it('the rail renders at most eight verb rows in every place', async () => {
    // Model level: the declaration never truncates; the rail caps at 8 + `more…`.
    for (const [placeId, actionCount] of Object.entries(PLACE_ACTION_COUNTS)) {
      const model = buildCommandRailModel(wireframeSurface, placeContext(placeId));
      expect(model.rows.length, placeId).toBeLessThanOrEqual(8);
      expect(model.rows.length + model.overflow, placeId).toBe(actionCount);
    }

    // DOM level: every place's rendered verb rows honour the same cap.
    renderShell();
    expect(screen.getAllByTestId(NAV_RAIL_ROW_TESTID)).toHaveLength(2);

    for (const place of PLACES) {
      await press(place.key);
      const rendered = screen.getAllByTestId(NAV_RAIL_ROW_TESTID);
      expect(rendered.length, place.id).toBeLessThanOrEqual(8);
      const model = buildCommandRailModel(wireframeSurface, placeContext(place.id));
      expect(rendered.length, place.id).toBe(model.rows.length);
      await press('Escape');
    }
  });

  it('the create place reports one overflow verb and opens the map filtered', async () => {
    const model = buildCommandRailModel(wireframeSurface, placeContext(CREATE));
    expect(model.rows).toHaveLength(8);
    expect(model.overflow).toBe(1);
    expect(model.actionCount).toBe(9);
    expect(model.more).toEqual({ label: 'more…', opensFilteredTo: CREATE });

    renderShell();
    await press('c');

    const more = screen.getByTestId(NAV_RAIL_MORE_TESTID);
    expect(more.textContent).toBe('more…');
    await act(async () => {
      fireEvent.click(more);
    });

    const map = screen.getByTestId(NAV_MAP_TESTID);
    // `more…` seeds the map with the place path label, so only Create's block survives.
    const search = screen.getByTestId(NAV_MAP_SEARCH_TESTID) as HTMLInputElement;
    expect(search.value).toContain('Create');
    // The 9th Create verb (the overflow row) is reachable in the filtered map.
    expect(map.querySelector('[data-nav-verb-id="wireframe.add.line"]')).not.toBeNull();
  });

  it('mounts no legacy bar and exactly ONE navigation announcer per webview', () => {
    renderWithChakra(
      React.createElement(
        NavigationProvider,
        null,
        React.createElement(
          'div',
          { 'data-fredo-app-id': WIREFRAME_SURFACE_APP_ID },
          React.createElement(WireframeEditor),
        ),
      ),
    );

    // ONE navigation region, ZERO legacy announcer (U-1 channel-scoped invariant).
    expect(screen.getAllByTestId('navigation-announcer')).toHaveLength(1);
    expect(screen.queryAllByTestId('hotkeys-announcer')).toHaveLength(0);
    expect(document.querySelectorAll(`[${LEGACY_KEY_ATTR}]`)).toHaveLength(0);
    expect(screen.queryAllByTestId('wireframe-toolbar')).toHaveLength(0);
  });

  it('every rail row availability comes from the host snapshot', async () => {
    renderShell();

    // Root: the two selection verbs are bound but unavailable with no selection.
    const rootRows = screen.getAllByTestId(NAV_RAIL_ROW_TESTID);
    expect(rootRows.map((row) => row.getAttribute('data-nav-availability'))).toEqual([
      'disabled',
      'disabled',
    ]);

    // A selection change (a pure store notify — no verb dispatch) flips the SAME rows.
    seedElement('text', 'text-1');
    await act(async () => {
      select('text-1');
    });
    expect(
      screen
        .getAllByTestId(NAV_RAIL_ROW_TESTID)
        .every((row) => row.getAttribute('data-nav-availability') === 'available'),
    ).toBe(true);

    // Inside Edit, the element-scoped verbs follow the same selection snapshot.
    await press('e');
    const editRows = screen.getAllByTestId(NAV_RAIL_ROW_TESTID);
    expect(editRows).toHaveLength(5);
    expect(editRows.every((row) => row.getAttribute('data-nav-availability') === 'available')).toBe(
      true,
    );

    const journalBefore = getNavigationJournal().entries().length;
    await act(async () => {
      select(null);
    });
    expect(
      screen
        .getAllByTestId(NAV_RAIL_ROW_TESTID)
        .every((row) => row.getAttribute('data-nav-availability') === 'disabled'),
    ).toBe(true);
    // A selection change is editor state: it never journals.
    expect(getNavigationJournal().entries().length).toBe(journalBefore);
  });
});

/* ───────────────────────────── R-3a / AC3 parity ───────────────────────────── */

/** The parity manifest: all 33 `toolbar: true` registry rows → declared verb id. */
const PARITY_MANIFEST: Readonly<Record<string, string>> = {
  'wireframe.add.text': 'wireframe.add.text',
  'wireframe.add.button': 'wireframe.add.button',
  'wireframe.add.input': 'wireframe.add.input',
  'wireframe.add.image': 'wireframe.add.image',
  'wireframe.add.icon': 'wireframe.add.icon',
  'wireframe.add.card': 'wireframe.add.card',
  'wireframe.add.section': 'wireframe.add.section',
  'wireframe.add.shape': 'wireframe.add.shape',
  'wireframe.add.line': 'wireframe.add.line',
  'wireframe.element.duplicate': 'wireframe.element.duplicate',
  'wireframe.element.delete': 'wireframe.element.delete',
  'wireframe.element.toggleLock': 'wireframe.element.toggleLock',
  'wireframe.edit.undo': 'journal.undo',
  'wireframe.edit.redo': 'journal.redo',
  'wireframe.zoom.in': 'wireframe.zoom.in',
  'wireframe.zoom.out': 'wireframe.zoom.out',
  'wireframe.view.fitPage': 'wireframe.view.fitPage',
  'wireframe.view.resetView': 'wireframe.view.resetView',
  'wireframe.view.togglePan': 'wireframe.view.togglePan',
  'wireframe.file.saveAs': 'place.saveAs',
  'wireframe.file.open': 'place.open',
  'wireframe.file.exportPng': 'place.exportPng',
  'wireframe.arrange.group': 'wireframe.arrange.group',
  'wireframe.arrange.ungroup': 'wireframe.arrange.ungroup',
  'wireframe.arrange.toggleGroupLock': 'wireframe.arrange.toggleGroupLock',
  'wireframe.arrange.toggleSnap': 'wireframe.arrange.toggleSnap',
  'wireframe.arrange.alignLeft': 'wireframe.arrange.alignLeft',
  'wireframe.arrange.alignCenter': 'wireframe.arrange.alignCenter',
  'wireframe.arrange.alignRight': 'wireframe.arrange.alignRight',
  'wireframe.arrange.distribute': 'wireframe.arrange.distribute',
  'wireframe.arrange.bringForward': 'wireframe.arrange.bringForward',
  'wireframe.arrange.sendBackward': 'wireframe.arrange.sendBackward',
  'wireframe.document.new': 'wireframe.document.new',
};

const DECLARED_VERB_IDS = new Set<string>([
  ...wireframeSurface.verbs.map((verb) => verb.id),
  ...ENGINE_VERB_IDS,
]);

describe('the 33-row capability parity (R-3a / AC3)', () => {
  it('the parity manifest has thirty-three rows', () => {
    const toolbarRows = WIREFRAME_ACTIONS.filter((action) => action.toolbar);
    // Seeded from the RUNTIME list (never a lone hard-coded literal).
    expect(toolbarRows).toHaveLength(33);
    expect(WIREFRAME_ACTIONS).toHaveLength(35);

    // The two Companion-only rows are deliberately NOT part of the manifest.
    const companionRows = WIREFRAME_ACTIONS.filter((action) => !action.toolbar);
    expect(companionRows.map((action) => action.id).sort()).toEqual([
      'wireframe.companion.draftApp',
      'wireframe.companion.listActions',
    ]);
    for (const row of companionRows) {
      expect(PARITY_MANIFEST[row.id]).toBeUndefined();
    }
  });

  it('every toolbar capability resolves to a declared verb', () => {
    const toolbarIds = WIREFRAME_ACTIONS.filter((action) => action.toolbar).map(
      (action) => action.id,
    );

    // Every runtime row resolves — an unmapped row FAILS the suite (no silent skip).
    for (const id of toolbarIds) {
      expect(PARITY_MANIFEST[id], `unmapped toolbar row ${id}`).toBeTruthy();
    }
    // …and the manifest adds no phantom row.
    expect(Object.keys(PARITY_MANIFEST).sort()).toEqual([...toolbarIds].sort());

    // Every target is a declared verb id or an engine-owned verb id.
    for (const [id, target] of Object.entries(PARITY_MANIFEST)) {
      expect(DECLARED_VERB_IDS.has(target), `${id} -> ${target}`).toBe(true);
    }

    // The five id-aliased rows are pinned LITERALLY.
    expect(PARITY_MANIFEST['wireframe.file.open']).toBe('place.open');
    expect(PARITY_MANIFEST['wireframe.file.saveAs']).toBe('place.saveAs');
    expect(PARITY_MANIFEST['wireframe.file.exportPng']).toBe('place.exportPng');
    expect(PARITY_MANIFEST['wireframe.edit.undo']).toBe('journal.undo');
    expect(PARITY_MANIFEST['wireframe.edit.redo']).toBe('journal.redo');

    // Negative control: the retired registry ids are NOT declared verbs themselves.
    expect(DECLARED_VERB_IDS.has('wireframe.file.open')).toBe(false);
    expect(DECLARED_VERB_IDS.has('wireframe.edit.undo')).toBe(false);
  });
});

/* ───────────────────────────── R-3b reachability ───────────────────────────── */

function verbsReachableByKey(): Set<string> {
  const reachable = new Set<string>();
  for (const place of wireframeSurface.tree.places) {
    for (const binding of Object.values(place.keys)) {
      // A place binding enters a place whose id IS the place-entry verb id.
      reachable.add(binding.kind === 'verb' ? binding.verbId : binding.placeId);
    }
  }
  for (const target of Object.values(wireframeSurface.tree.directAliases)) {
    reachable.add(target);
  }
  return reachable;
}

function availableInSomeContext(verbId: string): boolean {
  const contexts: ContextSnapshot[] = [
    context(),
    context({ selection: selectionOf(1, ['shape']) }),
    context({ selection: selectionOf(1, ['text']) }),
    context({ selection: selectionOf(1, ['button']) }),
    // Spec #3120 ST-3 — the named text-edit verbs need their own kind contexts.
    context({ selection: selectionOf(1, ['input']) }),
    context({ selection: selectionOf(1, ['card']) }),
    context({ selection: selectionOf(2, ['shape', 'shape']) }),
    context({ selection: selectionOf(3, ['shape', 'shape', 'shape']) }),
  ];
  const verb = wireframeSurface.verbs.find((candidate) => candidate.id === verbId);
  if (verb === undefined) return false;
  return contexts.some((snapshot) => {
    const map = buildNavigationMapModel(wireframeSurface, snapshot);
    return verb.appliesTo.places.some((placeId) => {
      const block = map.places.find((place) => place.placeId === placeId);
      return (
        block !== undefined &&
        block.verbs.some((row) => row.verbId === verbId && row.available)
      );
    });
  });
}

describe('every declared verb is reachable (R-3b / AC3)', () => {
  it('every argument-requiring capability performs from the map with its default', async () => {
    // 1 — every declared verb is key-bound somewhere OR available in its map block.
    const keyReachable = verbsReachableByKey();
    const unreachable = wireframeSurface.verbs
      .map((verb) => verb.id)
      .filter((id) => !keyReachable.has(id) && !availableInSomeContext(id));
    expect(unreachable).toEqual([]);

    // Engine undo/redo are reachable through the root aliases.
    expect(keyReachable.has('journal.undo')).toBe(true);
    expect(keyReachable.has('journal.redo')).toBe(true);

    // Spec #3120 (rework) — `app.ask` is available and opens the companion composer.
    const rootMap = buildNavigationMapModel(wireframeSurface, context());
    const canvasBlock = rootMap.places.find((place) => place.placeId === CANVAS);
    expect(canvasBlock?.verbs.find((verb) => verb.verbId === 'app.ask')?.available).toBe(true);

    // 2 — the three argument-requiring map capabilities PERFORM with the declared defaults.
    expect(WIREFRAME_MAP_DEFAULT_ARGS).toEqual({
      'wireframe.add.icon': { iconId: DEFAULT_ICON_ID },
      'wireframe.add.shape': { shape: DEFAULT_SHAPE_KIND },
      'wireframe.add.section': { preset: DEFAULT_SECTION_PRESET },
    });

    const journal = createJournalStore();
    const host = createNavigationHost({
      surface: wireframeSurface,
      getContext: () => context(),
      journal,
      applyPatch: (patch) =>
        applyDocumentPatch(patch as unknown as WireframeDocumentPatch),
      confirm: () => true,
    });

    const cases = [
      { verbId: 'wireframe.add.icon', check: { type: 'icon', iconId: DEFAULT_ICON_ID } },
      { verbId: 'wireframe.add.shape', check: { type: 'shape', shape: DEFAULT_SHAPE_KIND } },
      { verbId: 'wireframe.add.section', check: { type: 'section', preset: DEFAULT_SECTION_PRESET } },
    ] as const;

    for (const { verbId, check } of cases) {
      const before = getSnapshot().document.elements.length;
      // A bare `{}` must perform from the model defaults — `invalid-args` is a FAIL.
      const result = await host.runVerb(verbId, 'pointer', {});
      expect(result.status, verbId).not.toBe('rejected');
      expect(result.status, verbId).toBe('performed');
      const elements = getSnapshot().document.elements;
      expect(elements.length, verbId).toBe(before + 1);
      expect(elements[elements.length - 1], verbId).toMatchObject(check);
    }
  });
});

/* ──────────────── Spec #3120 ST-6 — bottom bar shell placement (R-1.7) ──────────────── */

const VIEWPORT = { width: 1280, height: 800 } as const;
const DETAILS_WIDTH = 288;
const BAR_HEIGHT = 44;
const STATUS_HEIGHT = 24;
const WORKSPACE_HEIGHT = VIEWPORT.height - BAR_HEIGHT - STATUS_HEIGHT;

function rectOf(top: number, height: number, left = 0, width = VIEWPORT.width): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom has no layout engine. This stub models the shell's COLUMN STACK — each root
 * child occupies its declared box in DOM ORDER (workspace = the flex remainder, the
 * bar and the status bar fixed) — so `bar.top >= workspace.bottom - 1` is a real
 * consequence of where the bar is rendered: a bar placed above the workspace reads
 * `top = 0` and fails. The workspace's own two children split their width (the
 * details column keeps 288 px, the canvas takes the rest) — the flex contract the
 * shell declares. The live rows (QA F-N31) measure the real browser geometry.
 */
function simulatedRect(el: Element): DOMRect {
  const rootEl = document.querySelector('[data-testid="wireframe-root"]');
  if (rootEl === null) return rectOf(0, 0);
  if (el === rootEl) return rectOf(0, VIEWPORT.height);
  const testId = el.getAttribute('data-testid');
  if (testId === 'wireframe-workspace' || testId === 'wireframe-command-bar' || testId === 'wireframe-status-bar') {
    let top = 0;
    for (const child of Array.from(rootEl.children)) {
      const childId = child.getAttribute('data-testid');
      const height =
        childId === 'wireframe-workspace'
          ? WORKSPACE_HEIGHT
          : childId === 'wireframe-command-bar'
            ? BAR_HEIGHT
            : childId === 'wireframe-status-bar'
              ? STATUS_HEIGHT
              : 0;
      if (child === el) return rectOf(top, height);
      top += height;
    }
    return rectOf(0, 0);
  }
  const region = el.getAttribute('data-wireframe-region');
  if (region === 'canvas') {
    return rectOf(0, WORKSPACE_HEIGHT, 0, VIEWPORT.width - DETAILS_WIDTH);
  }
  if (region === 'details') {
    return rectOf(0, WORKSPACE_HEIGHT, VIEWPORT.width - DETAILS_WIDTH, DETAILS_WIDTH);
  }
  return rectOf(0, 0);
}

describe('bottom bar shell placement (R-1.7) — F-N31', () => {
  it('the command bar sits below the workspace row and above the status bar', () => {
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        return simulatedRect(this);
      });

    try {
      renderShell();

      const workspace = screen.getByTestId('wireframe-workspace');
      const bar = screen.getByTestId('wireframe-command-bar');
      const status = screen.getByTestId('wireframe-status-bar');

      // The bar region CONTAINS the bar root; the region/value hooks are bound.
      expect(bar).toContainElement(screen.getByTestId(NAV_RAIL_TESTID));
      expect(bar.getAttribute('data-wireframe-region')).toBe('command-bar');

      // DOM order (real, independent of the rect stub): workspace → bar → status.
      expect(workspace.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(bar.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // Measured geometry: bar below the workspace, status below the bar.
      const workspaceRect = workspace.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      expect(barRect.top).toBeGreaterThanOrEqual(workspaceRect.bottom - 1);
      expect(statusRect.top).toBeGreaterThanOrEqual(barRect.bottom - 1);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('the workspace row is exactly canvas + details, with the canvas taking the rest of the width', () => {
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        return simulatedRect(this);
      });

    try {
      renderShell();

      const workspace = screen.getByTestId('wireframe-workspace');
      const children = Array.from(workspace.children) as HTMLElement[];

      // EXACTLY two children — canvas and the details column (no rail, no bar).
      expect(children).toHaveLength(2);
      expect(children.map((child) => child.getAttribute('data-wireframe-region'))).toEqual([
        'canvas',
        'details',
      ]);
      const canvas = children[0];
      const details = children[1];
      expect(details).toBe(screen.getByTestId('wireframe-details-column'));

      // No left command column / no bar inside the workspace (R-8).
      expect(workspace.querySelector('[data-wireframe-region="command-bar"]')).toBeNull();
      expect(workspace.querySelector('[data-testid="wireframe-command-bar"]')).toBeNull();

      // The details column holds the property panel AND the compact trail footer.
      expect(details.querySelector('[data-testid="wireframe-property-panel"]')).not.toBeNull();
      expect(details.querySelector('[data-testid="navigation-trail"]')).not.toBeNull();

      // The canvas fills the remaining width (≥ 2× the 288 px details column at 1280).
      const canvasRect = canvas.getBoundingClientRect();
      const detailsRect = details.getBoundingClientRect();
      expect(canvasRect.width).toBeGreaterThanOrEqual(detailsRect.width * 2);

      // The bar spans the full editor width.
      const bar = screen.getByTestId('wireframe-command-bar').getBoundingClientRect();
      expect(bar.width).toBe(VIEWPORT.width);
    } finally {
      rectSpy.mockRestore();
    }
  });
});
