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
 * # One action per order (AC-5's NARROW reading), and the per-turn funnel
 *
 * The plan's AC-5 decision is binding: this slice proves the narrow reading
 * against its four declared actions, and must NOT be read as the general claim.
 * So when a turn carries more than one selection, exactly ONE step runs plus at
 * most one lawful LOOKUP ahead of it (R-5b), and the rest are refused with typed
 * copy — never a loop over the selection, which is the defect the F-21 row counts
 * document changes to catch.
 *
 * # Why the funnel is NOT "first selection wins, refuse the rest"
 *
 * That naive rule would refuse R-5b's lawful `read` → `changing` pair, which is
 * F-22's subject, and would redden a sound row. The rule implemented below
 * arbitrates by the DECLARED RISK (the registry's, never the model's):
 *
 *   - the FIRST selection of a turn always runs;
 *   - a second runs ONLY when the first was a `read` and the second is the ACT
 *     (`changing`/`destructive`) — the one permitted two-step shape;
 *   - everything else is refused, in the shipped copy, naming the app AND the
 *     displaced action (`orderSupersededReply`). Two reads, an act-then-read and
 *     a three-step chain are all refused rather than executed.
 *
 * R-5c rides the same accumulation point (and is the reason it must exist): a
 * step that classifies `unknown` HALTS the chain, so every later selection in the
 * turn is refused and never executes. Before this funnel each event dispatched
 * independently, so nothing enforced that at all.
 *
 * # The turn boundary is the SHIPPED terminal signal, never a second timer
 *
 * The hook opens the window on the first `order` selection and closes it on
 * `llm-done` / `llm-error` — the same terminal events the transport already uses
 * to complete a generation (`TauriAdapter.llmChatWithSkills`), so the funnel adds
 * no timer and no second settle mechanism. A DIRECT `dispatchOrderSelection` call
 * (a test, the in-repo lever) that declares no turn is its own single-selection
 * turn, which is byte-equivalent to the pre-funnel behaviour — the green-green
 * control that keeps every single-selection row correct and refusal-free.
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
  orderSupersededReply,
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

/* ------------------------------------------------------------------------- */
/* The per-turn funnel (AC-5 / R-5a / R-5b / R-5c)                            */
/* ------------------------------------------------------------------------- */

/**
 * What one turn has done so far.
 *
 * `seen` counts the selections that RAN (a refused one changes nothing, so a
 * refusal can never widen the chain); `acted` records that the turn's one ACT
 * has run; `halted` records that a step could not be classified, after which
 * nothing else may run (R-5c — a failed lookup never becomes a blind act).
 */
interface OrderTurnState {
  seen: number;
  acted: boolean;
  halted: boolean;
}

/**
 * The open turn, or `null` when no turn is accumulating.
 *
 * Module-scoped for the same reason as the flight and the placement: the
 * selections of ONE turn are dispatched from the Home tree with no React owner
 * that could hold them, and the turn must survive a composer re-render between
 * two selections of the same generation.
 */
let currentTurn: OrderTurnState | null = null;

/**
 * Open a turn window. The dispatcher hook calls this implicitly on the turn's
 * first selection; `llm-done`/`llm-error` close it (see the hook below), so the
 * window IS the shipped generation, never a second timer.
 */
export function beginOrderTurn(): void {
  currentTurn = { seen: 0, acted: false, halted: false };
}

/** Close the turn window. A selection after this starts a fresh turn. */
export function endOrderTurn(): void {
  currentTurn = null;
}

/** The open turn's reading, or `null`. Diagnostics/tests only. */
export function readOrderTurn(): Readonly<OrderTurnState> | null {
  return currentTurn === null ? null : { ...currentTurn };
}

/** Drop the open turn. TEST ONLY — the `llm-done` path closes it in product. */
export function resetOrderTurnForTests(): void {
  currentTurn = null;
}

/** How one selection is admitted to the turn it arrived in. */
type TurnAdmission = 'run' | 'superseded' | 'halted';

function isActRisk(invocation: OrderInvocation): boolean {
  return invocation.risk === 'changing' || invocation.risk === 'destructive';
}

