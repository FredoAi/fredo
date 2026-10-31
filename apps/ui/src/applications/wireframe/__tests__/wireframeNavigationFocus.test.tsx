/**
 * Wireframe shell — command-bar focus retention (Spec #3119 retry, ST-F3; reworked for the
 * bottom command bar by Spec #3120 ST-5 — F-N30 / R-1.6; the `Ask` bridge cases added by
 * Spec #3120 ST-6 — F-N45 / R-1.8).
 *
 * The exact tester repro: focus a bar VERB row in the REAL shell and press `c`. Entering
 * `Create` replaces the verb cluster (a different place declares different verbs), so the
 * focused row unmounts; without a re-home, `document.activeElement` becomes `BODY` and the
 * shell's ONE element-scoped key adapter stops receiving strokes. The bar re-homes focus to
 * the current-place breadcrumb segment (`navigation-bar-place`, `tabIndex={-1}`) and returns
 * it to the triggering verb row when that place renders again.
 *
 * The shell is the REAL `WireframeEditor` over the REAL navigation host; only the Konva
 * canvas is replaced by a static host element (the canvas is another surface).
 *
 * Titles are authored to the Fix Plan's literal manifest (G-419).
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  NAV_RAIL_ASK_TESTID,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_ROW_TESTID,
  NAV_RAIL_TESTID,
  getNavigationHost,
  resolveLauncherConfirmation,
  resetNavigationAnnouncer,
  subscribeLauncherConfirmation,
  type NavigationHost,
  type PendingLauncherConfirmation,
} from '@/shared/navigation/ui';
import {
  resetCompanionComposerBridgeForTests,
  subscribeCompanionComposerOpen,
  type CompanionComposerOpenRequest,
} from '@/shared/companion/composerBridge';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import {
  WireframeNavigationProvider,
  useWireframeNavigation,
} from '../components/WireframeNavigationProvider';
import { WIREFRAME_SURFACE_APP_ID } from '../wireframeSurface';
import { WireframeEditor } from '../components/WireframeEditor';
import {
  clearSelection,
  getNavigationJournal,
  getSnapshot,
  loadDocument,
  resetWireframeStoreForTests,
  select,
} from '../store/wireframeDocumentStore';
import { createNewWireframeDocument } from '../model/document';
import { createDefaultElement } from '../model/elements';
import { resetWireframeSurfaceForTests } from '../wireframeSurface';

// The Konva canvas is another surface; a static host element keeps the shell real.
vi.mock('../components/WireframeCanvas', async () => {
  const ReactModule = await import('react');
  return {
    WireframeCanvas: () =>
      ReactModule.createElement('div', { 'data-testid': 'wireframe-canvas' }),
  };
});

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';

function root(): HTMLElement {
  return screen.getByTestId('wireframe-root');
}

function rail(): HTMLElement {
  return screen.getByTestId(NAV_RAIL_TESTID);
}

/** The currently rendered verb row for `verbId` (never cached — a transition unmounts it). */
function verbRow(verbId: string): HTMLElement {
  const row = screen
    .getAllByTestId(NAV_RAIL_ROW_TESTID)
    .find((candidate) => candidate.getAttribute('data-nav-verb-id') === verbId);
  if (row === undefined) {
    throw new Error(`verb row ${verbId} is not rendered`);
  }
  return row;
}

/** The current-place breadcrumb segment — the bar's programmatic focus anchor. */
function anchor(): HTMLElement {
  return screen.getByTestId(NAV_RAIL_PLACE_TESTID);
}

async function press(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, { key });
  });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
  resetCompanionComposerBridgeForTests();
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
  resetCompanionComposerBridgeForTests();
  vi.restoreAllMocks();
});

