/**
 * Spec #3151 (ST-2) — registrar WIRING pin.
 *
 * `grounding.test.ts` proves the module's contract in isolation; this file proves
 * the ONE production registrant a unit harness can mount end-to-end (the
 * Wireframe shell) actually calls `registerCompanionGrounding` and that the
 * payload it publishes reflects LIVE store state — so the registrations are not
 * dead code. (The other four registrants — terminal, mission-monitor,
 * database-client, dev-mode — are mounted by their own feature suites and proved
 * live by the tester's Q-36/Q-37 rows.)
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  listCompanionGroundingAppIds,
  readCompanionGrounding,
  resetCompanionGroundingForTests,
} from '@/shared/companion/grounding';
import {
  clearSelection,
  dispatch,
  getSnapshot,
  markSaved,
  resetWireframeStoreForTests,
  select,
  selectMany,
} from '@/applications/wireframe/store/wireframeDocumentStore';
import { createDefaultElement } from '@/applications/wireframe/model/elements';
import { WireframeEditor } from '@/applications/wireframe/components/WireframeEditor';

function addText(id: string) {
  const snapshot = getSnapshot();
  const element = createDefaultElement('text', {
    page: snapshot.document.page,
    elements: snapshot.document.elements,
    id,
  });
  dispatch('element.add', { element });
  return element;
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetCompanionGroundingForTests();
});

afterEach(() => {
  cleanup();
  resetCompanionGroundingForTests();
});

describe('#3151 ST-2 — the Wireframe shell registers a live grounding source', () => {
  it('registers on mount, reads the LIVE selection, and disposes on unmount', () => {
    expect(listCompanionGroundingAppIds()).toEqual([]);

    const view = renderWithChakra(React.createElement(WireframeEditor, null));

    expect(listCompanionGroundingAppIds()).toContain('wireframe');
    const empty = readCompanionGrounding('wireframe');
    expect(empty?.appId).toBe('wireframe');
    expect(empty?.appName).toBe('Wireframe');
    expect(empty?.selection).toStrictEqual({ count: 0, ids: [], kinds: [], label: null });

    // The provider is a LIVE read: a store mutation between two reads is observed
    // with no re-render, and `kinds` stays index-aligned with `ids`.
    const first = addText('element-1');
    act(() => { select('element-1'); });
    const one = readCompanionGrounding('wireframe');
    expect(one?.selection).toStrictEqual({
      count: 1,
      ids: ['element-1'],
      kinds: [first.type],
      label: one?.selection.label ?? null,
    });
    expect(one?.selection.kinds).toHaveLength(one?.selection.ids.length ?? -1);
    // A freshly-created document is dirty; `dirty` is read from the store snapshot.
    expect(one?.dirty).toBe(true);

    act(() => { markSaved('C:\\docs\\a.wireframe.json'); });
    expect(readCompanionGrounding('wireframe')?.dirty).toBe(false);

    // A multi-selection keeps kinds/ids index-aligned.
    addText('element-2');
    act(() => { selectMany(['element-1', 'element-2']); });
    const two = readCompanionGrounding('wireframe');
    expect(two?.selection.count).toBe(2);
    expect(two?.selection.kinds).toHaveLength(two?.selection.ids.length ?? -1);

    act(() => { clearSelection(); });
    expect(readCompanionGrounding('wireframe')?.selection).toStrictEqual({
      count: 0,
      ids: [],
      kinds: [],
      label: null,
    });

    // Unmount disposes the registration (no stale payload survives the app).
    view.unmount();
    expect(readCompanionGrounding('wireframe')).toBeNull();
    expect(listCompanionGroundingAppIds()).not.toContain('wireframe');
  });
});
