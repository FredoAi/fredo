/**
 * Spec #3117 (P3) — the NavigationEngine leaf vocabulary.
 *
 * This module is the ONLY leaf of `shared/navigation/`: it imports nothing. Every noun,
 * constant and result variant the engine speaks lives here, so the other ten modules
 * consume ONE vocabulary instead of re-declaring it (ADR-6, G-255).
 *
 * `docs/NAVIGATION_ENGINE.md` §1–§10 is the normative contract. The names below are the
 * binding names block of the #3117 plan — renaming any of them is a breaking change.
 *
 * PURE by design: constants + types only. No imports, no clock, no globals, no I/O.
 */

/* ───────────────────────────── constants ───────────────────────────── */

/** §4.1 — the pending-prefix timeout. Time is an ARGUMENT (`nowMs`), never `Date.now()`. */
export const PENDING_TIMEOUT_MS = 250;

/** §6.3 — coalescing window for two adjacent entries sharing a `coalesceKey`. */
export const COALESCE_TS_GAP_MS = 400;

/** §7 — the context envelope version. */
export const CONTEXT_VERSION = 1;

/** §8.1 — the reserved companion action id appended after every command id. */
export const LIST_ACTIONS_ID = 'listActions';

/** §6.4 — the single empty-undo copy, emitted exactly once. */
export const NOTHING_TO_UNDO = 'Nothing to undo.';

/** §5/§6 — the MACHINE reason token for a non-undoable affordance (never rendered as prose). */
export const NOT_UNDOABLE_REASON = 'not-undoable';

/** §6.2 — engine-owned journal verb ids. */
export const JOURNAL_UNDO_VERB_ID = 'journal.undo';
export const JOURNAL_REDO_VERB_ID = 'journal.redo';

/** §2.2 — the engine-owned Escape verb id. */
export const PLACE_EXIT_VERB_ID = 'place.exit';

/**
 * §4.4 — engine-reserved strokes, bindable but never a bare `[a-z0-9]` token.
 *
 * P5 extends the grammar with the four arrow keys and the two zoom characters so a
 * place-scoped surface can express `← ↑ ↓ →` (selection/align) and `+`/`-` (zoom). The
 * tokens are matched case-insensitively by `registry.normalizeToken` / `resolver.normalizeToken`;
 * `+`/`-` are single characters and already pass the bare pattern, but they are listed here so
 * the reserved set is the ONE published source of bindable non-alphanumeric strokes.
 */
export const ENGINE_RESERVED_STROKES = [
  'Escape',
  'Enter',
  'Tab',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  '+',
  '-',
] as const;

/** §9.2 — the channels a companion may originate. */
export const COMPANION_CHANNELS = ['voice', 'agent'] as const;

/** Engine-owned verb ids that have no `VerbDescriptor` (recognised, never declared). */
export const ENGINE_VERB_IDS = [
  JOURNAL_UNDO_VERB_ID,
  JOURNAL_REDO_VERB_ID,
  PLACE_EXIT_VERB_ID,
] as const;

/**
 * §4.4 — one bindable bare token: exactly one lowercase letter or digit.
 *
 * Deliberately NOT global (`g`) — a stateful `lastIndex` would make repeated `.test()`
 * calls depend on call history and break determinism (REQ-01.5).
 */
export const BINDABLE_STROKE_PATTERN: RegExp = /^[a-z0-9]$/;

/** §7.1 — the frozen envelope caps. */
export const CAPABILITY_LIMITS: CapabilityLimits = Object.freeze({
  maxVerbs: 64,
  maxJournalEntries: 10,
  maxSelectionIds: 32,
  maxLabelChars: 120,
  maxPathDepth: 8,
  maxContextBytes: 16384,
});

/* ───────────────────────────── nouns ───────────────────────────── */

/** §3.1 — the four risk classes. */
export type Risk = 'safe' | 'mutating' | 'destructive' | 'external';

