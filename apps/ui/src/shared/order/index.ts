/**
 * Spec #3243 — the order surface's public barrel (ST-4 + ST-5 + ST-6).
 *
 * The barrel exists so an app-author-facing consumer has ONE import site for
 * declaring actions and reading the classification. Its dependency edges are
 * the plan's: ST-5 (`confirmGate`) and ST-6 (`orderUndo`) both require ST-4
 * (`actionRisk`/`orderActions`), and neither is a barrel over the other's
 * internals — each re-exports only its own module's public names.
 *
 * Not here on purpose: the GESTURE (ST-2, `orderGesture.ts`), the FLIGHT store
 * (ST-8, `orderFlight.ts`) and the CONFIRMATION COMPONENT (ST-5,
 * `components/companion/OrderConfirmation.tsx`). Consumers import those
 * directly, so the barrel carries no hidden predecessor (G-167) and a component
 * import never drags the store graph into a test.
 */

export {
  ORDER_RISK_CLASSES,
  OrderSurfaceRegistrationError,
  classifyOrder,
  classifyOrderAction,
  isOrderRiskClass,
  listOrderSurfaceAppIds,
  readOrderAction,
  readOrderSurface,
  registerOrderSurface,
  resetOrderSurfacesForTests,
  unknownOrderClassification,
} from './actionRisk';
export type { OrderClassification, OrderRiskClass } from './actionRisk';

export {
  buildOrderInvocation,
  canonicalOrderArgs,
  fingerprintOrder,
} from './orderActions';
export type {
  FredoOrderAction,
  FredoOrderActionArgument,
  FredoOrderSurface,
  OrderInvocation,
} from './orderActions';

export {
  ORDER_IRREVERSIBLE_NOTICE,
  ORDER_UNDOABLE_NOTICE,
  orderCancelledReply,
  orderIrreversibleWarning,
  orderNeedsConfirmationReply,
  orderNothingToUndoReply,
  orderPerformedReply,
  orderRefusedUnknownReply,
  orderSupersededReply,
  orderUndoReply,
} from './orderReply';

export {
  WIREFRAME_DELETE_ACTION,
  WIREFRAME_DESCRIBE_ACTION,
  WIREFRAME_FILL_ACTION,
  WIREFRAME_NEW_DOCUMENT_ACTION,
  WIREFRAME_ORDER_EXECUTORS,
  WIREFRAME_ORDER_SURFACE,
  registerWireframeOrderSurface,
  runWireframeOrder,
} from './wireframeOrderSurface';
export type { WireframeOrderExecutor, WireframeOrderOutcome } from './wireframeOrderSurface';

/**
 * The GATE (ST-5) and UNDO (ST-6) are exported here too, because a consumer that
 * dispatches an order needs all three together.
 *
 * `mintOrderGrant` is DELIBERATELY NOT exported. The whole point of AC-7's grant
 * provenance is that a grant exists only as the return value of the one writer,
 * reachable only through `confirmOrder`. Re-exporting the mint "for symmetry"
 * would hand every consumer of this barrel a direct writer — a second way to
 * mint, which is exactly what the construction forbids. Consumers import it from
 * `confirmGate` if they are the gate's own tests; nothing else may.
 */
export {
  ORDER_GRANT_LIMIT,
  confirmOrder,
  consumeOrderGrant,
  hasLiveOrderGrant,
  readOrderGrants,
  resetOrderGrantsForTests,
  resolveOrderConfirmation,
} from './confirmGate';
export type { OrderGateVerdict, OrderGrant } from './confirmGate';

export {
  ORDER_UNDO_DEPTH,
  hasOrderUndo,
  peekOrderUndoLabel,
  readOrderUndoRecords,
  registerOrderUndo,
  resetOrderUndoForTests,
  undoLastOrder,
} from './orderUndo';
export type { OrderUndoOutcome, OrderUndoRecord } from './orderUndo';