/**
 * THE ARBITRATION. At most one ACTION per turn, with `read` steps permitted
 * ahead of it (R-5b) — and nothing permitted after it (R-5a).
 *
 * Deliberately NOT "first selection wins, refuse the rest": that naive rule
 * refuses R-5b's lawful lookup-then-act, which is a real product behaviour
 * (F-22), not a defect. The rule is stated over the DECLARED risk, which is the
 * registry's and never the model's:
 *
 *   1. a halted turn admits nothing (R-5c);
 *   2. an `unknown` classification is admitted only so the GATE can refuse it in
 *      its own words — it never runs and it halts the chain;
 *   3. the first selection is admitted;
 *   4. after the act, nothing is admitted (a second act, or an act-then-read);
 *   5. before the act, only an ACT is admitted (so a second `read` is refused —
 *      a lookup after a lookup is not a lookup-then-act);
 *   6. everything else — a second read, a two-act pair, a three-step chain — is
 *      refused.
 */
function admitToTurn(invocation: OrderInvocation, turn: OrderTurnState): TurnAdmission {
  if (turn.halted) return 'halted';
  // An unclassifiable step is handed to the gate, whose `refused-unknown` arm
  // owns that sentence. It must not become the turn's act.
  if (invocation.risk === 'unknown') return 'run';
  if (turn.seen === 0) return 'run';
  if (turn.acted) return 'superseded';
  return isActRisk(invocation) ? 'run' : 'superseded';
}

/**
 * Record what a step that RAN did to the turn.
 *
 * `unknown` halts (R-5c); an act closes the turn's one action slot (R-5a). A
 * `read` records only that it ran, which is what lets exactly one later act
 * follow it (R-5b) while a second read cannot.
 */
function recordTurnStep(invocation: OrderInvocation, turn: OrderTurnState): void {
  turn.seen += 1;
  if (invocation.risk === 'unknown') {
    turn.halted = true;
    return;
  }
  if (isActRisk(invocation)) turn.acted = true;
}

/** The action's declared label, for copy — the id when it does not resolve. */
function declaredLabelFor(appId: string, actionId: string): string {
  return (
    readOrderSurface(appId)?.actions.find((candidate) => candidate.id === actionId)?.label ?? actionId
  );
}

/**
 * Refuse a DISPLACED selection with the shipped copy (R-5a).
 *
 * It pushes and speaks the sentence but deliberately does NOT settle the flight:
 * the record belongs to the step that actually ran, and marking a real execution
 * `refused` because a second order arrived alongside it would be the UI lying
 * about the first. The sentence is the user's only signal for the dropped one,
 * which is exactly the gap the silent single-slot overwrite left behind.
 */
function refuseDisplaced(appName: string, label: string): OrderDispatchOutcome {
  const text = orderSupersededReply(appName, label);
  settleReply(text);
  return { kind: 'refused', text };
}

/**
 * Refuse a selection because the turn's chain HALTED (R-5c). A halted chain is a
 * fault in the first step, so this is the unknown-refusal class — not the
 * "one thing at a time" sentence, which would describe a different condition.
 */
function refuseHalted(appName: string): OrderDispatchOutcome {
  const text = orderRefusedUnknownReply(appName);
  settleReply(text);
  return { kind: 'refused', text };
}