describe('wireframe command-bar focus retention (R-9 / AC9 / F-N30)', () => {
  /** The root place's first verb row — rendered at Canvas, unmounted inside Create. */
  const ROOT_VERB = 'wireframe.selection.previous';

  it('keeps focus in the bar when a place is entered from the keyboard', async () => {
    renderWithChakra(React.createElement(WireframeEditor));

    const row = verbRow(ROOT_VERB);
    row.focus();
    expect(row).toHaveFocus();

    await press(row, 'c');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CREATE));

    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active instanceof HTMLElement && rail().contains(active)).toBe(true);
    expect(active).toBe(anchor());
    expect(anchor()).toHaveAttribute('tabindex', '-1');
    expect(anchor().textContent).toBe('Create');
  });

  it('restores the triggering verb row when the place is exited from the keyboard', async () => {
    renderWithChakra(React.createElement(WireframeEditor));

    const row = verbRow(ROOT_VERB);
    row.focus();
    await press(row, 'c');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CREATE));
    await waitFor(() => expect(anchor()).toHaveFocus());

    await press(anchor(), 'Escape');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CANVAS));

    await waitFor(() => expect(verbRow(ROOT_VERB)).toHaveFocus());
    expect(verbRow(ROOT_VERB).getAttribute('data-nav-verb-id')).toBe(ROOT_VERB);
  });

  it('keeps focus in the bar when a transient place is popped with the pointer', async () => {
    const user = userEvent.setup();
    renderWithChakra(React.createElement(WireframeEditor));

    // Enter the transient `Create` place first, then activate an add verb with the pointer —
    // the transient place pops back to Canvas, replacing the whole verb cluster.
    const row = verbRow(ROOT_VERB);
    row.focus();
    await press(row, 'c');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CREATE));
    await waitFor(() => expect(anchor()).toHaveFocus());

    await user.click(verbRow('wireframe.add.text'));
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CANVAS));

    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active instanceof HTMLElement && rail().contains(active)).toBe(true);
  });

  it('keeps keyboard dispatch alive after a place entry', async () => {
    renderWithChakra(React.createElement(WireframeEditor));

    const row = verbRow(ROOT_VERB);
    row.focus();
    await press(row, 'c');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CREATE));
    await waitFor(() => expect(anchor()).toHaveFocus());

    // The next stroke must still reach the shell's element-scoped adapter from the re-homed
    // focus: Escape pops exactly one level back to the Canvas place.
    await press(anchor(), 'Escape');
    await waitFor(() => expect(root().getAttribute('data-wireframe-place')).toBe(CANVAS));
  });
});

/* ──────────────── P6 root-place context freshness (ST-4-R3, R-1.1 root leg) ──────────────── */

/**
 * Spec #3120 (P6), ST-4-R3 — the provider publishes its store's context changes to the host.
 * A store-only selection (`select`/`clearSelection`) never reaches a host mutation, so before
 * the fix the launcher memo (keyed on `epoch`) kept the root place's stale, selection-less
 * envelope. Case 1 is the defect's regression pin; case 3 is the apply guard (it already
 * passed on the pre-fix tip — it is NOT the freshness proof).
 */
