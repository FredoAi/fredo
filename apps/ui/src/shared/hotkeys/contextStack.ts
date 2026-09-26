/**
 * Spec #2958 ST-2 — the module-scoped, per-webview interaction-context
 * navigation stack (EARS R-2.1 stack mechanics, R-2.2/R-5.2 continuity,
 * R-3.1/R-3.2 unwind primitives, R-4.2 announcement, R-4.3 body hook).
 *
 * The stack is `[base, ...explicitDescents]`:
 *   - the BASE is derived from focus (`resolveBaseContextId(focusedFeatureId)`):
 *     a focused feature's base id is its feature id, else ROOT (`fredo.root`).
 *   - explicit descents are pushed by `enterHotkeyContext` and popped one at a
 *     time by `exitHotkeyContext`.
 *
 * It is transient per webview module state — mirrors the keymap store
 * (`store.ts:42`) and the window store (`windowStore.ts:19`); nothing is
 * persisted, and there is NO `keydown` listener here (the ONE engine owns the
 * single document listener). `installHotkeyContextTracking` subscribes only to
 * the window store so the base re-derives when the focused feature changes.
 *
 * Observability:
 *   - `document.body` carries `data-fredo-hotkey-context` (active context id) +
 *     `data-fredo-hotkey-context-depth` (path length; base = 1) while the active
 *     context is not the platform ROOT (R-4.3) — absent at ROOT.
 *   - every real change calls the ONE shared polite channel `announce(...)`
 *     (R-4.2) with the pure copy from `contextAnnouncement`.
 *
 * `getHotkeyContextSnapshot()` returns a module-cached FROZEN object that only
 * changes on a real change (context id or depth), so `useSyncExternalStore`
 * never sees a fresh identity. The snapshot deliberately carries no label —
 * resolve it from the registry (`getHotkeyContext(snapshot.contextId)?.title`).
 */

import { useSyncExternalStore } from 'react';

import { announce } from './announcer';
import { getHotkeyContext, isPlatformContext, resolveBaseContextId } from './contexts';
import {
  ROOT_CONTEXT_ID,
  type HotkeyContextChangeReason,
  type HotkeyContextId,
  type HotkeyContextSnapshot,
} from './types';
import { getWindowSnapshot, subscribeWindows } from '../window-system/windowStore';

/** `document.body` — the active context id (absent while at the platform ROOT). */
export const BODY_HOTKEY_CONTEXT_ATTR = 'data-fredo-hotkey-context';
/** `document.body` — the active path length (base = 1; absent at the platform ROOT). */
export const BODY_HOTKEY_CONTEXT_DEPTH_ATTR = 'data-fredo-hotkey-context-depth';

/** Hard cap on stack frames (base included); a descent beyond it is refused. */
const MAX_CONTEXT_STACK_FRAMES = 8;

// ── Module-scoped state (per webview; transient) ─────────────────────────────

/** The focused feature id from this webview's window store, else `null`. */
function readFocusedFeatureId(): string | null {
  const focused = getWindowSnapshot().find((entry) => entry.focused);
  return focused ? focused.id : null;
}

let baseContextId: HotkeyContextId = resolveBaseContextId(readFocusedFeatureId());

/** Explicit descents above the focus-derived base (never contains the base). */
const explicitDescents: HotkeyContextId[] = [];

/** `useSyncExternalStore` listeners for the cached snapshot. */
const listeners = new Set<() => void>();

function makeSnapshot(reason: HotkeyContextChangeReason): HotkeyContextSnapshot {
  const path = [baseContextId, ...explicitDescents];
  return Object.freeze({
    contextId: path[path.length - 1] ?? ROOT_CONTEXT_ID,
    depth: path.length,
    reason,
  });
}

let snapshot: HotkeyContextSnapshot = makeSnapshot('focus');

let windowUnsubscribe: (() => void) | null = null;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

// ── DOM body hooks (R-4.3) ───────────────────────────────────────────────────

function setBodyAttr(name: string, value: string | null): void {
  if (typeof document === 'undefined' || !document.body) return;
  const body = document.body;
  if (value === null) {
    if (body.hasAttribute(name)) body.removeAttribute(name);
    return;
  }
  if (body.getAttribute(name) !== value) body.setAttribute(name, value);
}

/** Publish the body hooks; both are ABSENT while the active context is ROOT. */
function publishBodyHooks(contextId: HotkeyContextId, depth: number): void {
  if (contextId === ROOT_CONTEXT_ID) {
    setBodyAttr(BODY_HOTKEY_CONTEXT_ATTR, null);
    setBodyAttr(BODY_HOTKEY_CONTEXT_DEPTH_ATTR, null);
    return;
  }
  setBodyAttr(BODY_HOTKEY_CONTEXT_ATTR, contextId);
  setBodyAttr(BODY_HOTKEY_CONTEXT_DEPTH_ATTR, String(depth));
}

// ── Change publication ───────────────────────────────────────────────────────

/**
 * Commit the current stack as the active snapshot when it represents a REAL
 * change (context id or depth changed). A no-op change keeps the cached
 * snapshot identity, does not notify, and does not announce. On a real change
 * the frozen snapshot is replaced, the body hooks are published, subscribers
 * are notified, and — when `announceChange` — the shared channel speaks.
 */
