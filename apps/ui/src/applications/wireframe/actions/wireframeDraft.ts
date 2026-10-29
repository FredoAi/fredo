/**
 * Deterministic Wireframe starter draft (Spec #3070 C4; moved here by Spec
 * #3099 ST-3).
 *
 * `wireframe.companion.draftApp` is a DETERMINISTIC four-step script — no
 * model-authored layout. The steps and every value are fixed; `app_name`
 * supplies the heading text and the card label only. A missing `app_name`
 * cannot produce the binding draft, so it performs nothing rather than
 * inventing a name. A failing step stops the script and only the prior steps
 * are reported.
 *
 * The script takes an operations seam (the production default reads the store
 * and the ONE command table) so the stop-on-failure rule is unit pinned
 * without a rendering harness. This module is the ONE implementation shared by
 * the published surface command (Spec #3099 ST-3) and the retired
 * `wireframeCompanion` executor until ST-6 removes it.
 */

import {
  addWireframeElement,
  type AddWireframeElementOptions,
} from './wireframeActions';
import type { WireframeElementPatch, WireframeElementType } from '../model/elements';
import {
  dispatch,
  getSnapshot,
  resetForNewDocument,
  select,
} from '../store/wireframeDocumentStore';

/** The published command id that runs the deterministic starter draft. */
export const WIREFRAME_DRAFT_APP_ID = 'wireframe.companion.draftApp';

/** The deterministic draft script's action ids, in execution order (C4). */
export const WIREFRAME_DRAFT_STEPS: readonly string[] = [
  'wireframe.document.new',
  'wireframe.add.section',
  'wireframe.add.text',
  'wireframe.add.card',
];

/** The draft's page preset (binding Gherkin: desktop 1280×800). */
export const WIREFRAME_DRAFT_PAGE_PRESET = 'desktop';

/**
 * The operations the draft needs. Production wires the store + command table;
 * tests can make any step fail to pin the honesty rule.
 */
export interface WireframeDraftOperations {
  /** Start a fresh document on `preset`. */
  newDocument: (preset: 'desktop') => boolean;
  /** Add one element (the same helper the toolbar uses). */
  addElement: (type: WireframeElementType, options?: AddWireframeElementOptions) => boolean;
  /** Patch the element the last add selected (the draft's heading styling). */
  updateSelected: (patch: WireframeElementPatch) => boolean;
  /** Clear the selection (UI/UX §4: a completed draft shows page controls). */
  clearSelection: () => void;
}

/** The production operations: the real store and the real command table. */
export function createWireframeDraftOperations(): WireframeDraftOperations {
  return {
    newDocument: (preset) => {
      resetForNewDocument(preset);
      return true;
    },
    addElement: (type, options) => addWireframeElement(type, options),
    updateSelected: (patch) => {
      const { selectedId } = getSnapshot();
      if (selectedId === null) return false;
      dispatch('element.update', { id: selectedId, patch });
      return true;
    },
    clearSelection: () => {
      select(null);
    },
  };
}

/** Read the declared `app_name` argument (trimmed), or `null` when absent/blank. */
export function readDraftAppName(
  args: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (!args || typeof args !== 'object') return null;
  const value = args.app_name;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Run the deterministic starter draft and return exactly the step ids that
 * performed, in execution order (C4). A missing `app_name` performs nothing.
 */
export function runWireframeDraft(
  args: Readonly<Record<string, unknown>> | null | undefined,
  operations: WireframeDraftOperations = createWireframeDraftOperations(),
): string[] {
  const appName = readDraftAppName(args);
  if (appName === null) return [];

  const performed: string[] = [];
  const steps: ReadonlyArray<{ id: string; run: () => boolean }> = [
    {
      id: 'wireframe.document.new',
      run: () => operations.newDocument(WIREFRAME_DRAFT_PAGE_PRESET),
    },
    {
      id: 'wireframe.add.section',
      run: () => operations.addElement('section', { preset: 'navbar' }),
    },
    {
      id: 'wireframe.add.text',
      // The add is the performed action; the heading styling is part of the
      // same deterministic step (the add selects the new text element).
      run: () => {
        if (!operations.addElement('text', { text: appName })) return false;
        operations.updateSelected({ textStyle: 'heading', size: 'xl', align: 'left' });
        return true;
      },
    },
    {
      id: 'wireframe.add.card',
      // The add is the performed action; the report label is applied to the
      // card the add just selected (the insert helper has no label option).
      run: () => {
        if (!operations.addElement('card')) return false;
        operations.updateSelected({ label: `${appName} reports` });
        return true;
      },
    },
  ];

  for (const step of steps) {
    if (!step.run()) break;
    performed.push(step.id);
  }

  // UI/UX §4/§6: a COMPLETED draft leaves nothing selected so the panel shows
  // the page controls. A stopped script keeps the last added element selected.
  if (performed.length === WIREFRAME_DRAFT_STEPS.length) {
    operations.clearSelection();
  }

  return performed;
}
