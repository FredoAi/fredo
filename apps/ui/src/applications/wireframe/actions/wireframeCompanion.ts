/**
 * Wireframe Companion executor (Spec #3070, ST-7, C4 / C5 / R-6.2–R-6.5).
 *
 * Executes ONE relayed `wireframe-intent` against the module-scoped document
 * store and reports exactly what it performed. The deterministic `draftApp`
 * script itself lives in `./wireframeDraft.ts` (Spec #3099 ST-3) so the
 * published surface command and this executor share ONE implementation.
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
  runWireframeAction,
  findWireframeAction,
} from './wireframeActions';
import { wireframeListReply } from './wireframeReply';
import {
  WIREFRAME_DRAFT_APP_ID,
  WIREFRAME_DRAFT_PAGE_PRESET,
  WIREFRAME_DRAFT_STEPS,
  createWireframeDraftOperations,
  runWireframeDraft,
  type WireframeDraftOperations,
} from './wireframeDraft';

export {
  WIREFRAME_DRAFT_APP_ID,
  WIREFRAME_DRAFT_PAGE_PRESET,
  WIREFRAME_DRAFT_STEPS,
};

/** The Companion-only id that lists the catalog. */
export const WIREFRAME_LIST_ACTIONS_ID = 'wireframe.companion.listActions';

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
export interface WireframeCompanionOperations extends WireframeDraftOperations {
  /** Run one catalog action id through the command table. */
  runAction: (id: string) => boolean;
}

/** The production operations: the real store and the real command table. */
export function createWireframeCompanionOperations(): WireframeCompanionOperations {
  return {
    ...createWireframeDraftOperations(),
    runAction: (id) => runWireframeAction(id),
  };
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
    return { performed: runWireframeDraft(intent.arguments, operations) };
  }

  return { performed: operations.runAction(action) ? [action] : [] };
}
