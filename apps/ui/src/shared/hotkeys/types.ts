/**
 * Spec #2946 ST-1 — the SINGLE declaration site for the keyboard-first hotkey
 * model (plan contract blocks 2/3/4/5/6/9/10/11).
 *
 * Every later capsule (registry, store, engine, settings, macros) consumes the
 * types below; no capsule re-derives a key rule. This module is PURE: types +
 * a handful of constant/id helpers only — no DOM/Tauri/React/clock imports
 * (mirrors the `launcherSpaceHold.ts` purity contract).
 *
 * The binding storage model is the TYPED-CHARACTER model (PO#6): a chord step's
 * `key` is the layout-resolved `KeyboardEvent.key` — a typed character for
 * printable keys, a lowercase named token (`space`, `escape`, `f10`, …) for
 * non-printable keys. It is NEVER `KeyboardEvent.code` (no physical-key token).
 *
 * The ONE serialization/matching implementation lives in `keys.ts`; the ONE
 * reserved-combo list in `reserved.ts`; the ONE focus classifier in
 * `focusContext.ts`; the ONE sequence matcher in `sequence.ts`; the ONE
 * conflict classifier in `conflicts.ts`; the shipped tables in `defaults.ts`.
 */

/** A platform we make primary-modifier decisions for. */
export type Platform = 'win32' | 'linux' | 'darwin';

/**
 * One chord step.
 *
 * `key` is the TYPED CHARACTER (`KeyboardEvent.key`), never `code`:
 *  - a single character (`'g'`, `'?'`, `'~'`, `','`), stored VERBATIM and
 *    case-sensitive (`g` ≠ `G`); Shift is folded into the character, so a
 *    single-character stroke always carries `shift: false`;
 *  - a named key (`'space'`, `'escape'`, `'enter'`, `'tab'`, `'backspace'`,
 *    `'delete'`, `'insert'`, `'home'`, `'end'`, `'pageup'`, `'pagedown'`,
 *    `'arrowup'`, `'arrowdown'`, `'arrowleft'`, `'arrowright'`, `'f1'..'f24'`).
 *
 * `primary` is the platform-neutral primary modifier (Ctrl on win32/linux,
 * Meta on darwin). `ctrl`/`meta` are the EXPLICIT platform-specific modifiers
 * and are NOT set while that modifier is acting as the primary one.
 */