/** §5.1 — the six channels, all of which funnel through `dispatch`. */
export type Channel = 'keyboard' | 'pointer' | 'launcher' | 'voice' | 'agent' | 'system';

/** §9.2 — host-asserted actor identity. */
export type Actor = 'human' | 'companion' | 'system';

/** §6.1 — the journal effect kind. */
export type EffectKind = 'mutation' | 'navigation';

/** §6.1 — why a transient place stopped being current. */
export type ExitedBy = 'verb' | 'escape' | 'none';

/** §4.1 — who owns the keyboard right now. */
export type KeyboardOwner = 'engine' | 'text-entry' | 'terminal' | 'modal';

/** A JSON-serialisable value (the envelope and checkpoint patch payloads). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A whole-document checkpoint patch: applying it REPLACES the document state. */
export type JsonPatch = Readonly<Record<string, JsonValue>>;

/** §10.1 — the twelve validation rules. */
export type SurfaceRule =
  | 'V-01'
  | 'V-02'
  | 'V-03'
  | 'V-04'
  | 'V-05'
  | 'V-06'
  | 'V-07'
  | 'V-08'
  | 'V-09'
  | 'V-10'
  | 'V-11'
  | 'V-12';

/** §10.1 — the stable diagnostic codes, one per rule. */
export type SurfaceDiagnosticCode =
  | 'NAV-E001'
  | 'NAV-E002'
  | 'NAV-E003'
  | 'NAV-E004'
  | 'NAV-E005'
  | 'NAV-E006'
  | 'NAV-E007'
  | 'NAV-E008'
  | 'NAV-E009'
  | 'NAV-E010'
  | 'NAV-E011'
  | 'NAV-E012';

/** §5.3 — the named rejection/failure codes. */
export type DispatchCode =
  | 'did-nothing'
  | 'unknown-verb'
  | 'unavailable'
  | 'invalid-args'
  | 'canceled-confirmation'
  | 'failed-run'
  | 'undo-failed'
  | 'ambiguous-key'
  | 'actor-spoof'
  | 'no-matches';

/** §2.1 — a place key either names a verb or enters a child place. */
export type KeyBinding =
  | { readonly kind: 'verb'; readonly verbId: string }
  | { readonly kind: 'place'; readonly placeId: string };

/** §2.1 — one place in the tree. */
export interface PlaceNode {
  readonly id: string;
  readonly label: string;
  readonly parent: string | null;
  readonly transient: boolean;
  readonly sticky: boolean;
  readonly cursor: string | null;
  readonly operator: string | null;
  readonly keys: Readonly<Record<string, KeyBinding>>;
  readonly entryHooks: readonly string[];
  readonly exitHooks: readonly string[];
}

/** §2.1 — the whole declaration tree. */
export interface PlaceTree {
  readonly appId: string;
  readonly root: string;
  readonly places: readonly PlaceNode[];
  readonly directAliases: Readonly<Record<string, string>>;
}

/** §3.1 — one declared verb argument. */
export interface VerbArg {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'enum';
  readonly required: boolean;
  readonly validate?: (value: string) => boolean;
  /**
   * Spec #3120 (P6), ST-1 — the free-text opt-out of the blank rule.
   *
   * A declared `''`-capable argument (a label that may be cleared) sets this so the
   * dispatch argument validator accepts an empty/whitespace-only value. Absent ⇒ the
   * strict blank rule is unchanged: a non-free-text argument still rejects `''`.
   * Propagation to the manifest follows the absent-key rule (only `true` is emitted).
   */
  readonly allowEmpty?: boolean;
}

/** §1.1 — one object a verb applies to. */
export interface ObjectRef {
  readonly type: string;
  readonly id: string;
  readonly label: string;
}

/** §7 — the selection summary the engine reads. */
export interface SelectionSnapshot {
  readonly count: number;
  readonly kinds: readonly string[];
  readonly label: string | null;
  readonly ids: readonly string[];
}

