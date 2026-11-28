/**
 * Spec #3243 ST-4 — Wireframe's declared order surface: the ONE shipped instance.
 *
 * Exactly FOUR actions are declared, chosen so every AC-6/AC-7/AC-8 branch is
 * demonstrable without inventing new application behaviour. Each DELEGATES to a
 * mechanism the Wireframe app already ships:
 *
 *   | order action                    | risk        | undoable | shipped mechanism          |
 *   |---------------------------------|-------------|----------|----------------------------|
 *   | `wireframe.selection.describe`  | `read`      | false    | `getSnapshot()`            |
 *   | `wireframe.element.fill`        | `changing`  | true     | `dispatch('elements.update')` |
 *   | `wireframe.element.delete`      | `destructive` | true   | `dispatch('elements.delete')` |
 *   | `wireframe.document.new`        | `destructive` | **false** | `resetForNewDocument()` |
 *
 * ## Non-goals (BINDING, G-522)
 *
 * `WIREFRAME_ACTIONS` gains NO row and NO id — this table is a separate
 * declaration surface, so the app's own 35-action catalog, its toolbar and its
 * keys are untouched. `wireframeDocumentStore.ts` / `wireframeHistory.ts` are
 * NOT edited and `WIREFRAME_HISTORY_LIMIT` (100) is untouched: every executor
 * below calls the SHIPPED function, and every undo closure verifies entry
 * identity on the SHIPPED history rather than re-implementing an inverse.
 *
 * ## Why `document.new` is the irreversible one
 *
 * New is *"deliberately NOT undoable"*: it records NO history entry, so AC-8's
 * *"explicitly warned, before it ran"* branch is the ONLY lawful path for it.
 * Its declared `consequence` is what the confirmation renders pre-run.
 *
 * ## Stale-safe undo (the single worst outcome this slice can produce)
 *
 * Wireframe's own Undo control sits on the SAME history. If the user confirms
 * an order (entry 1) and then makes their own edit (entry 2), a blind
 * "one step back" would revert ENTRY 2 — the user's own work. So every undo
 * closure here captures the history revision + its own entry `seq` at commit
 * time and re-verifies, at undo time, that its own entry is STILL the newest
 * APPLIED one (`canRedo()` false and the last retained entry is ours). Anything
 * else returns `false`, which the registry reports as `nothing`/`failed` — never
 * a silent revert.
 *
 * Pure data + thin delegations: no React, no state of its own.
 */

import {
  getSnapshot,
  getWireframeHistory,
  dispatch,
  resetForNewDocument,
  undo as undoWireframe,
} from '../../applications/wireframe/store/wireframeDocumentStore';
import { isWireframeColorToken, type WireframeColorToken } from '../../applications/wireframe/model/elements';
import { WIREFRAME_APP_ID } from '../../applications/wireframe/model/document';
import { registerOrderSurface } from './actionRisk';
import type { FredoOrderAction, FredoOrderSurface } from './orderActions';

/* ------------------------------------------------------------------------- */
/* The four declarations                                                       */
/* ------------------------------------------------------------------------- */

/**
 * `read` — the app's current selection snapshot. Mutates nothing, so AC-8's
 * pre-warning requirement is vacuous here and `undoable`/`consequence` are
 * `false`/absent by the classifier's own invariant.
 *
 * Its existence is what makes AC-5's allowed lookup-then-act shape expressible
 * at all (a `read` followed by a `changing`/`destructive` step).
 */
export const WIREFRAME_DESCRIBE_ACTION: FredoOrderAction = {
  id: 'wireframe.selection.describe',
  label: 'Describe selection',
  description:
    'Read what is currently selected in the wireframe. Changes nothing.',
  risk: 'read',
  undoable: false,
  args: [],
};

/** `changing` + undoable — set one shape's fill token (ONE history entry). */
export const WIREFRAME_FILL_ACTION: FredoOrderAction = {
  id: 'wireframe.element.fill',
  label: 'Fill element',
  description:
    'Set the fill colour of one shape element. Undoable with the wireframe history.',
  risk: 'changing',
  undoable: true,
  args: [
    { name: 'elementId', type: 'string', required: true },
    { name: 'fill', type: 'string', required: true },
  ],
};

/** `destructive` + undoable — delete elements (ONE history entry). */
export const WIREFRAME_DELETE_ACTION: FredoOrderAction = {
  id: 'wireframe.element.delete',
  label: 'Delete element',
  description: 'Delete one element from the wireframe. Undoable with the wireframe history.',
  risk: 'destructive',
  undoable: true,
  args: [{ name: 'elementId', type: 'string', required: true }],
};