describe('WireframeNavigationProvider — root-place context freshness (R-1.1 root leg)', () => {
  /** Load a saved (journal-free) document with one shape element (as wireframeJournal.test.ts does). */
  function seedShape(id: string): void {
    const base = createNewWireframeDocument('desktop');
    const element = createDefaultElement('shape', { page: base.page, elements: [], id });
    loadDocument({ ...base, elements: [element] }, 'C:/tmp/doc.wireframe.json');
  }

  it('a store-only selection at the root advances the host epoch and the envelope carries it', async () => {
    const host = await mountProviderHost();
    seedShape('shape-1');
    const before = host.getSnapshot().epoch;

    // NO host dispatch — the store mutator is the ONLY change (the exact defect lever).
    act(() => {
      select('shape-1');
    });

    const snapshot = host.getSnapshot();
    expect(snapshot.context.placePath).toEqual([CANVAS]);
    expect(snapshot.epoch).toBeGreaterThan(before);
    expect(host.describeContext().selection).toEqual({
      count: 1,
      ids: ['shape-1'],
      kinds: ['shape'],
      // A shape's `documentTitle` is its shape kind (`rect`).
      label: 'rect',
    });
  });

  it('clearing the selection advances the epoch and the envelope carries count 0', async () => {
    const host = await mountProviderHost();
    seedShape('shape-2');
    act(() => {
      select('shape-2');
    });
    const afterSelect = host.getSnapshot().epoch;

    act(() => {
      clearSelection();
    });

    expect(host.getSnapshot().epoch).toBeGreaterThan(afterSelect);
    expect(host.describeContext().selection.count).toBe(0);
    expect(host.describeContext().selection.label).toBeNull();
  });

  it('a companion intent at the root applies wireframe.style.fill with its argument', async () => {
    // NOTE: this leg already passed on the pre-fix tip — it is the AC1 APPLY guard, not the
    // freshness pin. The defect was that the model was told there was no selection.
    const host = await mountProviderHost();
    seedShape('shape-3');
    act(() => {
      select('shape-3');
    });

    let result: Awaited<ReturnType<typeof host.runIntent>> | undefined;
    await act(async () => {
      result = await host.runIntent({
        verbId: 'wireframe.style.fill',
        args: { fill: 'accent' },
        channel: 'agent',
        actor: 'companion',
      });
    });

    expect(result?.status).toBe('performed');

    const element = getSnapshot().document.elements[0];
    expect(element?.type).toBe('shape');
    if (element?.type !== 'shape') throw new Error('expected the seeded shape element');
    expect(element.fill).toBe('accent');

    const entries = host.getSnapshot().entries;
    expect(entries[entries.length - 1]).toMatchObject({
      verbId: 'wireframe.style.fill',
      actor: 'companion',
      label: 'Fill',
    });
  });
});

/* ──────────────── P6 launcher bridge + confirmation policy (ST-4) ──────────────── */

/** Captures the provider's ONE host without rendering any UI. */
function HostProbe({
  onReady,
}: {
  readonly onReady: (host: NavigationHost) => void;
}): null {
  const { host } = useWireframeNavigation();
  React.useEffect(() => {
    onReady(host);
  }, [host, onReady]);
  return null;
}

async function mountProviderHost(): Promise<NavigationHost> {
  let captured: NavigationHost | null = null;
  renderWithChakra(
    React.createElement(
      WireframeNavigationProvider,
      null,
      React.createElement(HostProbe, {
        onReady: (host: NavigationHost) => {
          captured = host;
        },
      }),
    ),
  );
  await waitFor(() => expect(captured).not.toBeNull());
  return captured as unknown as NavigationHost;
}

async function addAndSelectElement(host: NavigationHost): Promise<string> {
  await act(async () => {
    const result = await host.runIntent({
      verbId: 'wireframe.create.rect',
      args: { x: '10', y: '10', width: '40', height: '30' },
      channel: 'pointer',
      actor: 'human',
    });
    expect(result.status).toBe('performed');
  });
  const element = getSnapshot().document.elements[0];
  expect(element).toBeDefined();
  act(() => {
    select(element.id);
  });
  return element.id;
}

describe('WireframeNavigationProvider — host registry + composer bridge (R-1.8)', () => {
  it('registers the host on mount and unregisters it on unmount', async () => {
    const view = renderWithChakra(React.createElement(WireframeEditor));
    expect(getNavigationHost(WIREFRAME_SURFACE_APP_ID)).not.toBeNull();

    view.unmount();
    expect(getNavigationHost(WIREFRAME_SURFACE_APP_ID)).toBeNull();
  });

  /** Subscribe to the composer bridge for the duration of `run`, then detach. */
  function captureComposerRequests(run: () => void): CompanionComposerOpenRequest[] {
    const requests: CompanionComposerOpenRequest[] = [];
    const unsubscribe = subscribeCompanionComposerOpen((request) => requests.push(request));
    try {
      run();
    } finally {
      unsubscribe();
    }
    return requests;
  }

  it('clicking `navigation-bar-ask` publishes exactly one composer request for wireframe', () => {
    renderWithChakra(React.createElement(WireframeEditor));

    const requests = captureComposerRequests(() => {
      fireEvent.click(screen.getByTestId(NAV_RAIL_ASK_TESTID));
    });

    expect(requests).toEqual([
      { source: 'command-bar-ask', appId: 'wireframe', focus: true },
    ]);
  });

  it('pressing `k` publishes exactly one composer request for wireframe and journals nothing', async () => {
    renderWithChakra(React.createElement(WireframeEditor));
    const entriesBefore = getNavigationJournal().entries().length;

    const requests = captureComposerRequests(() => {
      fireEvent.keyDown(root(), { key: 'k' });
    });

    expect(requests).toEqual([{ source: 'keyboard', appId: 'wireframe', focus: true }]);
    // Ask is not an editor mutation — the consumed stroke appends no journal entry.
    expect(getNavigationJournal().entries().length).toBe(entriesBefore);
  });
});

