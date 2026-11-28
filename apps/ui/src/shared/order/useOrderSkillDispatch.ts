/**
 * Spec #3243 ST-8 — the ONE order dispatcher.
 *
 * # A FOURTH FILTER on the SAME channel, never a second dispatch route
 *
 * `llm-skill-call` is the product's one execution seam, and it already carries
 * three filters: `useAppOpenRequests` (open/close), `useDoomModeSkill` (doom).
 * This is the fourth, and it follows their shape exactly — it listens on the
 * same channel, ignores every skill name that is not `order`, and never opens a
 * route of its own (`useAppOpenRequests.ts:168-174` documents the pattern:
 * "Anything that is neither intent is ignored here: zero spurious opens/closes
 * for every other skill (single shared dispatcher)").
 *
 * # The loop
 *
 *   model turn
 *     └─ llm-skill-call { skill: "order", arguments: { action, arguments } }
 *          ├─ buildOrderInvocation(...)  ── null → refused (fail closed)
 *          ├─ resolveOrderConfirmation()  ── 'refused-unknown' → refusal copy
 *          │                              ── 'needs-confirmation' → await the user
 *          │                              ── 'granted' → execute
 *          └─ executor: the app's SHIPPED mechanism
 *               ├─ performed + undoable   → registerOrderUndo(...) → performed copy
 *               ├─ performed + !undoable  → performed copy (the warning already ran)
 *               └─ unchanged / failed     → typed copy
 *   └─ exactly one reply, pushed through the shipped reply bridge + spoken
 *
 * # AC-7's executor arm is here, and it is a REFUSAL ORDER
 *
 * The gate is consulted BEFORE anything runs, and the executor is reached only
 * through a `granted` verdict. `needs-confirmation` cannot execute — the user's
 * confirm control is the only thing that can mint a grant (`confirmOrder`), and
 * that control is rendered by `OrderConfirmation` with `onConfirm` wired to the
 * `confirm` callback below. Nothing in this hook reads a model-supplied
 * confirmation-shaped argument: `args` reaches only `buildOrderInvocation`'s
 * fingerprint, and the classification itself is the REGISTRY's.
 *
 * # One action per order (AC-5's NARROW reading), and the multi-selection refusal
 *
 * The plan's AC-5 decision is binding: this slice proves the narrow reading
 * against its four declared actions, and must NOT be read as the general claim.
 * So when a selection carries more than one action, exactly ONE runs (the first
 * resolvable) and the rest are refused with typed copy — never a loop over the
 * selection, which is the defect the F-21 row counts document changes to catch.
 */

import { useCallback, useEffect, useRef } from 'react';

import { adapterBridge } from '../utils/adapterBridge';
import type { LlmSkillCall } from '../../app/adapters/HostAdapter';
import {
  buildOrderInvocation,
  type OrderInvocation,
} from './orderActions';
import { confirmOrder, resolveOrderConfirmation } from './confirmGate';
import {
  orderCancelledReply,
  orderNothingToUndoReply,
  orderNeedsConfirmationReply,
  orderPerformedReply,
  orderRefusedUnknownReply,
  orderUndoReply,
} from './orderReply';
import {
  hasOrderUndo,
  registerOrderUndo,
  undoLastOrder,
} from './orderUndo';
import { readOrderSurface } from './actionRisk';
import { runWireframeOrder } from './wireframeOrderSurface';
import {
  awaitOrderConfirmation,
  beginOrderFlight,
  clearOrderConfirmationRequest,
  clearOrderFlight,
  readOrderFlight,
  requestOrderConfirmation,
  settleOrderFlight,
} from './orderFlight';
import { readPlacement } from '../placement/placementStore';
import { pushAppOpenReply } from '../components/companion/skillBridge';
import { speakCompanionReply } from '../companion/companionSpeech';

/** The skill name this filter owns. Every other selection is ignored here. */
export const ORDER_SKILL_NAME = 'order';

/** The `arguments.action` / `arguments.arguments` keys of the offered schema. */
export const ORDER_ACTION_ARG = 'action';
export const ORDER_ARGUMENTS_ARG = 'arguments';

/** The outcome of driving one order — the caller's/test's reading, never user copy. */
export type OrderDispatchOutcome =
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'needs-confirmation'; readonly invocation: OrderInvocation }
  | { readonly kind: 'performed'; readonly text: string; readonly undoable: boolean }
  | { readonly kind: 'failed'; readonly text: string }
  | { readonly kind: 'ignored' };

