/**
 * Spec #3243 ST-4 — the order surface's public barrel.
 *
 * It re-exports ONLY ST-4's own modules, so it carries no hidden predecessor
 * (G-167): the gesture (ST-2), the gate (ST-5), undo (ST-6) and the dispatcher
 * (ST-8) are consumed by DIRECT import, never through here. An application
 * declaring an order surface imports from this module; a consumer of the gate
 * or the undo registry imports those modules directly.
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
