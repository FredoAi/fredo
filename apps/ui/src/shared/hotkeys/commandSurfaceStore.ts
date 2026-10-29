/**
 * Spec #3097 (slice A / ST-2) — the application command-surface runtime store
 * and the ONE command executor.
 *
 * Module-scoped (AGENTS.md / ENGINEERING_RULES: React refs reset on remount and
 * MUST NOT carry state that has to survive blur/remount). The mode stack, the
 * open inline prompt, the focus-derived snapshot and the body hooks all live
 * here so an application's mode survives a window blur and a React remount and
 * resets only on Escape / a successful non-sticky command / the application
 * closing.
 *
 * ONE EXECUTOR (binding): `executeCommand` is the ONLY site that invokes a
 * command's `run`. A declared mode key, a toolbar control and a companion
 * intent all funnel through it, so AC5 (exactly once) cannot double-fire.
 *
 * INVOCATION-TIME RETURN: every command captures the mode that was active at
 * INVOCATION. After a non-throwing invocation (sync return or resolved promise)
 * a non-root, non-`sticky` invocation mode returns to its parent. The CURRENT
 * top is never popped — a root command that pushes `tool` must leave `tool`
 * active (no flash, no pop).
 *
 * Body hooks (read by CSS / validation only):
 *   - `data-fredo-active-mode`   — the focused app's TOP mode id (root counts)
 *   - `data-fredo-command-prompt`— the focused app's open prompt command id
 * Both are absent while the focused application declares no surface.
 *
 * No persistence, no IPC, no `await` on the dispatch path, no new dependency.
 */

import { useSyncExternalStore } from 'react';

import { announce } from './announcer';
import {
  getApplicationCommandMode,
  getRootCommandMode,
  type ApplicationCommandArgs,
  type ApplicationCommandMode,
  type ApplicationCommandSpec,
  type ApplicationCommandSurface,
} from './commandSurface';
import {
  resolveApplicationCommandSurface,
  resolveFocusedApplicationId,
} from './applicationFocus';
import { getWindowSnapshot, subscribeWindows } from '../window-system/windowStore';

// ── Body hooks ───────────────────────────────────────────────────────────────

/** `document.body` — the focused application's TOP command-mode id. */
export const BODY_ACTIVE_MODE_ATTR = 'data-fredo-active-mode';
/** `document.body` — the focused application's open prompt command id. */
export const BODY_COMMAND_PROMPT_ATTR = 'data-fredo-command-prompt';

// ── Public shapes ────────────────────────────────────────────────────────────

/** The draft + metadata of one open inline value prompt. */
export interface CommandPromptState {
  readonly commandId: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly value: string;
  /** Where focus returns when the prompt closes (may be detached by then). */
  readonly restoreElement: Element | null;
}

/** The focus-derived command-surface view consumed by the bar + hooks. */
export interface CommandSurfaceSnapshot {
  readonly revision: number;
  readonly appId: string | null;
  readonly modePath: readonly string[];
  readonly prompt: CommandPromptState | null;
}

// ── Module state ─────────────────────────────────────────────────────────────

const EMPTY_PATH: readonly string[] = Object.freeze([]);

/** appId → root..top mode path (never mutated in place; replaced on change). */
const modeStacks = new Map<string, string[]>();

/** appId → the open inline prompt (state + the path captured at invocation). */
interface PromptRecord {
  readonly state: CommandPromptState;
  readonly invocationPath: readonly string[];
}
const prompts = new Map<string, PromptRecord>();

let revision = 0;
let snapshot: CommandSurfaceSnapshot | null = null;
let snapshotSignature: string | null = null;
const listeners = new Set<() => void>();

/** Own-window kernel ids seen by this webview — the prune boundary. */
let knownAppIds = new Set<string>();

let installCount = 0;
let unsubscribeWindows: (() => void) | null = null;
let focusInHandler: (() => void) | null = null;
let focusOutHandler: (() => void) | null = null;

// ── Surface + mode reads ─────────────────────────────────────────────────────

/** The application's declared command surface, or `null` when it has none. */
export function resolveCommandSurface(appId: string | null): ApplicationCommandSurface | null {
  return resolveApplicationCommandSurface(appId);
}

