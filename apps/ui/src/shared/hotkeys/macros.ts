/**
 * Spec #2946 ST-8 — macros: named action sequences + raw keystroke record/replay
 * (EARS R-3.7, R-3.8, R-3.9).
 *
 * Two kinds of macro, both persisted in the ONE keymap document (ST-2):
 *
 *  1. NAMED ACTION SEQUENCE — an ordered list of declared `HotkeyActionId`s that
 *     runs EXACTLY once per invocation, in order. A step that cannot run
 *     (unregistered / `enabled() === false` / thrown) is surfaced per the macro's
 *     `onStepError` policy (`abort` stops at the failure; `continue` finishes and
 *     reports every failure). The editor's picker excludes macro actions, so a
 *     nested/self-referential macro cannot be authored.
 *
 *  2. RAW KEYSTROKE RECORD/REPLAY — a recorded stroke stream guarded by an
 *     EXPLICIT confirmation on both start and replay. While recording, the ST-4
 *     engine suspends dispatch except the stop chord + Escape (R-3.9); this module
 *     owns the recorder and the PERSISTENT indicator state.
 *
 * Privacy (R-3.9 + PO#13): the recorder NEVER retains a stroke produced under a
 * text-entry target (`input`/`textarea`/`contenteditable`) or a terminal target —
 * those keys belong to the field / the PTY. The recorder's window-capture listener
 * keeps a text-entry stroke's native default (no `preventDefault`) so the field
 * still receives the typed character, and leaves terminal strokes to the PTY.
 *
 * Exactly-one-recording across webviews (G-124): the `fredo.hotkeys.recording` KV
 * latch is acquired before a recording starts and released when it stops/discards
 * or is saved, so a second webview can never start a concurrent recording.
 *
 * ZERO shortcut-usage telemetry (PO#13): this module never emits a span, event or
 * metric and imports no telemetry/OTLP surface.
 */

import { announce } from './announcer';
import { MINIMAL_DEFAULT_BINDINGS } from './defaults';
import { isTextControl } from './focusContext';
import {
  keyStrokeEquals,
  normalizeKeyStroke,
  parseSequence,
  parseStrokeToken,
  resolvePrimaryModifier,
  serializeStroke,
} from './keys';
import { acquireRecordingLatch, releaseRecordingLatch } from './persistence';
import { getHotkeyAction, listHotkeyActions, registerFredoAction, registerHotkeyHandler } from './registry';
import {
  applyKeymap,
  getKeymap,
  isMacroRecording,
  setMacroRecording,
  subscribeHotkeyEvents,
} from './store';
import { getWindowSnapshot } from '../window-system/windowStore';
import {
  MACRO_RECORD_TOGGLE_ACTION_ID,
  type HotkeyActionId,
  type HotkeyInvocationContext,
  type KeyStroke,
  type PersistedMacro,
  type PersistedRawMacro,
} from './types';

// ── Small helpers ─────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `macro-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/** The focused window id — the feature-scope key for a macro's steps (R-2.5). */
function focusedFeatureId(): string | null {
  try {
    const focused = getWindowSnapshot().find((entry) => entry.focused);
    return focused ? focused.id : null;
  } catch {
    return null;
  }
}

// ── Action-id mapping (ONE declaration site) ─────────────────────────────────

/** Sanitize a macro id into a valid action-id segment (`[a-z][a-zA-Z0-9-]*`). */
function macroSlug(macroId: string): string {
  const cleaned = macroId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '');
  return `m-${cleaned.length > 0 ? cleaned : 'macro'}`;
}

/** The registered action id that carries a macro's trigger binding. */
export function macroActionId(macroId: string): HotkeyActionId {
  return `fredo.macro.${macroSlug(macroId)}`;
}

// ── Named-macro model (pure transforms) ──────────────────────────────────────

/** A fresh named macro draft. */
export function createDraftMacro(name = 'New macro'): PersistedMacro {
  return { id: newId(), name, steps: [], trigger: null, onStepError: 'abort' };
}

