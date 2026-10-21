/**
 * Wireframe file actions (Spec #3070, ST-6, C5 / UI/UX section 3.10).
 *
 * `saveAs()`, `openDocument()` and `exportPng()` are the ONLY entry points the
 * toolbar (ST-3), the hotkey table (ST-3) and the Companion (ST-7) call. They
 * are lazy-import-friendly: this module statically imports only pure model code
 * and the canvas capture seam — never `@tauri-apps/api`; IPC goes through the
 * shipped `adapterBridge`.
 *
 * State discipline (R-4.10 / R-4.11):
 *   - the pending status is set on the same tick, before any await;
 *   - one file operation runs at a time (re-entry is a no-op);
 *   - success writes the store (`markSaved` / `loadDocument`), cancel restores
 *     idle with no error and NO dirty/path change;
 *   - failure sets the error banner and restores idle, leaving the document and
 *     dirty state untouched. Nothing is ever thrown at the UI.
 */

import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { captureWireframePagePng } from '../canvas/wireframeCanvasRegistry';
import {
  documentBasename,
  documentDisplayName,
  parseWireframeDocument,
  serializeWireframeDocument,
} from '../model/document';
import {
  getSnapshot,
  loadDocument,
  markSaved,
  setError,
  setStatus,
  type WireframeOperationStatus,
} from '../store/wireframeDocumentStore';

/** The `wireframe_open_document` IPC payload (C5). */
export interface WireframeOpenedDocument {
  path: string;
  contents: string;
}

const UNAVAILABLE_DETAIL =
  'File operations are only available in the desktop app. Nothing changed.';
const NOT_READY_DETAIL =
  'The wireframe page is not ready to export yet. Nothing changed.';

/** True while one file operation is in flight (all three share the lock). */
let fileOperationInFlight = false;

/** A safe, user-readable detail from any rejection shape. */
function detailFrom(error: unknown): string {
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return 'The file operation failed. Nothing changed.';
}

/**
 * Run one file command with the shared pending / re-entry / error discipline.
 * The task is responsible for the success and cancel branches (both must land
 * on `idle`); any throw becomes the error banner + idle.
 */
async function runFileOperation(
  status: WireframeOperationStatus,
  task: () => Promise<void>,
): Promise<void> {
  if (fileOperationInFlight) return;
  fileOperationInFlight = true;
  setStatus(status);
  try {
    await task();
  } catch (error) {
    setError(detailFrom(error));
    setStatus('idle');
  } finally {
    fileOperationInFlight = false;
  }
}

/** Default PNG file name: the document stem with a `.png` extension. */
function defaultExportName(): string {
  const basename = documentBasename(getSnapshot().filePath);
  const stem = basename
    .replace(/\.wireframe\.json$/i, '')
    .replace(/\.[^./\\]+$/, '');
  return `${stem || 'untitled'}.png`;
}

/**
 * Save As (R-4.7): serialise the document and let Rust own the picker.
 * Success sets the path and clears dirty; cancel/failure leave both untouched.
 */
export async function saveAs(): Promise<void> {
  await runFileOperation('saving', async () => {
    const snapshot = getSnapshot();
    const contents = serializeWireframeDocument(snapshot.document);
    const path = await adapterBridge.invoke<string | null>('wireframe_save_as', {
      defaultName: documentDisplayName(snapshot.filePath),
      contents,
    });

    if (path === undefined) {
      setError(UNAVAILABLE_DETAIL);
      setStatus('idle');
      return;
    }
    if (path === null) {
      setStatus('idle');
      return;
    }
    markSaved(path);
  });
}

/**
 * Open (R-4.8 / R-4.12 / R-4.13): read + parse the chosen file, then replace
 * the document (clears selection, resets history, fits the view, sets the path
 * and marks it saved). A rejected file sets the banner and changes nothing.
 */
export async function openDocument(): Promise<void> {
  await runFileOperation('opening', async () => {
    const opened = await adapterBridge.invoke<WireframeOpenedDocument | null>(
      'wireframe_open_document',
    );

    if (opened === undefined) {
      setError(UNAVAILABLE_DETAIL);
      setStatus('idle');
      return;
    }
    if (opened === null) {
      setStatus('idle');
      return;
    }

    // Throws `WireframeDocumentError` for unreadable JSON / foreign app tag /
    // unknown-or-missing schemaVersion (R-4.13); the outer catch surfaces it and
    // `loadDocument` is never reached, so the page is unchanged.
    const document = parseWireframeDocument(opened.contents);
    loadDocument(document, opened.path);
  });
}

/**
 * Export PNG (R-4.9): capture the page rect at 2x, then let Rust write the
 * bytes. Export never changes the document, the path or the dirty flag.
 */
export async function exportPng(): Promise<void> {
  await runFileOperation('exporting', async () => {
    const pngBase64 = captureWireframePagePng();
    if (pngBase64 === null) {
      setError(NOT_READY_DETAIL);
      setStatus('idle');
      return;
    }

    const path = await adapterBridge.invoke<string | null>('wireframe_export_png', {
      defaultName: defaultExportName(),
      pngBase64,
    });

    if (path === undefined) {
      setError(UNAVAILABLE_DETAIL);
      setStatus('idle');
      return;
    }
    // `null` is a cancelled dialog and a string is a written file: both leave
    // the document/path/dirty state alone. Only the pending status ends.
    setStatus('idle');
  });
}

/** Test-only: drop the module-scoped re-entry lock between test cases. */
export function resetWireframeFileActionsForTests(): void {
  fileOperationInFlight = false;
}
