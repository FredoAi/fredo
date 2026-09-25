/**
 * Spec #2946 ST-4 — the ONE dispatch engine (plan contract block 4; EARS R-2.5,
 * R-2.6, R-3.1, R-3.3, R-3.4, R-3.5, R-3.6, R-3.10, R-5.5, R-5.6, R-5.7, R-5.9).
 *
 * This is the "single truth" the issue demands. The PURE decision lives in
 * `sequence.ts` (`decideDispatch`); this module is the imperative wiring around
 * it:
 *   - resolves the ACTIVE bindings (keymap document + registry defaults) and
 *     scopes feature-tier bindings to the focused feature (R-2.5),
 *   - classifies the focus context (`focusContext.ts`) and computes whether the
 *     focused control natively consumes the key (native-consumer preference),
 *   - owns the pending-sequence state machine + its timeout (R-3.1…R-3.6),
 *   - runs the winning action (never awaited — the keydown path must not block),
 *   - mirrors the live state onto `document.body` DOM hooks for QA,
 *   - gates macro recording (ST-8) and exposes terminal passthrough (ST-12).
 *
 * Exactly ONE `keydown` listener exists per webview: `installHotkeyEngine()` is
 * idempotent and adds the listener in the CAPTURE phase so a consumed chord never
 * reaches a per-surface listener or a React `onKeyDown` (no double fire).
 *
 * Keydown path budget: zero IPC, zero keymap write, zero React re-render. Only
 * transient which-key state (arm/pending/reset) touches the store, exactly as
 * ST-2's transient setters intend.
 */

import { isInteractiveElement, classifyFocusContext } from './focusContext';
import {
  displayStroke,
  keyStrokeEquals,
  normalizeKeyStroke,
  parseSequence,
  parseStrokeToken,
  serializeStroke,
} from './keys';
import {
  getHotkeyAction,
  listHotkeyActions,
  registerFredoAction,
  runHotkeyAction,
} from './registry';
import { decideDispatch } from './sequence';
import {
  clearPendingSequence,
  getKeymap,
  isMacroRecording,
  setPendingSequence,
  subscribeHotkeyEvents,
} from './store';
import { MINIMAL_DEFAULT_BINDINGS } from './defaults';
import { focusWindow, getWindowSnapshot } from '../window-system/windowStore';
import {
  type DispatchDecision,
  type FeatureHotkeyAction,
  type FocusContext,
  type HotkeyCandidate,
  type HotkeyResetReason,
  type KeySequence,
  type KeyStroke,
  type PersistedKeymap,
  type RegisteredHotkeyAction,
  type ResolvedBinding,
} from './types';

// ── Action ids the engine ships + consumes (ONE declaration site here) ────────

/** The launcher toggle action re-homed from the old LauncherShell document listener. */
export const LAUNCHER_TOGGLE_ACTION_ID = 'fredo.launcher.toggle';
const FOCUS_NEXT_ACTION_ID = 'fredo.focus.nextWindow';
const FOCUS_PREV_ACTION_ID = 'fredo.focus.prevWindow';
const CYCLE_NTH_ACTION_ID = 'fredo.window.cycleNth';
const FIRST_WINDOW_ACTION_ID = 'fredo.window.first';

// ── DOM hooks (contract block 7) ─────────────────────────────────────────────

/** `document.documentElement` — this webview runs the engine. */
const ENGINE_ATTR = 'data-fredo-hotkeys-engine';
/** `document.body` — live focus classification. */
export const BODY_FOCUS_CONTEXT_ATTR = 'data-fredo-focus-context';
/** `document.body` — the serialized pending prefix (absent when idle). */
export const BODY_PENDING_SEQUENCE_ATTR = 'data-fredo-pending-sequence';
/** `document.body` — terminal passthrough is active. */
export const BODY_PASSTHROUGH_ATTR = 'data-fredo-passthrough';
/** `document.body` — a raw macro recording is active (ST-8 owns the recorder). */
export const BODY_MACRO_RECORDING_ATTR = 'data-fredo-macro-recording';

const NO_CANDIDATES: readonly HotkeyCandidate[] = Object.freeze([]);

/** The synthetic stroke that stands for the configured leader inside a sequence. */
function leaderTokenStroke(): KeyStroke {
  return { key: '@leader', primary: false, ctrl: false, alt: false, shift: false, meta: false };
}

// ── Default Fredo actions (titles + minimal run) ─────────────────────────────
//
// Declaring the actions here is what lets the engine resolve the shipped default
// bindings AND lets each owning capsule (ST-9/ST-10/ST-12/ST-8) override the run
// through `registerHotkeyHandler` without re-declaring the action.