/**
 * `destructive` + NOT undoable — start a brand-new document. Records no history
 * entry, so the declared `consequence` MUST be shown before it runs (AC-8).
 */
export const WIREFRAME_NEW_DOCUMENT_ACTION: FredoOrderAction = {
  id: 'wireframe.document.new',
  label: 'Create a new document',
  description:
    'Replace the whole wireframe with an empty new document. This cannot be undone.',
  risk: 'destructive',
  undoable: false,
  consequence:
    'The current unsaved wireframe is discarded and cannot be recovered with undo.',
  args: [{ name: 'preset', type: 'string', required: false }],
};

/** Wireframe's declared action table — exactly four entries, in this order. */
export const WIREFRAME_ORDER_SURFACE: FredoOrderSurface = {
  actions: [
    WIREFRAME_DESCRIBE_ACTION,
    WIREFRAME_FILL_ACTION,
    WIREFRAME_DELETE_ACTION,
    WIREFRAME_NEW_DOCUMENT_ACTION,
  ],
};

/**
 * Register Wireframe's surface. Kept as an explicit call (never an import side
 * effect) so a consumer decides when the app's actions become addressable.
 * Idempotent: the returned disposer is a no-op after a newer registration, and
 * re-registering replaces the entry.
 */
export function registerWireframeOrderSurface(): () => void {
  return registerOrderSurface(WIREFRAME_APP_ID, WIREFRAME_ORDER_SURFACE);
}

/* ------------------------------------------------------------------------- */
/* The executors (the shipped mechanism behind each declaration)               */
/* ------------------------------------------------------------------------- */

/**
 * What an executor did. `performed` may carry an `undo` closure (only for an
 * `undoable` declaration); `unchanged` is a true no-op (a value-equal fill, a
 * missing element, a clamped action) and must NEVER be reported as
 * `performed` — a settle that claims work it did not do is the "UI is lying"
 * defect.
 */
export interface WireframeOrderOutcome {
  readonly status: 'performed' | 'unchanged' | 'failed';
  /** Present iff the action ran AND is undoable — the ST-6 registry's record body. */
  readonly undo?: () => boolean;
  /** Structured detail for diagnostics (never the user-visible reply). */
  readonly detail?: string;
}

const PERFECT: Readonly<Record<string, never>> = Object.freeze({});

/** A human reading of the current selection, for the `read` action. */
function describeSelection(): string {
  const snapshot = getSnapshot();
  const count = snapshot.selectedIds.length;
  if (count === 0) return 'Nothing is selected.';
  const kinds = snapshot.document.elements
    .filter((element) => snapshot.selectedIds.includes(element.id))
    .map((element) => element.type);
  const label = kinds.length === 1 ? kinds[0] : `${count} elements`;
  return `${label} selected.`;
}

/**
 * Capture the history state that makes an undo closure stale-safe, or `null`
 * when the shipped dispatch recorded no entry (a true no-op).
 *
 * The captured facts are the entry's `seq` AND the history revision: `seq` says
 * "this is my entry"; the revision says "nothing else has happened since". Both
 * are re-checked at undo time.
 */
function captureEntry(): { seq: number; revision: number } | null {
  const history = getWireframeHistory();
  const entries = history.entries();
  if (entries.length === 0) return null;
  const newest = entries[entries.length - 1];
  return { seq: newest.seq, revision: history.revision() };
}

/**
 * True iff OUR entry is still the newest APPLIED one on the shipped history.
 *
 * `canRedo()` false ⇒ nothing has been undone since (the cursor is at the end);
 * the last RETAINED entry being ours ⇒ our change is the newest applied one, so
 * "one step back" would revert OUR change and nobody else's. A newer edit by
 * the user moves the last entry off ours; the user pressing the app's own Undo
 * turns `canRedo()` true. Both cases are a refusal, never a revert.
 */
function isStillNewestApplied(entry: { seq: number }): boolean {
  const history = getWireframeHistory();
  if (history.canRedo()) return false;
  const entries = history.entries();
  if (entries.length === 0) return false;
  return entries[entries.length - 1].seq === entry.seq;
}

/**
 * Apply the app's own inverse for OUR entry, or report `false` without touching
 * the document when the entry is gone/superseded.
 */
