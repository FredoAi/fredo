/**
 * Spec #2946 ST-10 — the keyboard-only traversal engine (AC1; EARS R-1.1…R-1.7).
 *
 * This module COMPLETES the window traversal the ST-4 engine delegates: it turns
 * the shipped traversal bindings into real focus movement and adds the native
 * `Tab`/`Shift+Tab` window-boundary hand-off that guarantees focus is never
 * trapped inside one window.
 *
 * Division of labour (do NOT re-implement either side):
 *   - `windowStore.focusWindow()` (window kernel contract, untouched) is the ONE
 *     raise/focus API. Traversal CALLS it; it never rewrites store semantics.
 *   - `engine.ts` owns the single dispatch `document` keydown listener and the
 *     pending-sequence machine. Traversal overrides the `run` of the three
 *     traversal actions through the registry's public `registerHotkeyHandler`
 *     extension point — the engine's minimal delegation is replaced, not edited.
 *   - `Tab`/`Shift+Tab` stay native DOM order; traversal only intervenes AT a
 *     window boundary (last→next window first, first→previous window last). It
 *     ignores any modified Tab so the `primary+tab` binding stays the engine's.
 *
 * Focus placement (R-1.2/R-1.6): a keyboard raise places DOM focus on the
 * window's first focusable control, or its content region when it has none, and
 * scrolls the target into view BEFORE focus lands — never leaves focus on `body`.
 *
 * No open window ⇒ every traversal entry point is a no-op returning `false`
 * (R-1.7). Nothing here throws.
 */

import { focusWindow, getWindowSnapshot } from '../window-system/windowStore';
import { registerHotkeyHandler } from './registry';
import type { HotkeyActionId, KeySequence } from './types';

// ── Traversal action ids (the engine declares these; traversal overrides their run) ──

export const FOCUS_NEXT_ACTION_ID: HotkeyActionId = 'fredo.focus.nextWindow';
export const FOCUS_PREVIOUS_ACTION_ID: HotkeyActionId = 'fredo.focus.prevWindow';
export const CYCLE_NTH_ACTION_ID: HotkeyActionId = 'fredo.window.cycleNth';

// ── DOM hook names (contract block 7 + UI/UX §5) ─────────────────────────────

/** `data-testid` prefix on the frame root. */
export const WINDOW_FRAME_TESTID_PREFIX = 'window-frame-';
/** `data-testid` prefix on the focusable content region. */
export const WINDOW_CONTENT_TESTID_PREFIX = 'window-content-';

const FRAME_SELECTOR = '[data-testid^="window-frame-"]';
const CONTENT_SELECTOR = '[data-testid^="window-content-"]';

/**
 * The focusable-control selector. `[tabindex]` is filtered afterwards so a
 * negative `tabindex` (programmatically focusable only, e.g. the content
 * region) is EXCLUDED from Tab order — it is the R-1.2 fallback, not a stop.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
  '[contenteditable="true"]',
].join(',');

// ── Element discovery ────────────────────────────────────────────────────────

/** True when an element can receive keyboard focus and participate in Tab order. */
export function isFocusableElement(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hasAttribute('disabled')) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.hidden) return false;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null) {
    const value = Number(tabindex);
    if (Number.isNaN(value) || value < 0) return false;
  }
  return true;
}

/** Every Tab-reachable control inside `root`, in DOM order. */
export function getFocusableElements(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))) {
    if (isFocusableElement(el)) out.push(el);
  }
  return out;
}

/** The frame root for a window id, or `null` when it is not rendered. */
export function getWindowFrameElement(windowId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(FRAME_SELECTOR))) {
    if (el.dataset.testid === `${WINDOW_FRAME_TESTID_PREFIX}${windowId}`) return el;
  }
  return null;
}

/** The focusable content region for a window id, or `null`. */
export function getWindowContentElement(windowId: string): HTMLElement | null {
  const frame = getWindowFrameElement(windowId);
  if (!frame) return null;
  for (const el of Array.from(frame.querySelectorAll<HTMLElement>(CONTENT_SELECTOR))) {
    if (el.dataset.testid === `${WINDOW_CONTENT_TESTID_PREFIX}${windowId}`) return el;
  }
  return null;
}

/** The window id encoded in a frame root, or `null` for a non-frame element. */
export function windowIdFromFrame(frame: Element): string | null {
  const testid = frame instanceof HTMLElement ? frame.dataset.testid : undefined;
  if (!testid || !testid.startsWith(WINDOW_FRAME_TESTID_PREFIX)) return null;
  return testid.slice(WINDOW_FRAME_TESTID_PREFIX.length);
}

/** The nearest enclosing window frame of an element (the active focus scope). */
export function closestWindowFrame(el: Element | null): HTMLElement | null {
  if (!el) return null;
  return el.closest<HTMLElement>(FRAME_SELECTOR);
}

