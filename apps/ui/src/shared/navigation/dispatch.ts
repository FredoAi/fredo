/**
 * Spec #3117 (P3) — the ONE dispatch funnel.
 *
 * Every channel (keyboard, pointer, launcher, voice, agent, system) reaches a verb through
 * `dispatch` (REQ-04.1); no channel calls a verb's `run`. The funnel enforces the §5.2 order —
 * actor-spoof pre-check, existence, availability, arguments, risk policy — and only then runs the
 * verb, applies exactly one effect and writes exactly one journal entry (or a typed refusal).
 *
 * It also owns the two engine verbs that have no `VerbDescriptor` (`journal.undo`,
 * `journal.redo`, `place.exit`) and the dispatch-time navigation facts (`exitedBy`).
 *
 * Synchronous by default; an async `run` makes the whole call return a `Promise` (Reading #12) —
 * callers `await`, which is identity for a plain value.
 *
 * PURE machinery: no clock (`now()` is injected), no timers, no DOM, no I/O.
 */

import {
  JOURNAL_REDO_VERB_ID,
  JOURNAL_UNDO_VERB_ID,
  NOTHING_TO_UNDO,
  NOT_UNDOABLE_REASON,
  PLACE_EXIT_VERB_ID,
  type Actor,
  type Channel,
  type ConfirmationRequest,
  type ContextSnapshot,
  type DispatchResult,
  type EffectKind,
  type ExitedBy,
  type Intent,
  type JsonPatch,
  type JournalEntry,
  type JournalQuery,
  type Surface,
  type VerbDescriptor,
  type VerbEffect,
} from './types';
import {
  NON_UNDOABLE_CONSEQUENCES,
  appendEntry,
  normalizeQuery,
  queryEntries,
  type JournalEntryDraft,
  type JournalStore,
} from './journal';

/** §5 — the injected dependencies of the funnel. */
export interface EngineDeps {
  readonly surface: Surface;
  readonly getContext: () => ContextSnapshot;
  readonly journal: JournalStore;
  /** ISO-8601 UTC, ms precision — injected so the engine never reads the clock. */
  readonly now: () => string;
  /** Apply a whole-document patch; throwing marks an undo failure. */
  readonly applyPatch: (patch: JsonPatch) => void;
  /**
   * §9 — the risk-policy decision. The intent is passed alongside the request so a host can
   * gate the dialog on the channel (launcher/voice/agent ask; keyboard/pointer stay shipped).
   * A promise is awaited: a false (sync or resolved) rejects with `canceled-confirmation`
   * BEFORE the verb runs. Sync callers keep working unchanged (additive second arg).
   */
  readonly confirm: (request: ConfirmationRequest, intent: Intent) => boolean | Promise<boolean>;
  /** Root-Escape only: true when the host has an overlay to close. */
  readonly overlayOpen?: () => boolean;
}

/** §3.1/§5.3 — a synchronous result, or a promise when `run` is async. */
export type DispatchOutcome = DispatchResult | Promise<DispatchResult>;

const MAX_TARGET_LABELS = 5;

function isCompanionChannel(channel: Channel): boolean {
  return channel === 'voice' || channel === 'agent';
}

function rejected(
  code:
    | 'unknown-verb'
    | 'unavailable'
    | 'invalid-args'
    | 'canceled-confirmation'
    | 'actor-spoof',
): DispatchResult {
  return { status: 'rejected', code };
}

function authoredConsequence(verbId: string): string | null {
  if (verbId in NON_UNDOABLE_CONSEQUENCES) {
    return NON_UNDOABLE_CONSEQUENCES[verbId as keyof typeof NON_UNDOABLE_CONSEQUENCES] ?? null;
  }
  return null;
}

/* ───────────────────────────── argument validation (§5.2 step 3) ───────────────────────────── */

function isValidArguments(
  verb: VerbDescriptor,
  args: Readonly<Record<string, string>>,
): boolean {
  const declared = new Map(verb.args.map((arg) => [arg.name, arg]));
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) return false; // undeclared key
  }
  for (const arg of verb.args) {
    const value = args[arg.name];
    if (value === undefined) {
      if (arg.required) return false; // missing required
      continue;
    }
    if (typeof value !== 'string') return false; // non-string (madcast at the boundary)
    if (value.trim().length === 0) return false; // blank / whitespace-only
    if (arg.validate !== undefined && !arg.validate(value)) return false; // failed guard
  }
  return true;
}

