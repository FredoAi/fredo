/**
 * Spec #3243 ST-4 — the action-classification surface (AC-6/AC-7/AC-8's datum).
 *
 * This module is the ONE place an application action's danger is declared and
 * read. It carries three things and nothing else:
 *
 *   1. the CLOSED risk vocabulary (`ORDER_RISK_CLASSES`, the ONE runtime array;
 *      the `OrderRiskClass` union is derived from it, so a fifth class cannot be
 *      added without a gate arm),
 *   2. the declaration registry an application registers its
 *      `FredoOrderSurface` into (module-scoped, last registration wins,
 *      idempotent disposer — the shape proven at
 *      `shared/companion/grounding.ts`), and
 *   3. `classifyOrder` / `classifyOrderAction`, the FAIL-CLOSED mapping the gate
 *      consumes.
 *
 * ## Why the registry lives beside the classifier
 *
 * The classifier is the registry's only reader, and `orderActions.ts` (which
 * builds a dispatchable `OrderInvocation`) depends on the classifier. Keeping
 * the registry here makes the module graph ONE-directional
 * (`orderActions -> actionRisk`, with `actionRisk` importing only TYPES back),
 * so there is no runtime import cycle whose evaluation order could silently
 * leave the risk array undefined.
 *
 * ## Fail-closed is the whole point
 *
 * An unregistered app, an unregistered action id, a blank action id, or an
 * action whose declared `risk` is not a member of the closed set ALL classify
 * `{ risk: 'unknown', undoable: false, consequence: null }`. `classifyOrder`
 * NEVER defaults to `read` — a fail-open classifier would report `granted` and
 * execute a change nobody confirmed, which is the defect world AC-6/AC-7 exist
 * to make impossible.
 */

import type { FredoOrderAction, FredoOrderSurface } from './orderActions';

/**
 * The closed risk vocabulary. ONE runtime array; the union below is DERIVED, so
 * a new class reaches the type system and the runtime together (a second list
 * would let them drift).
 */
export const ORDER_RISK_CLASSES = ['read', 'changing', 'destructive', 'unknown'] as const;

/** The risk of an order action. Derived from `ORDER_RISK_CLASSES` — never re-listed. */
export type OrderRiskClass = (typeof ORDER_RISK_CLASSES)[number];

/** The classification the gate consumes. */
export interface OrderClassification {
  readonly risk: OrderRiskClass;
  /** True iff the app's OWN mechanism can revert this action. */
  readonly undoable: boolean;
  /**
   * The declared sentence shown BEFORE an irreversible action runs (AC-8);
   * `null` for every undoable action (undo is the notice) and for a `read`
   * (it mutates nothing, so a warning would be a lie).
   */
  readonly consequence: string | null;
}

/** True iff `value` is a member of the closed risk vocabulary. */
export function isOrderRiskClass(value: unknown): value is OrderRiskClass {
  return typeof value === 'string' && (ORDER_RISK_CLASSES as readonly string[]).includes(value);
}

/**
 * The fail-closed classification. Frozen and shared so every unknown path
 * returns the SAME value (a test can compare against it by reference).
 */
const UNKNOWN_CLASSIFICATION: OrderClassification = Object.freeze({
  risk: 'unknown' as OrderRiskClass,
  undoable: false,
  consequence: null,
});

/** The fail-closed classification value (never mutated — it is frozen). */
export function unknownOrderClassification(): OrderClassification {
  return UNKNOWN_CLASSIFICATION;
}

/** A registration refused a declaration that could not be warned about. */
export class OrderSurfaceRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderSurfaceRegistrationError';
  }
}

/** Module-scoped: the declared action table per app id (last registration wins). */
const surfaces = new Map<string, FredoOrderSurface>();

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Validate ONE declaration. This is where an un-warnable irreversible action is
 * stopped: a declaration with `undoable: false` and no `consequence` (and a risk
 * other than `read`) is REFUSED at registration, so it cannot ship and cannot
 * reach the gate (AC-8's pre-warning branch is the only lawful path for an
 * irreversible action).
 */
