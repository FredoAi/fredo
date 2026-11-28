/**
 * Spec #3243 ST-8 — the in-flight order record (AC-3's construction site).
 *
 * # Why this cannot be a React ref or a `useState`
 *
 * AC-3 says an order in flight **completes in the app it was started in**, and the
 * move is not announced. The dispatcher that will execute orders lives in the
 * Home tree (`useAppOpenRequests`'s pattern) while the composer lives in
 * `CompanionEntity` — **two React trees**. A React ref resets on every mount by
 * engineering rule, and the composer's `useState` dies with the box, so neither
 * can hold a fact that must outlive both a re-render and the box's own unmount.
 * Without a module-scoped record AC-3 is not merely awkward to observe — it is
 * unobservable, because the surface that must keep naming the ORIGINAL app is not
 * the surface that knows about the order.
 *
 * The shape is the shipped module-scoped-store contract (`grounding.ts`,
 * `performanceGate.ts`, `skillBridge.ts`): a value, a listener set, and a
 * `useSyncExternalStore`-compatible read.
 *
 * # Why the record is scoped to a PLACEMENT, not to an app
 *
 * Two different things can happen while an order is in flight, and conflating
 * them breaks AC-3 in opposite directions:
 *
 *   - **The user moves to another app** (AC-3). The order keeps running in the
 *     ORIGINAL app, and its record must stay readable so the surface can keep
 *     naming that app while the target chip names the new one. Two claims, one
 *     subject each (G-475b).
 *   - **The placement ends** (AC-4 — the box closes). The record must be
 *     discarded, so a later placement of the SAME app cannot show the previous
 *     placement's outcome.
 *
 * A move does not end a placement, so the record is keyed on the **placement
 * identity** it was begun under — never on the app id. `readOrderFlight()`
 * compares that identity with the live placement, so "leaving discards" is a
 * property of the READ and not a call-site promise somebody can forget: the
 * moment the placement is cleared (or a new one is minted) the old record is
 * simply not there any more.
 *
 * That is deliberately stronger than clearing on an event. A wiring that forgot
 * to call a clear would still leak a previous placement's outcome into a fresh
 * one; a read that filters by identity cannot, because a new placement always
 * mints a new identity (`placeFredo` never reuses one).
 */

import { readPlacement } from '../placement/placementStore';

/**
 * The order states a surface may render (the plan's published
 * `data-order-state` vocabulary, ADJ-1).
 *
 * The SET is declared here because it is the record's own shape. The SENTENCES
 * each state renders are B's (`shared/order/orderReply.ts`) and are never
 * authored here — this module stores states, never copy.
 */
export type OrderFlightState =
  | 'running'
  | 'needs-confirmation'
  | 'done'
  | 'failed'
  | 'refused';

/** Every state, in the order a row should enumerate them. */
export const ORDER_FLIGHT_STATES: readonly OrderFlightState[] = Object.freeze([
  'running',
  'needs-confirmation',
  'done',
  'failed',
  'refused',
]);

/** What a caller supplies when an order starts. */
export interface BeginOrderFlightInput {
  /** The order's own id (stable for the whole flight). */
  readonly orderId: string;
  /** The app resolved AT SUBMIT — the app the order runs in (AC-3). */
  readonly appId: string;
  /** That app's display name, so a surface can name it long after the move. */
  readonly appName: string;
}

/** A settled order's terminal verdict. */
export interface SettleOrderFlightInput {
  readonly state: Exclude<OrderFlightState, 'running' | 'needs-confirmation'>;
  /** The sentence the outcome renders (from the ONE copy source). */
  readonly text: string;
}

/** The live record. Immutable: every transition produces a new value. */
export interface OrderFlight {
  readonly orderId: string;
  /** The app the order runs in — NEVER the app the user is in now. */
  readonly appId: string;
  readonly appName: string;
  /** The placement this order belongs to (its read-scope). */
  readonly placementId: string;
  readonly state: OrderFlightState;
  /** The outcome sentence for a settled flight; `''` while running. */
  readonly text: string;
  /** Monotonic per transition — makes "the record changed" observable. */
  readonly seq: number;
}

type Listener = () => void;

let current: OrderFlight | null = null;
let seq = 0;
const listeners = new Set<Listener>();

function notify(): void {
  // Snapshot: a listener may unsubscribe while being notified.
  for (const listener of [...listeners]) listener();
}

/** The live placement identity, or `''` when Fredo is not placed. */
function livePlacementId(): string {
  return readPlacement()?.placementId ?? '';
}

/**
 * The record as it may be READ right now.
 *
 * Filtered by placement identity, which is what makes AC-4's "leaving discards"
 * true without a call site having to remember anything. Note the ungrounded case
 * (`''` on both sides) reads a flight begun while unplaced — an order cannot
 * begin unplaced (it is refused before it is dispatched), so that pairing is
 * unreachable in product and is left consistent rather than special-cased.
 */