interface DefaultFredoActionDef {
  readonly actionId: string;
  readonly title: string;
  readonly description: string;
  readonly run?: (ctx: { readonly sequence: KeySequence }) => void;
}

function focusRelative(delta: number): void {
  const entries = getWindowSnapshot();
  if (entries.length === 0) return;
  const current = entries.findIndex((w) => w.focused);
  const base = current === -1 ? (delta > 0 ? -1 : 0) : current;
  const next = (base + delta + entries.length) % entries.length;
  const target = entries[next];
  if (target) focusWindow(target.id);
}

function focusNth(sequence: KeySequence): void {
  const key = sequence[sequence.length - 1]?.key;
  if (!key || !/^[1-9]$/.test(key)) return;
  const target = getWindowSnapshot()[Number(key) - 1];
  if (target) focusWindow(target.id);
}

/** Focus the FIRST open window (ST-16's non-leader `g g` action). */
function focusFirstWindow(): void {
  const target = getWindowSnapshot()[0];
  if (target) focusWindow(target.id);
}

const DEFAULT_FREDO_ACTION_DEFS: readonly DefaultFredoActionDef[] = [
  {
    actionId: LAUNCHER_TOGGLE_ACTION_ID,
    title: 'Toggle launcher',
    description: 'Show or focus the launcher command bar',
  },
  {
    actionId: 'fredo.palette.openActions',
    title: 'Open actions palette',
    description: 'Open the launcher pre-filled with the action prefix',
  },
  {
    actionId: 'fredo.help.cheatsheet',
    title: 'Open hotkey cheat sheet',
    description: 'Show every binding in one searchable list',
  },
  {
    actionId: FOCUS_NEXT_ACTION_ID,
    title: 'Focus next window',
    description: 'Move focus to the next open window',
    run: () => focusRelative(1),
  },
  {
    actionId: FOCUS_PREV_ACTION_ID,
    title: 'Focus previous window',
    description: 'Move focus to the previous open window',
    run: () => focusRelative(-1),
  },
  {
    actionId: CYCLE_NTH_ACTION_ID,
    title: 'Focus window by number',
    description: 'Focus the Nth open window',
    run: (ctx) => focusNth(ctx.sequence),
  },
  {
    actionId: FIRST_WINDOW_ACTION_ID,
    title: 'Focus first window',
    description: 'Focus the first open window',
    run: () => focusFirstWindow(),
  },
  { actionId: 'fredo.focus.left', title: 'Focus left', description: 'Move focus left' },
  { actionId: 'fredo.focus.down', title: 'Focus down', description: 'Move focus down' },
  { actionId: 'fredo.focus.up', title: 'Focus up', description: 'Move focus up' },
  { actionId: 'fredo.focus.right', title: 'Focus right', description: 'Move focus right' },
  {
    actionId: 'fredo.terminal.exitPassthrough',
    title: 'Exit terminal passthrough',
    description: 'Release the keyboard from the terminal',
  },
  {
    actionId: 'fredo.macro.recordToggle',
    title: 'Toggle macro recording',
    description: 'Start or stop recording a keystroke macro',
  },
];

function defaultSequenceFor(actionId: string): string | null {
  const sequences = MINIMAL_DEFAULT_BINDINGS[actionId];
  return sequences && sequences.length > 0 ? sequences[0] : null;
}

/**
 * Register the shipped Fredo actions. Idempotent across `resetRegistryForTests`
 * (an already-resolvable action is left untouched), so re-installing the engine
 * can never create a duplicate `invalid` row.
 */
export function registerDefaultFredoActions(): void {
  for (const def of DEFAULT_FREDO_ACTION_DEFS) {
    if (getHotkeyAction(def.actionId) !== null) continue;
    const action: FeatureHotkeyAction = {
      actionId: def.actionId,
      title: def.title,
      description: def.description,
      defaultSequence: defaultSequenceFor(def.actionId),
      run: (ctx) => def.run?.(ctx),
    };
    registerFredoAction(action);
  }
}

// ── Binding resolution ───────────────────────────────────────────────────────

/** The currently focused window id — the feature-local scope key (R-2.5). */
export function getFocusedFeatureId(): string | null {
  const focused = getWindowSnapshot().find((w) => w.focused);
  return focused ? focused.id : null;
}