/**
 * The traversal scope of a window: its CONTENT region, or the frame root when
 * no content region is rendered. Chrome controls (min/max/close) are chrome, not
 * window content — a keyboard raise lands on the content's first control (or the
 * content region itself), never on a chrome button.
 */
export function getWindowTraversalRoot(windowId: string): HTMLElement | null {
  return getWindowContentElement(windowId) ?? getWindowFrameElement(windowId);
}

// ── Store reads (the focused window + the open list) ─────────────────────────

/** The open window ids in z-order (lowest first), as the store holds them. */
export function getWindowIds(): string[] {
  return getWindowSnapshot().map((w) => w.id);
}

/** The currently focused window id, or `null` when none is focused. */
export function getFocusedWindowId(): string | null {
  return getWindowSnapshot().find((w) => w.focused)?.id ?? null;
}

// ── Scroll-before-focus (R-1.6) ──────────────────────────────────────────────

/**
 * Bring `el` into view before focus lands. jsdom does not implement
 * `scrollIntoView`, so the call is guarded; a throw falls back to the boolean
 * form. Non-fatal by design — a scroll failure must never block focus.
 */
export function scrollIntoViewIfNeeded(el: HTMLElement): void {
  const scroll = el.scrollIntoView;
  if (typeof scroll !== 'function') return;
  try {
    scroll.call(el, { block: 'nearest', inline: 'nearest' });
  } catch {
    scroll.call(el, true);
  }
}

// ── Focus placement (R-1.2/R-1.6) ────────────────────────────────────────────

/**
 * Place DOM focus on a window's first focusable control, or its content region
 * when it has none. Returns true when focus landed. Never leaves focus on `body`
 * when the window is rendered.
 */
export function focusFirstInWindow(windowId: string): boolean {
  const root = getWindowTraversalRoot(windowId);
  if (!root) return false;
  const first = getFocusableElements(root)[0];
  if (first) {
    scrollIntoViewIfNeeded(first);
    first.focus();
    return document.activeElement === first;
  }
  return focusWindowRegion(root);
}

/** Place DOM focus on a window's last focusable control, or its content region. */
export function focusLastInWindow(windowId: string): boolean {
  const root = getWindowTraversalRoot(windowId);
  if (!root) return false;
  const focusables = getFocusableElements(root);
  const last = focusables[focusables.length - 1];
  if (last) {
    scrollIntoViewIfNeeded(last);
    last.focus();
    return document.activeElement === last;
  }
  return focusWindowRegion(root);
}

/** The R-1.2 fallback: focus the content region (tabIndex -1) for an empty window. */
function focusWindowRegion(region: HTMLElement): boolean {
  scrollIntoViewIfNeeded(region);
  region.focus();
  return document.activeElement === region || region.contains(document.activeElement);
}

// ── Raise + place (R-1.1/R-1.2) ──────────────────────────────────────────────

/**
 * Raise a window through the kernel's `focusWindow` and place keyboard focus
 * inside it. Returns false when the window is not open (or not rendered).
 */
export function focusWindowWithKeyboard(windowId: string): boolean {
  if (!getWindowSnapshot().some((w) => w.id === windowId)) return false;
  focusWindow(windowId);
  return focusFirstInWindow(windowId);
}

function focusRelative(delta: number): boolean {
  const ids = getWindowIds();
  if (ids.length === 0) return false; // R-1.7 — no open window, no-op
  const current = getFocusedWindowId();
  const currentIndex = current === null ? -1 : ids.indexOf(current);
  const base = currentIndex === -1 ? (delta > 0 ? -1 : 0) : currentIndex;
  const next = (base + delta + ids.length) % ids.length;
  const target = ids[next];
  return target ? focusWindowWithKeyboard(target) : false;
}

/** Move focus to the next open window and raise it (R-1.1). */
export function focusNextWindow(): boolean {
  return focusRelative(1);
}

/** Move focus to the previous open window and raise it (R-1.1). */
export function focusPreviousWindow(): boolean {
  return focusRelative(-1);
}

/** Focus the Nth (1-based) open window and raise it (`primary+1..9`). */
export function focusWindowByIndex(index1Based: number): boolean {
  if (!Number.isInteger(index1Based) || index1Based < 1) return false;
  const target = getWindowIds()[index1Based - 1];
  return target ? focusWindowWithKeyboard(target) : false;
}

/** The last digit of a completed traversal sequence (`primary+2` → 2), or null. */
function lastDigit(sequence: KeySequence): number | null {
  const key = sequence[sequence.length - 1]?.key;
  if (!key || key.length !== 1 || key < '1' || key > '9') return null;
  return Number(key);
}

// ── Transient-surface return (R-1.4) ─────────────────────────────────────────

/**
 * Return focus to the element that invoked a transient surface, or — when that
 * element is no longer connected — to the focused window's first focusable
 * control. Returns the element that received focus, or `null` when neither an
 * invoker nor a rendered focused window exists. Never leaves focus on `body`.
 */