export function readOrderFlight(): OrderFlight | null {
  if (current === null) return null;
  return current.placementId === livePlacementId() ? current : null;
}

/**
 * Start (or restart) the flight for one order.
 *
 * BEGINS A NEW RECORD unconditionally: one user order is one flight, and a new
 * submit supersedes the previous record rather than merging into it. The previous
 * order's outcome is not carried anywhere — there is no history here, only the
 * current order's state (the acknowledgement surface's own record lives in the
 * composer, not in this module).
 */
export function beginOrderFlight(input: BeginOrderFlightInput): OrderFlight {
  seq += 1;
  current = Object.freeze({
    orderId: input.orderId,
    appId: input.appId,
    appName: input.appName,
    // Keyed on the placement LIVE AT BEGIN — the identity the order ran under.
    placementId: livePlacementId(),
    state: 'running',
    text: '',
    seq,
  });
  notify();
  return current;
}

/**
 * Settle the flight with a terminal state.
 *
 * Returns the new record, or `null` when there is no readable flight to settle
 * (the placement ended while the order was in flight — a late settle must NEVER
 * resurrect a discarded record; that would show a previous placement's outcome in
 * a fresh one). Callers treat `null` as "the placement moved on", not an error.
 */
export function settleOrderFlight(input: SettleOrderFlightInput): OrderFlight | null {
  if (readOrderFlight() === null) return null;
  seq += 1;
  current = Object.freeze({
    ...(current as OrderFlight),
    state: input.state,
    text: input.text,
    seq,
  });
  notify();
  return current;
}

/**
 * Move a running flight to `needs-confirmation`.
 *
 * A separate entry point from `settleOrderFlight` on purpose: a confirmation is
 * NOT terminal (the user may still confirm or cancel), so it must not be
 * reachable through the same function that closes the record — a caller that
 * settles it as `done` would render a success sentence for an unrun action.
 */
export function awaitOrderConfirmation(): OrderFlight | null {
  if (readOrderFlight() === null) return null;
  seq += 1;
  current = Object.freeze({
    ...(current as OrderFlight),
    state: 'needs-confirmation' as OrderFlightState,
    text: '',
    seq,
  });
  notify();
  return current;
}

/**
 * Discard the record outright.
 *
 * The leave path calls this together with `clearPlacement()` so subscribers are
 * notified (a read that merely starts returning `null` does not wake a
 * `useSyncExternalStore` consumer). The READ filter above is what makes the
 * discard correct even if a caller forgets this — the clear is for the
 * notification, not for the correctness.
 */
export function clearOrderFlight(): void {
  if (current === null) return;
  current = null;
  notify();
}

/**
 * Subscribe to flight changes (a begin, a settle, a confirmation, a clear).
 * Returns the unsubscribe function — the `useSyncExternalStore` listener contract.
 */
export function subscribeOrderFlight(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop the record and every subscriber. TEST ONLY — never call from product code. */
export function resetOrderFlightForTests(): void {
  current = null;
  seq = 0;
  listeners.clear();
  confirmationListeners.clear();
  pendingConfirmation = null;
}

/* ------------------------------------------------------------------------- */
/* The confirmation hand-off                                                   */
/* ------------------------------------------------------------------------- */

/**
 * A pending confirmation, published from the DISPATCHER (Home tree) to the
 * SURFACE (this entity's tree).
 *
 * The flight store already carries `needs-confirmation` as a STATE, but a state
 * alone cannot render a dialog: the dialog needs the `OrderInvocation` the user
 * is deciding about, and only the dispatcher has it. So the invocation crosses
 * the tree boundary through this module too — same reason as the flight, and it
 * is deliberately NOT a second source of truth: `confirmOrder` is still the only
 * mint site, and this record only says WHICH invocation to show.
 */
export interface OrderConfirmationRequest {
  readonly invocation: import('./orderActions').OrderInvocation;
  readonly label: string;
}

let pendingConfirmation: OrderConfirmationRequest | null = null;
const confirmationListeners = new Set<(request: OrderConfirmationRequest) => void>();

/**
 * Publish a pending confirmation. Called by the dispatcher when the gate returns
 * `needs-confirmation` — never on any other verdict (a `read` never prompts).
 */
export function requestOrderConfirmation(request: OrderConfirmationRequest): void {
  pendingConfirmation = request;
  for (const listener of [...confirmationListeners]) listener(request);
}

/** The pending confirmation, or `null` (a late mount re-reads it once). */
export function readOrderConfirmationRequest(): OrderConfirmationRequest | null {
  return pendingConfirmation;
}

/** The user answered (confirm or cancel) — drop the pending request. */
export function clearOrderConfirmationRequest(): void {
  pendingConfirmation = null;
}

/** Subscribe to confirmation requests. Returns the unsubscribe function. */
export function subscribeOrderConfirmationRequest(
  listener: (request: OrderConfirmationRequest) => void,
): () => void {
  confirmationListeners.add(listener);
  return () => {
    confirmationListeners.delete(listener);
  };
}