function effectiveSequences(
  action: RegisteredHotkeyAction,
  keymap: PersistedKeymap,
): readonly string[] {
  const configured = keymap.bindings[action.actionId];
  if (configured !== undefined) return configured;
  if (action.defaultSequence) return [action.defaultSequence];
  return [];
}

/**
 * Resolve every dispatchable binding for a focus scope. Fredo-tier bindings are
 * always included (R-2.6); a feature-tier binding is included only while its
 * owning feature is focused (R-2.5). Invalid actions are never dispatchable.
 */
export function resolveActiveBindings(
  focusedFeatureId: string | null = getFocusedFeatureId(),
): readonly ResolvedBinding[] {
  const keymap = getKeymap();
  const resolved: ResolvedBinding[] = [];
  for (const action of listHotkeyActions()) {
    if (action.invalid) continue;
    if (action.tier === 'feature' && action.featureId !== focusedFeatureId) continue;
    for (const serialized of effectiveSequences(action, keymap)) {
      const sequence = parseSequence(serialized);
      if (sequence.length === 0) continue;
      resolved.push({
        actionId: action.actionId,
        tier: action.tier,
        sequence,
        serialized,
        action,
      });
    }
  }
  return resolved;
}

/** The configured leader stroke, or `null` when the leader is disabled. */
export function getLeaderStroke(): KeyStroke | null {
  const leader = getKeymap().leader;
  return leader ? parseStrokeToken(leader) : null;
}

