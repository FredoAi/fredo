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
 *   - builds the application command-surface scope (Spec #3097) and applies the
 *     `command` / `mode-pop` / `prompt-cancel` outcomes,
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
import { findApplication, isElementInActiveCommandScope, resolveFocusedApplicationId } from './applicationFocus';
import {
  cancelCommandPrompt,
  commitCommandPrompt,
  executeCommand,
  getModePath,
  getOpenCommandPrompt,
  popMode,
  resolveCommandSurface,
} from './commandSurfaceStore';
import { isInteractiveElement, isTextControl, classifyFocusContext } from './focusContext';
import { activateHotkeyElement, listElementHotkeys, type HotkeyElementEntry } from './hotkeyElements';
import { normalizeKeyStroke, parseSequence, serializeStroke } from './keys';
import {
  getHotkeyAction,
  registerFredoAction,
  runResolvedAction,
} from './registry';
import { decideDispatch, type CommandDispatchScope } from './sequence';
import { setHotkeysDisabled } from './store';
import { focusWindow, getWindowSnapshot } from '../window-system/windowStore';
import { getNavigationHost } from '../navigation/ui/hostRegistry';
import {
  type ApplicationHotkeyAction,
  type DispatchDecision,
  type FocusContext,
  type KeySequence,
  type KeyStroke,
  type RegisteredHotkeyAction,
  type ResolvedBinding,
} from './types';

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

// ── Kept-global delegation into the window surface host (Spec #3121 ST-2) ──

/** §B.2 — the declared window-system surface app id. */
const WINDOW_SYSTEM_SURFACE_APP_ID = 'window-system';

/**
 * D-3(a) — the modifier chords are NOT expressible in the §4.4 grammar, so the three kept
 * platform globals stay here and DELEGATE into the declared `window-system` host through
 * `runIntent({channel:'keyboard'})`. Key → verb id → outcome is therefore provable without
 * a second key table and without a grammar change. The fallback is the pre-#3121
 * behaviour, used only while the window system is not mounted (no host registered).
 *
 * The re-entry guard terminates a launcher round-trip: the surface's
 * `window.launcher.toggle` run re-enters the shared registry, whose default action run is
 * this same delegation.
 */
let windowHostIntentInFlight = false;

function runKeptGlobalThroughWindowHost(verbId: string, fallback: () => void): void {
  const host = getNavigationHost(WINDOW_SYSTEM_SURFACE_APP_ID);
  if (host === null || windowHostIntentInFlight) {
    fallback();
    return;
  }
  windowHostIntentInFlight = true;
  const settle = (): void => {
    windowHostIntentInFlight = false;
  };
  void host
    .runIntent({ verbId, args: {}, channel: 'keyboard', actor: 'human' })
    .then(settle, settle);
}

// ── Default action registration (the kept globals) ──────────────────────────

const DEFAULT_FREDO_ACTION_DEFS: readonly ApplicationHotkeyAction[] = [
  {
    actionId: LAUNCHER_TOGGLE_ACTION_ID,
    title: 'Toggle launcher',
    description: 'Show or focus the launcher command bar',
    defaultSequence: 'primary+space',
    run: () => runKeptGlobalThroughWindowHost('window.launcher.toggle', () => {}),
  },
  {
    actionId: FOCUS_NEXT_ACTION_ID,
    title: 'Focus next window',
    description: 'Move focus to the next open window',
    defaultSequence: 'primary+tab',
    run: () => runKeptGlobalThroughWindowHost('window.focus.next', () => focusRelative(1)),
  },
  {
    actionId: FOCUS_PREVIOUS_ACTION_ID,
    title: 'Focus previous window',
    description: 'Move focus to the previous open window',
    defaultSequence: 'primary+shift+tab',
    run: () => runKeptGlobalThroughWindowHost('window.focus.previous', () => focusRelative(-1)),
  },
];

/**
 * Register the shipped kept-global actions. Spec #3120 (P6) ST-7 removed the
 * unbound palette-open action with the `>` palette (R-2/R-8).
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
 *
 * Spec #3097: when `focusedAppId` is supplied, element bindings are SCOPED —
 * an element owned by a different application root is dropped, while an element
 * outside every app root (launcher / desktop chrome) stays global.
 *
 * Spec #3098 ST-1 (A1): the SAME scoping now applies when the focused
 * application declares NO surface (a scoped element owned by a surface app that
 * is not the displayed app is dropped) and when no application is focused at
 * all (`null`): a hidden carrier's bindings must not dispatch off-screen.
 * `null`-scoped elements keep today's behaviour byte-identically, and a
 * no-argument call (every pre-#3097 direct caller) is still exactly today's
 * list. An id that names no registered application carries no scope to enforce
 * (synthetic/legacy ids) and also keeps today's list.
 */
export function resolveActiveBindings(
  focusedAppId?: string | null,
): readonly ResolvedBinding[] {
  registerDefaultFredoActions();
  if (focusedAppId === undefined) {
    return [...keptGlobalBindings(), ...listElementHotkeys().map(elementHotkeyToBinding)];
  }
  if (focusedAppId !== null && findApplication(focusedAppId) === null) {
    return [...keptGlobalBindings(), ...listElementHotkeys().map(elementHotkeyToBinding)];
  }
  return [
    ...keptGlobalBindings(),
    ...listElementHotkeys()
      .filter((entry) => isElementInActiveCommandScope(entry.element, focusedAppId))
      .map(elementHotkeyToBinding),
  ];
}

// ── Application command-surface scope (Spec #3097) ───────────────────────────

/**
 * The inline value prompt's selectors. The strings mirror the playbook's binding
 * DOM contract (`HOTKEY_BAR_PROMPT_INPUT_TESTID` / `HOTKEY_BAR_PROMPT_TESTID` in
 * `HotkeyBar.tsx`); they are duplicated here as literals so the engine's module
 * graph never pulls the React bar component in.
 */
const PROMPT_INPUT_SELECTOR = '[data-testid="hotkeys-keybar-prompt-input"]';
const PROMPT_WRAPPER_SELECTOR = '[data-testid="hotkeys-keybar-prompt"]';

/** The prompt input element, or `null` off-DOM / while no prompt is open. */
function readPromptInput(): Element | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector(PROMPT_INPUT_SELECTOR);
}

