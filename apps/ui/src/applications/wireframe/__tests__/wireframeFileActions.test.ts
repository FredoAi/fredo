/**
 * Wireframe file actions (Spec #3070, ST-6 / R-4.7-R-4.13).
 *
 * Pins the store transitions for Save As / Open / Export PNG across success,
 * cancel and failure — including that cancel produces NO error and leaves the
 * dirty state alone, that failures leave the document byte-identical, and that
 * a foreign/unknown/ unreadable file is rejected without touching the page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  exportPng,
  openDocument,
  resetWireframeFileActionsForTests,
  saveAs,
} from '../actions/wireframeFileActions';
import { captureWireframePagePng } from '../canvas/wireframeCanvasRegistry';
import {
  WIREFRAME_APP_TAG,
  WIREFRAME_SCHEMA_VERSION,
  createNewWireframeDocument,
  serializeWireframeDocument,
} from '../model/document';
import { createDefaultElement } from '../model/elements';
import {
  dispatch,
  getSnapshot,
  markSaved,
  resetWireframeStoreForTests,
} from '../store/wireframeDocumentStore';

vi.mock('../canvas/wireframeCanvasRegistry', () => ({
  captureWireframePagePng: vi.fn(),
  PAGE_EXPORT_PIXEL_RATIO: 2,
}));

type InvokeHandler = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const invoke = vi.fn<InvokeHandler>();
const capture = vi.mocked(captureWireframePagePng);

const SAVED_PATH = 'C:/tmp/board.wireframe.json';

function setInvoke(handler: InvokeHandler): void {
  adapterBridge.setInvoke(handler as never);
}

function addText(id = 'element-1'): void {
  const snapshot = getSnapshot();
  dispatch('element.add', {
    element: createDefaultElement('text', {
      page: snapshot.document.page,
      elements: snapshot.document.elements,
      id,
    }),
  });
}

function savedDocumentJson(): string {
  const base = createNewWireframeDocument('tablet');
  const element = createDefaultElement('text', {
    page: base.page,
    elements: [],
    id: 'opened-1',
  });
  return serializeWireframeDocument({ ...base, elements: [element] });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeFileActionsForTests();
  invoke.mockReset();
  capture.mockReset();
  capture.mockReturnValue('UE5HMjQ=');
  setInvoke(invoke);
});

afterEach(() => {
  adapterBridge.setInvoke(undefined as never);
  resetWireframeFileActionsForTests();
});

describe('saveAs (R-4.7 / R-4.10)', () => {
  it('sets the pending status on the same tick and disables re-entry', async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );

    const first = saveAs();
    expect(getSnapshot().status).toBe('saving');

    await saveAs();
    expect(invoke).toHaveBeenCalledTimes(1);

    resolve(SAVED_PATH);
    await first;
    expect(getSnapshot().status).toBe('idle');
  });

  it('writes the serialised document and marks it saved', async () => {
    addText();
    invoke.mockResolvedValue(SAVED_PATH);

    await saveAs();

    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe('wireframe_save_as');
    expect(args?.defaultName).toBe('untitled.wireframe.json');
    expect(JSON.parse(String(args?.contents))).toEqual(getSnapshot().document);

    expect(getSnapshot().filePath).toBe(SAVED_PATH);
    expect(getSnapshot().dirty).toBe(false);
    expect(getSnapshot().status).toBe('idle');
    expect(getSnapshot().error).toBeNull();
  });

  it('returns to idle on cancel with no error and no dirty change', async () => {
    addText();
    invoke.mockResolvedValue(null);

    await saveAs();

    const state = getSnapshot();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.dirty).toBe(true);
    expect(state.filePath).toBeNull();
  });

  it('surfaces a failure and leaves the document and dirty state untouched', async () => {
    addText();
    const before = getSnapshot().document;
    invoke.mockRejectedValue('Access is denied.');

    await saveAs();

    const state = getSnapshot();
    expect(state.status).toBe('idle');
    expect(state.error).toBe('Access is denied.');
    expect(state.dirty).toBe(true);
    expect(state.filePath).toBeNull();
    expect(state.document).toBe(before);
  });
});

describe('openDocument (R-4.8 / R-4.12 / R-4.13)', () => {
  it('replaces the document, resets history/selection and marks it saved', async () => {
    addText('existing-1');
    expect(getSnapshot().canUndo).toBe(true);
    invoke.mockResolvedValue({
      path: SAVED_PATH,
      contents: savedDocumentJson(),
    });

    await openDocument();

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(1);
    expect(state.document.elements[0].id).toBe('opened-1');
    expect(state.document.page.preset).toBe('tablet');
    expect(state.selectedId).toBeNull();
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.filePath).toBe(SAVED_PATH);
    expect(state.dirty).toBe(false);
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
  });

  it('returns to idle on cancel with no error and no dirty change', async () => {
    addText();
    const before = getSnapshot();
    invoke.mockResolvedValue(null);

    await openDocument();

    const state = getSnapshot();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.dirty).toBe(before.dirty);
    expect(state.filePath).toBeNull();
    expect(state.document).toBe(before.document);
  });

  it('surfaces an I/O failure and changes nothing', async () => {
    addText();
    const before = getSnapshot().document;
    invoke.mockRejectedValue('failed to read C:/tmp/board.wireframe.json');

    await openDocument();

    const state = getSnapshot();
    expect(state.error).toBe('failed to read C:/tmp/board.wireframe.json');
    expect(state.status).toBe('idle');
    expect(state.document).toBe(before);
    expect(state.dirty).toBe(true);
    expect(state.filePath).toBeNull();
  });

  it.each([
    ['unreadable JSON', '{ not json', /not readable JSON/],
    [
      'foreign app tag',
      JSON.stringify({
        schemaVersion: 1,
        app: 'other.app',
        page: { preset: 'desktop', width: 1280, height: 800 },
        elements: [],
      }),
      /app tag "other\.app"/,
    ],
    [
      'unknown schemaVersion',
      JSON.stringify({
        schemaVersion: 99,
        app: 'fredo.wireframe',
        page: { preset: 'desktop', width: 1280, height: 800 },
        elements: [],
      }),
      /version "99"/,
    ],
    [
      'missing schemaVersion',
      JSON.stringify({
        app: 'fredo.wireframe',
        page: { preset: 'desktop', width: 1280, height: 800 },
        elements: [],
      }),
      // ST-1's parser stringifies the absent value; the contract is rejection.
      /Unsupported Wireframe document version/,
    ],
  ])('rejects %s without changing the page', async (_label, contents, message) => {
    addText('existing-1');
    const before = getSnapshot().document;
    invoke.mockResolvedValue({ path: SAVED_PATH, contents });

    await openDocument();

    const state = getSnapshot();
    expect(state.status).toBe('idle');
    expect(state.error).toMatch(message);
    expect(state.document).toBe(before);
    expect(state.filePath).toBeNull();
    expect(state.dirty).toBe(true);
  });

  it('accepts every binding document identity value', () => {
    // Guards the test fixtures themselves against schema drift.
    expect(WIREFRAME_SCHEMA_VERSION).toBe(1);
    expect(WIREFRAME_APP_TAG).toBe('fredo.wireframe');
  });
});

describe('exportPng (R-4.9)', () => {
  it('writes the captured PNG and leaves path/dirty untouched', async () => {
    addText();
    invoke.mockResolvedValue('C:/tmp/board.png');

    await exportPng();

    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe('wireframe_export_png');
    expect(args?.pngBase64).toBe('UE5HMjQ=');
    expect(args?.defaultName).toBe('untitled.png');

    const state = getSnapshot();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.dirty).toBe(true);
    expect(state.filePath).toBeNull();
  });

  it('derives the default PNG name from the saved document name', async () => {
    markSaved('C:/docs/board.wireframe.json');
    invoke.mockResolvedValue('C:/docs/board.png');

    await exportPng();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]?.defaultName).toBe('board.png');
    expect(getSnapshot().dirty).toBe(false);
    expect(getSnapshot().filePath).toBe('C:/docs/board.wireframe.json');
  });

  it('returns to idle on cancel with no error and no dirty change', async () => {
    invoke.mockResolvedValue(null);

    await exportPng();

    const state = getSnapshot();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.dirty).toBe(true);
    expect(state.filePath).toBeNull();
  });

  it('surfaces a failure without touching the document or dirty state', async () => {
    addText();
    const before = getSnapshot().document;
    invoke.mockRejectedValue('disk is full');

    await exportPng();

    const state = getSnapshot();
    expect(state.error).toBe('disk is full');
    expect(state.status).toBe('idle');
    expect(state.document).toBe(before);
    expect(state.dirty).toBe(true);
  });

  it('reports a not-ready page instead of invoking the command', async () => {
    capture.mockReturnValue(null);

    await exportPng();

    expect(invoke).not.toHaveBeenCalled();
    expect(getSnapshot().error).toMatch(/not ready to export/);
    expect(getSnapshot().status).toBe('idle');
  });
});
