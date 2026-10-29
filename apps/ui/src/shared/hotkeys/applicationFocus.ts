/**
 * Spec #3097 (slice A / ST-2) — the ONE "which application owns focus" resolver.
 *
 * A mode key must NEVER leak into an application while the launcher/desktop
 * chrome owns focus, and two applications must be able to declare the same
 * letter without a global collision. Both need the SAME answer to "which
 * application is the user currently in", so this module owns it:
 *
 *   1. the nearest `[data-fredo-app-id]` ancestor (incl. self) of the active
 *      element — the application that actually owns the focused control;
 *   2. else, for a body/null active element, the focused window in the own
 *      window kernel (`getWindowSnapshot()`);
 *   3. else, the single `[data-fredo-app-id]` root in the document (own-window /
 *      standalone webview — where there is no window kernel entry);
 *   4. else `null`.
 *
 * Crucially a NON-BODY active element outside every application root (launcher,
 * desktop chrome) resolves to `null` and MUST NOT fall through to 2/3.
 *
 * DEPENDENCY DISCIPLINE (binding): this module imports ONLY the application
 * registry (+ types) and the window kernel — NEVER `commandSurfaceStore`. The
 * store imports this module, so the reverse edge would be a module cycle.
 * It holds NO state and adds NO listeners (the store owns the runtime).
 */

import { getApplications } from '../../applications/applicationRegistry';
import type { FredoApplicationClass } from '../classes';
import type { ApplicationCommandSurface } from './commandSurface';
import { getWindowSnapshot } from '../window-system/windowStore';

/** The attribute an application's window/content root declares itself with. */
export const APP_ROOT_ATTR = 'data-fredo-app-id';

/** `[data-fredo-app-id]` as a CSS selector (built from the exported constant). */
const APP_ROOT_SELECTOR = `[${APP_ROOT_ATTR}]`;

/**
 * The nearest ancestor-or-self carrying `[data-fredo-app-id]`, or `null` when
 * the element is outside every application root. Never dereferences application
 * metadata off the element — the attribute is the only DOM contract.
 */
export function getElementApplicationId(el: Element | null): string | null {
  if (el === null || typeof el.closest !== 'function') return null;
  const root = el.closest(APP_ROOT_SELECTOR);
  if (root === null) return null;
  return root.getAttribute(APP_ROOT_ATTR);
}

/** The registered application instance for `appId` (first registration wins). */
export function findApplication(appId: string | null): FredoApplicationClass | null {
  if (appId === null) return null;
  return getApplications().find((application) => application.id === appId) ?? null;
}

/**
 * The application's declared command surface, or `null` when the application is
 * unknown OR has not opted in. This is the ONE opt-in test every consumer uses
 * (never `.commandSurface` on an element).
 */
export function resolveApplicationCommandSurface(
  appId: string | null,
): ApplicationCommandSurface | null {
  return findApplication(appId)?.commandSurface ?? null;
}

/** Top-level `[data-fredo-app-id]` roots (nested roots are ignored), in order. */
function listTopLevelApplicationRoots(): string[] {
  if (typeof document === 'undefined') return [];
  const roots: string[] = [];
  document.querySelectorAll<HTMLElement>(APP_ROOT_SELECTOR).forEach((node) => {
    const parentRoot = node.parentElement?.closest(APP_ROOT_SELECTOR) ?? null;
    if (parentRoot !== null) return;
    const id = node.getAttribute(APP_ROOT_ATTR);
    if (id !== null) roots.push(id);
  });
  return roots;
}

/**
 * The application that currently owns keyboard focus, or `null` when the
 * launcher/desktop chrome owns it (or no application can be derived).
 */
export function resolveFocusedApplicationId(): string | null {
  if (typeof document === 'undefined') return null;

  const active = document.activeElement;
  if (active !== null && active !== document.body && active !== document.documentElement) {
    // Step 1/4 — an element outside every root is launcher/chrome focus: NEVER
    // fall through to the focused window or the single-root fallback.
    return getElementApplicationId(active);
  }

  // Step 2 — body/null focus defers to the own window kernel.
  const focusedWindow = getWindowSnapshot().find((win) => win.focused === true);
  if (focusedWindow !== undefined) return focusedWindow.id;

  // Step 3 — own-window / standalone webview: exactly one application root.
  const roots = listTopLevelApplicationRoots();
  return roots.length === 1 ? roots[0] : null;
}

/**
 * The focused application's id ONLY when it has opted into a command surface.
 * Used as the per-scope bucket key for duplicate detection, so two applications
 * that both bind `c` never collide while a duplicate inside one application
 * still does.
 */
export function getCommandSurfaceScopeId(el: Element | null): string | null {
  const appId = getElementApplicationId(el);
  if (appId === null) return null;
  return resolveApplicationCommandSurface(appId) !== null ? appId : null;
}

/**
 * True when an element binding belongs to the application currently
 * focused/displayed (Spec #3098 ST-1 / A1 — the ONE predicate for BOTH the
 * keydown resolution and the bar listing).
 *
 *  - a `null`-scoped element (owner declares no surface, or no app root at all)
 *    is ALWAYS in scope — today's behaviour, byte-identically;
 *  - a scoped element is in scope only for its own surface-owning application;
 *  - `focusedAppId === null` means no application is displayed, so a scoped
 *    element is never in scope (the off-screen carrier must stay dead).
 */
export function isElementInActiveCommandScope(
  el: Element | null,
  focusedAppId: string | null,
): boolean {
  const scopeId = getCommandSurfaceScopeId(el);
  if (scopeId === null) return true;
  return focusedAppId !== null && scopeId === focusedAppId;
}