/**
 * The executor registry: `appId` → the app's SHIPPED mechanism.
 *
 * A map rather than a switch, so an app that declares actions supplies its own
 * executor and nothing here re-implements any app's behaviour (G-522). An app
 * with no entry is a typed failure — never a silent no-op.
 */
export type OrderExecutor = (
  actionId: string,
  args: Readonly<Record<string, string>>,
) => { readonly status: 'performed' | 'unchanged' | 'failed'; readonly undo?: () => boolean };

const EXECUTORS: Readonly<Record<string, OrderExecutor>> = Object.freeze({
  wireframe: runWireframeOrder,
});

/** Read the model's `arguments` object as the string-valued arg bag. */
function readArgBag(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') return {};
  const bag: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Every declared argument is string-valued at this seam. A non-string value
    // is kept by its JSON text so it still changes the fingerprint (an injected
    // key must not ride a grant minted for the clean invocation).
    bag[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return bag;
}

/** The app's display name for copy — the placement's own datum, else the id. */
function appNameFor(appId: string): string {
  const placement = readPlacement();
  if (placement !== null && placement.appId === appId) return placement.appName;
  return appId;
}

/**
 * Execute one GRANTED invocation. Split out so the gate's arm is the only way in.
 */
function executeOrder(
  invocation: OrderInvocation,
  appName: string,
): OrderDispatchOutcome {
  const action = readOrderSurface(invocation.appId)?.actions.find(
    (candidate) => candidate.id === invocation.actionId,
  );
  const label = action?.label ?? invocation.actionId;

  const executor = EXECUTORS[invocation.appId];
  if (executor === undefined) {
    // The app declares actions but ships no executor — a typed failure, never a
    // silent no-op and never a claim that something ran.
    return { kind: 'failed', text: orderRefusedUnknownReply(appName) };
  }

  let outcome: ReturnType<OrderExecutor>;
  try {
    outcome = executor(invocation.actionId, invocation.args);
  } catch {
    // An executor fault is a typed failure, never a thrown turn.
    return { kind: 'failed', text: orderRefusedUnknownReply(appName) };
  }

  if (outcome.status === 'unchanged') {
    // Nothing changed: the performed sentence would be a claim about work that
    // did not happen (the "UI is lying" defect). The refusal class is the honest
    // one — it names the app and does not claim a change.
    return { kind: 'failed', text: orderRefusedUnknownReply(appName) };
  }
  if (outcome.status === 'failed') {
    return { kind: 'failed', text: orderRefusedUnknownReply(appName) };
  }

  // Performed. An undoable change registers exactly ONE record carrying the
  // app's OWN inverse (the closure ST-4 captured against its history entry).
  if (invocation.undoable && typeof outcome.undo === 'function') {
    registerOrderUndo({
      fingerprint: invocation.fingerprint,
      label,
      undo: outcome.undo,
    });
  }
  return {
    kind: 'performed',
    text: orderPerformedReply(appName, label),
    undoable: invocation.undoable,
  };
}

/**
 * Drive one winner invocation through the gate and (only if granted) execute.
 * Shared by the `llm-skill-call` path and the user's confirm event so both take
 * the SAME route — there is no second execution path.
 */
function routeInvocation(
  invocation: OrderInvocation,
  appName: string,
): OrderDispatchOutcome {
  const verdict = resolveOrderConfirmation(invocation);
  if (verdict === 'refused-unknown') {
    return { kind: 'refused', text: orderRefusedUnknownReply(appName) };
  }
  if (verdict === 'needs-confirmation') {
    return { kind: 'needs-confirmation', invocation };
  }
  return executeOrder(invocation, appName);
}

/** Push one reply through the shipped channel AND speak it (AC-1). */
function settleReply(text: string): void {
  pushAppOpenReply({ kind: 'success', text });
  // ST-7's seam, and therefore the one-channel rule's speech arm: the reply
  // surface already carries the sentence, so speech is the audio channel.
  speakCompanionReply(text);
}

/**
 * Dispatch one `order` selection WITHOUT a model or a pointer — the in-repo
 * induction lever's landing point, and the seam every row drives.
 *
 * Returns the outcome so a test/lever can assert what happened, and pushes the
 * user-visible reply as a side effect (the same one reply per order).
 */
export function dispatchOrderSelection(
  selection: { readonly action?: unknown; readonly arguments?: unknown } | null | undefined,
): OrderDispatchOutcome {
  if (selection === null || selection === undefined) return { kind: 'ignored' };

  const actionId = typeof selection.action === 'string' ? selection.action.trim() : '';
  const placement = readPlacement();
  // AC-3's subject: the app resolved AT SUBMIT. With no placement there is no
  // resolved target, so an order is refused by name (UIUX-D7) rather than
  // narrated as prose.
  const appId = placement?.appId ?? '';
  const appName = placement?.appName ?? '';

  const invocation = buildOrderInvocation(appId, actionId, readArgBag(selection.arguments));
  if (invocation === null) {
    const text = orderRefusedUnknownReply(appName);
    beginOrderFlight({ orderId: `order-${Date.now()}`, appId, appName });
    settleOrderFlight({ state: 'refused', text });
    settleReply(text);
    return { kind: 'refused', text };
  }

  // AC-3's record is created at SUBMIT, before the gate: the ticker names the
  // ORIGINAL app from this moment, so a later move cannot change it.
  beginOrderFlight({
    orderId: `order-${invocation.fingerprint}-${Date.now()}`,
    appId: invocation.appId,
    appName,
  });

  const outcome = routeInvocation(invocation, appName);

  if (outcome.kind === 'needs-confirmation') {
    // A confirmation is NOT a refusal: the order is understood and awaiting the
    // user's decision, so it gets its OWN sentence (G-505) — never the
    // "can't carry out" copy, which describes a fault.
    awaitOrderConfirmation();
    // The label is needed for the copy; read it from the declared surface.
    const declaredLabel = readOrderSurface(invocation.appId)?.actions.find(
      (candidate) => candidate.id === invocation.actionId,
    )?.label ?? invocation.actionId;
    // Hand the INVOCATION to the surface that renders the dialog (two React
    // trees, one module store — the same reason the flight is module-scoped).
    requestOrderConfirmation({ invocation, label: declaredLabel });
    settleReply(orderNeedsConfirmationReply(appName, declaredLabel));
    return outcome;
  }
  if (outcome.kind === 'performed') {
    settleOrderFlight({ state: 'done', text: outcome.text });
    settleReply(outcome.text);
    return outcome;
  }
  if (outcome.kind === 'ignored') return outcome;
  // `refused` is the GATE's verdict (`refused-unknown`) and it must survive to the
  // ticker as `refused`, not be flattened into `failed`: the two are different
  // facts to a user (an order that could not be classified vs one that ran and
  // broke). `failed` is reserved for an executor that resolved and then failed.
  const state = outcome.kind === 'refused' ? 'refused' : 'failed';
  settleOrderFlight({ state, text: outcome.text });
  settleReply(outcome.text);
  return outcome;
}

/**
 * The user CONFIRMED an order. **The only event that can authorise a change.**
 *
 * Entered only from `OrderConfirmation`'s `onConfirm`. It mints the grant via
 * ST-5's `confirmOrder` (through the invocation the dialog was shown for) and,
 * only on success, executes. A refused confirm (no matching invocation, a
 * consumed grant, an unknown classification) lands in `refused` — NEVER
 * `running`, because a ticker that says "Working…" after a refused grant is the
 * UI lying.
 */
/**
 * **THE USER EVENT BOUNDARY. `OrderConfirmation`'s `onConfirm`.**
 *
 * The ONE line in the product that reaches `confirmOrder`, kept as a named
 * `onConfirm` so the boundary is visible in the code rather than implied by a
 * call graph: this arrow IS the click handler, and it exists nowhere else.
 *
 * AC-7's source sweep (`confirmGate.test.ts`) asserts that every `confirmOrder`
 * entry names a user event, so keeping the name here is the pin's own evidence —
 * a wiring that reached the mint from an effect, a timer or an `llm-skill-call`
 * payload would have no `onConfirm` to name and would redden.
 */
const onConfirm = (invocation: OrderInvocation): boolean => confirmOrder(invocation);

/**
 * The user CONFIRMED an order. **The only event that can authorise a change.**
 *
 * Entered only from `OrderConfirmation`'s `onConfirm` — through the named
 * boundary above. A refused confirm (no matching invocation, a consumed grant, an
 * unknown classification) lands in `refused` — NEVER `running`, because a ticker
 * that says "Working…" after a refused grant is the UI lying.
 */
export function confirmOrderExecution(
  invocation: OrderInvocation,
  appName: string,
): OrderDispatchOutcome {
  // The user's decision is spent — the dialog must never re-open for it.
  clearOrderConfirmationRequest();
  const granted = onConfirm(invocation);
  if (!granted) {
    const text = orderRefusedUnknownReply(appName);
    settleOrderFlight({ state: 'refused', text });
    settleReply(text);
    return { kind: 'refused', text };
  }
  // The gate now sees the live grant and returns `granted`, so the SAME
  // `routeInvocation` executes — no second execution path.
  const outcome = routeInvocation(invocation, appName);
  if (outcome.kind === 'performed') {
    settleOrderFlight({ state: 'done', text: outcome.text });
    settleReply(outcome.text);
    return outcome;
  }
  if (outcome.kind === 'refused') {
    settleOrderFlight({ state: 'refused', text: outcome.text });
    settleReply(outcome.text);
    return outcome;
  }
  // `needs-confirmation` after a successful mint cannot happen (the grant is
  // live); treat any other shape as a typed failure rather than a silent no-op.
  const text = orderRefusedUnknownReply(appName);
  settleOrderFlight({ state: 'failed', text });
  settleReply(text);
  return { kind: 'failed', text };
}

/** The user CANCELLED. Executes nothing, consumes no grant, and SAYS SO. */
export function cancelOrderExecution(appName: string, label: string): OrderDispatchOutcome {
  clearOrderConfirmationRequest();
  const text = orderCancelledReply(appName, label);
  settleOrderFlight({ state: 'refused', text });
  settleReply(text);
  return { kind: 'refused', text };
}

/** Undo the newest registered order through the APP's own inverse (AC-8). */
export function undoOrderExecution(appName: string): OrderDispatchOutcome {
  const outcome = undoLastOrder();
  if (outcome.status === 'nothing') {
    const text = orderNothingToUndoReply(appName);
    settleOrderFlight({ state: 'refused', text });
    settleReply(text);
    return { kind: 'refused', text };
  }
  if (outcome.status === 'failed') {
    // The stale case: the app's history moved, so the order's change can no
    // longer be reverted safely. Reported, never a silent revert.
    const text = orderNothingToUndoReply(appName, outcome.label);
    settleOrderFlight({ state: 'failed', text });
    settleReply(text);
    return { kind: 'failed', text };
  }
  const text = orderUndoReply(appName, outcome.label);
  settleOrderFlight({ state: 'done', text });
  settleReply(text);
  return { kind: 'performed', text, undoable: false };
}

/** True iff an undo affordance should be rendered. */
export function canUndoOrder(): boolean {
  return hasOrderUndo();
}

/** The in-flight record a surface renders from (see `orderFlight.ts`). */
export function readOrderFlightState() {
  return readOrderFlight();
}

/** Discard the flight — the placement's leave path. */
export function clearOrderFlightState(): void {
  clearOrderFlight();
}

/**
 * The hook. Mounted ONCE beside `useAppOpenRequests` / `useDoomModeSkill` in the
 * Home tree — the fourth filter on the ONE channel.
 */
export function useOrderSkillDispatch(): void {
  const handleSkillCall = useCallback((payload: LlmSkillCall | null | undefined) => {
    if (!payload || payload.skill !== ORDER_SKILL_NAME) return;
    const args = payload.arguments as
      | { readonly [ORDER_ACTION_ARG]?: unknown; readonly [ORDER_ARGUMENTS_ARG]?: unknown }
      | undefined;
    dispatchOrderSelection({
      action: args?.[ORDER_ACTION_ARG],
      arguments: args?.[ORDER_ARGUMENTS_ARG],
    });
  }, []);

  // A stable ref so the listener never re-subscribes on a re-render, and so a
  // late selection still reaches the CURRENT handler.
  const handlerRef = useRef(handleSkillCall);
  handlerRef.current = handleSkillCall;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void adapterBridge
      .listen<LlmSkillCall>('llm-skill-call', (payload) => {
        handlerRef.current(payload);
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      })
      .catch(() => {
        // A registration failure must never escape the hook (dev/no-Tauri).
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
