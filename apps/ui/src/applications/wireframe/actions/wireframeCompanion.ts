/**
 * Wireframe Companion executor (Spec #3070, ST-7, C4 / C5 / R-6.2–R-6.5).
 *
 * Executes ONE relayed `wireframe-intent` against the module-scoped document
 * store and reports exactly what it performed. The executor is pure-ish: it
 * takes an operations seam (the production default reads the store and the
 * command table) so the deterministic draft's stop-on-failure rule is unit
 * pinned without a rendering harness.
 *
 * Guarantees (binding):
 *   - an UNKNOWN id mutates nothing and reports `performed: []` (R-6.4);
 *   - `wireframe.companion.draftApp` is a DETERMINISTIC four-step script — no
 *     model-authored layout (C4). A failing step stops the script and only the
 *     prior steps are reported (R-6.3);
 *   - `wireframe.companion.listActions` performs no mutation; it returns the
 *     list text in `detail` (Home also answers it directly so it works while
 *     the app is closed);
 *   - every other catalog id runs through the ONE command table
 *     (`runWireframeAction`), so ids here can never drift from the toolbar.
 */

import {
  addWireframeElement,
  findWireframeAction,
  runWireframeAction,
  type AddWireframeElementOptions,
} from './wireframeActions';
import { wireframeListReply } from './wireframeReply';
import type { WireframeElementPatch, WireframeElementType } from '../model/elements';
import {
  dispatch,
  getSnapshot,
  resetForNewDocument,
  select,
} from '../store/wireframeDocumentStore';

/** The Companion-only id that lists the catalog. */
export const WIREFRAME_LIST_ACTIONS_ID = 'wireframe.companion.listActions';
/** The Companion-only id that runs the deterministic starter draft. */
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

/** One relayed intent (`wireframe-intent` payload, camelCase). */
export interface WireframeIntentPayload {
  requestId: string;
  action: string;
  arguments?: Record<string, unknown> | null;
}

/** What the executor reports back through `wireframe_intent_result`. */
export interface WireframeIntentOutcome {
  /** Exactly the catalog ids that performed, in execution order. */
  performed: string[];
  /** The list text for `listActions` (the only action that returns one). */
  detail?: string;
}

/**
 * The operations the executor needs. Production wires the store + command
 * table; tests can make any step fail to pin the honesty rule.
 */
export interface WireframeCompanionOperations {
  /** Start a fresh document on `preset`. */
  newDocument: (preset: 'desktop') => boolean;
  /** Add one element (the same helper the toolbar uses). */
  addElement: (type: WireframeElementType, options?: AddWireframeElementOptions) => boolean;
  /** Patch the element the last add selected (the draft's heading styling). */
  updateSelected: (patch: WireframeElementPatch) => boolean;
  /** Clear the selection (UI/UX §4: a completed draft shows page controls). */
  clearSelection: () => void;
  /** Run one catalog action id through the command table. */
  runAction: (id: string) => boolean;
}

/** The production operations: the real store and the real command table. */
export function createWireframeCompanionOperations(): WireframeCompanionOperations {
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
    runAction: (id) => runWireframeAction(id),
  };
}

/** Read a declared string argument (trimmed), or `null` when absent/blank. */
function readStringArgument(
  args: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!args || typeof args !== 'object') return null;
  const value = args[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The deterministic starter draft (C4). No model-authored layout: the steps and
 * every value are fixed; `app_name` supplies the heading text and the card
 * label only. A missing `app_name` cannot produce the binding draft, so it
 * performs nothing (R-6.4) rather than inventing a name.
 */
function runDraftApp(
  args: Record<string, unknown> | null | undefined,
  operations: WireframeCompanionOperations,
): WireframeIntentOutcome {
  const appName = readStringArgument(args, 'app_name');
  if (appName === null) return { performed: [] };

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

  return { performed };
}

/**
 * Execute one intent. Unknown ids and unsupported `draftApp` arguments mutate
 * nothing and report `performed: []`; the caller composes the honest reply.
 */
export function executeWireframeIntent(
  intent: WireframeIntentPayload,
  operations: WireframeCompanionOperations = createWireframeCompanionOperations(),
): WireframeIntentOutcome {
  const action = typeof intent?.action === 'string' ? intent.action.trim() : '';
  if (action === '' || !findWireframeAction(action)) return { performed: [] };

  if (action === WIREFRAME_LIST_ACTIONS_ID) {
    return { performed: [], detail: wireframeListReply() };
  }

  if (action === WIREFRAME_DRAFT_APP_ID) {
    return runDraftApp(intent.arguments, operations);
  }

  return { performed: operations.runAction(action) ? [action] : [] };
}