/** The next-key candidates for a pending prefix (the which-key overlay's data). */
export function candidatesFor(
  prefix: KeySequence,
  bindings: readonly ResolvedBinding[],
): readonly HotkeyCandidate[] {
  const candidates: HotkeyCandidate[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (binding.sequence.length <= prefix.length) continue;
    let matches = true;
    for (let i = 0; i < prefix.length; i += 1) {
      if (!keyStrokeEquals(prefix[i], binding.sequence[i])) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const nextStroke = binding.sequence[prefix.length];
    const strokeToken = serializeStroke(nextStroke);
    if (seen.has(strokeToken)) continue;
    seen.add(strokeToken);
    candidates.push({
      strokeToken,
      display: displayStroke(nextStroke),
      actionId: binding.actionId,
      title: binding.action.title,
      tier: binding.tier,
    });
  }
  return candidates;
}

// ── Pending-sequence state machine ───────────────────────────────────────────

let pending: KeySequence | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

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

function armPending(prefix: KeySequence, bindings: readonly ResolvedBinding[]): void {
  pending = prefix;
  const serialized = prefix.map(serializeStroke).join(' ');
  setPendingSequence(serialized, candidatesFor(prefix, bindings));
  setBodyAttr(BODY_PENDING_SEQUENCE_ATTR, serialized);
  clearPendingTimer();
  pendingTimer = setTimeout(onSequenceTimeout, getKeymap().sequenceTimeoutMs);
}

function onSequenceTimeout(): void {
  pendingTimer = null;
  if (pending === null) return;
  pending = null;
  clearPendingSequence('timeout');
  setBodyAttr(BODY_PENDING_SEQUENCE_ATTR, null);
}

/** Clear a pending sequence that ended in an abandonment (R-3.5/R-3.6). */
function abandonPending(reason: HotkeyResetReason): void {
  if (pending === null) return;
  pending = null;
  clearPendingTimer();
  clearPendingSequence(reason);
  setBodyAttr(BODY_PENDING_SEQUENCE_ATTR, null);
}

/**
 * Clear a pending sequence that COMPLETED (R-3.4). The store has no dedicated
 * success-clear, so the idle projection is an empty prefix + no candidates —
 * ST-5's overlay reads that as hidden and no false `sequence:reset` is emitted.
 */
function completePending(): void {
  pending = null;
  clearPendingTimer();
  setPendingSequence('', NO_CANDIDATES);
  setBodyAttr(BODY_PENDING_SEQUENCE_ATTR, null);
}

function resetReasonFor(reason: string): HotkeyResetReason {
  if (reason === 'sequence-escape' || reason === 'escape') return 'escape';
  if (reason === 'timeout') return 'timeout';
  if (reason === 'focus-change') return 'focus-change';
  if (reason === 'native-consumes') return 'native-consumes';
  return 'invalid';
}

// ── Focus context + DOM hooks ────────────────────────────────────────────────

/** Classify `document.activeElement` (including the global open-modal fact). */
export function computeFocusContext(): FocusContext {
  if (typeof document === 'undefined') return 'default';
  const active = document.activeElement;
  const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
  return classifyFocusContext(active, { modalOpen });
}

function updateHooks(context: FocusContext): void {
  setBodyAttr(BODY_FOCUS_CONTEXT_ATTR, context);
  setBodyAttr(BODY_PASSTHROUGH_ATTR, context === 'terminal' ? 'true' : null);
  setBodyAttr(BODY_MACRO_RECORDING_ATTR, isMacroRecording() ? 'true' : null);
}

function clearBodyHooks(): void {
  setBodyAttr(BODY_FOCUS_CONTEXT_ATTR, null);
  setBodyAttr(BODY_PENDING_SEQUENCE_ATTR, null);
  setBodyAttr(BODY_PASSTHROUGH_ATTR, null);
  setBodyAttr(BODY_MACRO_RECORDING_ATTR, null);
}

function onFocusChange(): void {
  updateHooks(computeFocusContext());
  // A focus move mid-sequence abandons it without action (R-3.9-adjacent).
  abandonPending('focus-change');
}

// ── The dispatch path ────────────────────────────────────────────────────────

function applyDecision(
  decision: DispatchDecision,
  stroke: KeyStroke,
  bindings: readonly ResolvedBinding[],
  focusedFeatureId: string | null,
): void {
  switch (decision.outcome) {
    case 'match': {
      const action = decision.action;
      if (!action) return;
      const completed = pending !== null ? [...pending, stroke] : [stroke];
      if (pending !== null) completePending();
      runHotkeyAction(action.actionId, 'binding', completed, focusedFeatureId);
      return;
    }
    case 'arm-sequence': {
      const prefix =
        decision.reason === 'leader-armed' ? [leaderTokenStroke()] : [stroke];
      armPending(prefix, bindings);
      return;
    }
    case 'pending': {
      if (pending === null) return;
      armPending([...pending, stroke], bindings);
      return;
    }
    case 'suppress': {
      abandonPending(resetReasonFor(decision.reason));
      return;
    }
    case 'passthrough': {
      if (pending !== null) abandonPending('focus-change');
      return;
    }
  }
}

/**
 * The ONE keydown decision, fully applied. Returns the decision so tests can
 * assert the outcome directly; the installed listener ignores the return value.
 */
export function handleHotkeyKeydown(event: KeyboardEvent): DispatchDecision {
  const stroke = normalizeKeyStroke(event);
  if (stroke === null) {
    // IME composition / AltGraph / dead key — no match AND no preventDefault.
    return { outcome: 'passthrough', consumed: false, reason: 'unhandled-key' };
  }

  const context = computeFocusContext();
  updateHooks(context);

  const focusedFeatureId = getFocusedFeatureId();
  const bindings = resolveActiveBindings(focusedFeatureId);
  const active = typeof document === 'undefined' ? null : document.activeElement;

  const decision = decideDispatch({
    stroke,
    context,
    pending,
    bindings,
    leader: getLeaderStroke(),
    macroRecording: isMacroRecording(),
    nativeConsumes: isInteractiveElement(active),
  });

  applyDecision(decision, stroke, bindings, focusedFeatureId);

  if (decision.consumed) {
    event.preventDefault();
    event.stopPropagation();
  }
  return decision;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let installed = false;
let keydownListener: ((event: KeyboardEvent) => void) | null = null;
let focusListener: (() => void) | null = null;
let eventUnsubscribe: (() => void) | null = null;

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
  focusListener = () => {
    onFocusChange();
  };
  document.addEventListener('keydown', keydownListener, true);
  document.addEventListener('focusin', focusListener, true);
  document.addEventListener('focusout', focusListener, true);
  document.documentElement.setAttribute(ENGINE_ATTR, '1');

  eventUnsubscribe = subscribeHotkeyEvents((event) => {
    if (event.type === 'macro:recording') updateHooks(computeFocusContext());
  });

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

  eventUnsubscribe?.();
  eventUnsubscribe = null;

  clearPendingTimer();
  pending = null;

  document.documentElement.removeAttribute(ENGINE_ATTR);
  clearBodyHooks();
}

/** True while the engine's `document` keydown listener is installed. */
export function isHotkeyEngineInstalled(): boolean {
  return installed;
}

/** Test-only: uninstall + drop transient pending state. */
export function resetHotkeyEngineForTests(): void {
  uninstallHotkeyEngine();
  clearPendingTimer();
  pending = null;
}

/** Test/reporter only: the serialized pending prefix, or `null` when idle. */
export function getPendingPrefix(): string | null {
  return pending === null ? null : pending.map(serializeStroke).join(' ');
}