/** §7 — the injected read model. */
export interface ContextSnapshot {
  readonly appId: string;
  readonly placePath: readonly string[];
  readonly selection: SelectionSnapshot;
  readonly dirty: boolean;
}

/** §6.1 — one append-only journal entry. */
export interface JournalEntry {
  readonly seq: number;
  readonly ts: string;
  readonly verbId: string;
  readonly actor: Actor;
  readonly channel: Channel;
  readonly label: string;
  readonly effect: EffectKind;
  readonly placePath: readonly string[];
  readonly target: readonly ObjectRef[];
  readonly patch: { readonly before: JsonPatch; readonly after: JsonPatch } | null;
  readonly inverse: JsonPatch | null;
  readonly undoable: boolean;
  readonly external: boolean;
  readonly consequence: string | null;
  readonly exitedBy: ExitedBy;
  readonly coalesceKey: string | null;
  readonly groupId: string | null;
}

/** §3.1 — what a verb's `run` reports. */
export interface VerbEffect {
  readonly effect?: EffectKind;
  readonly label: string;
  readonly patch: { readonly before: JsonPatch; readonly after: JsonPatch } | null;
  readonly inverse: JsonPatch | null;
  readonly target: readonly ObjectRef[];
  readonly external?: boolean;
  readonly consequence?: string | null;
  readonly coalesceKey?: string | null;
}

/** §3.1 — the single unit of capability. */
export interface VerbDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly appliesTo: {
    readonly objects: readonly string[];
    readonly places: readonly string[];
  };
  readonly args: readonly VerbArg[];
  readonly available: (ctx: ContextSnapshot) => boolean;
  readonly risk: Risk;
  readonly aliases: readonly string[];
  readonly run: (intent: Intent, ctx: ContextSnapshot) => VerbEffect | Promise<VerbEffect>;
  readonly undo?: (entry: JournalEntry) => VerbEffect | Promise<VerbEffect>;
  readonly consequence?: string;
  /**
   * Spec #3120 (P6) — the authored external party for a `risk: 'external'` verb (e.g.
   * `your file system`). The funnel prefers it over the derived value so the declaration,
   * not a heuristic, names where the action reaches outside Fredo (§9.1).
   */
  readonly externalParty?: string;
  readonly publish: boolean;
}

/** §2–§3 — one application's complete declaration. */
export interface Surface {
  readonly tree: PlaceTree;
  readonly verbs: readonly VerbDescriptor[];
  readonly companion: { readonly appName: string; readonly description: string } | null;
}

/** §5.1 — the one wire shape every channel produces. */
export interface Intent {
  readonly verbId: string;
  readonly args: Readonly<Record<string, string>>;
  readonly channel: Channel;
  readonly actor: Actor;
  readonly actorRef?: string;
}

/** §6.4 — the undo/redo query shape. */
export interface JournalQuery {
  readonly actor?: Actor;
  readonly since?: string;
  readonly count?: number;
  readonly verbId?: string;
  readonly channel?: Channel;
  readonly effect?: EffectKind;
}

/* ───────────────────────── §7 envelope v1 ───────────────────────── */

/** §7.1 — one breadcrumb record. */
export interface PlaceRef {
  id: string;
  label: string;
  transient: boolean;
  sticky: boolean;
}

/** §7.1 — one verb summary row. */
export interface VerbSummary {
  id: string;
  title: string;
  risk: Risk;
  keys: string[];
  available: boolean;
  unavailableReason: string | null;
}

/** §7.1 — one journal summary row. */
export interface JournalSummary {
  seq: number;
  ts: string;
  verbId: string;
  actor: Actor;
  label: string;
  undoable: boolean;
}

/** §7.1 — the frozen capability caps. */
export interface CapabilityLimits {
  maxVerbs: 64;
  maxJournalEntries: 10;
  maxSelectionIds: 32;
  maxLabelChars: 120;
  maxPathDepth: 8;
  maxContextBytes: 16384;
}

