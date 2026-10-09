/**
 * Spec #3009 — the ONE dispatch engine (ST-3).
 *
 * The PURE decision lives in `sequence.ts` (`decideDispatch`); this module is the
 * imperative wiring around it:
 *   - resolves the ACTIVE bindings: the KEPT platform globals (`primary+space`,
 *     `primary+tab`, `primary+shift+tab`) merged with every mounted `data-hotkey`
 *     element (the ONE seam, `resolveActiveBindings`),
 *   - classifies the focus context (`focusContext.ts`),
 *   - owns the pending-sequence state machine + its timeout,
 *   - runs the winning action (never awaited — the keydown path must not block),
 *   - mirrors live state onto `document.body` DOM hooks for QA.
 *
 * Exactly ONE `keydown` listener exists per webview (`installHotkeyEngine()` is
 * idempotent and adds the listener in the CAPTURE phase). The retired
 * configuration and context machinery is gone: there is NO
 * second resolver, NO second action table, NO second listener.
 *
 * Keydown path budget: zero IPC, zero persistence, zero React re-render.
 */

import { useSyncExternalStore } from 'react';

import { FOCUS_NEXT_ACTION_ID, FOCUS_PREVIOUS_ACTION_ID, KEPT_GLOBAL_BINDINGS, LAUNCHER_TOGGLE_ACTION_ID } from './defaults';
import { isInteractiveElement, isTextControl, classifyFocusContext } from './focusContext';
import { activateHotkeyElement, listElementHotkeys, type HotkeyElementEntry } from './hotkeyElements';
import { normalizeKeyStroke, parseSequence, serializeStroke } from './keys';
import {
  getHotkeyAction,
  registerFredoAction,
  runResolvedAction,
} from './registry';
import { decideDispatch } from './sequence';
import { setHotkeysDisabled } from './store';
import { focusWindow, getWindowSnapshot } from '../window-system/windowStore';
import {
  type ApplicationHotkeyAction,
  type DispatchDecision,
  type FocusContext,
  type HotkeyActionId,
  type KeySequence,
  type KeyStroke,
  type RegisteredHotkeyAction,
  type ResolvedBinding,
} from './types';

/** The palette-open action id (the launcher contributes its run). */
export const ACTION_PALETTE_OPEN_ACTION_ID: HotkeyActionId = 'fredo.palette.openActions';
/** The launcher-toggle action id (re-exported for the launcher shell). */
export { LAUNCHER_TOGGLE_ACTION_ID };
/** The pending-sequence timeout (no keymap config any more). */
export const PENDING_SEQUENCE_TIMEOUT_MS = 1000;

// ── DOM hooks ────────────────────────────────────────────────────────────────

/** `document.documentElement` — this webview runs the engine. */
const ENGINE_ATTR = 'data-fredo-hotkeys-engine';
/** `document.body` — live focus classification. */
export const BODY_FOCUS_CONTEXT_ATTR = 'data-fredo-focus-context';
/** `document.body` — the serialized pending prefix (absent when idle). */
export const BODY_PENDING_SEQUENCE_ATTR = 'data-fredo-pending-sequence';
/** `document.body` — terminal passthrough is active. */
export const BODY_PASSTHROUGH_ATTR = 'data-fredo-passthrough';

// ── Window-focus helpers for the kept globals ────────────────────────────────

function focusRelative(delta: number): void {
  const entries = getWindowSnapshot();
  if (entries.length === 0) return;
  const current = entries.findIndex((w) => w.focused);
  const base = current === -1 ? (delta > 0 ? -1 : 0) : current;
  const next = (base + delta + entries.length) % entries.length;
  const target = entries[next];
  if (target) focusWindow(target.id);
}

// ── Default action registration (the kept globals + palette open) ────────────