export interface KeyStroke {
  readonly key: string;
  readonly primary: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/** Ordered chord steps; a real binding has length >= 1. */
export type KeySequence = readonly KeyStroke[];

/** The two binding tiers. Fredo (platform) always sorts before a feature. */
export type HotkeyTier = 'fredo' | 'feature';

/**
 * `fredo.` for the platform tier; `<featureId>.` for a feature tier. Dot-separated
 * segments: the first segment is lowercase kebab (`fredo` or a feature id); every
 * following segment starts with a lowercase letter and may be camelCase. This
 * admits the shipped multi-segment ids the plan itself declares, e.g.
 * `fredo.launcher.toggle`, `fredo.window.cycleNth`, `fredo.terminal.exitPassthrough`.
 */
export type HotkeyActionId = string;

/**
 * The action-id grammar (contract block 3, corrected per the ST-2 adjudication).
 *
 * The literal contract regex admitted exactly ONE dot and would reject the plan's
 * own multi-segment camelCase ids; the corrected grammar allows one or more
 * dot-separated segments after the leading namespace.
 */
export const HOTKEY_ACTION_ID_PATTERN =
  /^(fredo|[a-z0-9][a-z0-9-]*)\.[a-z][a-zA-Z0-9-]*(\.[a-z][a-zA-Z0-9-]*)*$/;

/** True when `id` is a well-formed hotkey action id. */
export function isValidHotkeyActionId(id: string): boolean {
  return typeof id === 'string' && HOTKEY_ACTION_ID_PATTERN.test(id);
}

/** The tier an action id belongs to. `fredo.` is the only platform namespace. */
export function tierForActionId(id: HotkeyActionId): HotkeyTier {
  return id.startsWith('fredo.') ? 'fredo' : 'feature';
}

/** The ambient context in which an action was invoked. */
export interface HotkeyInvocationContext {
  readonly actionId: HotkeyActionId;
  readonly tier: HotkeyTier;
  readonly sequence: KeySequence;
  readonly source: 'binding' | 'macro' | 'palette' | 'cheatsheet';
  readonly focusedFeatureId: string | null;
  readonly at: number;
}

/**
 * What a feature declares (contract block 3). `defaultSequence: null` = declared
 * but unbound. `run` may be async; the engine NEVER awaits it on the keydown
 * path. `enabled()` is an availability probe — a false result skips the action
 * AND shows it as unavailable-with-reason.
 */
export interface FeatureHotkeyAction {
  readonly actionId: HotkeyActionId;
  readonly title: string;
  readonly description?: string;
  readonly defaultSequence: string | null;
  readonly run: (ctx: HotkeyInvocationContext) => void | Promise<void>;
  readonly enabled?: () => boolean;
}

/**
 * The empty contribution a feature with no hotkeys inherits (ST-2). A frozen
 * singleton so every feature instance points at the SAME object — no per-instance
 * allocation and no accidental mutation of the default declaration.
 */
export const EMPTY_HOTKEYS: readonly FeatureHotkeyAction[] = Object.freeze([]);

/**
 * A registered action as listed by the registry (ST-2 fills this). `invalid`
 * carries a registration-time diagnostic (e.g. a bad id/sequence) so Settings
 * can show an unavailable-with-reason row.
 */
export interface RegisteredHotkeyAction {
  readonly actionId: HotkeyActionId;
  readonly tier: HotkeyTier;
  readonly featureId?: string;
  readonly title: string;
  readonly description?: string;
  readonly defaultSequence: string | null;
  readonly run: (ctx: HotkeyInvocationContext) => void | Promise<void>;
  readonly enabled?: () => boolean;
  readonly invalid?: string;
}

/** A binding resolved against the registry — the matcher's input unit. */
export interface ResolvedBinding {
  readonly actionId: HotkeyActionId;
  readonly tier: HotkeyTier;
  readonly sequence: KeySequence;
  readonly serialized: string;
  readonly action: RegisteredHotkeyAction;
}

/**
 * The focus classification of `document.activeElement` (contract block 4).
 *
 * - `text-entry`  — INPUT / TEXTAREA / SELECT / contenteditable / role=textbox
 * - `terminal`    — inside `[data-fredo-terminal-root="true"]`
 * - `modal`       — inside `[role="dialog"][aria-modal="true"]`, or a global open modal
 * - `interactive` — a focusable control that may natively act on a bare key
 * - `default`     — everywhere else
 */
export type FocusContext = 'text-entry' | 'terminal' | 'modal' | 'interactive' | 'default';

/**
 * A pure dispatch decision (contract block 4).
 *
 * `consumed: true` ⇒ the engine calls `preventDefault()` + `stopPropagation()`.
 *  - `match`        — a binding fired (`action` is set)
 *  - `arm-sequence` — the stroke starts a multi-key sequence
 *  - `pending`      — a pending sequence accepted the stroke and is still incomplete
 *  - `suppress`     — no action, but the key is consumed (invalid sequence, macro gate)
 *  - `passthrough`  — no action and the key is left native
 */
export interface DispatchDecision {
  readonly outcome: 'match' | 'arm-sequence' | 'pending' | 'suppress' | 'passthrough';
  readonly action?: RegisteredHotkeyAction;
  readonly consumed: boolean;
  readonly reason: string;
}

/** Why a pending sequence was reset (matches the `HotkeyEvent` reset reasons). */
export type HotkeyResetReason =
  | 'invalid'
  | 'timeout'
  | 'escape'
  | 'focus-change'
  | 'native-consumes';

/** One candidate for the which-key pending overlay (contract block 6). */
export interface HotkeyCandidate {
  readonly strokeToken: string;
  readonly display: string;
  readonly actionId: HotkeyActionId;
  readonly title: string;
  readonly tier: HotkeyTier;
}

/** In-process keymap events (contract block 6) — NOT Tauri IPC. */
export type HotkeyEvent =
  | { type: 'keymap:changed'; revision: number }
  | { type: 'sequence:pending'; prefix: string; candidates: readonly HotkeyCandidate[] }
  | { type: 'sequence:reset'; reason: HotkeyResetReason }
  | { type: 'macro:recording'; recording: boolean; macroId: string | null; startedAt: number | null }
  | { type: 'passthrough:changed'; active: boolean };

/** The one settingsService key that owns the keymap document. */
export const KEYMAP_STORAGE_KEY = 'fredo.hotkeys.keymap';
/** The cross-webview latch that enforces exactly one raw recording at a time. */
export const RECORDING_LATCH_KEY = 'fredo.hotkeys.recording';
/** The current keymap document schema version (the migration field). */
export const CURRENT_SCHEMA_VERSION = 1;
/** Typing this prefix in the launcher command bar switches results to actions. */
export const ACTION_PALETTE_PREFIX = '>';
/** The action id whose invocation toggles raw macro recording. */
export const MACRO_RECORD_TOGGLE_ACTION_ID: HotkeyActionId = 'fredo.macro.recordToggle';
/** The single terminal exit-passthrough action id (R-5.7). */
export const TERMINAL_EXIT_ACTION_ID: HotkeyActionId = 'fredo.terminal.exitPassthrough';

/** A named action macro (contract block 5). */
export interface PersistedMacro {
  id: string;
  name: string;
  steps: HotkeyActionId[];
  trigger: string | null;
  onStepError: 'abort' | 'continue';
}

/** A recorded raw keystroke macro (contract block 5). `strokes` are serialized single strokes. */
export interface PersistedRawMacro {
  id: string;
  name: string;
  strokes: string[];
  trigger: string | null;
}

/**
 * The persisted keymap document (contract block 5). `bindings` maps an action id
 * to its ordered serialized sequences (`[]` = unbound).
 */
export interface PersistedKeymap {
  schemaVersion: number;
  leader: string | null;
  vimPresetEnabled: boolean;
  sequenceTimeoutMs: number;
  bindings: Record<HotkeyActionId, string[]>;
  macros: PersistedMacro[];
  rawMacros: PersistedRawMacro[];
}

/** One fixed platform-reserved combination (contract block 9). */
export interface ReservedCombo {
  readonly serialized: string;
  readonly reason: string;
}

/** The conflict classification of a candidate binding (contract block 11). */
export type ConflictKind = 'none' | 'same-tier' | 'cross-tier' | 'reserved' | 'invalid';

/** One other binding that collides with a candidate. */
export interface ConflictCollision {
  readonly actionId: HotkeyActionId;
  readonly tier: HotkeyTier;
  readonly sequence: string;
}

/**
 * `same-tier` blocks a save; `cross-tier` is labelled, never blocking;
 * `reserved`/`invalid` always carry a `reason`.
 */
export interface ConflictReport {
  readonly kind: ConflictKind;
  readonly colliding: ReadonlyArray<ConflictCollision>;
  readonly reason?: string;
}