/** §7.1 — the only read model the UI consumes. */
export interface ContextEnvelope {
  version: 1;
  appId: string;
  placePath: PlaceRef[];
  selection: { count: number; kinds: string[]; label: string | null; ids: string[] };
  verbs: VerbSummary[];
  journal: { last: JournalSummary[]; undoableCount: number };
  dirty: boolean;
  limits: CapabilityLimits;
}

/* ───────────────────── §8 which-key hint model ───────────────────── */

/**
 * §8.1 — one which-key row.
 *
 * Declared here (the leaf) rather than in `discover.ts` because `KeyResolution`'s hint
 * variant carries it and `keyResolver.ts` may import only `./types`, `./registry` and
 * `./resolver` (the plan's acyclic import graph). `discover.ts` re-exports these names.
 */
export interface HintRow {
  key: string;
  label: string;
  verbId: string;
}

/** §8.1 — the which-key / next-step hint model. */
export interface HintModel {
  readonly kind: 'prefix' | 'next';
  readonly rows: readonly HintRow[];
  readonly readyAfterMs: number;
}

/* ───────────────────── §5.3 result taxonomy ───────────────────── */

/** §5.3 — the single typed outcome of one dispatch. */
export type DispatchResult =
  | { readonly status: 'performed'; readonly entry: JournalEntry }
  | {
      readonly status: 'noop';
      readonly code: 'did-nothing' | 'no-matches';
      readonly message: string | null;
    }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'unknown-verb'
        | 'unavailable'
        | 'invalid-args'
        | 'canceled-confirmation'
        | 'ambiguous-key'
        | 'actor-spoof';
    }
  | { readonly status: 'failed'; readonly code: 'failed-run' }
  | {
      readonly status: 'partial';
      readonly code: 'undo-failed';
      readonly applied: number;
      readonly failedSeq: number;
    };

/* ───────────────────── §9.1 confirmation payload ───────────────────── */

/** §9.1 — the complete input to the host's confirmation dialog. */
export interface ConfirmationRequest {
  readonly verbId: string;
  readonly title: string;
  readonly targetLabels: readonly string[];
  readonly targetOverflow: number;
  readonly consequence: string | null;
  readonly undoAvailability:
    | { readonly undoable: true }
    | { readonly undoable: false; readonly reason: typeof NOT_UNDOABLE_REASON };
  readonly externalParty: string | null;
}

/* ───────────── Spec #3122 (P8), ST-1 — relocated keyboard vocabulary ───────────── */

/**
 * A platform the primary-modifier decision is made for (relocated verbatim from the
 * retired hotkey types; the navigation layer now owns the ONE key model).
 */
export type Platform = 'win32' | 'linux' | 'darwin';

/**
 * One chord step. `key` is the TYPED CHARACTER (`KeyboardEvent.key`), never `code`:
 * a single character is stored verbatim (case-sensitive, Shift folded in); a named key
 * becomes its lowercase token (`space`, `tab`, `escape`, `f10`, …).
 *
 * `primary` is the platform-neutral primary modifier (Ctrl on win32/linux, Meta on darwin);
 * `ctrl`/`meta` are the EXPLICIT platform-specific modifiers and are never set while that
 * modifier is acting as the primary one.
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

/**
 * The focus classification of `document.activeElement` (the ONE focus vocabulary):
 * - `text-entry`  — INPUT / TEXTAREA / SELECT / contenteditable / role=textbox
 * - `terminal`    — inside `[data-fredo-terminal-root="true"]`
 * - `modal`       — inside `[role="dialog"][aria-modal="true"]`, or a global open modal
 * - `interactive` — a focusable control that may natively act on a bare key
 * - `default`     — everywhere else
 */
export type FocusContext = 'text-entry' | 'terminal' | 'modal' | 'interactive' | 'default';