describe('WireframeNavigationProvider — confirmation policy (R-5.2 / R-5.3)', () => {
  it('gates launcher/voice/agent intents and leaves keyboard/pointer unconfirmed', async () => {
    const host = await mountProviderHost();
    await addAndSelectElement(host);

    const pending: PendingLauncherConfirmation[] = [];
    const unsubscribe = subscribeLauncherConfirmation((request) => {
      if (request !== null) pending.push(request);
    });

    try {
      for (const channel of ['launcher', 'voice', 'agent'] as const) {
        const actor = channel === 'launcher' ? 'human' : 'companion';
        const before = pending.length;
        const dispatchPromise = host.runIntent({
          verbId: 'wireframe.element.delete',
          args: {},
          channel,
          actor,
        });
        await waitFor(() => expect(pending).toHaveLength(before + 1));
        act(() => {
          resolveLauncherConfirmation(false);
        });
        await act(async () => {
          await expect(dispatchPromise).resolves.toEqual({
            status: 'rejected',
            code: 'canceled-confirmation',
          });
        });
        expect(getSnapshot().document.elements).toHaveLength(1);
      }
      expect(pending).toHaveLength(3);
      expect(pending[0]?.request.verbId).toBe('wireframe.element.delete');
      expect(pending[0]?.request.consequence?.trim().length ?? 0).toBeGreaterThan(0);
      expect(pending[0]?.intent.actor).toBe('human');

      // Keyboard performs with NO confirmation request.
      await act(async () => {
        const result = await host.runIntent({
          verbId: 'wireframe.element.delete',
          args: {},
          channel: 'keyboard',
          actor: 'human',
        });
        expect(result.status).toBe('performed');
      });
      expect(pending).toHaveLength(3);
      expect(getSnapshot().document.elements).toHaveLength(0);

      // Pointer performs too (no confirmation), on a fresh element.
      await addAndSelectElement(host);
      await act(async () => {
        const result = await host.runIntent({
          verbId: 'wireframe.element.delete',
          args: {},
          channel: 'pointer',
          actor: 'human',
        });
        expect(result.status).toBe('performed');
      });
      expect(pending).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });

  it('confirms the external export with the authored party and cancels without applying', async () => {
    const host = await mountProviderHost();

    const pending: PendingLauncherConfirmation[] = [];
    const unsubscribe = subscribeLauncherConfirmation((request) => {
      if (request !== null) pending.push(request);
    });

    try {
      const dispatchPromise = host.runIntent({
        verbId: 'place.exportPng',
        args: {},
        channel: 'launcher',
        actor: 'human',
      });
      await waitFor(() => expect(pending).toHaveLength(1));
      const request = pending[0]!.request;
      expect(request.verbId).toBe('place.exportPng');
      expect(request.externalParty).toBe('your file system');
      expect(request.consequence?.trim().length ?? 0).toBeGreaterThan(0);
      expect(request.undoAvailability).toEqual({
        undoable: false,
        reason: expect.any(String),
      });

      act(() => {
        resolveLauncherConfirmation(false);
      });
      await act(async () => {
        await expect(dispatchPromise).resolves.toEqual({
          status: 'rejected',
          code: 'canceled-confirmation',
        });
      });
      // Cancel never ran the file action.
      expect(getSnapshot().document.elements).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});
