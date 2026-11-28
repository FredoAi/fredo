/**
 * Spec #3243 ST-4 — THE ONE copy source for every order reply (ADJ-3, ADJ-4).
 *
 * Every sentence a user SEES or HEARS about an order is composed here and
 * nowhere else. The reply surface, the ticker and the speech seam all consume
 * these strings, so the visual and the spoken text cannot drift, and no surface
 * may concatenate its own copy (that would be a second copy source, which is
 * exactly what this module exists to prevent).
 *
 * ## Two binding rules
 *
 * 1. **Every settle sentence names BOTH the action label and the application**
 *    (ADJ-4). The ticker is the DURABLE record of an order: it is read after
 *    the bubble's 5 s hold has expired, and possibly after the user left the
 *    app and returned to a different one. A `Done`-only sentence is unreadable
 *    there. So the formatters take `(appName, label)` — never `label` alone.
 *
 * 2. **No fault borrows another fault's sentence** (G-505). A user who
 *    CANCELLED understood the order perfectly and changed their mind; telling
 *    them Fredo "couldn't carry it out" is a different condition with a
 *    different user next-action (reword vs change your mind). That is why
 *    `orderCancelledReply` exists as its own formatter (ADJ-3) and why its text
 *    deliberately contains NEITHER the `couldn't` NOR the `can't carry`
 *    wording of `orderRefusedUnknownReply`.
 *
 * Copy rules (binding): plain ASCII quotes/apostrophes only (U+0027 / U+0022),
 * no curly variants, no leading/trailing whitespace, one sentence where the
 * shape allows. Pure text — no React, no theme values, no state.
 */

/** `Done - Fill Rectangle in Wireframe` — the settle sentence for a performed action. */
export function orderPerformedReply(appName: string, label: string): string {
  return `Done - ${label} in ${appName}`;
}

/** `Needs your confirmation - Fill Rectangle in Wireframe` — the `needs-confirmation` ticker text. */
export function orderNeedsConfirmationReply(appName: string, label: string): string {
  return `Needs your confirmation - ${label} in ${appName}`;
}

/**
 * The fail-closed refusal (AC-6d). It names the app and states that the order
 * cannot be carried out THERE — the app was found perfectly well, so it
 * deliberately does NOT borrow the app-OPEN `I couldn't find "<name>"` sentence
 * (`appOpenReply.ts`), which would tell the user the app does not exist
 * (G-505 / UIUX-D5).
 *
 * A blank `appName` is the UNGROUNDED composer (UIUX-D7): the same refusal
 * class, naming the missing app instead of naming a wrong one.
 */
export function orderRefusedUnknownReply(appName: string): string {
  const name = typeof appName === 'string' ? appName.trim() : '';
  if (name === '') {
    return "I can't carry out that order - there is no app in front of me yet.";
  }
  return `I can't carry out that order in ${name} yet.`;
}

/**
 * The user CANCELLED the confirmation (R-6c, ADJ-3). The subject is the USER's
 * own decision, never a fault: nothing was carried out because they said so.
 *
 * Contains neither `couldn't` nor `can't carry` — the QA row asserts the
 * ABSENCE of the unknown-refusal wording, so borrowing it here fails on a
 * correct product.
 */
export function orderCancelledReply(appName: string, label: string): string {
  return `Cancelled - ${label} in ${appName}. Nothing was changed.`;
}

/** `Undone - Fill Rectangle in Wireframe` — a successful undo through the app's own inverse. */
export function orderUndoReply(appName: string, label: string): string {
  return `Undone - ${label} in ${appName}`;
}

/**
 * Nothing left to undo (R-8c, and the stale-safe race in F-34). Never claims an
 * undo occurred and never implies one did; `label` is optional because an empty
 * registry has no action to name.
 */
export function orderNothingToUndoReply(appName: string, label?: string): string {
  const named = typeof label === 'string' ? label.trim() : '';
  if (named === '') return `Nothing left to undo in ${appName}.`;
  return `Nothing left to undo for ${named} in ${appName}.`;
}

/**
 * The PRE-RUN warning for an irreversible action (AC-8 / R-8b). Rendered in the
 * confirmation BEFORE anything runs, together with the action's declared
 * `consequence`, so an `undoable: false` action is always warned about before it
 * can change anything.
 *
 * Non-empty for EVERY irreversible classification (the QA pin), including an
 * empty declared consequence — a bare "cannot be undone" still warns.
 */
export function orderIrreversibleWarning(
  appName: string,
  label: string,
  consequence: string,
): string {
  const declared = typeof consequence === 'string' ? consequence.trim() : '';
  const base = `This cannot be undone: ${label} in ${appName}.`;
  return declared === '' ? base : `${base} ${declared}`;
}

/**
 * The confirmation's statement for an UNDOABLE change. It is bound to the
 * declared `undoable` datum (not a promise about what will be registered), and
 * it lives here so the dialog does not become a second copy source.
 */
export const ORDER_UNDOABLE_NOTICE = 'You can undo this afterwards.';

/** The irreversible variant's explanation of WHY it is dangerous (before the consequence). */
export const ORDER_IRREVERSIBLE_NOTICE = 'This cannot be undone.';

/** The a11y/verbatim identity of the order notice strings, for documents/tests. */
export const ORDER_REPLY_SOURCE_FILE = 'apps/ui/src/shared/order/orderReply.ts';