/**
 * The application's mode path (root → top). Derived `[root]` when no stack has
 * been recorded yet — a pure read NEVER mutates the store.
 */
export function getModePath(appId: string): readonly string[] {
  const surface = resolveCommandSurface(appId);
  if (surface === null) return EMPTY_PATH;
  const stored = modeStacks.get(appId);
  if (stored !== undefined && stored.length > 0) return stored;
  const root = getRootCommandMode(surface);
  return root === null ? EMPTY_PATH : [root.id];
}

/** The application's active (top) command mode, or `null` when it has no surface. */
export function getActiveCommandMode(appId: string | null): ApplicationCommandMode | null {
  if (appId === null) return null;
  const surface = resolveCommandSurface(appId);
  if (surface === null) return null;
  const path = getModePath(appId);
  if (path.length === 0) return null;
  return getApplicationCommandMode(surface, path[path.length - 1]) ?? getRootCommandMode(surface);
}

/** Subscribe a component to the focused application's active mode. */
export function useActiveCommandMode(appId: string | null): ApplicationCommandMode | null {
  const getMode = () => getActiveCommandMode(appId);
  return useSyncExternalStore(subscribeCommandSurface, getMode, getMode);
}

// ── Snapshot + subscription ──────────────────────────────────────────────────

/**
 * The bar's inline-prompt wrapper. It is platform chrome (outside every
 * `[data-fredo-app-id]` root), so focusing its input makes the PURE resolver
 * return `null` by design — the display fallback below exists only for this case.
 */
const PROMPT_WRAPPER_SELECTOR = '[data-testid="hotkeys-keybar-prompt"]';

/**
 * The application whose surface the bar DISPLAYS.
 *
 * `resolveFocusedApplicationId()` stays the authoritative focused-app answer and
 * is never changed here. While the user types into the bar's inline prompt,
 * however, focus lives in platform chrome (outside every application root), so
 * the pure resolver returns `null`; without a fallback the bar would unmount the
 * very prompt it just focused (`appId:null` ⇒ `prompt:null`). The prompt wrapper
 * carries the owning `data-app-id` (the binding DOM contract), so the store
 * falls back to it — a DISPLAY-identity fallback only: no new listener, no
 * persistence, and the resolved app id itself is untouched.
 */
function resolveDisplayedApplicationId(): string | null {
  const focused = resolveFocusedApplicationId();
  if (focused !== null) return focused;
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (active === null || typeof active.closest !== 'function') return null;
  const wrapper = active.closest(PROMPT_WRAPPER_SELECTOR);
  if (wrapper === null) return null;
  const appId = wrapper.getAttribute('data-app-id');
  return appId !== null && appId.length > 0 ? appId : null;
}

interface CommandSurfaceView {
  readonly appId: string | null;
  readonly modePath: readonly string[];
  readonly prompt: CommandPromptState | null;
}

function currentView(): CommandSurfaceView {
  const appId = resolveDisplayedApplicationId();
  const surface = resolveCommandSurface(appId);
  if (appId === null || surface === null) {
    return { appId: null, modePath: EMPTY_PATH, prompt: null };
  }
  return { appId, modePath: getModePath(appId), prompt: getOpenCommandPrompt(appId) };
}

function signatureOf(view: CommandSurfaceView): string {
  const prompt = view.prompt;
  const promptKey =
    prompt === null
      ? ''
      : `${prompt.commandId}\u0001${prompt.label}\u0001${prompt.placeholder ?? ''}\u0001${prompt.value}`;
  return `${view.appId ?? ''}\u0000${view.modePath.join('\u0001')}\u0000${promptKey}`;
}

/**
 * The current focus-derived snapshot. The object identity is STABLE between real
 * changes (cached by the derived view) so `useSyncExternalStore` never loops.
 */
export function getCommandSurfaceSnapshot(): CommandSurfaceSnapshot {
  const view = currentView();
  const signature = signatureOf(view);
  if (snapshot !== null && signature === snapshotSignature) return snapshot;
  snapshotSignature = signature;
  snapshot = Object.freeze({
    revision,
    appId: view.appId,
    modePath: Object.freeze([...view.modePath]),
    prompt: view.prompt,
  });
  return snapshot;
}