/** The body of one dispatch, with a turn guaranteed open. */
function dispatchWithinTurn(
  selection: { readonly action?: unknown; readonly arguments?: unknown },
): OrderDispatchOutcome {
  const turn = currentTurn as OrderTurnState;
  const actionId = typeof selection.action === 'string' ? selection.action.trim() : '';
  const placement = readPlacement();
  // AC-3's subject: the app resolved AT SUBMIT. With no placement there is no
  // resolved target, so an order is refused by name (UIUX-D7) rather than
  // narrated as prose.
  const appId = placement?.appId ?? '';
  const appName = placement?.appName ?? '';

  const invocation = buildOrderInvocation(appId, actionId, readArgBag(selection.arguments));
  if (invocation === null) {
    // No dispatchable order at all: nothing later in this turn can be reasoned
    // about against a declared shape, so the chain halts here too.
    turn.halted = true;
    const text = orderRefusedUnknownReply(appName);
    beginOrderFlight({ orderId: `order-${Date.now()}`, appId, appName });
    settleOrderFlight({ state: 'refused', text });
    settleReply(text);
    return { kind: 'refused', text };
  }

  const admission = admitToTurn(invocation, turn);
  if (admission === 'halted') return refuseHalted(appName);
  if (admission === 'superseded') {
    return refuseDisplaced(appName, declaredLabelFor(invocation.appId, invocation.actionId));
  }

  // AC-3's record is created at SUBMIT, before the gate: the ticker names the
  // ORIGINAL app from this moment, so a later move cannot change it.
  beginOrderFlight({
    orderId: `order-${invocation.fingerprint}-${Date.now()}`,
    appId: invocation.appId,
    appName,
  });

  const outcome = routeInvocation(invocation, appName);
  recordTurnStep(invocation, turn);

  if (outcome.kind === 'needs-confirmation') {
    // A confirmation is NOT a refusal: the order is understood and awaiting the
    // user's decision, so it gets its OWN sentence (G-505) — never the
    // "can't carry out" copy, which describes a fault.
    awaitOrderConfirmation();
    // The label is needed for the copy; read it from the declared surface.
    const declaredLabel = declaredLabelFor(invocation.appId, invocation.actionId);
    // Hand the INVOCATION to the surface that renders the dialog (two React
    // trees, one module store — the same reason the flight is module-scoped).
    requestOrderConfirmation({ invocation, label: declaredLabel, appName });
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
 * Dispatch one `order` selection WITHOUT a model or a pointer — the in-repo
 * induction lever's landing point, and the seam every row drives.
 *
 * A call while a turn is open joins THAT turn (and is arbitrated against what the
 * turn already did). A call with no turn open is its own single-selection turn —
 * identical in behaviour to the pre-funnel dispatcher, which is what keeps every
 * one-selection row correct and refusal-free.
 *
 * Returns the outcome so a test/lever can assert what happened, and pushes the
 * user-visible reply as a side effect (the same one reply per order).
 */
export function dispatchOrderSelection(
  selection: { readonly action?: unknown; readonly arguments?: unknown } | null | undefined,
): OrderDispatchOutcome {
  if (selection === null || selection === undefined) return { kind: 'ignored' };
  if (currentTurn !== null) return dispatchWithinTurn(selection);
  currentTurn = { seen: 0, acted: false, halted: false };
  try {
    return dispatchWithinTurn(selection);
  } finally {
    currentTurn = null;
  }
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
 *
 * **The turn window's open/close is the SHIPPED generation boundary, not a new
 * timer.** The first `order` selection of a turn opens it; `llm-done` and
 * `llm-error` close it — the same two terminal events `TauriAdapter.
 * llmChatWithSkills` already uses to finish a generation (`finish()` on either).
 * A turn that emits several selections therefore accumulates them into ONE
 * arbitration window with no second settle mechanism and no timeout of our own.
 */
export function useOrderSkillDispatch(): void {
  const handleSkillCall = useCallback((payload: LlmSkillCall | null | undefined) => {
    if (!payload || payload.skill !== ORDER_SKILL_NAME) return;
    const args = payload.arguments as
      | { readonly [ORDER_ACTION_ARG]?: unknown; readonly [ORDER_ARGUMENTS_ARG]?: unknown }
      | undefined;
    // Open the turn on its first selection; later selections of the SAME turn
    // join it and are arbitrated against what it already did.
    if (readOrderTurn() === null) beginOrderTurn();
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
    let unlistenDone: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

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

    // The turn boundary: the generation's own terminal events. Registered
    // alongside the selection channel so a turn that emits its selections and
    // then completes is closed exactly once — and so the NEXT turn starts with a
    // fresh window (a second user order is a second order).
    void adapterBridge
      .listen<void>('llm-done', () => {
        endOrderTurn();
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlistenDone = off;
      })
      .catch(() => {
        // Same contract as the selection channel: never escape the hook.
      });

    void adapterBridge
      .listen<string>('llm-error', () => {
        // A failed generation ends its turn too: its selections are already
        // arbitrated, and nothing more arrives for it.
        endOrderTurn();
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlistenError = off;
      })
      .catch(() => {
        // Same contract as the selection channel: never escape the hook.
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenDone?.();
      unlistenError?.();
    };
  }, []);
}