/** A copy with `actionId` appended as the last step. */
export function withStep(macro: PersistedMacro, actionId: HotkeyActionId): PersistedMacro {
  return { ...macro, steps: [...macro.steps, actionId] };
}

/** A copy with the step at `index` moved by `delta` (−1 up / +1 down). */
export function withStepMoved(
  macro: PersistedMacro,
  index: number,
  delta: number,
): PersistedMacro {
  const target = index + delta;
  if (index < 0 || index >= macro.steps.length) return macro;
  if (target < 0 || target >= macro.steps.length) return macro;
  const steps = [...macro.steps];
  const [moved] = steps.splice(index, 1);
  steps.splice(target, 0, moved);
  return { ...macro, steps };
}

/** A copy with the step at `index` removed. */
export function withStepRemoved(macro: PersistedMacro, index: number): PersistedMacro {
  if (index < 0 || index >= macro.steps.length) return macro;
  return { ...macro, steps: macro.steps.filter((_, i) => i !== index) };
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export function getNamedMacro(macroId: string): PersistedMacro | null {
  return getKeymap().macros.find((macro) => macro.id === macroId) ?? null;
}

export function getRawMacro(macroId: string): PersistedRawMacro | null {
  return getKeymap().rawMacros.find((macro) => macro.id === macroId) ?? null;
}

// ── Named-macro execution (R-3.7) ────────────────────────────────────────────

export interface MacroStepResult {
  readonly actionId: HotkeyActionId;
  readonly status: 'ran' | 'unavailable' | 'failed';
  readonly error?: string;
}

export interface MacroRunResult {
  readonly macroId: string;
  readonly status: 'ran' | 'empty' | 'aborted' | 'completed-with-errors' | 'reentrant';
  readonly results: readonly MacroStepResult[];
  /** The first step that could not run (present when `status` is `aborted`). */
  readonly failingStepId?: HotkeyActionId;
}

const runningMacros = new Set<string>();

/**
 * Run a named macro's declared action sequence in order, exactly once. A step that
 * cannot run is surfaced per the macro's `onStepError`:
 *   - `abort`    — stop at the first failing step;
 *   - `continue` — run every remaining step and report the failures.
 * Never throws. Re-entrant invocation of the same macro is refused.
 */
export async function runNamedMacro(
  macroId: string,
  source: HotkeyInvocationContext['source'] = 'macro',
): Promise<MacroRunResult> {
  const empty: MacroRunResult = { macroId, status: 'empty', results: [] };

  const macro = getNamedMacro(macroId);
  if (!macro) return empty;
  if (macro.steps.length === 0) {
    announce(`Macro "${macro.name}" has no steps.`);
    return empty;
  }
  if (runningMacros.has(macroId)) {
    announce(`Macro "${macro.name}" is already running.`);
    return { macroId, status: 'reentrant', results: [] };
  }

  runningMacros.add(macroId);
  const results: MacroStepResult[] = [];
  try {
    for (const stepId of macro.steps) {
      const action = getHotkeyAction(stepId);
      const available = action !== null && !(action.enabled && !action.enabled());

      if (!available) {
        results.push({ actionId: stepId, status: 'unavailable' });
        if (macro.onStepError === 'abort') {
          announce(
            `Macro "${macro.name}" stopped: step "${action?.title ?? stepId}" is unavailable.`,
          );
          return { macroId, status: 'aborted', results, failingStepId: stepId };
        }
        continue;
      }

      try {
        await action.run({
          actionId: stepId,
          tier: action.tier,
          sequence: [],
          source,
          focusedFeatureId: focusedFeatureId(),
          at: Date.now(),
        });
        results.push({ actionId: stepId, status: 'ran' });
      } catch (error) {
        results.push({ actionId: stepId, status: 'failed', error: messageOf(error) });
        if (macro.onStepError === 'abort') {
          announce(`Macro "${macro.name}" stopped: step "${action.title}" failed.`);
          return { macroId, status: 'aborted', results, failingStepId: stepId };
        }
      }
    }
  } finally {
    runningMacros.delete(macroId);
  }

  const failed = results.filter((result) => result.status !== 'ran');
  if (failed.length > 0) {
    announce(
      `Macro "${macro.name}" finished with ${failed.length} failing step${
        failed.length === 1 ? '' : 's'
      }.`,
    );
    return { macroId, status: 'completed-with-errors', results };
  }
  announce(`Macro "${macro.name}" ran ${results.length} step${results.length === 1 ? '' : 's'}.`);
  return { macroId, status: 'ran', results };
}

// ── Persistence (named + raw) ────────────────────────────────────────────────

/** Insert or replace a named macro; its dispatch action is registered first. */
export async function saveMacro(macro: PersistedMacro): Promise<void> {
  syncMacroRegistrations();
  const keymap = getKeymap();
  const exists = keymap.macros.some((entry) => entry.id === macro.id);
  const macros = exists
    ? keymap.macros.map((entry) => (entry.id === macro.id ? macro : entry))
    : [...keymap.macros, macro];
  await applyKeymap({
    ...keymap,
    macros: macros.map((entry) => ({ ...entry, steps: [...entry.steps] })),
  });
  syncMacroRegistrations();
}

/** Insert or replace a recorded raw macro. */
export async function saveRawMacro(raw: PersistedRawMacro): Promise<void> {
  syncMacroRegistrations();
  const keymap = getKeymap();
  const exists = keymap.rawMacros.some((entry) => entry.id === raw.id);
  const rawMacros = exists
    ? keymap.rawMacros.map((entry) => (entry.id === raw.id ? raw : entry))
    : [...keymap.rawMacros, raw];
  await applyKeymap({
    ...keymap,
    rawMacros: rawMacros.map((entry) => ({ ...entry, strokes: [...entry.strokes] })),
  });
  syncMacroRegistrations();
}

/** Remove a macro (named or raw) and unbind its trigger. Idempotent. */
export async function deleteMacro(macroId: string): Promise<void> {
  const keymap = getKeymap();
  const actionId = macroActionId(macroId);
  const bindings: Record<HotkeyActionId, string[]> = { ...keymap.bindings };
  delete bindings[actionId];
  await applyKeymap({
    ...keymap,
    bindings,
    macros: keymap.macros.filter((entry) => entry.id !== macroId),
    rawMacros: keymap.rawMacros.filter((entry) => entry.id !== macroId),
  });
  announce('Macro deleted.');
}

/**
 * The effective trigger for a macro. The dispatch source of truth is the trigger
 * action's binding in the keymap document (so a rebind through the standard flow
 * is honoured); the persisted `trigger` field is the cross-session mirror.
 */
export function getMacroTrigger(macroId: string): string | null {
  const keymap = getKeymap();
  const bound = keymap.bindings[macroActionId(macroId)];
  if (bound && bound.length > 0) return bound[0];
  const macro = getNamedMacro(macroId) ?? getRawMacro(macroId);
  return macro?.trigger ?? null;
}

/**
 * Assign (or clear, with `null`) a macro's trigger binding. Writes the macro's
 * `trigger` mirror AND the trigger action's binding in ONE optimistic keymap write
 * so the persisted document never carries a half-applied change.
 */
export async function setMacroTrigger(macroId: string, sequence: string | null): Promise<void> {
  syncMacroRegistrations();
  const keymap = getKeymap();
  const actionId = macroActionId(macroId);
  const hasNamed = keymap.macros.some((entry) => entry.id === macroId);
  const hasRaw = keymap.rawMacros.some((entry) => entry.id === macroId);
  if (!hasNamed && !hasRaw) return;

  const mirror = <T extends PersistedMacro | PersistedRawMacro>(entry: T): T =>
    entry.id === macroId ? { ...entry, trigger: sequence } : entry;

  await applyKeymap({
    ...keymap,
    bindings: { ...keymap.bindings, [actionId]: sequence === null ? [] : [sequence] },
    macros: keymap.macros.map(mirror),
    rawMacros: keymap.rawMacros.map(mirror),
  });
}

// ── Registry registration (the engine dispatches macro triggers) ─────────────

/**
 * Ensure every persisted macro has a registered Fredo-tier trigger action. The
 * action's `run` resolves the macro LIVE (so rename/step edits are honoured) and
 * a raw macro's `run` always funnels through the replay confirmation.
 * Idempotent: an already-resolvable action is left untouched.
 */
export function syncMacroRegistrations(): void {
  const keymap = getKeymap();
  for (const macro of keymap.macros) {
    const actionId = macroActionId(macro.id);
    if (getHotkeyAction(actionId) !== null) continue;
    registerFredoAction({
      actionId,
      title: `Macro: ${macro.name}`,
      description: 'Run a saved action-sequence macro',
      defaultSequence: null,
      run: () => {
        void runNamedMacro(macro.id, 'binding');
      },
    });
  }
  for (const raw of keymap.rawMacros) {
    const actionId = macroActionId(raw.id);
    if (getHotkeyAction(actionId) !== null) continue;
    registerFredoAction({
      actionId,
      title: `Recorded macro: ${raw.name}`,
      description: 'Replay a recorded keystroke macro (requires confirmation)',
      defaultSequence: null,
      run: () => {
        requestReplay(raw.id);
      },
    });
  }
}

// ── Confirmation intents (start + replay) ────────────────────────────────────

export interface MacroConfirmRequest {
  readonly kind: 'record-start' | 'replay';
  readonly macroId: string | null;
  readonly name: string | null;
}

export interface MacroUiSnapshot {
  readonly confirm: MacroConfirmRequest | null;
  readonly recording: boolean;
  readonly recordingMacroId: string | null;
  readonly recordedStrokes: readonly string[];
}

let confirmRequest: MacroConfirmRequest | null = null;
let recordedStrokes: string[] = [];
let recordingMacroId: string | null = null;
let uiSnapshot: MacroUiSnapshot = freezeSnapshot(null, false, null, []);
const uiListeners = new Set<() => void>();
let uiBridgeInstalled = false;

function freezeSnapshot(
  confirm: MacroConfirmRequest | null,
  recording: boolean,
  macroId: string | null,
  strokes: readonly string[],
): MacroUiSnapshot {
  return Object.freeze({
    confirm,
    recording,
    recordingMacroId: macroId,
    recordedStrokes: Object.freeze([...strokes]),
  });
}

function notifyMacroUi(): void {
  uiSnapshot = freezeSnapshot(confirmRequest, isMacroRecording(), recordingMacroId, recordedStrokes);
  for (const listener of [...uiListeners]) listener();
}

/** Install the ONE store → macro-UI bridge (idempotent, module lifetime). */
function ensureUiBridge(): void {
  if (uiBridgeInstalled) return;
  uiBridgeInstalled = true;
  subscribeHotkeyEvents((event) => {
    if (event.type === 'macro:recording') notifyMacroUi();
  });
}

export function subscribeMacroUi(listener: () => void): () => void {
  ensureUiBridge();
  uiListeners.add(listener);
  return () => {
    uiListeners.delete(listener);
  };
}

export function getMacroUiSnapshot(): MacroUiSnapshot {
  return uiSnapshot;
}

/**
 * Ask for the explicit confirmation required before a recording starts (R-3.8).
 * Does NOT start recording — only the confirmed path may.
 */
export function requestRecordStart(macroId: string | null = null): void {
  confirmRequest = { kind: 'record-start', macroId, name: null };
  notifyMacroUi();
  announce('Confirm recording in the Macros section. Typed field text is never captured.');
}

/** Ask for the explicit confirmation required before a raw replay (R-3.8). */
export function requestReplay(macroId: string): void {
  const raw = getRawMacro(macroId);
  confirmRequest = { kind: 'replay', macroId, name: raw?.name ?? null };
  notifyMacroUi();
  announce(
    raw
      ? `Confirm replay of "${raw.name}" in the Macros section.`
      : 'Confirm the macro replay in the Macros section.',
  );
}

/** Dismiss the pending confirmation without acting. */
export function cancelMacroConfirm(): void {
  if (confirmRequest === null) return;
  confirmRequest = null;
  notifyMacroUi();
  announce('Macro action cancelled.');
}

// ── Recording lifecycle (R-3.8/R-3.9) ────────────────────────────────────────

export interface MacroRecordingStartResult {
  readonly ok: boolean;
  readonly macroId: string;
  readonly reason?: string;
}

function recordToggleSequences(): readonly string[] {
  const keymap = getKeymap();
  const configured = keymap.bindings[MACRO_RECORD_TOGGLE_ACTION_ID];
  if (configured !== undefined) return configured;
  const declared = getHotkeyAction(MACRO_RECORD_TOGGLE_ACTION_ID)?.defaultSequence;
  if (declared) return [declared];
  return MINIMAL_DEFAULT_BINDINGS[MACRO_RECORD_TOGGLE_ACTION_ID] ?? [];
}

/** True when `stroke` is the configured recording-stop chord. */
export function isRecordStopStroke(stroke: KeyStroke): boolean {
  for (const serialized of recordToggleSequences()) {
    const sequence = parseSequence(serialized);
    if (sequence.length === 1 && keyStrokeEquals(sequence[0], stroke)) return true;
  }
  return false;
}

/** The recording-stop chord, serialized (for the persistent indicator copy). */
export function recordStopChord(): string | null {
  const sequences = recordToggleSequences();
  return sequences.length > 0 ? sequences[0] : null;
}

/**
 * A target whose strokes MUST NOT be retained (R-3.9): any text-entry control
 * (input / textarea / contenteditable / role=textbox) or any element inside a
 * terminal root (those keys belong to the PTY).
 */
export function isPrivacyExemptTarget(target: Element | null): boolean {
  if (!target) return false;
  if (target.closest('[data-fredo-terminal-root="true"]') !== null) return true;
  if (isTextControl(target)) return true;
  return target.closest('input, textarea, [contenteditable]') !== null;
}

/** The recorder's privacy predicate: `true` only when the stroke may be retained. */
export function shouldCaptureStroke(target: Element | null): boolean {
  return !isPrivacyExemptTarget(target);
}

/**
 * A text-entry target (not a terminal): the recorder keeps its native default so
 * the typed character still reaches the field while recording.
 */
export function isTextEntryTarget(target: Element | null): boolean {
  if (!target) return false;
  if (target.closest('[data-fredo-terminal-root="true"]') !== null) return false;
  if (isTextControl(target)) return true;
  return target.closest('input, textarea, [contenteditable]') !== null;
}

/** Install the stop-chord/confirm handler for `fredo.macro.recordToggle`. */
export function installMacroRecordToggleHandler(): void {
  registerHotkeyHandler(MACRO_RECORD_TOGGLE_ACTION_ID, () => {
    if (isMacroRecording()) {
      stopRecording();
      return;
    }
    requestRecordStart();
  });
}

let captureListener: ((event: KeyboardEvent) => void) | null = null;

function handleRecordingKeydown(event: KeyboardEvent): void {
  if (!isMacroRecording()) return;
  const stroke = normalizeKeyStroke(event);
  // IME composition / AltGraph / pure modifier: never retained, never consumed.
  if (!stroke) return;
  // Escape is suspended by the engine (R-3.9) and is never retained.
  if (stroke.key === 'escape') return;
  // The stop chord stops the recording (engine) and is never retained.
  if (isRecordStopStroke(stroke)) return;

  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (!shouldCaptureStroke(active)) {
    // Privacy bound (R-3.9): the event keeps its native default so a text-entry
    // stroke still reaches the field; it must not fall through to a dispatcher
    // that would swallow it. Terminal keys are left untouched for the PTY.
    if (isTextEntryTarget(active)) event.stopPropagation();
    return;
  }

  recordedStrokes = [...recordedStrokes, serializeStroke(stroke)];
  notifyMacroUi();
}

function installCaptureListener(): void {
  if (typeof window === 'undefined') return;
  if (captureListener !== null) return;
  captureListener = handleRecordingKeydown;
  // WINDOW capture phase: it runs before the document-capture engine so the
  // privacy bound above can keep a text-entry stroke's native default intact.
  window.addEventListener('keydown', captureListener, true);
}

function removeCaptureListener(): void {
  if (typeof window === 'undefined' || captureListener === null) return;
  window.removeEventListener('keydown', captureListener, true);
  captureListener = null;
}

/**
 * Start a raw recording. EXPLICIT CONFIRMATION IS REQUIRED (R-3.8): callers SHOULD
 * go through `confirmRecordStart()`; the latch (G-124) still refuses a concurrent
 * recording started by another webview.
 */
export async function startRecording(
  macroId: string | null = null,
): Promise<MacroRecordingStartResult> {
  const id = macroId ?? `raw-${newId()}`;
  if (isMacroRecording()) return { ok: false, macroId: id, reason: 'already-recording' };

  const acquired = await acquireRecordingLatch(id, Date.now());
  if (!acquired) {
    announce('Another recording is already in progress.');
    return { ok: false, macroId: id, reason: 'another-webview' };
  }

  recordedStrokes = [];
  recordingMacroId = id;
  setMacroRecording(true, id, Date.now());
  installMacroRecordToggleHandler();
  installCaptureListener();
  notifyMacroUi();
  announce('Recording keystrokes. Press the stop chord to stop; typed field text is not captured.');
  return { ok: true, macroId: id };
}

/** Confirm a pending record-start request and begin recording (R-3.8). */
export async function confirmRecordStart(): Promise<MacroRecordingStartResult> {
  const request = confirmRequest;
  const macroId = request?.kind === 'record-start' ? request.macroId : null;
  confirmRequest = null;
  notifyMacroUi();
  return startRecording(macroId);
}

/** Stop the active recording; the captured strokes stay available to save. */
export function stopRecording(): void {
  if (!isMacroRecording()) return;
  setMacroRecording(false);
  removeCaptureListener();
  void releaseRecordingLatch();
  notifyMacroUi();
  if (recordedStrokes.length === 0) {
    announce('Recording stopped. No keystrokes were captured.');
  } else {
    announce(
      `Recording stopped. ${recordedStrokes.length} keystroke${
        recordedStrokes.length === 1 ? '' : 's'
      } captured. Save or discard the recording.`,
    );
  }
}

/** Persist the stopped recording under an explicit name (R-3.8). */
export async function commitRecording(name?: string): Promise<PersistedRawMacro | null> {
  if (recordingMacroId === null) return null;
  const raw: PersistedRawMacro = {
    id: recordingMacroId,
    name:
      name && name.trim().length > 0
        ? name.trim()
        : `Recorded macro ${new Date().toLocaleTimeString()}`,
    strokes: [...recordedStrokes],
    trigger: null,
  };
  await saveRawMacro(raw);
  recordedStrokes = [];
  recordingMacroId = null;
  removeCaptureListener();
  void releaseRecordingLatch();
  setMacroRecording(false);
  notifyMacroUi();
  announce(`Saved macro "${raw.name}".`);
  return raw;
}

/** Discard the stopped recording (announced — never a silent loss). */
export function discardRecording(): void {
  recordedStrokes = [];
  recordingMacroId = null;
  removeCaptureListener();
  void releaseRecordingLatch();
  setMacroRecording(false);
  notifyMacroUi();
  announce('Recording discarded.');
}

export function getRecordedStrokes(): readonly string[] {
  return recordedStrokes;
}

export function isRecordingActive(): boolean {
  return isMacroRecording();
}

// ── Raw replay (R-3.8) ───────────────────────────────────────────────────────

const EVENT_KEY_FOR_TOKEN: Readonly<Record<string, string>> = {
  space: ' ',
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/** The `KeyboardEventInit` a recorded stroke replays as. */
export function strokeToEventInit(stroke: KeyStroke): KeyboardEventInit {
  const primaryIsCtrl = resolvePrimaryModifier() === 'ctrl';
  return {
    key: EVENT_KEY_FOR_TOKEN[stroke.key] ?? stroke.key,
    ctrlKey: stroke.ctrl || (primaryIsCtrl && stroke.primary),
    metaKey: stroke.meta || (!primaryIsCtrl && stroke.primary),
    altKey: stroke.alt,
    shiftKey: stroke.shift,
  };
}

export interface RawReplayResult {
  readonly macroId: string;
  readonly status: 'replayed' | 'empty' | 'missing';
  readonly played: number;
}

/**
 * Replay a recorded macro's strokes as synthetic keydown events. EXPLICIT
 * CONFIRMATION IS REQUIRED (R-3.8): callers SHOULD go through `confirmReplay()`.
 */
export async function replayRawMacro(macroId: string): Promise<RawReplayResult> {
  const raw = getRawMacro(macroId);
  if (!raw) return { macroId, status: 'missing', played: 0 };
  if (raw.strokes.length === 0) {
    announce(`Recorded macro "${raw.name}" has no keystrokes.`);
    return { macroId, status: 'empty', played: 0 };
  }

  const target =
    typeof document === 'undefined' ? null : (document.activeElement ?? document.body);
  if (target === null) return { macroId, status: 'empty', played: 0 };

  let played = 0;
  for (const token of raw.strokes) {
    const stroke = parseStrokeToken(token);
    if (!stroke) continue;
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...strokeToEventInit(stroke),
    });
    target.dispatchEvent(event);
    played += 1;
  }
  announce(`Replayed "${raw.name}" (${played} keystroke${played === 1 ? '' : 's'}).`);
  return { macroId, status: 'replayed', played };
}

