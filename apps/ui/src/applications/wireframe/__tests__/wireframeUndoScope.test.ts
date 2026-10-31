/**
 * Wireframe undo scope (Spec #3120 round 2, ST-4-REWORK / AC6 / R-6.1 / R-6.2).
 *
 * The EXACT live defect: an older companion entry's inverse must not revert a
 * later human edit of a different field. The harness is the REAL surface over the
 * REAL navigation host with `applyDocumentPatch` as its `applyPatch` seam (the
 * `wireframeRailParity.test.tsx` harness) — never a fake that replaces documents.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { appendEntry } from '../../../shared/navigation/journal';
import type { JsonPatch } from '../../../shared/navigation/types';
import { createNavigationHost, type NavigationHost } from '../../../shared/navigation/ui/host';
import { createNewWireframeDocument } from '../model/document';
import { applyDocumentDelta } from '../model/documentDelta';
import { createDefaultElement, type WireframeElement } from '../model/elements';
import {
  applyDocumentPatch,
  getNavigationJournal,
  getSnapshot,
  getWireframeContext,
  loadDocument,
  resetWireframeStoreForTests,
  select,
  undo,
  type WireframeDocumentPatch,
} from '../store/wireframeDocumentStore';
import { resetWireframeSurfaceForTests, wireframeSurface } from '../wireframeSurface';

/** The REAL surface over the REAL host; the host owns its own session journal. */
function createHost(): { host: NavigationHost; journal: ReturnType<typeof getNavigationJournal> } {
  const journal = getNavigationJournal();
  // A dedicated journal would hide the store's undo path; the plan's harness uses a
  // fresh journal with the real document write, so entries never share the store's.
  journal.commit([], []);
  const host = createNavigationHost({
    surface: wireframeSurface,
    getContext: getWireframeContext,
    journal,
    applyPatch: (patch) => applyDocumentPatch(patch as unknown as WireframeDocumentPatch),
    confirm: () => true,
  });
  return { host, journal };
}

/** Load one card `a` and select it (journal/history free). */
function seed(): void {
  const base = createNewWireframeDocument('desktop');
  const element = createDefaultElement('card', { page: base.page, elements: [], id: 'a' });
  loadDocument({ ...base, elements: [element] }, 'C:/tmp/doc.wireframe.json');
  select('a');
}

function currentElement(): WireframeElement {
  const element = getSnapshot().document.elements.find((candidate) => candidate.id === 'a');
  if (element === undefined) throw new Error('element a missing');
  return element;
}

function human(host: NavigationHost, verbId: string, args: Record<string, string> = {}) {
  return host.runIntent({ verbId, args, channel: 'launcher', actor: 'human' });
}

function companion(host: NavigationHost, verbId: string, args: Record<string, string> = {}) {
  return host.runIntent({ verbId, args, channel: 'agent', actor: 'companion' });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
});