/* ───────────────────────────── risk policy (§9) ───────────────────────────── */

function externalPartyOf(
  verb: VerbDescriptor,
  context: ContextSnapshot,
  intent: Intent,
): string {
  // Spec #3120 (P6) — an authored party is the declaration's own word; the derivation below is
  // only the fallback for a verb that does not author one.
  const authored = verb.externalParty;
  if (authored !== undefined && authored.trim().length > 0) return authored;
  for (const arg of verb.args) {
    const value = intent.args[arg.name];
    if (value !== undefined && value.trim().length > 0) return value;
  }
  if (context.selection.label !== null && context.selection.label.trim().length > 0) {
    return context.selection.label;
  }
  if (context.selection.ids.length > 0) return context.selection.ids[0];
  return verb.title;
}

function buildConfirmation(
  verb: VerbDescriptor,
  context: ContextSnapshot,
  intent: Intent,
): ConfirmationRequest {
  const ids = context.selection.ids;
  const consequence = verb.consequence ?? authoredConsequence(verb.id);
  const undoAvailability: ConfirmationRequest['undoAvailability'] =
    verb.risk === 'external'
      ? { undoable: false, reason: NOT_UNDOABLE_REASON }
      : verb.undo !== undefined
        ? { undoable: true }
        : { undoable: false, reason: NOT_UNDOABLE_REASON };
  return {
    verbId: verb.id,
    title: verb.title,
    targetLabels: ids.slice(0, MAX_TARGET_LABELS),
    targetOverflow: Math.max(0, ids.length - MAX_TARGET_LABELS),
    consequence,
    undoAvailability,
    externalParty: verb.risk === 'external' ? externalPartyOf(verb, context, intent) : null,
  };
}

/* ───────────────────────────── journal helpers ───────────────────────────── */

function transientExitedBy(surface: Surface, placePath: readonly string[]): ExitedBy {
  const currentId = placePath.length > 0 ? placePath[placePath.length - 1] : surface.tree.root;
  const place = surface.tree.places.find((candidate) => candidate.id === currentId);
  return place !== undefined && place.transient ? 'verb' : 'none';
}

function commitAppend(
  deps: EngineDeps,
  draft: JournalEntryDraft,
): JournalEntry {
  const state = { entries: deps.journal.entries(), redo: deps.journal.redo() };
  const outcome = appendEntry(state, draft, deps.now());
  deps.journal.commit(outcome.state.entries, outcome.state.redo);
  return outcome.entry;
}

/* ───────────────────────────── effect application (§5.2 step 4) ───────────────────────────── */

function applyEffect(
  deps: EngineDeps,
  intent: Intent,
  verb: VerbDescriptor,
  context: ContextSnapshot,
  effect: VerbEffect,
): DispatchResult {
  const effectKind: EffectKind = effect.effect ?? 'mutation';
  const exitedBy = transientExitedBy(deps.surface, context.placePath);

  if (effectKind === 'navigation') {
    const entry = commitAppend(deps, {
      verbId: verb.id,
      actor: intent.actor,
      channel: intent.channel,
      label: effect.label,
      effect: 'navigation',
      placePath: context.placePath,
      target: effect.target,
      patch: null,
      inverse: null,
      external: false,
      consequence: null,
      exitedBy,
      coalesceKey: null,
    });
    return { status: 'performed', entry };
  }

  if (effect.patch === null) {
    // §5.3 — a mutation that changed nothing writes no entry and claims no effect.
    return { status: 'noop', code: 'did-nothing', message: null };
  }

  try {
    deps.applyPatch(effect.patch.after);
  } catch {
    // No partial claim, no journal entry.
    return { status: 'failed', code: 'failed-run' };
  }

  const external = effect.external ?? verb.risk === 'external';
  const entry = commitAppend(deps, {
    verbId: verb.id,
    actor: intent.actor,
    channel: intent.channel,
    label: effect.label,
    effect: 'mutation',
    placePath: context.placePath,
    target: effect.target,
    patch: effect.patch,
    inverse: effect.inverse,
    external,
    consequence: effect.consequence ?? verb.consequence ?? authoredConsequence(verb.id) ?? null,
    exitedBy,
    coalesceKey: effect.coalesceKey ?? null,
  });
  return { status: 'performed', entry };
}

