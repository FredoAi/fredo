/**
 * Wireframe store — exactly ONE undo stack (Spec #3119, ST-2 / R-5a).
 *
 * Replaces `store.undo.test.ts`. The journal is the only undo authority: the
 * store keeps no private history container, `canUndo`/`canRedo` are derived from
 * the module-scoped `JournalStore`, New/Open clear it in place, and every
 * shipped document mutation still commits exactly one undo step.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createNewWireframeDocument,
  type WireframeGroup,
} from '../model/document';
import { createDefaultElement } from '../model/elements';
import {
  dispatch,
  getNavigationJournal,
  getSnapshot,
  loadDocument,
  redo,
  resetForNewDocument,
  resetWireframeStoreForTests,
  setView,
  undo,
  type WireframeStoreAction,
  type WireframeStoreActionArgs,
} from '../store/wireframeDocumentStore';

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

/** Load a saved (journal-free) document with the given element ids. */
function seed(ids: readonly string[], groups: readonly WireframeGroup[] = []): void {
  const base = createNewWireframeDocument('desktop');
  const elements = ids.map((id) =>
    createDefaultElement('card', { page: base.page, elements: [], id }),
  );
  loadDocument({ ...base, elements, groups: [...groups] }, 'C:/tmp/doc.wireframe.json');
}

describe('single undo stack (R-5a)', () => {
  it('the store keeps no past or future stack', () => {
    const source = Object.values(STORE_SOURCES)[0] ?? '';
    expect(source.length).toBeGreaterThan(0);
    const code = stripCommentsAndStrings(source);
    expect(code).not.toMatch(/\bpast\b/);
    expect(code).not.toMatch(/\bfuture\b/);
    // The ONE history container is the module-scoped journal (not a private array).
    expect(code).toMatch(/getNavigationJournal/);
    expect(code).toMatch(/createJournalStore/);
  });

  it('canUndo and canRedo read the journal', () => {
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

    // Derived, not stored: clearing the shared journal removes both flags even
    // though no private history object was touched.
    undo();
    getNavigationJournal().commit([], []);
    setView({ scale: 2, x: 0, y: 0 });
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
  });

  it('history reset on new and open clears the journal', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 5 } });
    expect(getNavigationJournal().entries()).toHaveLength(1);
    expect(getSnapshot().canUndo).toBe(true);

    resetForNewDocument('phone');
    expect(getNavigationJournal().entries()).toHaveLength(0);
    expect(getNavigationJournal().redo()).toEqual([]);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
    expect(getSnapshot().dirty).toBe(true);
    expect(getSnapshot().filePath).toBeNull();

    dispatch('page.update', { page: { width: 640 } });
    expect(getNavigationJournal().entries()).toHaveLength(1);

    loadDocument(createNewWireframeDocument('tablet'), 'C:/tmp/open.wireframe.json');
    expect(getNavigationJournal().entries()).toHaveLength(0);
    expect(getNavigationJournal().redo()).toEqual([]);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
    expect(getSnapshot().dirty).toBe(false);
    expect(getSnapshot().filePath).toBe('C:/tmp/open.wireframe.json');
  });

  it('every shipped document mutation still commits exactly one undo step', () => {
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
      const journalBefore = getNavigationJournal().entries().length;

      expect(dispatch(action, args), action).toBe(true);
      expect(getNavigationJournal().entries().length, action).toBe(journalBefore + 1);
      expect(getSnapshot().canUndo, action).toBe(true);

      undo();
      expect(getSnapshot().document, action).toEqual(before);
      expect(getSnapshot().canUndo, action).toBe(false);
    }
  });
});
