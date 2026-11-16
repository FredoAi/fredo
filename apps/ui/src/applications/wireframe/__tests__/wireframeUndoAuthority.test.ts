/**
 * Wireframe store — exactly ONE undo stack (Spec #3119, ST-2 / R-5a; re-pointed
 * by Spec #3151, ST-3 / AC4).
 *
 * The app-local bounded `WireframeHistory` is the only undo authority: the store
 * keeps no private past/future array, `canUndo`/`canRedo` are derived from the
 * module-scoped history, New/Open clear it IN PLACE, and every shipped document
 * mutation still records exactly one undo step.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createNewWireframeDocument,
  type WireframeGroup,
} from '../model/document';
import { createDefaultElement } from '../model/elements';
import {
  UNDO_DEPTH,
  dispatch,
  getSnapshot,
  getWireframeHistory,
  loadDocument,
  redo,
  resetForNewDocument,
  resetWireframeStoreForTests,
  setView,
  undo,
  type WireframeStoreAction,
  type WireframeStoreActionArgs,
} from '../store/wireframeDocumentStore';
import { WIREFRAME_HISTORY_LIMIT } from '../store/wireframeHistory';

/** The store source as raw text (the shipped source-scan pattern). */
const STORE_SOURCES = import.meta.glob(
  '/src/applications/wireframe/store/wireframeDocumentStore.ts',
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

beforeEach(() => {
  resetWireframeStoreForTests();
});

/** Drop comments and string/template literal TEXT (interpolations are code). */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 1;
      out += '""';
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

/** Load a saved (history-free) document with the given element ids. */
function seed(ids: readonly string[], groups: readonly WireframeGroup[] = []): void {
  const base = createNewWireframeDocument('desktop');
  const elements = ids.map((id) =>
    createDefaultElement('card', { page: base.page, elements: [], id }),
  );
  loadDocument({ ...base, elements, groups: [...groups] }, 'C:/tmp/doc.wireframe.json');
}

describe('single undo stack (R-5a / AC4)', () => {
  it('the store keeps no past or future stack and reads the app-local history', () => {
    const source = Object.values(STORE_SOURCES)[0] ?? '';
    expect(source.length).toBeGreaterThan(0);
    const code = stripCommentsAndStrings(source);
    expect(code).not.toMatch(/\bpast\b/);
    expect(code).not.toMatch(/\bfuture\b/);
    // The ONE history container is the module-scoped app-local history.
    expect(code).toMatch(/createWireframeHistory/);
    expect(code).toMatch(/getWireframeHistory/);
    // No shared-journal reference survives (AC4's "no undo path references a
    // shared journal").
    expect(code).not.toMatch(/navigationJournal/);
    expect(code).not.toMatch(/getNavigationJournal/);
    expect(code).not.toMatch(/createJournalStore/);
  });

  it('canUndo and canRedo read the history', () => {
    seed(['a']);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);

    expect(dispatch('element.update', { id: 'a', patch: { x: 11 } })).toBe(true);
    expect(getSnapshot().canUndo).toBe(true);
    expect(getSnapshot().canRedo).toBe(false);

    undo();
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(true);

    redo();
    expect(getSnapshot().canUndo).toBe(true);
    expect(getSnapshot().canRedo).toBe(false);

    // Derived, not stored: clearing the app-local history removes both flags even
    // though no private history object was touched.
    undo();
    getWireframeHistory().clear();
    setView({ scale: 2, x: 0, y: 0 });
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
  });

  it('history reset on new and open clears the history in place', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 5 } });
    expect(getWireframeHistory().entries()).toHaveLength(1);
    expect(getSnapshot().canUndo).toBe(true);

    // Clear IN PLACE: the instance identity never changes.
    const instance = getWireframeHistory();
    resetForNewDocument('phone');
    expect(getWireframeHistory()).toBe(instance);
    expect(getWireframeHistory().entries()).toHaveLength(0);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
    expect(getSnapshot().dirty).toBe(true);
    expect(getSnapshot().filePath).toBeNull();

    dispatch('page.update', { page: { width: 640 } });
    expect(getWireframeHistory().entries()).toHaveLength(1);

    loadDocument(createNewWireframeDocument('tablet'), 'C:/tmp/open.wireframe.json');
    expect(getWireframeHistory()).toBe(instance);
    expect(getWireframeHistory().entries()).toHaveLength(0);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
    expect(getSnapshot().dirty).toBe(false);
    expect(getSnapshot().filePath).toBe('C:/tmp/open.wireframe.json');
  });

  it('the bounded depth is the shipped UNDO_DEPTH (NFR-5)', () => {
    expect(UNDO_DEPTH).toBe(100);
    expect(WIREFRAME_HISTORY_LIMIT).toBe(UNDO_DEPTH);
  });

  it('every shipped document mutation still records exactly one undo step', () => {
    const cases: Array<() => { action: WireframeStoreAction; args: WireframeStoreActionArgs }> = [
      () => {
        seed([]);
        const { page } = getSnapshot().document;
        return {
          action: 'element.add',
          args: { element: createDefaultElement('text', { page, elements: [], id: 'added' }) },
        };
      },
      () => {
        seed(['a']);
        return { action: 'element.update', args: { id: 'a', patch: { x: 42 } } };
      },
      () => {
        seed(['a']);
        return { action: 'element.duplicate', args: { id: 'a' } };
      },
      () => {
        seed(['a', 'b']);
        return { action: 'element.delete', args: { id: 'a' } };
      },
      () => {
        seed(['a', 'b']);
        return { action: 'element.toggleLock', args: { ids: ['a', 'b'] } };
      },
      () => {
        seed(['a', 'b']);
        return { action: 'elements.update', args: { patches: { a: { x: 5 }, b: { y: 7 } } } };
      },
      () => {
        seed(['a', 'b']);
        return { action: 'elements.delete', args: { ids: ['a'] } };
      },
      () => {
        seed(['a', 'b', 'c']);
        return { action: 'element.reorder', args: { ids: ['a'], direction: 'forward' } };
      },
      () => {
        seed(['a', 'b']);
        return { action: 'group.create', args: { ids: ['a', 'b'] } };
      },
      () => {
        seed(['a', 'b'], [{ id: 'g1', memberIds: ['a', 'b'], locked: false }]);
        return { action: 'group.ungroup', args: { groupIds: ['g1'] } };
      },
      () => {
        seed(['a', 'b'], [{ id: 'g1', memberIds: ['a', 'b'], locked: false }]);
        return { action: 'group.toggleLock', args: { groupIds: ['g1'] } };
      },
      () => {
        seed([]);
        return { action: 'page.update', args: { page: { width: 640 } } };
      },
    ];

    for (const build of cases) {
      resetWireframeStoreForTests();
      const { action, args } = build();
      const before = getSnapshot().document;
      const historyBefore = getWireframeHistory().entries().length;

      expect(dispatch(action, args), action).toBe(true);
      expect(getWireframeHistory().entries().length, action).toBe(historyBefore + 1);
      expect(getSnapshot().canUndo, action).toBe(true);

      undo();
      expect(getSnapshot().document, action).toEqual(before);
      expect(getSnapshot().canUndo, action).toBe(false);
    }
  });
});
