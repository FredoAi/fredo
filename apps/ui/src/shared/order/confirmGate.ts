/**
 * Spec #3243 ST-5 — the confirmation gate. **AC-7's construction site.**
 *
 * ## AC-7 is a SECURITY property, and it is STRUCTURAL here — not a policy
 *
 * The requirement is not "the model is told not to confirm its own action". It
 * is that **the model has no channel through which it could**. Three
 * construction sites hold, and this module is two of them:
 *
 *   1. **The offer schema** declares exactly `action` + `arguments`
 *      (`order_offer.rs`, ST-3) — there is no confirmation-shaped property to
 *      fill.
 *   2. **Grant provenance (this module).** A grant exists ONLY as the return
 *      value of `mintOrderGrant`, and this file is the ONLY place that calls it:
 *      `confirmOrder` is its sole caller, and `confirmOrder` is entered only
 *      from the confirmation control's USER event (`OrderConfirmation`'s
 *      `onConfirm`). `mintOrderGrant` takes a bare `fingerprint: string` — the
 *      type admits no model payload, so there is no argument a model could
 *      supply that becomes a grant. `OrderGrant.mintedBy` is the literal type
 *      `'user'`, and no writer produces any other value.
 *   3. **The executor** refuses unless an UNCONSUMED grant matches the
 *      invocation's fingerprint, and consumes it (single use).
 *
 * A model argument named `confirmed`/`approved`/`grant` lands in
 * `invocation.args`, and **nothing here reads `args` at all** — the gate's only
 * model-derived input is the invocation's identity (appId + actionId + args, via
 * its fingerprint), never a field that could be interpreted as consent.
 *
 * ## `unknown` NEVER consults a grant (fail closed)
 *
 * `resolveOrderConfirmation` short-circuits on `unknown` BEFORE touching the
 * grant store. A stale or attacker-minted unconsumed grant therefore cannot
 * authorise an order the classifier could not classify — the fail-open reading
 * ("unknown ⇒ try the grant") is the defect world, and the row that matters
 * asserts the grant is neither consulted NOR consumed on that path.
 *
 * ## Why the grant store is module-scoped and bounded
 *
 * A React ref resets on mount and a component's `useState` dies with the box
 * (the engineering persistence rule); the confirmation survives the composer's
 * re-render, and a granted-then-dispatched turn must be readable in the same
 * synchronous turn the gate runs in. So the store is module-scoped, and
 * `ORDER_GRANT_LIMIT` bounds it oldest-first so a long session cannot grow it
 * without limit.
 */

import type { OrderInvocation } from './orderActions';

/** A user-minted, single-use authorisation for ONE invocation fingerprint. */
export interface OrderGrant {
  /** The invocation fingerprint this grant authorises (and nothing else). */
  readonly fingerprint: string;
  /** Monotonic mint sequence — the store's ordering token. */
  readonly seq: number;
  /**
   * A LITERAL type. There is no other writer: `mintOrderGrant` is the only
   * producer and it stamps this value itself, so no model data can reach it.
   */
  readonly mintedBy: 'user';
  /** True once the grant has authorised one execution. */
  readonly consumed: boolean;
}

/** The gate's verdict. */
export type OrderGateVerdict = 'granted' | 'needs-confirmation' | 'refused-unknown';

/**
 * Bounded grant store depth. A confirmation is short-lived by design (it dies
 * with the placement), so a large bound would only ever hold stale grants.
 */
export const ORDER_GRANT_LIMIT = 20;

/** Module-scoped: live grants, oldest first. */
let grants: OrderGrant[] = [];
/** Monotonic mint counter — never rewound. */
let nextSeq = 1;

/**
 * THE ONLY WRITER of a grant.
 *
 * Takes a bare fingerprint — deliberately NOT an invocation, and deliberately
 * not an object that could carry model-authored fields — so the only way to
 * reach it with model data would be to compute a fingerprint, which grants
 * nothing on its own (the grant still only authorises THAT fingerprint once,
 * through the user's confirm control).
 *
 * Its sole caller is `confirmOrder`, below.
 */