/** Confirm a pending replay request (R-3.8). */
export async function confirmReplay(): Promise<RawReplayResult | null> {
  const request = confirmRequest;
  if (request?.kind !== 'replay' || request.macroId === null) return null;
  confirmRequest = null;
  notifyMacroUi();
  return replayRawMacro(request.macroId);
}

// ── Picker helpers (MacroEditor) ─────────────────────────────────────────────

export interface MacroStepOption {
  readonly actionId: HotkeyActionId;
  readonly title: string;
  readonly tier: string;
  readonly binding: string | null;
}

/**
 * The actions available as macro steps: every valid non-macro action. Macro
 * actions are excluded so a macro can never nest or reference itself.
 */
export function listMacroStepActions(): readonly MacroStepOption[] {
  const keymap = getKeymap();
  return listHotkeyActions()
    .filter((action) => !action.invalid && !action.actionId.startsWith('fredo.macro.'))
    .map((action) => {
      const bound = keymap.bindings[action.actionId];
      const binding = bound !== undefined ? (bound[0] ?? null) : (action.defaultSequence ?? null);
      return { actionId: action.actionId, title: action.title, tier: action.tier, binding };
    });
}

/** The picker's client-side filter (label + id + binding). */
export function matchesStepQuery(entry: MacroStepOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return `${entry.title}\n${entry.actionId}\n${entry.binding ?? ''}`.toLowerCase().includes(needle);
}

// ── Test hygiene ─────────────────────────────────────────────────────────────

/** Test-only: drop every module-scoped macro state. Never call from app code. */
export function resetMacrosForTests(): void {
  confirmRequest = null;
  recordedStrokes = [];
  recordingMacroId = null;
  runningMacros.clear();
  removeCaptureListener();
  uiListeners.clear();
  notifyMacroUi();
}