/* ───────────────────────────── engine verbs (no descriptor) ───────────────────────────── */

function parseUndoQuery(args: Readonly<Record<string, string>>): JournalQuery {
  const query: {
    actor?: Actor;
    since?: string;
    count?: number;
    verbId?: string;
    channel?: Channel;
    effect?: EffectKind;
  } = {};
  const actor = args.actor;
  if (actor === 'human' || actor === 'companion' || actor === 'system') query.actor = actor;
  const channel = args.channel;
  if (
    channel === 'keyboard' ||
    channel === 'pointer' ||
    channel === 'launcher' ||
    channel === 'voice' ||
    channel === 'agent' ||
    channel === 'system'
  ) {
    query.channel = channel;
  }
  const effect = args.effect;
  if (effect === 'mutation' || effect === 'navigation') query.effect = effect;
  if (args.since !== undefined) query.since = args.since;
  if (args.verbId !== undefined) query.verbId = args.verbId;
  if (args.count !== undefined) {
    const parsed = Number(args.count);
    if (Number.isFinite(parsed)) query.count = parsed;
  }
  return query;
}

/** §6.2 — LIFO inverses, newest first; every applied inverse is journaled for the requester. */
function dispatchUndo(deps: EngineDeps, intent: Intent): DispatchResult {
  const query = parseUndoQuery(intent.args);
  const { count } = normalizeQuery(query);
  // Spec #3120 (P6) §3.10 — the reversal belongs to the requester. A companion-channel undo is
  // performed BY a human (the trail's `You`); a human/system requester keeps its own identity.
  const undoActor: Actor = intent.actor === 'companion' ? 'human' : intent.actor;
  const stateEntries = deps.journal.entries();
  // Search the widest window, drop non-invertible entries, then apply the newest `count`.
  const candidates = queryEntries(stateEntries, { ...query, count: 100 }).filter(
    (entry) => entry.inverse !== null,
  );
  const targets = candidates.slice(0, count);
  if (targets.length === 0) {
    return { status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO };
  }

  const context = deps.getContext();
  let entries: readonly JournalEntry[] = stateEntries;
  let redo: readonly number[] = deps.journal.redo();
  let applied = 0;
  let lastEntry: JournalEntry | null = null;

  for (const target of targets) {
    const inverse = target.inverse;
    if (inverse === null) continue;
    try {
      deps.applyPatch(inverse);
    } catch {
      deps.journal.commit(entries, redo);
      return { status: 'partial', code: 'undo-failed', applied, failedSeq: target.seq };
    }

    const beforeUndo: JsonPatch = target.patch !== null ? target.patch.after : inverse;
    const outcome = appendEntry(
      { entries, redo },
      {
        verbId: target.verbId,
        actor: undoActor,
        channel: intent.channel,
        label: `Undo ${target.label}`,
        effect: 'mutation',
        placePath: context.placePath,
        target: target.target,
        patch: { before: beforeUndo, after: inverse },
        inverse: beforeUndo,
        external: false,
        consequence: null,
        exitedBy: 'none',
        coalesceKey: null,
      },
      deps.now(),
    );
    entries = outcome.state.entries;
    // Redo is oldest-first; a newer undo is prepended, so the stack stays ascending.
    redo = [target.seq, ...redo.filter((seq) => seq !== target.seq)];
    lastEntry = outcome.entry;
    applied += 1;
  }

  deps.journal.commit(entries, redo);
  return lastEntry === null
    ? { status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO }
    : { status: 'performed', entry: lastEntry };
}

/** §6.2 — re-apply `patch.after` in ASC seq order, oldest first. */
function dispatchRedo(deps: EngineDeps): DispatchResult {
  const entries = deps.journal.entries();
  const redoSeqs = deps.journal.redo();
  if (redoSeqs.length === 0) {
    return { status: 'noop', code: 'no-matches', message: null };
  }

  const bySeq = new Map<number, JournalEntry>();
  for (const entry of entries) bySeq.set(entry.seq, entry);

  let lastEntry: JournalEntry | null = null;
  for (const seq of redoSeqs) {
    const entry = bySeq.get(seq);
    if (entry === undefined || entry.patch === null) continue;
    try {
      deps.applyPatch(entry.patch.after);
    } catch {
      return { status: 'failed', code: 'failed-run' };
    }
    lastEntry = entry;
  }

  deps.journal.commit(entries, []);
  return lastEntry === null
    ? { status: 'noop', code: 'no-matches', message: null }
    : { status: 'performed', entry: lastEntry };
}