/**
 * The application that owns the rendered prompt. The bar is platform chrome, so
 * focusing its input makes `resolveFocusedApplicationId()` return `null` by
 * design (focus outside every app root) — the prompt wrapper carries the owning
 * app id (`data-app-id`, the binding DOM contract) so the prompt branch stays
 * reachable while the user is typing into it.
 */
function readPromptAppId(): string | null {
  if (typeof document === 'undefined') return null;
  const wrapper = document.querySelector(PROMPT_WRAPPER_SELECTOR);
  if (wrapper === null) return null;
  const appId = wrapper.getAttribute('data-app-id');
  return appId !== null && appId.length > 0 ? appId : null;
}

/**
 * Build the read-only command-surface view the pure decision consumes. Returns
 * `null` when the focused application declares no `commandSurface`, which makes
 * every new branch unreachable — a non-opting app keeps today's behaviour.
 *
 * Synchronous by design: plain module reads + one `querySelector`; no IPC, no
 * persistence, no React.
 */
function buildCommandScope(): CommandDispatchScope | null {
  const promptInput = readPromptInput();
  const promptInputFocused =
    promptInput !== null && typeof document !== 'undefined' && document.activeElement === promptInput;

  const appId = promptInputFocused
    ? readPromptAppId() ?? resolveFocusedApplicationId()
    : resolveFocusedApplicationId();
  if (appId === null) return null;

  const surface = resolveCommandSurface(appId);
  if (surface === null) return null;

  const prompt = getOpenCommandPrompt(appId);
  return {
    appId,
    surface,
    modePath: getModePath(appId),
    promptOpen: prompt !== null,
    promptInput: promptInputFocused && prompt !== null,
    promptCommandId: prompt === null ? null : prompt.commandId,
  };
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
  commandScope: CommandDispatchScope | null,
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
    // Spec #3097 — the application command surface. A consumed command ends any
    // armed element sequence (mode keys never enter the pending machine). The
    // handler is invoked EXACTLY ONCE: the executor for a mode/command key, the
    // prompt commit for Enter in the prompt — never both (AC5).
    case 'command': {
      const command = decision.command;
      if (!command) return;
      abandonPending();
      if (command.promptAction === 'commit') commitCommandPrompt(command.appId);
      else executeCommand(command.appId, command.commandId);
      return;
    }
    case 'mode-pop': {
      abandonPending();
      const appId = commandScope === null ? null : commandScope.appId;
      if (appId !== null) popMode(appId);
      return;
    }
    case 'prompt-cancel': {
      abandonPending();
      const appId = commandScope === null ? null : commandScope.appId;
      if (appId !== null) cancelCommandPrompt(appId);
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
  const commandScope = buildCommandScope();
  // Spec #3098 ST-1 (A1): always hand the resolution the displayed/focused
  // application id — `null` when none — so a surface-owned carrier cannot keep
  // dispatching while another application (opting or not) owns focus.
  const activeAppId =
    commandScope === null ? resolveFocusedApplicationId() : commandScope.appId;
  const bindings = resolveActiveBindings(activeAppId);
  const active = readActiveElement();

  const decision = decideDispatch({
    stroke,
    context,
    pending,
    bindings,
    nativeConsumes: isInteractiveElement(active),
    commandScope,
  });

  applyDecision(decision, stroke, focusedFeatureId, commandScope);

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
