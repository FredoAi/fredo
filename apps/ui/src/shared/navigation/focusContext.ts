/**
 * Spec #3122 (P8), ST-1 — the ONE focus classifier, relocated verbatim from
 * `shared/hotkeys/focusContext.ts` into the navigation layer.
 *
 * The predicate that identifies a text-editing control is the single implementation; the
 * global chord dispatcher (`navigation/ui/globalKeys.ts`) and every navigation provider
 * consume this copy rather than re-deriving one. This module does not import React/Tauri and
 * holds no state — it only inspects the element tree it is handed.
 *
 * Precedence (binding):
 *   terminal > modal > text-entry > interactive > default.
 * `terminal` is checked before `text-entry` because a terminal's hidden helper textarea would
 * otherwise classify as text-entry and mask the terminal passthrough context.
 */

import type { FocusContext } from './types';

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
 * The ONE text-editing-control predicate: INPUT / TEXTAREA / SELECT / contenteditable /
 * role=textbox.
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
 * Classify the active element into a `FocusContext`.
 *
 * `options.modalOpen` lets the caller contribute the global "an aria-modal dialog is open"
 * fact without this pure module querying the document itself.
 */
export function classifyFocusContext(
  active: Element | null,
  options?: { readonly modalOpen?: boolean },
): FocusContext {
  if (active && active.closest('[data-fredo-terminal-root="true"]')) return 'terminal';
  if (options?.modalOpen === true) return 'modal';
  if (active && active.closest('[role="dialog"][aria-modal="true"]')) return 'modal';
  if (isTextControl(active)) return 'text-entry';
  if (isInteractiveElement(active)) return 'interactive';
  return 'default';
}