function undoIfSafe(entry: { seq: number; revision: number }): boolean {
  if (!isStillNewestApplied(entry)) return false;
  // The shipped undo applies `entries[cursor - 1]` — ours, verified above.
  undoWireframe();
  const history = getWireframeHistory();
  // The undo MOVED the cursor: a second press must not claim it again. Proven by
  // `canRedo()` now being true (our entry sits in the redo tail).
  return history.canRedo() && history.revision() !== entry.revision;
}

function runDescribe(): WireframeOrderOutcome {
  return { status: 'performed', detail: describeSelection() };
}

function runFill(args: Readonly<Record<string, string>>): WireframeOrderOutcome {
  const elementId = (args.elementId ?? '').trim();
  const fill = (args.fill ?? '').trim();
  if (elementId === '' || fill === '') {
    return { status: 'unchanged', detail: 'the order named no element or no fill' };
  }
  if (!isWireframeColorToken(fill)) {
    return { status: 'unchanged', detail: `"${fill}" is not a wireframe fill token` };
  }
  const { document } = getSnapshot();
  const target = document.elements.find((element) => element.id === elementId);
  if (target === undefined) {
    return { status: 'unchanged', detail: `no element "${elementId}"` };
  }
  if (target.type !== 'shape') {
    return { status: 'unchanged', detail: `element "${elementId}" is not a shape` };
  }
  const token: WireframeColorToken = fill;
  // The SHIPPED reducer: ONE history entry, and a value-equal fill is a true
  // no-op (`reduceDocument` returns null), so `false` means nothing changed.
  const applied = dispatch('elements.update', { patches: { [elementId]: { fill: token } } });
  if (!applied) return { status: 'unchanged', detail: 'the fill was already in place' };
  const entry = captureEntry();
  if (entry === null) return { status: 'unchanged', detail: 'no history entry was recorded' };
  return { status: 'performed', undo: () => undoIfSafe(entry) };
}

function runDelete(args: Readonly<Record<string, string>>): WireframeOrderOutcome {
  const elementId = (args.elementId ?? '').trim();
  if (elementId === '') {
    return { status: 'unchanged', detail: 'the order named no element' };
  }
  const { document } = getSnapshot();
  if (!document.elements.some((element) => element.id === elementId)) {
    return { status: 'unchanged', detail: `no element "${elementId}"` };
  }
  const applied = dispatch('elements.delete', { ids: [elementId] });
  if (!applied) return { status: 'unchanged', detail: 'the element could not be deleted' };
  const entry = captureEntry();
  if (entry === null) return { status: 'unchanged', detail: 'no history entry was recorded' };
  return { status: 'performed', undo: () => undoIfSafe(entry) };
}

function runNewDocument(args: Readonly<Record<string, string>>): WireframeOrderOutcome {
  const raw = (args.preset ?? '').trim();
  const preset = raw === 'desktop' || raw === 'tablet' || raw === 'phone' ? raw : 'desktop';
  // Non-undoable by the app's own contract: records NO history entry, so this
  // executor deliberately returns NO undo closure.
  resetForNewDocument(preset);
  return { status: 'performed' };
}

/** The shipped mechanism behind each declared action id. */
export type WireframeOrderExecutor = (
  args: Readonly<Record<string, string>>,
) => WireframeOrderOutcome;

export const WIREFRAME_ORDER_EXECUTORS: Readonly<Record<string, WireframeOrderExecutor>> =
  Object.freeze({
    [WIREFRAME_DESCRIBE_ACTION.id]: runDescribe,
    [WIREFRAME_FILL_ACTION.id]: runFill,
    [WIREFRAME_DELETE_ACTION.id]: runDelete,
    [WIREFRAME_NEW_DOCUMENT_ACTION.id]: runNewDocument,
  });

/**
 * Run one of Wireframe's declared actions. An id this app does not declare is a
 * TYPED failure, never a default (the same fail-closed direction the classifier
 * takes for an unknown action).
 */
export function runWireframeOrder(
  actionId: string,
  args: Readonly<Record<string, string>> = PERFECT,
): WireframeOrderOutcome {
  const executor = WIREFRAME_ORDER_EXECUTORS[actionId];
  if (executor === undefined) {
    return { status: 'failed', detail: `wireframe declares no order action "${actionId}"` };
  }
  try {
    return executor(args);
  } catch (error) {
    // Fail closed: an executor fault is a typed failure, never a thrown turn.
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'failed', detail };
  }
}