/** Subscribe to command-surface changes; returns the unsubscribe handle. */
export function subscribeCommandSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a component to the focused application's command-surface snapshot. */
export function useCommandSurface(): CommandSurfaceSnapshot {
  return useSyncExternalStore(
    subscribeCommandSurface,
    getCommandSurfaceSnapshot,
    getCommandSurfaceSnapshot,
  );
}

function notifyListeners(): void {
  for (const listener of [...listeners]) listener();
}

/** Apply a REAL state change: bump the revision, re-derive hooks, notify. */
function commit(): void {
  revision += 1;
  snapshot = null;
  snapshotSignature = signatureOf(currentView());
  syncBodyHooks();
  notifyListeners();
}

// ── Body hooks ───────────────────────────────────────────────────────────────

function setBodyAttribute(name: string, value: string | null): void {
  if (typeof document === 'undefined' || !document.body) return;
  const body = document.body;
  if (value === null) {
    if (body.hasAttribute(name)) body.removeAttribute(name);
    return;
  }
  if (body.getAttribute(name) !== value) body.setAttribute(name, value);
}

/** Re-derive both body hooks from the currently displayed application. */
function syncBodyHooks(): void {
  if (typeof document === 'undefined' || !document.body) return;
  const appId = resolveDisplayedApplicationId();
  if (appId === null || resolveCommandSurface(appId) === null) {
    setBodyAttribute(BODY_ACTIVE_MODE_ATTR, null);
    setBodyAttribute(BODY_COMMAND_PROMPT_ATTR, null);
    return;
  }
  const path = getModePath(appId);
  setBodyAttribute(BODY_ACTIVE_MODE_ATTR, path.length > 0 ? path[path.length - 1] : null);
  const prompt = getOpenCommandPrompt(appId);
  setBodyAttribute(BODY_COMMAND_PROMPT_ATTR, prompt === null ? null : prompt.commandId);
}

// ── Mode stack writes ────────────────────────────────────────────────────────

/** Push `modeId` onto the application's stack (seeds the root first). */
export function pushMode(appId: string, modeId: string): void {
  const surface = resolveCommandSurface(appId);
  if (surface === null) return;
  const mode = getApplicationCommandMode(surface, modeId);
  if (mode === null) return;
  const path = getModePath(appId);
  if (path.length === 0) return;
  if (path[path.length - 1] === modeId) return; // already the top — no-op
  modeStacks.set(appId, [...path, modeId]);
  announce(`${mode.label} mode`);
  commit();
}

/**
 * Pop the application's top mode. A root pop is a no-op returning `false`
 * (no state change, no announcement).
 */
export function popMode(appId: string): boolean {
  const path = getModePath(appId);
  if (path.length <= 1) return false;
  const next = path.slice(0, -1);
  modeStacks.set(appId, next);
  const mode = getActiveCommandMode(appId);
  if (mode !== null) announce(`${mode.label} mode`);
  commit();
  return true;
}

/** Return the application to its root mode + drop any open prompt. */
export function resetApplicationMode(appId: string): void {
  const surface = resolveCommandSurface(appId);
  const root = surface === null ? null : getRootCommandMode(surface);
  const previousPath = modeStacks.get(appId);
  const hadPrompt = prompts.delete(appId);
  if (root === null) {
    if (previousPath !== undefined || hadPrompt) {
      modeStacks.delete(appId);
      commit();
    }
    return;
  }
  modeStacks.set(appId, [root.id]);
  announce(`${root.label} mode`);
  const changed =
    hadPrompt ||
    previousPath === undefined ||
    previousPath.length !== 1 ||
    previousPath[0] !== root.id;
  if (changed) commit();
}

// ── Prompt reads / writes ────────────────────────────────────────────────────

/** The application's open inline prompt, or `null`. */
export function getOpenCommandPrompt(appId: string): CommandPromptState | null {
  return prompts.get(appId)?.state ?? null;
}

/** Update the module-owned draft (no-op when the value is unchanged). */
export function setCommandPromptValue(appId: string, value: string): void {
  const record = prompts.get(appId);
  if (record === undefined || record.state.value === value) return;
  prompts.set(appId, {
    state: { ...record.state, value },
    invocationPath: record.invocationPath,
  });
  commit();
}