const DEFAULT_FREDO_ACTION_DEFS: readonly ApplicationHotkeyAction[] = [
  {
    actionId: LAUNCHER_TOGGLE_ACTION_ID,
    title: 'Toggle launcher',
    description: 'Show or focus the launcher command bar',
    defaultSequence: 'primary+space',
    run: () => {},
  },
  {
    actionId: ACTION_PALETTE_OPEN_ACTION_ID,
    title: 'Open actions palette',
    description: 'Open the launcher pre-filled with the action prefix',
    defaultSequence: null,
    run: () => {},
  },
  {
    actionId: FOCUS_NEXT_ACTION_ID,
    title: 'Focus next window',
    description: 'Move focus to the next open window',
    defaultSequence: 'primary+tab',
    run: () => focusRelative(1),
  },
  {
    actionId: FOCUS_PREVIOUS_ACTION_ID,
    title: 'Focus previous window',
    description: 'Move focus to the previous open window',
    defaultSequence: 'primary+shift+tab',
    run: () => focusRelative(-1),
  },
];

/**
 * Register the shipped kept-global actions + the unbound palette-open action.
 * Idempotent across `resetRegistryForTests` (an already-resolvable action is left
 * untouched), so re-installing the engine can never create a duplicate row.
 */
export function registerDefaultFredoActions(): void {
  for (const def of DEFAULT_FREDO_ACTION_DEFS) {
    if (getHotkeyAction(def.actionId) !== null) continue;
    registerFredoAction(def);
  }
}

// ── Binding resolution (the ONE seam) ────────────────────────────────────────

/** The kept platform globals as resolved bindings (registry order). */
function keptGlobalBindings(): ResolvedBinding[] {
  const out: ResolvedBinding[] = [];
  for (const def of KEPT_GLOBAL_BINDINGS) {
    const action = getHotkeyAction(def.actionId);
    if (!action) continue;
    out.push({
      actionId: def.actionId,
      tier: 'fredo',
      sequence: parseSequence(def.sequence),
      serialized: def.sequence,
      action,
    });
  }
  return out;
}

/**
 * Convert one mounted element's grammar into a dispatchable binding. The action
 * is synthesized per resolution (element hotkeys are NOT registry declarations);
 * its `run` activates the element through the CU-1 contract.
 */
export function elementHotkeyToBinding(entry: HotkeyElementEntry): ResolvedBinding {
  const action: RegisteredHotkeyAction = {
    actionId: entry.actionId,
    tier: 'feature',
    title: entry.title,
    defaultSequence: entry.grammar.serialized,
    run: () => activateHotkeyElement(entry.element),
  };
  return {
    actionId: entry.actionId,
    tier: 'feature',
    sequence: parseSequence(entry.grammar.serialized),
    serialized: entry.grammar.serialized,
    action,
  };
}

/**
 * Resolve every dispatchable binding: the kept globals + every mounted element
 * hotkey. This is the ONLY binding source for BOTH the keydown decision and the
 * bar.
 */
export function resolveActiveBindings(
  _focusedFeatureId?: string | null,
): readonly ResolvedBinding[] {
  registerDefaultFredoActions();
  return [...keptGlobalBindings(), ...listElementHotkeys().map(elementHotkeyToBinding)];
}

// ── Pending-sequence state machine ───────────────────────────────────────────

let pending: KeySequence | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
const pendingListeners = new Set<() => void>();

function notifyPending(): void {
  for (const listener of [...pendingListeners]) listener();
}

/** Subscribe to pending-prefix changes (the bar's pending chip). */
export function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