function commit(reason: HotkeyContextChangeReason, announceChange: boolean): boolean {
  const next = makeSnapshot(reason);
  if (next.contextId === snapshot.contextId && next.depth === snapshot.depth) return false;
  snapshot = next;
  publishBodyHooks(next.contextId, next.depth);
  notify();
  if (announceChange) announce(contextAnnouncement(next));
  return true;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The active context id — a stable primitive (`useSyncExternalStore`-safe). */
export function getActiveHotkeyContext(): HotkeyContextId {
  return snapshot.contextId;
}

/** The active path: `[base, ...explicit descents]`. */
export function getHotkeyContextPath(): readonly HotkeyContextId[] {
  return Object.freeze([baseContextId, ...explicitDescents]);
}

/** The active path length; `1` = base only. */
export function getHotkeyContextDepth(): number {
  return snapshot.depth;
}

/** The module-cached frozen snapshot — identical between real changes. */
export function getHotkeyContextSnapshot(): HotkeyContextSnapshot {
  return snapshot;
}

// ── Stack operations (R-2.1 / R-3.1 / R-3.2) ─────────────────────────────────

/**
 * Push a descent onto the stack. Succeeds iff the target resolves to a declared,
 * non-invalid context, is not already active, and is either a DIRECT child of
 * the active context OR a platform context (`fredo.*`). Refused (returns
 * `false`, no state change) otherwise or when the 8-frame cap is reached.
 */
export function enterHotkeyContext(contextId: HotkeyContextId): boolean {
  const context = getHotkeyContext(contextId);
  if (context === null || context.invalid !== undefined) return false;

  const active = snapshot.contextId;
  if (contextId === active) return false;
  if (context.parentId !== active && !isPlatformContext(contextId)) return false;
  if (explicitDescents.length + 1 >= MAX_CONTEXT_STACK_FRAMES) return false;

  explicitDescents.push(contextId);
  commit('enter', true);
  return true;
}

/**
 * Pop exactly ONE explicit descent. Returns `false` (and changes nothing) when
 * already at the base — Escape must not be consumed by the context model there
 * (R-3.2).
 */
export function exitHotkeyContext(): boolean {
  if (explicitDescents.length === 0) return false;
  explicitDescents.pop();
  commit('back', true);
  return true;
}

// ── Focus derivation ─────────────────────────────────────────────────────────

function applyFocus(announceChange: boolean): void {
  const nextBase = resolveBaseContextId(readFocusedFeatureId());
  if (nextBase === baseContextId) return;
  baseContextId = nextBase;
  // A focused-feature change resets to the new base and CLEARS descents; a
  // same-feature notification preserves the active descent.
  explicitDescents.length = 0;
  commit('focus', announceChange);
}

/**
 * Re-derive the base from the current focus. Clears explicit descents only when
 * the focused feature (base) actually changed; publishes the body hooks and
 * announces the new base when it did. A same-focus call is a no-op that
 * preserves the active descent (R-2.2/R-5.2 continuity).
 */
export function syncHotkeyContextFromFocus(): void {
  applyFocus(true);
}

// ── Window-store tracking (NO keydown listener) ──────────────────────────────

function uninstallHotkeyContextTracking(): void {
  windowUnsubscribe?.();
  windowUnsubscribe = null;
}

/**
 * Track this webview's window store so the base re-derives whenever the focused
 * feature changes. Adds NO `keydown` listener. Idempotent — a second call
 * returns the same unsubscribe handle.
 */
export function installHotkeyContextTracking(): () => void {
  if (windowUnsubscribe !== null) return uninstallHotkeyContextTracking;
  // Establish the initial base WITHOUT announcing (boot is not a user change).
  applyFocus(false);
  windowUnsubscribe = subscribeWindows(() => {
    applyFocus(true);
  });
  return uninstallHotkeyContextTracking;
}

// ── Subscription + React binding ─────────────────────────────────────────────

/** Subscribe to active-context changes; returns the unsubscribe handle. */
export function subscribeHotkeyContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active context snapshot, re-rendering only on a real change. */
export function useActiveHotkeyContext(): HotkeyContextSnapshot {
  return useSyncExternalStore(
    subscribeHotkeyContext,
    getHotkeyContextSnapshot,
    getHotkeyContextSnapshot,
  );
}

// ── Announcement copy (pure) ─────────────────────────────────────────────────

/**
 * The polite announcement for a context change (UI/UX spec). Pure — the label
 * is resolved from the registry, never stored in the snapshot. `reason 'focus'`
 * uses the enter copy (a focus change re-enters a new base).
 */
export function contextAnnouncement(value: HotkeyContextSnapshot): string {
  const label = getHotkeyContext(value.contextId)?.title ?? value.contextId;
  if (value.reason === 'back') {
    return value.depth <= 1
      ? `Back to ${label}. Top level.`
      : `Back to ${label}. Level ${value.depth}.`;
  }
  return `Entered ${label}. Level ${value.depth}.`;
}

// ── Test-only reset ──────────────────────────────────────────────────────────

/** Test-only: wipe the module-scoped stack + hooks. Never call from app code. */
export function resetHotkeyContextForTests(): void {
  uninstallHotkeyContextTracking();
  baseContextId = ROOT_CONTEXT_ID;
  explicitDescents.length = 0;
  snapshot = makeSnapshot('focus');
  listeners.clear();
  publishBodyHooks(ROOT_CONTEXT_ID, 1);
}
