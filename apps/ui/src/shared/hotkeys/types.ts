/**
 * Spec #3009 — the shared hotkey type model.
 *
 * After #3009 the platform has exactly ONE keydown engine, ONE action registry
 * and ONE matcher. Bindings come from two sources only:
 *   - the KEPT platform globals (`primary+space`, `primary+tab`,
 *     `primary+shift+tab`), declared by the engine, and
 *   - mounted ELEMENTS carrying `data-hotkey`, discovered by `hotkeyElements.ts`.
 *
 * The retired configuration model (keymap, leader, macros, contexts, keyboard
 * mode, reserved combos, conflicts) is gone — this module no longer declares it.
 *
 * PURE: types + a handful of constant/id helpers only — no DOM/Tauri/React/clock
 * imports.
 *
 * The binding storage model is the TYPED-CHARACTER model: a chord step's `key`
 * is the layout-resolved `KeyboardEvent.key` — a typed character for printable
 * keys, a lowercase named token (`space`, `escape`, `f10`, …) for non-printable
 * keys. It is NEVER `KeyboardEvent.code`.
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
 * admits `fredo.launcher.toggle` and the element ids `fredo.element.<key>#<n>`.
 */
export type HotkeyActionId = string;

/** The action-id grammar. */
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
  readonly source: 'binding' | 'palette';
  readonly focusedFeatureId: string | null;
  readonly at: number;
}

/**
 * What a declared action is. `defaultSequence: null` = declared but unbound.
 * `run` may be async; the engine NEVER awaits it on the keydown path. `enabled()`
 * is an availability probe — a false result skips the action.
 */
export interface ApplicationHotkeyAction {
  readonly actionId: HotkeyActionId;
  readonly title: string;
  readonly description?: string;
  readonly defaultSequence: string | null;
  readonly run: (ctx: HotkeyInvocationContext) => void | Promise<void>;
  readonly enabled?: () => boolean;
}

/**
 * A registered action as listed by the registry. `invalid` carries a
 * registration-time diagnostic (e.g. a bad id/sequence).
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
 * The focus classification of `document.activeElement`.
 *
 * - `text-entry`  — INPUT / TEXTAREA / SELECT / contenteditable / role=textbox
 * - `terminal`    — inside `[data-fredo-terminal-root="true"]`
 * - `modal`       — inside `[role="dialog"][aria-modal="true"]`, or a global open modal
 * - `interactive` — a focusable control that may natively act on a bare key
 * - `default`     — everywhere else
 */
export type FocusContext = 'text-entry' | 'terminal' | 'modal' | 'interactive' | 'default';

/**
 * A pure dispatch decision.
 *
 * `consumed: true` ⇒ the engine calls `preventDefault()` + `stopPropagation()`.
 *  - `match`        — a binding fired (`action` is set)
 *  - `arm-sequence` — the stroke starts a multi-key sequence
 *  - `pending`      — a pending sequence accepted the stroke and is still incomplete
 *  - `suppress`     — no action, but the key is consumed (invalid sequence)
 *  - `passthrough`  — no action and the key is left native
 */
export interface DispatchDecision {
  readonly outcome: 'match' | 'arm-sequence' | 'pending' | 'suppress' | 'passthrough';
  readonly action?: RegisteredHotkeyAction;
  readonly consumed: boolean;
  readonly reason: string;
}

/** Why a pending sequence was reset. */
export type HotkeyResetReason =
  | 'invalid'
  | 'timeout'
  | 'escape'
  | 'focus-change'
  | 'native-consumes';

/** Typing this prefix in the launcher command bar switches results to actions. */
export const ACTION_PALETTE_PREFIX = '>';