/** Close the prompt without running its command (Escape cancels). */
export function cancelCommandPrompt(appId: string): void {
  const record = prompts.get(appId);
  if (record === undefined) return;
  prompts.delete(appId);
  commit();
  restoreFocus(record.state.restoreElement);
}

/**
 * Commit the draft exactly once to the command that opened the prompt, then
 * apply the invocation mode's auto-return and restore focus.
 *
 * Spec #3098 ST-1 — the command's optional `prompt.validate` guard runs BEFORE
 * the prompt is torn down: a `false` result keeps the SAME prompt open with its
 * draft and performs no run, no mode change, no body-hook change and no focus
 * restore.
 */
export function commitCommandPrompt(appId: string): void {
  const record = prompts.get(appId);
  if (record === undefined) return;
  const surface = resolveCommandSurface(appId);
  const command =
    surface === null
      ? null
      : surface.commands.find((candidate) => candidate.id === record.state.commandId) ?? null;
  const value = record.state.value;
  const restoreElement = record.state.restoreElement;

  const validate = command?.prompt?.validate;
  if (validate !== undefined && !validate(value)) return;

  prompts.delete(appId);
  commit(); // body hook clears before the handler runs

  if (command === null) {
    restoreFocus(restoreElement);
    return;
  }
  invokeRun(appId, command, { value }, record.invocationPath, restoreElement);
}

// ── The ONE executor ─────────────────────────────────────────────────────────

/**
 * Execute `commandId` for `appId` — the SINGLE `run` invocation site.
 *
 * - Unknown app / surface / command → no-op.
 * - No args + a prompt spec → open the inline prompt (no run).
 * - Otherwise → run exactly once, then auto-return a non-sticky non-root
 *   invocation mode to its parent on a non-throwing invocation.
 */
export function executeCommand(
  appId: string,
  commandId: string,
  args?: ApplicationCommandArgs,
): void {
  const surface = resolveCommandSurface(appId);
  if (surface === null) return;
  const command = surface.commands.find((candidate) => candidate.id === commandId);
  if (command === undefined) return;

  const invocationPath = getModePath(appId);

  if (args === undefined && command.prompt !== undefined) {
    openPrompt(appId, command, invocationPath);
    return;
  }

  invokeRun(appId, command, args, invocationPath);
}

function openPrompt(
  appId: string,
  command: ApplicationCommandSpec,
  invocationPath: readonly string[],
): void {
  const prompt = command.prompt;
  if (prompt === undefined) return;
  const restoreElement =
    typeof document === 'undefined' ? null : document.activeElement;
  const state: CommandPromptState = Object.freeze({
    commandId: command.id,
    label: prompt.label,
    placeholder: prompt.placeholder,
    value: prompt.initialValue ?? '',
    restoreElement,
  });
  prompts.set(appId, { state, invocationPath: [...invocationPath] });
  commit();
  announce(`${command.title} value`);
}

/**
 * Invoke `command.run` ONCE and settle the invocation-mode return. A thrown or
 * rejected run changes no mode; async rejections are swallowed.
 */
function invokeRun(
  appId: string,
  command: ApplicationCommandSpec,
  args: ApplicationCommandArgs | undefined,
  invocationPath: readonly string[],
  restoreElement?: Element | null,
): void {
  let result: void | Promise<void>;
  try {
    result = command.run(args);
  } catch {
    restoreFocus(restoreElement ?? null);
    return;
  }
  if (isPromiseLike(result)) {
    Promise.resolve(result).then(
      () => {
        applyAutoReturn(appId, invocationPath);
        restoreFocus(restoreElement ?? null);
      },
      () => {
        // A rejected run changes no mode — never surface an unhandled rejection.
        restoreFocus(restoreElement ?? null);
      },
    );
    return;
  }
  applyAutoReturn(appId, invocationPath);
  restoreFocus(restoreElement ?? null);
}

/**
 * Return from the invocation mode to its parent when that mode is non-root,
 * non-sticky AND still on the stack. The CURRENT top is never popped — a root
 * command that pushed `tool` leaves `tool` active.
 */