function assertDeclarable(appId: string, action: FredoOrderAction): void {
  if (action === null || typeof action !== 'object') {
    throw new OrderSurfaceRegistrationError(`${appId}: an order action must be an object`);
  }
  if (blank(action.id)) {
    throw new OrderSurfaceRegistrationError(`${appId}: an order action needs a non-empty id`);
  }
  if (action.id !== action.id.trim()) {
    throw new OrderSurfaceRegistrationError(
      `${appId}: the order action id "${action.id}" has surrounding whitespace`,
    );
  }
  if (blank(action.label)) {
    throw new OrderSurfaceRegistrationError(`${appId}/${action.id}: the label is required`);
  }
  if (blank(action.description)) {
    throw new OrderSurfaceRegistrationError(`${appId}/${action.id}: the description is required`);
  }
  if (!isOrderRiskClass(action.risk)) {
    throw new OrderSurfaceRegistrationError(
      `${appId}/${action.id}: the risk "${String(action.risk)}" is not one of ` +
        `${ORDER_RISK_CLASSES.join(', ')}`,
    );
  }
  if (action.risk === 'read') {
    // A read mutates nothing: it cannot be undone (there is nothing to revert)
    // and it cannot carry a consequence (a vacuous warning is a lie).
    if (action.undoable !== false) {
      throw new OrderSurfaceRegistrationError(
        `${appId}/${action.id}: a read action must declare undoable: false`,
      );
    }
    if (!blank(action.consequence)) {
      throw new OrderSurfaceRegistrationError(
        `${appId}/${action.id}: a read action cannot declare a consequence`,
      );
    }
  } else if (action.undoable === false && blank(action.consequence)) {
    throw new OrderSurfaceRegistrationError(
      `${appId}/${action.id}: an irreversible action MUST declare a consequence ` +
        '(AC-8 — an un-warnable irreversible action cannot ship)',
    );
  }
  if (!Array.isArray(action.args)) {
    throw new OrderSurfaceRegistrationError(`${appId}/${action.id}: args must be an array`);
  }
  const names = new Set<string>();
  for (const argument of action.args) {
    if (blank(argument.name)) {
      throw new OrderSurfaceRegistrationError(
        `${appId}/${action.id}: every declared argument needs a name`,
      );
    }
    if (names.has(argument.name)) {
      throw new OrderSurfaceRegistrationError(
        `${appId}/${action.id}: the argument "${argument.name}" is declared twice`,
      );
    }
    names.add(argument.name);
    if (argument.type !== 'string' && argument.type !== 'number' && argument.type !== 'boolean') {
      throw new OrderSurfaceRegistrationError(
        `${appId}/${action.id}: the argument "${argument.name}" has an unknown type`,
      );
    }
    if (typeof argument.required !== 'boolean') {
      throw new OrderSurfaceRegistrationError(
        `${appId}/${action.id}: the argument "${argument.name}" must declare required`,
      );
    }
  }
}

/**
 * Register (or replace) an application's declared action table. The LAST
 * registration for an `appId` wins and the returned disposer is idempotent —
 * calling it twice, or after a newer registration, never removes the newer
 * surface. An INVALID declaration throws, so nothing partial is ever published.
 */
export function registerOrderSurface(appId: string, surface: FredoOrderSurface): () => void {
  const key = typeof appId === 'string' ? appId.trim() : '';
  if (key === '') {
    throw new OrderSurfaceRegistrationError('an order surface needs a non-empty app id');
  }
  if (surface === null || typeof surface !== 'object' || !Array.isArray(surface.actions)) {
    throw new OrderSurfaceRegistrationError(`${key}: the surface must carry an actions array`);
  }
  const seen = new Set<string>();
  for (const action of surface.actions) {
    assertDeclarable(key, action);
    if (seen.has(action.id)) {
      throw new OrderSurfaceRegistrationError(
        `${key}: the action id "${action.id}" is declared twice`,
      );
    }
    seen.add(action.id);
  }
  const entry: FredoOrderSurface = { actions: [...surface.actions] };
  surfaces.set(key, entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (surfaces.get(key) === entry) surfaces.delete(key);
  };
}

/** The declared surface for `appId`, or `null` when it declares none. */
export function readOrderSurface(appId: string): FredoOrderSurface | null {
  if (typeof appId !== 'string') return null;
  const key = appId.trim();
  if (key === '') return null;
  return surfaces.get(key) ?? null;
}

/** Registered app ids (diagnostics/tests only). */
export function listOrderSurfaceAppIds(): readonly string[] {
  return [...surfaces.keys()];
}

/** Test-only: drop every registered surface. Never call from app code. */
export function resetOrderSurfacesForTests(): void {
  surfaces.clear();
}

/** The declaration for one action, or `null` when the app/id does not resolve. */
export function readOrderAction(appId: string, actionId: string): FredoOrderAction | null {
  const surface = readOrderSurface(appId);
  if (surface === null) return null;
  const id = typeof actionId === 'string' ? actionId.trim() : '';
  if (id === '') return null;
  return surface.actions.find((action) => action.id === id) ?? null;
}

/**
 * FAIL-CLOSED classification (AC-6d). An unregistered app, an unregistered
 * action id, a blank id, or a risk outside the closed set all yield
 * `{ risk: 'unknown', undoable: false, consequence: null }` — never `read`.
 *
 * An irreversible declaration that somehow reached the registry without a
 * consequence (a bypassed registration) is ALSO downgraded to `unknown`, so the
 * gate refuses rather than running an action it cannot warn about.
 */
export function classifyOrder(appId: string, actionId: string): OrderClassification {
  const action = readOrderAction(appId, actionId);
  if (action === null) return UNKNOWN_CLASSIFICATION;
  return classifyOrderAction(action);
}

/** The classification of one already-resolved declaration. */
export function classifyOrderAction(action: FredoOrderAction): OrderClassification {
  if (action === null || typeof action !== 'object') return UNKNOWN_CLASSIFICATION;
  if (!isOrderRiskClass(action.risk)) return UNKNOWN_CLASSIFICATION;
  if (action.risk === 'read') {
    return { risk: 'read', undoable: false, consequence: null };
  }
  if (action.undoable === false) {
    const consequence = typeof action.consequence === 'string' ? action.consequence.trim() : '';
    if (consequence === '') return UNKNOWN_CLASSIFICATION;
    return { risk: action.risk, undoable: false, consequence };
  }
  return { risk: action.risk, undoable: true, consequence: null };
}