function clearPendingTimer(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function setBodyAttr(name: string, value: string | null): void {
  if (typeof document === 'undefined' || !document.body) return;
  const body = document.body;
  if (value === null) {
    if (body.hasAttribute(name)) body.removeAttribute(name);
    return;
  }
  if (body.getAttribute(name) !== value) body.setAttribute(name, value);
}

function publishPending(): void {
  const serialized = getPendingPrefix();
  setBodyAttr(BODY_PENDING_SEQUENCE_ATTR, serialized);
  notifyPending();
}

function armPending(prefix: KeySequence): void {
  pending = prefix;
  publishPending();
  clearPendingTimer();
  pendingTimer = setTimeout(onSequenceTimeout, PENDING_SEQUENCE_TIMEOUT_MS);
}

function onSequenceTimeout(): void {
  pendingTimer = null;
  if (pending === null) return;
  pending = null;
  publishPending();
}

function abandonPending(): void {
  if (pending === null) return;
  pending = null;
  clearPendingTimer();
  publishPending();
}

function completePending(): void {
  pending = null;
  clearPendingTimer();
  publishPending();
}

// ── Focus context + DOM hooks ────────────────────────────────────────────────

/** Classify `document.activeElement` (including the global open-modal fact). */
export function computeFocusContext(): FocusContext {
  if (typeof document === 'undefined') return 'default';
  const active = document.activeElement;
  const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
  return classifyFocusContext(active, { modalOpen });
}

// ── Live focus snapshot ──────────────────────────────────────────────────────

/** The stable snapshot of the current focus classification. */
export interface FocusSnapshot {
  readonly context: FocusContext;
  readonly nativeConsumes: boolean;
  /** `isTextControl(readActiveElement())` (the ONE predicate). */
  readonly textEntry: boolean;
}

const FOCUS_SNAPSHOT_DEFAULT: FocusSnapshot = Object.freeze({
  context: 'default',
  nativeConsumes: false,
  textEntry: false,
});

let focusSnapshot: FocusSnapshot = FOCUS_SNAPSHOT_DEFAULT;
const focusSnapshotListeners = new Set<() => void>();

/** The current focus snapshot — identical identity between real changes. */
export function getFocusSnapshot(): FocusSnapshot {
  return focusSnapshot;
}

/** Subscribe to focus-snapshot changes; returns the unsubscribe handle. */
export function subscribeFocusSnapshot(listener: () => void): () => void {
  focusSnapshotListeners.add(listener);
  return () => {
    focusSnapshotListeners.delete(listener);
  };
}

/** The live focus snapshot, re-rendering only on a real change. */
export function useFocusSnapshot(): FocusSnapshot {
  return useSyncExternalStore(subscribeFocusSnapshot, getFocusSnapshot, getFocusSnapshot);
}

/** Commit a new snapshot only when the classification actually changed. */
function publishFocusSnapshot(
  context: FocusContext,
  nativeConsumes: boolean,
  textEntry: boolean,
): void {
  if (
    focusSnapshot.context === context &&
    focusSnapshot.nativeConsumes === nativeConsumes &&
    focusSnapshot.textEntry === textEntry
  ) {
    return;
  }
  focusSnapshot = Object.freeze({ context, nativeConsumes, textEntry });
  for (const listener of [...focusSnapshotListeners]) listener();
}

/** The webview's active element, or `null` off-DOM. */
function readActiveElement(): Element | null {
  return typeof document === 'undefined' ? null : document.activeElement;
}

/** True while element hotkeys are suppressed (text-entry / terminal focus). */
function isSuppressed(context: FocusContext, textEntry: boolean): boolean {
  return context === 'terminal' || context === 'text-entry' || textEntry;
}

function updateHooks(context: FocusContext): void {
  setBodyAttr(BODY_FOCUS_CONTEXT_ATTR, context);
  setBodyAttr(BODY_PASSTHROUGH_ATTR, context === 'terminal' ? 'true' : null);
  const active = readActiveElement();
  const nativeConsumes = isInteractiveElement(active);
  const textEntry = isTextControl(active);
  setHotkeysDisabled(isSuppressed(context, textEntry));
  publishFocusSnapshot(context, nativeConsumes, textEntry);
}

function clearBodyHooks(): void {
  setBodyAttr(BODY_FOCUS_CONTEXT_ATTR, null);
  setBodyAttr(BODY_PENDING_SEQUENCE_ATTR, null);
  setBodyAttr(BODY_PASSTHROUGH_ATTR, null);
  setHotkeysDisabled(false);
}

function onFocusChange(): void {
  updateHooks(computeFocusContext());
  abandonPending();
}

// ── The dispatch path ────────────────────────────────────────────────────────

function applyDecision(
  decision: DispatchDecision,
  stroke: KeyStroke,
  focusedFeatureId: string | null,
): void {
  switch (decision.outcome) {
    case 'match': {
      const action = decision.action;
      if (!action) return;
      const completed = pending !== null ? [...pending, stroke] : [stroke];
      if (pending !== null) completePending();
      runResolvedAction(action, 'binding', completed, focusedFeatureId);
      return;
    }
    case 'arm-sequence': {
      armPending([stroke]);
      return;
    }
    case 'pending': {
      if (pending === null) return;
      armPending([...pending, stroke]);
      return;
    }
    case 'suppress': {
      abandonPending();
      return;
    }
    case 'passthrough': {
      if (pending !== null) abandonPending();
      return;
    }
  }
}

/** The currently focused window id (for the invocation context). */
export function getFocusedFeatureId(): string | null {
  const focused = getWindowSnapshot().find((w) => w.focused);
  return focused ? focused.id : null;
}

/**
 * The ONE keydown decision, fully applied. Returns the decision so tests can
 * assert the outcome directly; the installed listener ignores the return value.
 */
export function handleHotkeyKeydown(event: KeyboardEvent): DispatchDecision {
  const stroke = normalizeKeyStroke(event);
  if (stroke === null) {
    return { outcome: 'passthrough', consumed: false, reason: 'unhandled-key' };
  }

  const context = computeFocusContext();
  updateHooks(context);

  const focusedFeatureId = getFocusedFeatureId();
  const bindings = resolveActiveBindings();
  const active = readActiveElement();

  const decision = decideDispatch({
    stroke,
    context,
    pending,
    bindings,
    nativeConsumes: isInteractiveElement(active),
  });

  applyDecision(decision, stroke, focusedFeatureId);

  if (decision.consumed) {
    event.preventDefault();
    event.stopPropagation();
  }
  return decision;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let installed = false;
let keydownListener: ((event: KeyboardEvent) => void) | null = null;
let focusListener: ((event: FocusEvent) => void) | null = null;

/**
 * Install the ONE `document` keydown listener (capture phase) + focus tracking.
 * Idempotent: a second call is a no-op, so React StrictMode's double effect can
 * never double-fire a chord.
 */
export function installHotkeyEngine(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (installed) return uninstallHotkeyEngine;
  installed = true;

  registerDefaultFredoActions();

  keydownListener = (event: KeyboardEvent) => {
    handleHotkeyKeydown(event);
  };
  focusListener = (event: FocusEvent) => {
    if (event.type === 'focusout' && event.relatedTarget !== null) return;
    onFocusChange();
  };
  document.addEventListener('keydown', keydownListener, true);
  document.addEventListener('focusin', focusListener, true);
  document.addEventListener('focusout', focusListener, true);
  document.documentElement.setAttribute(ENGINE_ATTR, '1');

  updateHooks(computeFocusContext());
  return uninstallHotkeyEngine;
}

/** Remove the engine's listeners + DOM hooks (idempotent). */
export function uninstallHotkeyEngine(): void {
  if (!installed) return;
  installed = false;

  if (keydownListener) {
    document.removeEventListener('keydown', keydownListener, true);
  }
  if (focusListener) {
    document.removeEventListener('focusin', focusListener, true);
    document.removeEventListener('focusout', focusListener, true);
  }
  keydownListener = null;
  focusListener = null;

  clearPendingTimer();
  pending = null;

  document.documentElement.removeAttribute(ENGINE_ATTR);
  clearBodyHooks();
}

/** True while the engine's `document` keydown listener is installed. */
export function isHotkeyEngineInstalled(): boolean {
  return installed;
}

/** Test-only: uninstall + drop transient pending state + reset the focus snapshot. */
export function resetHotkeyEngineForTests(): void {
  uninstallHotkeyEngine();
  clearPendingTimer();
  pending = null;
  focusSnapshot = FOCUS_SNAPSHOT_DEFAULT;
  focusSnapshotListeners.clear();
  pendingListeners.clear();
}

/** Test/reporter only: the serialized pending prefix, or `null` when idle. */
export function getPendingPrefix(): string | null {
  return pending === null ? null : pending.map(serializeStroke).join(' ');
}

/** The live pending prefix (React), re-rendering only on a real change. */
export function usePendingPrefix(): string | null {
  return useSyncExternalStore(subscribePending, getPendingPrefix, getPendingPrefix);
}