function applyAutoReturn(appId: string, invocationPath: readonly string[]): void {
  if (invocationPath.length === 0) return;
  const surface = resolveCommandSurface(appId);
  if (surface === null) return;
  const invocationModeId = invocationPath[invocationPath.length - 1];
  const invocationMode = getApplicationCommandMode(surface, invocationModeId);
  if (invocationMode === null) return;
  if (invocationMode.parent === null) return; // root stays root
  if (invocationMode.sticky === true) return; // sticky stays active

  const stack = modeStacks.get(appId);
  if (stack === undefined || !stack.includes(invocationModeId)) return;
  const parentIndex = stack.lastIndexOf(invocationMode.parent);
  if (parentIndex === -1) return;
  const next = stack.slice(0, parentIndex + 1);
  if (samePath(stack, next)) return;
  modeStacks.set(appId, next);
  const topMode = getApplicationCommandMode(surface, next[next.length - 1]);
  announce(`${topMode?.label ?? invocationMode.parent} mode`);
  commit();
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Restore focus only when the captured element is still mounted. */
function restoreFocus(element: Element | null): void {
  if (element === null || !element.isConnected) return;
  const focusable = element as HTMLElement;
  if (typeof focusable.focus === 'function') focusable.focus();
}

// ── Runtime install (focus + window sync, prune) ─────────────────────────────

/** Re-derive the focused app after a focus move; notify only on a real change. */
function syncFromFocus(): void {
  syncBodyHooks();
  const signature = signatureOf(currentView());
  if (signature === snapshotSignature) return;
  snapshotSignature = signature;
  revision += 1;
  snapshot = null;
  notifyListeners();
}

function seedBaseline(): void {
  snapshotSignature = signatureOf(currentView());
}

/** Drop state for windows that were open and are now gone. */
function handleWindowSnapshotChange(): void {
  const current = new Set(getWindowSnapshot().map((win) => win.id));
  let pruned = false;
  for (const appId of knownAppIds) {
    if (current.has(appId)) continue;
    if (modeStacks.delete(appId)) pruned = true;
    if (prompts.delete(appId)) pruned = true;
  }
  knownAppIds = current;
  if (pruned) commit();
  else syncFromFocus();
}

/**
 * Install the focus/window sync + body hooks. Idempotent by reference count;
 * the first install subscribes and the last uninstall tears down. Adds NO
 * `keydown` listener (the engine owns the ONE).
 */
export function installCommandSurfaceRuntime(): () => void {
  if (typeof document === 'undefined') return () => {};

  if (installCount === 0) {
    knownAppIds = new Set(getWindowSnapshot().map((win) => win.id));
    seedBaseline();
    syncBodyHooks();
    unsubscribeWindows = subscribeWindows(handleWindowSnapshotChange);
    focusInHandler = () => syncFromFocus();
    focusOutHandler = () => syncFromFocus();
    document.addEventListener('focusin', focusInHandler, true);
    document.addEventListener('focusout', focusOutHandler, true);
  }

  installCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installCount = Math.max(0, installCount - 1);
    if (installCount === 0) teardownRuntime();
  };
}

function teardownRuntime(): void {
  unsubscribeWindows?.();
  unsubscribeWindows = null;
  if (focusInHandler !== null) {
    document.removeEventListener('focusin', focusInHandler, true);
    focusInHandler = null;
  }
  if (focusOutHandler !== null) {
    document.removeEventListener('focusout', focusOutHandler, true);
    focusOutHandler = null;
  }
  knownAppIds = new Set();
  // The runtime owns the hooks — clear them, but keep the mode/prompt state so
  // a remount preserves the user's active mode.
  setBodyAttribute(BODY_ACTIVE_MODE_ATTR, null);
  setBodyAttribute(BODY_COMMAND_PROMPT_ATTR, null);
}

/** Reset all module state + the installed runtime (tests only). */
export function resetCommandSurfaceForTests(): void {
  if (installCount > 0) {
    installCount = 1;
    teardownRuntime();
    installCount = 0;
  }
  modeStacks.clear();
  prompts.clear();
  knownAppIds = new Set();
  listeners.clear();
  revision = 0;
  snapshot = null;
  snapshotSignature = null;
  if (typeof document !== 'undefined' && document.body) {
    document.body.removeAttribute(BODY_ACTIVE_MODE_ATTR);
    document.body.removeAttribute(BODY_COMMAND_PROMPT_ATTR);
  }
}
