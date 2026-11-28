/**
 * Spec #3243 ST-4 — the declared order surface and the dispatch datum.
 *
 * An application publishes what Fredo may do in it as a `FredoOrderSurface`: a
 * table of `FredoOrderAction` declarations, each carrying its OWN risk
 * classification (`risk`, `undoable`, `consequence`). The model never supplies
 * any of those three — they are the registry's, which is what makes AC-6/AC-7
 * structural rather than a policy the model is asked to respect.
 *
 * `buildOrderInvocation` turns (appId, actionId, args) into the ONE
 * `OrderInvocation` the gate and the executor both key on. Its `fingerprint` is
 * a stable digest of `appId + actionId + canonical(args)` — the grant's scope,
 * so a grant minted for one invocation can never authorise a different one.
 *
 * ## Why every model-supplied argument is kept verbatim in the fingerprint
 *
 * A model that supplies `{ confirmed: true }` inside `arguments` reaches
 * `args["confirmed"]`, and NOTHING in this module, the classifier, the gate or
 * the executor reads an argument by name — there is no confirmation-shaped key
 * to honour. Keeping the extra key in `canonical(args)` (rather than dropping
 * it) is the SAFER direction: it changes the fingerprint, so an injected key
 * cannot ride a grant minted for the clean invocation. Filtering it out would
 * make the two invocations share a fingerprint and let a stale grant authorise
 * the tampered one.
 *
 * Pure data + one pure digest: no React, no state, no I/O.
 */

import { classifyOrder, type OrderClassification, type OrderRiskClass } from './actionRisk';

/** One argument an action accepts (`args` are model-supplied strings). */
export interface FredoOrderActionArgument {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean';
  readonly required: boolean;
}

/** One action an application declares. The ONLY source of risk/undo/consquence. */
export interface FredoOrderAction {
  /** Stable id, e.g. `'wireframe.element.fill'`. Never a shipped action-table row. */
  readonly id: string;
  /** Human label used by the reply formatters and the confirmation verb. */
  readonly label: string;
  /** Model-facing sentence — the ONLY offer description for this action. */
  readonly description: string;
  /** REQUIRED — no default. A missing/blank risk fails closed in the classifier. */
  readonly risk: OrderRiskClass;
  /** True iff the app's OWN mechanism can revert this action. */
  readonly undoable: boolean;
  /**
   * The sentence shown BEFORE an irreversible action runs (AC-8). REQUIRED when
   * `undoable === false` and `risk !== 'read'`; refused at registration
   * otherwise, so an un-warnable irreversible action cannot ship.
   */
  readonly consequence?: string;
  readonly args: readonly FredoOrderActionArgument[];
}

/** A placed application's declared action table (empty when it declares none). */
export interface FredoOrderSurface {
  readonly actions: readonly FredoOrderAction[];
}

/** The dispatch datum the gate and the executor both key on. */
export interface OrderInvocation {
  readonly appId: string;
  readonly actionId: string;
  readonly args: Readonly<Record<string, string>>;
  readonly risk: OrderRiskClass;
  readonly undoable: boolean;
  readonly consequence: string | null;
  /** Stable digest of `appId + actionId + canonical(args)` — the grant's scope. */
  readonly fingerprint: string;
}

/**
 * Canonical argument text: keys sorted (so insertion order cannot change the
 * digest) and rendered as JSON string pairs. Every value is a string — the
 * schema's `arguments` object is string-valued at this seam — so no numeric
 * formatting question can make two runs disagree.
 */
export function canonicalOrderArgs(args: Readonly<Record<string, string>>): string {
  const keys = Object.keys(args).sort();
  const pairs = keys.map((key) => [key, args[key]] as const);
  return JSON.stringify(pairs);
}

/**
 * FNV-1a over two lanes with different offset bases, rendered as 16 hex chars.
 *
 * Deliberately a small synchronous digest: the fingerprint is an equality token
 * (does this grant match this invocation?), never a cryptographic commitment,
 * and it must be computable in the same synchronous turn the gate runs in.
 */
function stableDigest(text: string): string {
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low ^= code;
    low = Math.imul(low, 0x01000193) >>> 0;
    high ^= code + index;
    high = Math.imul(high, 0x85ebca6b) >>> 0;
  }
  return `${low.toString(16).padStart(8, '0')}${high.toString(16).padStart(8, '0')}`;
}

/**
 * The grant's scope. Same app + same action + same canonical args ⇒ the same
 * fingerprint; a different arg VALUE, a different arg NAME, or a different
 * action id ⇒ a different fingerprint.
 */
export function fingerprintOrder(
  appId: string,
  actionId: string,
  args: Readonly<Record<string, string>>,
): string {
  return stableDigest(`${appId}\u0000${actionId}\u0000${canonicalOrderArgs(args)}`);
}

/**
 * Build the dispatch datum. Returns `null` only when there is structurally no
 * order to speak of (a blank app id — the ungrounded composer — or a blank
 * action id); the refusal for that case is a typed reply, not a partial
 * invocation.
 *
 * An action that does not resolve (unregistered app, unregistered id) still
 * produces an invocation, carrying the classifier's fail-closed
 * `risk: 'unknown'` — so the gate's `refused-unknown` arm is the ONE place a
 * fail-closed order is refused, and an unknown invocation can never be
 * authorised by a grant.
 */
export function buildOrderInvocation(
  appId: string,
  actionId: string,
  args: Readonly<Record<string, string>> = {},
): OrderInvocation | null {
  const app = typeof appId === 'string' ? appId.trim() : '';
  const action = typeof actionId === 'string' ? actionId.trim() : '';
  if (app === '' || action === '') return null;
  const classification: OrderClassification = classifyOrder(app, action);
  const safeArgs: Record<string, string> = {};
  for (const key of Object.keys(args)) {
    safeArgs[key] = args[key];
  }
  return {
    appId: app,
    actionId: action,
    args: safeArgs,
    risk: classification.risk,
    undoable: classification.undoable,
    consequence: classification.consequence,
    fingerprint: fingerprintOrder(app, action, safeArgs),
  };
}
