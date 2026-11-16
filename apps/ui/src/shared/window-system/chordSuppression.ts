/**
 * Chord suppression classifier (Spec #3151 ST-1) — the re-homed home of the
 * focus predicates the three surviving platform chords consult.
 *
 * The retired navigation engine classified focus into a five-value
 * `FocusContext` (`shared/navigation/focusContext.ts`); the only part that still
 * matters is "should a platform chord fire here?". This module narrows the
 * vocabulary to `ChordSuppressionContext` (`text-entry` | `terminal` | `modal` |
 * `none`) and keeps the SAME binding precedence:
 *
 *   terminal > modal > text-entry > none
 *
 * `terminal` is checked before `text-entry` because a terminal's hidden helper
 * textarea would otherwise classify as text-entry and mask the terminal
 * passthrough context. `modal` covers both a focus inside an open
 * `[role="dialog"][aria-modal="true"]` and the caller's global "a modal is open"
 * fact.
 *
 * Scope discipline: this module adds NO `document` listener and holds no state —
 * it only inspects the element tree it is handed (and, in `isChordSuppressed()`,
 * the CURRENT `document.activeElement`). The single capture-phase keydown
 * listener that consumes it belongs to the chord installer, not here.
 */

/** The terminal root the focus classifier keys on. */
export const TERMINAL_ROOT_SELECTOR = '[data-fredo-terminal-root="true"]';

/** The selector for an open, aria-modal dialog. */
const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';

/** Roles that make an element a textbox even without a native input tag. */
const TEXTBOX_ROLES: ReadonlySet<string> = new Set(['textbox']);

/** Roles that make an element act on a bare Space/Enter (native consumers). */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'slider',
]);

/**
 * The classification of the active element for chord-suppression purposes:
 * - `terminal`   — inside `[data-fredo-terminal-root="true"]`
 * - `modal`      — inside an open aria-modal dialog, or a global open modal
 * - `text-entry` — INPUT / TEXTAREA / SELECT / contenteditable / role=textbox
 * - `none`       — nothing suppresses the chord
 */
export type ChordSuppressionContext = 'text-entry' | 'terminal' | 'modal' | 'none';

/**
 * The ONE text-editing-control predicate: INPUT / TEXTAREA / SELECT /
 * contenteditable / role=textbox.
 */
export function isTextControl(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.getAttribute('contenteditable') === 'true') return true;
  const role = el.getAttribute('role');
  if (role !== null && TEXTBOX_ROLES.has(role)) return true;
  return (el as HTMLElement).isContentEditable === true;
}

/** True when the element is a focusable control that may natively consume a bare key. */
export function isInteractiveElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'BUTTON') return true;
  if (tag === 'A' && el.hasAttribute('href')) return true;
  const role = el.getAttribute('role');
  if (role !== null && INTERACTIVE_ROLES.has(role)) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  return false;
}

/**
 * Classify the active element into a `ChordSuppressionContext`.
 *
 * `options.modalOpen` lets the caller contribute the global "an aria-modal
 * dialog is open" fact without this pure module querying the document itself.
 */
export function classifyChordSuppression(
  active: Element | null,
  options?: { readonly modalOpen?: boolean },
): ChordSuppressionContext {
  if (active && active.closest(TERMINAL_ROOT_SELECTOR)) return 'terminal';
  if (options?.modalOpen === true) return 'modal';
  if (active && active.closest(MODAL_SELECTOR)) return 'modal';
  if (isTextControl(active)) return 'text-entry';
  return 'none';
}

/**
 * True when a platform chord must not fire in the CURRENT document focus state.
 *
 * Reads `document.activeElement` plus the document-wide aria-modal scan — the
 * one focus-derived suppression the three chords need. Fails OPEN (`false`) when
 * there is no document (SSR / unit environments without a DOM).
 */
export function isChordSuppressed(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  const modalOpen = document.querySelector(MODAL_SELECTOR) !== null;
  return classifyChordSuppression(active, { modalOpen }) !== 'none';
}