describe('an entry\'s inverse reverts only what the entry changed (AC6 / R-6.1)', () => {
  it('a companion undo leaves the later human visibility edit intact', async () => {
    seed();
    const { host, journal } = createHost();

    // Human toggleVisible → hidden.
    await human(host, 'wireframe.element.toggleVisible');
    expect(currentElement().visible).toBe(false);
    // Companion toggleLock → locked.
    await companion(host, 'wireframe.element.toggleLock');
    expect(currentElement().locked).toBe(true);
    // Human toggleVisible again → visible.
    await human(host, 'wireframe.element.toggleVisible');

    const beforeUndo = currentElement();
    expect(beforeUndo.visible).toBe(true);
    expect(beforeUndo.locked).toBe(true);
    const entriesBefore = journal.entries().length;

    const result = await human(host, 'journal.undo', { actor: 'companion', count: '1' });
    expect(result.status).toBe('performed');

    const afterUndo = currentElement();
    expect(afterUndo.locked).toBe(false);
    // The later human edit survives — the whole-document checkpoint reverted it.
    expect(afterUndo.visible).toBe(beforeUndo.visible);

    const entries = journal.entries();
    expect(entries).toHaveLength(entriesBefore + 1);
    const reversal = entries[entries.length - 1];
    expect(reversal.label).toBe('Undo Toggle lock');
    expect(reversal.actor).toBe('human');
    expect(
      entries.some(
        (entry) => entry.actor === 'companion' && entry.verbId === 'wireframe.element.toggleLock',
      ),
    ).toBe(true);
  });

  it('undo-by-count reverts exactly N companion entries and leaves human fields unchanged', async () => {
    seed();
    const { host, journal } = createHost();

    await companion(host, 'wireframe.element.toggleLock'); // locked true
    await human(host, 'wireframe.element.setField', { id: 'a', field: 'x', value: '111' });
    await companion(host, 'wireframe.element.toggleVisible'); // visible false
    await human(host, 'wireframe.element.setField', { id: 'a', field: 'y', value: '222' });
    await companion(host, 'wireframe.element.toggleLock'); // locked false
    await human(host, 'wireframe.element.setField', { id: 'a', field: 'width', value: '333' });

    const beforeUndo = currentElement();
    expect(beforeUndo.x).toBe(111);
    expect(beforeUndo.y).toBe(222);
    expect(beforeUndo.width).toBe(333);
    const entriesBefore = journal.entries().length;

    const result = await human(host, 'journal.undo', { actor: 'companion', count: '3' });
    expect(result.status).toBe('performed');

    const afterUndo = currentElement();
    // The three companion mutations revert (locked/visible), the human fields do not.
    expect(afterUndo.locked).toBe(false);
    expect(afterUndo.visible).toBe(true);
    expect(afterUndo.x).toBe(111);
    expect(afterUndo.y).toBe(222);
    expect(afterUndo.width).toBe(333);

    const appended = journal.entries().slice(entriesBefore);
    expect(appended.map((entry) => entry.label)).toEqual([
      'Undo Toggle lock',
      'Undo Toggle visible',
      'Undo Toggle lock',
    ]);
    expect(appended.every((entry) => entry.actor === 'human')).toBe(true);
  });

  it('undoing a HUMAN entry after a companion entry leaves the companion field untouched', async () => {
    seed();
    const { host } = createHost();

    await companion(host, 'wireframe.element.toggleLock'); // locked true
    await human(host, 'wireframe.element.toggleVisible'); // visible false

    const result = await human(host, 'journal.undo', { actor: 'human', count: '1' });
    expect(result.status).toBe('performed');

    // Only the human visibility edit reverts; the companion lock is untouched.
    expect(currentElement().locked).toBe(true);
    expect(currentElement().visible).toBe(true);
  });

  it('a redo re-applies only its own entry\'s fields (a later human field survives)', async () => {
    seed();
    const { host } = createHost();

    await companion(host, 'wireframe.element.toggleLock'); // locked true
    await human(host, 'wireframe.element.setField', { id: 'a', field: 'x', value: '111' });

    const undoResult = await human(host, 'journal.undo', { actor: 'companion', count: '1' });
    expect(undoResult.status).toBe('performed');
    expect(currentElement().locked).toBe(false);
    expect(currentElement().x).toBe(111);

    const redoResult = await human(host, 'journal.redo');
    expect(redoResult.status).toBe('performed');
    // The redo restores `locked` only — the later human `x` is untouched.
    expect(currentElement().locked).toBe(true);
    expect(currentElement().x).toBe(111);
  });

  it('a malformed delta is a no-op: applyDocumentDelta null, undo writes no entry', () => {
    seed();
    const document = getSnapshot().document;

    // Structural + inapplicable deltas never throw and never apply.
    expect(applyDocumentDelta(document, { page: { set: { width: 'wide' } } })).toBeNull();
    expect(
      applyDocumentDelta(document, { elements: { ghost: { set: { x: 1 } } } }),
    ).toBeNull();
    expect(
      applyDocumentDelta(document, {
        elementAdds: [null as unknown as WireframeElement],
      }),
    ).toBeNull();

    const journal = getNavigationJournal();
    const outcome = appendEntry(
      { entries: journal.entries(), redo: journal.redo() },
      {
        verbId: 'wireframe.element.toggleLock',
        actor: 'human',
        channel: 'launcher',
        label: 'Toggle lock',
        effect: 'mutation',
        placePath: ['wireframe.canvas'],
        target: [],
        patch: null,
        inverse: { delta: { page: 'not-a-delta' } } as unknown as JsonPatch,
        external: false,
        consequence: null,
        exitedBy: 'none',
        coalesceKey: null,
      },
      '2026-01-01T00:00:00.000Z',
    );
    journal.commit(outcome.state.entries, outcome.state.redo);
    const entriesBefore = journal.entries().length;

    undo();

    expect(getSnapshot().document).toBe(document);
    expect(journal.entries()).toHaveLength(entriesBefore);
  });
});