export function mintOrderGrant(fingerprint: string): OrderGrant {
  const grant: OrderGrant = Object.freeze({
    fingerprint,
    seq: nextSeq,
    mintedBy: 'user' as const,
    consumed: false,
  });
  nextSeq += 1;
  grants.push(grant);
  if (grants.length > ORDER_GRANT_LIMIT) {
    grants = grants.slice(grants.length - ORDER_GRANT_LIMIT);
  }
  return grant;
}

/**
 * Single use: `true` on the FIRST call for a live matching grant, then the grant
 * is consumed (a second call for the same fingerprint with no new mint returns
 * `false`).
 *
 * Consumption REPLACES the stored grant with a consumed copy rather than
 * deleting it, so a later `hasLiveOrderGrant` read is truthful about a grant
 * that existed and was spent.
 */
export function consumeOrderGrant(fingerprint: string): boolean {
  for (let index = grants.length - 1; index >= 0; index -= 1) {
    const grant = grants[index];
    if (grant.fingerprint !== fingerprint) continue;
    if (grant.consumed) return false;
    grants[index] = Object.freeze({ ...grant, consumed: true });
    return true;
  }
  return false;
}

/** True iff an UNCONSUMED grant exists for `fingerprint` (no consumption). */
export function hasLiveOrderGrant(fingerprint: string): boolean {
  return grants.some((grant) => grant.fingerprint === fingerprint && !grant.consumed);
}

/** The live (unconsumed) grants, oldest first — diagnostics/tests only. */
export function readOrderGrants(): readonly OrderGrant[] {
  return grants.filter((grant) => !grant.consumed);
}

/**
 * The USER-GRANTED confirm step. **The ONLY `mintOrderGrant` caller.**
 *
 * Entered ONLY from `OrderConfirmation`'s `onConfirm` — i.e. from a user event.
 * It mints one grant for the invocation's fingerprint and returns whether the
 * invocation is now authorised to run.
 *
 * It returns `false` for an invocation that could never be authorised
 * (`refused-unknown`), so a confirm on an unknown order cannot create a grant
 * that a later dispatch might spend.
 */
export function confirmOrder(invocation: OrderInvocation): boolean {
  // An unknown classification can NEVER be confirmed — the same fail-closed
  // short-circuit the gate takes, so no grant is minted for it.
  if (invocation.risk === 'unknown') return false;
  mintOrderGrant(invocation.fingerprint);
  return true;
}

/**
 * THE GATE (AC-6 + AC-7's executor arm).
 *
 *  - `read`            ⇒ `granted` (a read mutates nothing; AC-8's warning is
 *                        vacuous, and the confirmation never renders for it).
 *                        The grant store is NOT consulted and NOT consumed —
 *                        asserted by the truth-table pin.
 *  - `changing` /
 *    `destructive`     ⇒ `granted` iff an UNCONSUMED fingerprint-matching grant
 *                        exists, and that grant is CONSUMED (single use);
 *                        otherwise `needs-confirmation`.
 *  - `unknown`         ⇒ `refused-unknown`, and the grant store is NEVER
 *                        consulted and NEVER consumed (fail closed — a stale
 *                        grant must not authorise an unclassifiable order).
 */
export function resolveOrderConfirmation(invocation: OrderInvocation): OrderGateVerdict {
  if (invocation.risk === 'unknown') return 'refused-unknown';
  if (invocation.risk === 'read') return 'granted';
  return consumeOrderGrant(invocation.fingerprint) ? 'granted' : 'needs-confirmation';
}

/** Test-only: drop every grant and rewind the mint counter. */
export function resetOrderGrantsForTests(): void {
  grants = [];
  nextSeq = 1;
}