/** §2.2 — Escape: one level in a child, nothing at the root (host closes the overlay). */
function dispatchPlaceExit(deps: EngineDeps, intent: Intent): DispatchResult {
  const context = deps.getContext();
  if (context.placePath.length <= 1) {
    // No cursor mutation belongs to this layer: report so the host closes the innermost overlay.
    deps.overlayOpen?.();
    return { status: 'noop', code: 'did-nothing', message: null };
  }

  const entry = commitAppend(deps, {
    verbId: PLACE_EXIT_VERB_ID,
    actor: intent.actor,
    channel: intent.channel,
    label: 'Exit place',
    effect: 'navigation',
    placePath: context.placePath,
    target: [],
    patch: null,
    inverse: null,
    external: false,
    consequence: null,
    exitedBy: 'escape',
    coalesceKey: null,
  });
  return { status: 'performed', entry };
}

/* ───────────────────────────── the funnel ───────────────────────────── */

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  if (value === null || typeof value !== 'object') return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

/** All four validation steps passed — run the verb and apply its one effect (§5.2 step 4 tail). */
function runValidatedVerb(
  deps: EngineDeps,
  intent: Intent,
  verb: VerbDescriptor,
  context: ContextSnapshot,
): DispatchOutcome {
  let result: VerbEffect | Promise<VerbEffect>;
  try {
    result = verb.run(intent, context);
  } catch {
    return { status: 'failed', code: 'failed-run' };
  }

  if (isPromiseLike(result)) {
    return Promise.resolve(result).then(
      (effect) => applyEffect(deps, intent, verb, context, effect),
      (): DispatchResult => ({ status: 'failed', code: 'failed-run' }),
    );
  }
  return applyEffect(deps, intent, verb, context, result);
}

/**
 * §5.2 — validate in order and stop at the first failure. Existence and availability are checked
 * before arguments, so an unavailable verb with bad args reports `unavailable`.
 */
export function dispatch(deps: EngineDeps, intent: Intent): DispatchOutcome {
  // §9.2 — the host asserts identity; a companion channel with a non-companion actor is spoofing.
  if (isCompanionChannel(intent.channel) && intent.actor !== 'companion') {
    return rejected('actor-spoof');
  }

  // Engine-owned ids have no `VerbDescriptor` (§6.2, §2.2).
  if (intent.verbId === PLACE_EXIT_VERB_ID) return dispatchPlaceExit(deps, intent);
  if (intent.verbId === JOURNAL_UNDO_VERB_ID) return dispatchUndo(deps, intent);
  if (intent.verbId === JOURNAL_REDO_VERB_ID) return dispatchRedo(deps);

  // Step 1 — existence.
  const verb = deps.surface.verbs.find((candidate) => candidate.id === intent.verbId);
  if (verb === undefined) return rejected('unknown-verb');

  const context = deps.getContext();

  // Step 2 — availability.
  if (!verb.available(context)) return rejected('unavailable');

  // Step 3 — arguments.
  if (!isValidArguments(verb, intent.args)) return rejected('invalid-args');

  // Step 4 — risk policy. A promise decision defers the run until it resolves; a falsy sync
  // decision rejects BEFORE the verb runs. The order above is unchanged.
  if (verb.risk === 'destructive' || verb.risk === 'external') {
    const decision = deps.confirm(buildConfirmation(verb, context, intent), intent);
    if (isPromiseLike(decision)) {
      return Promise.resolve(decision).then((accepted) =>
        accepted ? runValidatedVerb(deps, intent, verb, context) : rejected('canceled-confirmation'),
      );
    }
    if (!decision) return rejected('canceled-confirmation');
  }

  // All four steps passed — run the verb.
  return runValidatedVerb(deps, intent, verb, context);
}

/** §4.1 — bind the funnel to one dependency set. */
export function createDispatcher(deps: EngineDeps): (intent: Intent) => DispatchOutcome {
  return (intent) => dispatch(deps, intent);
}