export function restoreTransientFocus(invoker: HTMLElement | null): HTMLElement | null {
  if (invoker && invoker.isConnected) {
    scrollIntoViewIfNeeded(invoker);
    invoker.focus();
    return document.activeElement === invoker ? invoker : null;
  }
  const focusedId = getFocusedWindowId();
  if (focusedId && focusFirstInWindow(focusedId)) {
    return document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  return null;
}

// ── Native Tab boundary hand-off (R-1.5) ─────────────────────────────────────

/**
 * Handle a plain `Tab`/`Shift+Tab` at a window boundary. Returns true when the
 * event was consumed (focus moved to the adjacent window); false leaves the
 * native default untouched. Modified tabs (Ctrl/Alt/Meta) are never intercepted
 * — they belong to the engine's `primary+tab` binding.
 */
export function handleWindowBoundaryTab(event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;

  const active = document.activeElement;
  const frame = closestWindowFrame(active);
  if (!frame) return false;
  const windowId = windowIdFromFrame(frame);
  if (!windowId) return false;

  const root = getWindowTraversalRoot(windowId);
  if (!root) return false;
  // Only a focus inside the window's CONTENT participates in the boundary hop;
  // a chrome button (min/max/close) keeps native Tab behaviour.
  if (!(active instanceof HTMLElement) || !root.contains(active)) return false;

  const ids = getWindowIds();
  const index = ids.indexOf(windowId);
  if (index === -1) return false;

  const focusables = getFocusableElements(root);

  if (event.shiftKey) {
    const atFirst = focusables.length === 0 || focusables[0] === active;
    if (!atFirst) return false;
    const previousId = ids[(index - 1 + ids.length) % ids.length];
    if (previousId === windowId) return false; // one window only → stay native
    const moved = focusLastInWindow(previousId);
    if (moved) event.preventDefault();
    return moved;
  }

  const atLast =
    focusables.length === 0 || focusables[focusables.length - 1] === active;
  if (!atLast) return false;
  const nextId = ids[(index + 1) % ids.length];
  if (nextId === windowId) return false; // one window only → stay native
  const moved = focusFirstInWindow(nextId);
  if (moved) event.preventDefault();
  return moved;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** The override handler set traversal installs for the three traversal actions. */
function registerTraversalHandlers(): void {
  registerHotkeyHandler(FOCUS_NEXT_ACTION_ID, () => {
    focusNextWindow();
  });
  registerHotkeyHandler(FOCUS_PREVIOUS_ACTION_ID, () => {
    focusPreviousWindow();
  });
  registerHotkeyHandler(CYCLE_NTH_ACTION_ID, (ctx) => {
    const nth = lastDigit(ctx.sequence);
    if (nth !== null) focusWindowByIndex(nth);
  });
}

/** Restore the engine's built-in delegation after the last traversal unmounts. */
function releaseTraversal(): void {
  if (tabListener) {
    document.removeEventListener('keydown', tabListener, true);
    tabListener = null;
  }
  registerHotkeyHandler(FOCUS_NEXT_ACTION_ID, null);
  registerHotkeyHandler(FOCUS_PREVIOUS_ACTION_ID, null);
  registerHotkeyHandler(CYCLE_NTH_ACTION_ID, null);
}

type KeydownFn = (event: KeyboardEvent) => void;

let activeInstalls = 0;
let tabListener: KeydownFn | null = null;

/**
 * Install the ONE Tab-boundary listener + the traversal action overrides. This
 * is NOT the hotkey dispatch listener (the engine owns that, exactly one per
 * webview); it only inspects plain Tab events at a window boundary. Reference
 * counted: the first install arms it, the last uninstall releases it, so React
 * StrictMode's double effect and multiple open windows are both safe.
 *
 * Returns the release function.
 */
export function installWindowTraversal(): () => void {
  if (typeof document === 'undefined') return () => {};
  activeInstalls += 1;
  if (activeInstalls === 1) {
    registerTraversalHandlers();
    tabListener = (event: KeyboardEvent) => {
      handleWindowBoundaryTab(event);
    };
    document.addEventListener('keydown', tabListener, true);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeInstalls = Math.max(0, activeInstalls - 1);
    if (activeInstalls === 0) releaseTraversal();
  };
}

/** True while the Tab-boundary listener + overrides are armed. */
export function isWindowTraversalInstalled(): boolean {
  return activeInstalls > 0;
}

/** Test-only: force-release the traversal installs + listener. */
export function resetWindowTraversalForTests(): void {
  if (tabListener && typeof document !== 'undefined') {
    document.removeEventListener('keydown', tabListener, true);
  }
  tabListener = null;
  activeInstalls = 0;
  registerHotkeyHandler(FOCUS_NEXT_ACTION_ID, null);
  registerHotkeyHandler(FOCUS_PREVIOUS_ACTION_ID, null);
  registerHotkeyHandler(CYCLE_NTH_ACTION_ID, null);
}
