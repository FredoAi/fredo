/**
 * Spec #3118 (P4), ST-5 — the navigation host: the ONE stateful seam the P4 surfaces read.
 *
 * The host owns the presentation state the components cannot derive (the pending prefix, the
 * map's open/filter, the last announcement) and the epoch-driven snapshot (NFR memoisation):
 * the snapshot object is rebuilt ONLY on a mutation, `epoch` advances exactly once per host
 * mutation OR context change, and `getSnapshot()` returns the SAME reference between those —
 * React's `useSyncExternalStore` contract. No polling, no interval; the only timer in the whole
 * P4 layer is the one-shot `PENDING_TIMEOUT_MS` the caller supplies as `nowMs`.
 *
 * Every state change funnels through the shipped P3 `dispatch` (R-2.3): `handleStroke` only
 * resolves a stroke, `runVerb` only wraps an intent, and both announce THROUGH the bound
 * composers (`announce.tsx`) at most once per call.
 *
 * `undoEntry(seq)` is implemented HERE, from the exported journal primitives, because the undo
 * funnel's `JournalQuery` (`types.ts:274-281`) has no `seq` field — adding one would edit two
 * P3 modules that are byte-identical in this slice. It mirrors `dispatchUndo`
 * (`dispatch.ts:270-330`) for exactly one selected entry (Architect §5 / QA GAP 10).
 */

import { useSyncExternalStore } from 'react';

import {
  JOURNAL_UNDO_VERB_ID,
  NOTHING_TO_UNDO,
  PLACE_EXIT_VERB_ID,
  appendEntry,
  buildContextEnvelope,
  createJournalStore,
  createRegistry,
  deriveHint,
  deriveRail,
  dispatch,
  resolveStroke,
  type Actor,
  type Channel,
  type ConfirmationRequest,
  type ContextEnvelope,
  type ContextSnapshot,
  type DispatchResult,
  type EngineDeps,
  type HintModel,
  type Intent,
  type JournalEntry,
  type JournalStore,
  type JsonPatch,
  type KeyboardOwner,
  type PendingPrefix,
  type RailModel,
  type Surface,
} from '../';
import { normalizeStroke } from '../resolver';
import { isTextControl } from '../../hotkeys/focusContext';
import {
  announceNavigation,
  configureNavigationAnnouncer,
  navAmbiguousKeyMessage,
  navPlaceEnterMessage,
  navPlaceExitMessage,
  navPrefixMessage,
  navUndoFailedMessage,
  navUndoMessage,
  navUndoNothingMessage,
  navUnavailableKeyMessage,
  resetNavigationAnnouncer,
  type AnnouncementChannel,
} from './announce';
import { buildCommandRailModel } from './models';

/* ───────────────────────────── contract ───────────────────────────── */

/** §5 — the injected dependencies of one navigation host. */
export interface NavigationHostOptions {
  readonly surface: Surface;
  readonly getContext: () => ContextSnapshot;
  readonly journal?: JournalStore;
  /** ISO-8601 UTC — injected so the host never reads the clock itself. */
  readonly now?: () => string;
  /** Apply a whole-document patch; throwing marks an undo failure. */
  readonly applyPatch?: (patch: JsonPatch) => void;
  /**
   * §9 — the risk-policy decision. The intent rides alongside the request so the provider can
   * gate the dialog on the channel; a promise is awaited by the funnel. Keyboard/pointer hosts
   * keep the shipped no-confirm behaviour by leaving this undefined.
   */
  readonly confirm?: (
    request: ConfirmationRequest,
    intent: Intent,
  ) => boolean | Promise<boolean>;
  readonly announcementChannel?: AnnouncementChannel;
  readonly overlayOpen?: () => boolean;
}

/** §5 — the ONE snapshot the components read. Stable between mutations. */
export interface NavigationHostSnapshot {
  readonly epoch: number;
  readonly surface: Surface;
  readonly context: ContextSnapshot;
  readonly envelope: ContextEnvelope;
  readonly rail: RailModel;
  readonly hint: HintModel;
  readonly entries: readonly JournalEntry[];
  readonly pending: PendingPrefix | null;
  readonly mapOpen: boolean;
  readonly mapFilterPlaceId: string | null;
  readonly undoableCount: number;
  readonly announcement: string;
}

/**
 * Spec #3121 (P7), ST-1 — the ADDITIVE stroke options (Architect §B.1).
 *
 * `keyboardOwner` is the §4.1 keyboard-ownership fact. It DEFAULTS to `'engine'`, so every
 * pre-existing caller keeps byte-identical behaviour; a surface whose keys belong to another
 * keyboard owner (the terminal PTY) passes `'terminal'` and the shipped `resolveStroke`
 * returns `passthrough` without consulting a binding, an alias or a prefix.
 */
export interface StrokeOptions {
  readonly target?: Element | null;
  /** §4.1 — the keyboard owner; DEFAULT `'engine'` (byte-identical behaviour). */
  readonly keyboardOwner?: KeyboardOwner;
}

export interface NavigationHost {
  readonly getSnapshot: () => NavigationHostSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Spec #3120 (P6) — a FRESH envelope built from the CURRENT context + journal. The launcher
   * reads this synchronously on open (NFR-1); it is never cached on the snapshot.
   */
  readonly describeContext: () => ContextEnvelope;
  /**
   * Spec #3120 (P6), ST-1-R3 — re-derive the snapshot when the INJECTED context changed; a
   * silent no-op when it did not. The owning application publishes its store's selection/dirty
   * changes through this seam, so the launcher memo (keyed on `epoch`) re-derives the header
   * and the grounding envelope without a remount. A value fingerprint (never reference
   * identity — the injected getter allocates a fresh object per call) decides; when changed,
   * `epoch` advances by exactly 1 and an EMPTY `commit()` runs, leaving `announcement` alone.
   */
  readonly refreshContext: () => void;
  /** Spec #3120 (P6) — a full intent (verbId, args, channel, actor, actorRef) through the ONE funnel. */
  readonly runIntent: (intent: Intent) => Promise<DispatchResult>;
  /** Resolves + dispatches one stroke. `null` ⇒ not handled (text-entry / passthrough). */
  readonly handleStroke: (
    stroke: string,
    nowMs: number,
    options?: StrokeOptions,
  ) => Promise<DispatchResult | null>;
  readonly runVerb: (
    verbId: string,
    channel?: Channel,
    args?: Readonly<Record<string, string>>,
  ) => Promise<DispatchResult>;
  /** Convenience: `JOURNAL_UNDO_VERB_ID` through the funnel (newest entry). */
  readonly undoLast: () => Promise<DispatchResult>;
  /**
   * Per-entry undo: selects the journal entry BY `seq` and undoes THAT entry. The reversal is
   * journaled for `options.actor`/`options.channel` (default `{actor:'human', channel:'pointer'}`
   * — the trail button reads `You`); a companion actor maps to `human` (§3.10).
   */
  readonly undoEntry: (
    seq: number,
    options?: { readonly actor?: Actor; readonly channel?: Channel },
  ) => Promise<DispatchResult>;
  readonly openMap: (filterPlaceId?: string | null) => void;
  readonly closeMap: () => void;
  /** Test hygiene: reset the presentation state (and a host-owned journal). */
  readonly reset: () => void;
}

/* ───────────────────────────── helpers ───────────────────────────── */

function pathEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => right[index] === id);
}

/** `shorter` is a STRICT place-path prefix of `longer` (a level was popped). */
function isPathPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  return shorter.length < longer.length && shorter.every((id, index) => longer[index] === id);
}

function isCompanionChannel(channel: Channel): boolean {
  return channel === 'voice' || channel === 'agent';
}

function activeElement(): Element | null {
  return typeof document === 'undefined' ? null : document.activeElement;
}

/** R-4.4 — the undone label from the shipped `Undo <label>` journal phrasing. */
function undoneLabelOf(entry: JournalEntry): string {
  const prefix = 'Undo ';
  return entry.label.startsWith(prefix) ? entry.label.slice(prefix.length) : entry.label;
}

/**
 * ST-1-R3 — a by-VALUE fingerprint of exactly the context fields `buildContextEnvelope`
 * consumes (`appId`, `placePath`, `selection.count`/`ids`/`kinds`/`label`, `dirty`).
 * Reference identity is never usable: `getContext` allocates a new object on every call.
 */
function contextFingerprint(context: ContextSnapshot): string {
  return JSON.stringify([
    context.appId,
    context.placePath,
    context.selection.count,
    context.selection.ids,
    context.selection.kinds,
    context.selection.label,
    context.dirty,
  ]);
}

/* ───────────────────────────── the host ───────────────────────────── */

export function createNavigationHost(options: NavigationHostOptions): NavigationHost {
  const surface = options.surface;
  const registry = createRegistry(surface);
  const journal: JournalStore = options.journal ?? createJournalStore();
  const ownsJournal = options.journal === undefined;
  const now = options.now ?? (() => new Date().toISOString());
  const applyPatch = options.applyPatch ?? (() => undefined);
  const confirm = options.confirm ?? (() => true);

  if (options.announcementChannel !== undefined) {
    configureNavigationAnnouncer({ channel: options.announcementChannel });
  }

  /* ── mutable state (closed over; never persisted — R-9.1 / N-06) ── */

  let epoch = 0;
  let path: string[] = seedPath();
  let pending: PendingPrefix | null = null;
  let mapOpen = false;
  let mapFilterPlaceId: string | null = null;
  let announcement = '';
  /**
   * ST-1-R3 — the context fingerprint the CURRENT snapshot was built from. Recorded inside
   * `buildSnapshot()` so `commit()` and `reset()` rebaseline for free (no double-counting a
   * dispatch that itself changed the selection).
   */
  let contextBaseline = '';
  let snapshot: NavigationHostSnapshot = buildSnapshot();

  const listeners = new Set<() => void>();

  /* ── path resolution ── */

  /** The declared ids of `ids` in order, or `null` when none resolve (never invents a place). */
  function knownPath(ids: readonly string[]): string[] | null {
    const known: string[] = [];
    for (const id of ids) {
      if (registry.placesById.has(id)) known.push(id);
    }
    return known.length > 0 ? known : null;
  }

  function seedPath(): string[] {
    return knownPath(options.getContext().placePath) ?? [registry.rootId];
  }

  /** The declaration's root → `placeId` ancestry (the host derives the cursor, never guesses). */
  function ancestryOf(placeId: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    let current: string | null = placeId;
    while (current !== null && !seen.has(current)) {
      const place = registry.placesById.get(current);
      if (place === undefined) break;
      seen.add(current);
      ids.push(place.id);
      current = place.parent;
    }
    return ids.reverse();
  }

  function labelFor(placeId: string): string {
    return registry.placesById.get(placeId)?.label ?? placeId;
  }

  function contextWithPath(ids: readonly string[]): ContextSnapshot {
    const base = options.getContext();
    return { ...base, placePath: [...ids] };
  }

  function currentContext(): ContextSnapshot {
    return contextWithPath(path);
  }

  /** R-4.1 — the announced action count is the rail's `actionCount` (bound verbs). */
  function actionCountFor(ids: readonly string[]): number {
    return buildCommandRailModel(surface, contextWithPath(ids)).actionCount;
  }

  /* ── snapshot ── */

  function buildSnapshot(): NavigationHostSnapshot {
    const context = currentContext();
    const entries = journal.entries();
    const envelope = buildContextEnvelope(surface, context, entries);
    contextBaseline = contextFingerprint(context);
    return {
      epoch,
      surface,
      context,
      envelope,
      rail: deriveRail(surface, context),
      hint: deriveHint(surface, context, pending),
      entries,
      pending,
      mapOpen,
      mapFilterPlaceId,
      undoableCount: envelope.journal.undoableCount,
      announcement,
    };
  }

  /** ONE mutation OR context change = ONE epoch advance + ONE subscription notification. */
  function commit(message?: string): void {
    if (message !== undefined) {
      announcement = message;
      announceNavigation(message);
    }
    epoch += 1;
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  /* ── announcements ── */

  function placeAnnouncement(
    previous: readonly string[],
    next: readonly string[],
  ): string | null {
    if (pathEquals(previous, next)) return null;
    const currentId = next[next.length - 1];
    if (currentId === undefined) return null;
    if (isPathPrefix(next, previous)) {
      const leftId = previous[previous.length - 1];
      const leftLabel = leftId === undefined ? '' : labelFor(leftId);
      return navPlaceExitMessage(leftLabel, labelFor(currentId), actionCountFor(next));
    }
    return navPlaceEnterMessage(labelFor(currentId), actionCountFor(next));
  }

  function labelForSeq(seq: number): string {
    const entry = journal.entries().find((candidate) => candidate.seq === seq);
    return entry === undefined ? 'the last action' : entry.label;
  }

  /** At most ONE message per result (R-4.1 … R-4.4). */
  function announcementFor(
    result: DispatchResult,
    previous: readonly string[],
    next: readonly string[],
  ): string | null {
    switch (result.status) {
      case 'performed': {
        const entry = result.entry;
        if (entry.effect === 'navigation') return placeAnnouncement(previous, next);
        // A completed mutation in a TRANSIENT place auto-exits (one pop) — announce the
        // exit through the SAME composer as an Escape pop, exactly once.
        if (!pathEquals(previous, next)) return placeAnnouncement(previous, next);
        // Spec #3120 (P6) — the reversal is now attributed to the requester (human/system), so
        // the engine's reserved `Undo <label>` phrasing is the discriminator, not `actor`.
        if (entry.label.startsWith('Undo ')) {
          return navUndoMessage(undoneLabelOf(entry));
        }
        return null;
      }
      case 'noop':
        return result.code === 'no-matches' && result.message === NOTHING_TO_UNDO
          ? navUndoNothingMessage()
          : null;
      case 'partial':
        return navUndoFailedMessage(labelForSeq(result.failedSeq));
      default:
        return null;
    }
  }

  /* ── the post-dispatch cursor ── */

  /**
   * The place the cursor moves to after a NAVIGATION effect. Engine-owned `place.exit` pops
   * one level; a verb whose id names a declared place enters it; otherwise the injected read
   * model's (changed) path wins, so a host controller that advances its own path still works.
   */
  function navigationPath(verbId: string): string[] {
    if (verbId === PLACE_EXIT_VERB_ID) {
      return path.length > 1 ? path.slice(0, -1) : [...path];
    }
    if (registry.placesById.has(verbId)) return ancestryOf(verbId);
    const external = knownPath(options.getContext().placePath);
    if (external !== null && !pathEquals(external, path)) return external;
    return [...path];
  }

  /** True when the cursor is inside a declared `transient` place. */
  function currentPlaceTransient(): boolean {
    const currentId = path[path.length - 1];
    if (currentId === undefined) return false;
    return registry.placesById.get(currentId)?.transient === true;
  }

  /**
   * Commit exactly one mutation for a finished dispatch.
   *
   * Cursor rules (§2.2 / §4.1): a NAVIGATION effect enters the verb's place (or honours the
   * injected path); a completed MUTATION in a `transient` place pops exactly one level; a
   * sticky place's cursor is unchanged. `key` (when the stroke path supplies it) lets a
   * bound-but-unavailable verb speak `navUnavailableKeyMessage` instead of doing nothing.
   */
  function commitResult(result: DispatchResult, key?: string): DispatchResult {
    const previous = path;
    let next = previous;
    if (result.status === 'performed') {
      if (result.entry.effect === 'navigation') {
        next = navigationPath(result.entry.verbId);
      } else if (currentPlaceTransient() && path.length > 1) {
        next = path.slice(0, -1);
      }
    }
    let message = announcementFor(result, previous, next);
    if (
      message === null &&
      key !== undefined &&
      result.status === 'rejected' &&
      result.code === 'unavailable'
    ) {
      message = navUnavailableKeyMessage(key);
    }
    path = next;
    pending = null;
    commit(message ?? undefined);
    return result;
  }

  /* ── dispatch plumbing ── */

  const deps: EngineDeps = {
    surface,
    getContext: currentContext,
    journal,
    now,
    applyPatch,
    confirm,
    overlayOpen: options.overlayOpen,
  };

  async function runIntent(intent: Intent): Promise<DispatchResult> {
    return commitResult(await dispatch(deps, intent));
  }

  async function run(verbId: string, channel: Channel, args: Readonly<Record<string, string>>) {
    const intent: Intent = {
      verbId,
      args,
      channel,
      actor: isCompanionChannel(channel) ? 'companion' : 'human',
    };
    return runIntent(intent);
  }

  /** Spec #3120 (P6) — a fresh envelope; never the snapshot's cached copy (NFR-1). */
  function describeContext(): ContextEnvelope {
    return buildContextEnvelope(surface, currentContext(), journal.entries());
  }

  /**
   * ST-1-R3 — publish a context change the host did not cause itself (a store-only selection
   * change). Value-equal ⇒ a STRICT no-op (same `getSnapshot()` reference, same epoch); a
   * real change reuses `commit()` with NO message, so `announcement` is untouched.
   */
  function refreshContext(): void {
    if (contextFingerprint(currentContext()) === contextBaseline) return;
    commit();
  }

  /* ── the stroke path (R-4.5 / §5 algorithm) ── */

  async function handleStroke(
    stroke: string,
    nowMs: number,
    strokeOptions?: StrokeOptions,
  ): Promise<DispatchResult | null> {
    // R-4.5 — a text-entry focus resolves NO stroke and emits NO announcement.
    const target = strokeOptions?.target ?? activeElement();
    if (isTextControl(target)) return null;

    // §2.2 / §4.1 — Escape cancels an armed prefix as part of the same press (the resolver
    // reports `hint` for a root Escape, so the host clears the prefix and speaks nothing).
    const key = normalizeStroke(stroke);
    const cancelledPrefix = key === 'Escape' && pending !== null;
    if (cancelledPrefix) pending = null;

    const resolution = resolveStroke({
      surface,
      placePath: path,
      pending,
      stroke,
      nowMs,
      // Spec #3121 (P7), ST-1 — the caller may assert a non-engine keyboard owner; the
      // default keeps the shipped `'engine'` behaviour byte-identical (Architect §B.1).
      keyboardOwner: strokeOptions?.keyboardOwner ?? 'engine',
    });

    switch (resolution.status) {
      case 'passthrough':
        return null;

      case 'timeout':
        // Clearing a stale prefix is silent (Q4-02): the region keeps its last message.
        if (pending !== null) {
          pending = null;
          commit();
        }
        return null;

      case 'armed':
      case 'pending': {
        pending = resolution.prefix;
        const hint = deriveHint(surface, currentContext(), pending);
        commit(
          navPrefixMessage(
            pending.sequence,
            hint.rows.map((row) => row.label),
          ),
        );
        return null;
      }

      case 'hint': {
        // Root Escape surfaces a quiet hint but is not an unavailable KEY (Q4-03).
        if (resolution.hint.rows.length === 0 && key !== null && key !== 'Escape') {
          commit(navUnavailableKeyMessage(key));
        } else if (cancelledPrefix) {
          // Publish the cancelled prefix; the cancellation itself announces nothing.
          commit();
        }
        return null;
      }

      case 'rejected': {
        commit(navAmbiguousKeyMessage(key ?? stroke));
        return null;
      }

      case 'dispatch':
        return commitResult(await dispatch(deps, resolution.intent), key ?? undefined);
    }
  }

  /* ── per-entry undo (Architect §5; QA GAP 10) ── */

  async function undoEntry(
    seq: number,
    options?: { readonly actor?: Actor; readonly channel?: Channel },
  ): Promise<DispatchResult> {
    const entries = journal.entries();
    const target = entries.find((entry) => entry.seq === seq);
    const inverse = target?.inverse ?? null;

    // Unknown seq or a non-invertible entry: the shipped empty-undo outcome, one message.
    if (target === undefined || inverse === null) {
      commit(navUndoNothingMessage());
      return { status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO };
    }

    // Spec #3120 (P6) §3.10 — the reversal is attributed to the requester (default: the human
    // clicking the trail); a companion actor still journals as `human`.
    const requestedActor: Actor = options?.actor ?? 'human';
    const undoActor: Actor = requestedActor === 'companion' ? 'human' : requestedActor;
    const undoChannel: Channel = options?.channel ?? 'pointer';

    try {
      applyPatch(inverse);
    } catch {
      // No state claimed: commit the UNCHANGED journal and report the failure once.
      journal.commit(entries, journal.redo());
      commit(navUndoFailedMessage(target.label));
      return { status: 'partial', code: 'undo-failed', applied: 0, failedSeq: seq };
    }

    const beforeUndo: JsonPatch = target.patch !== null ? target.patch.after : inverse;
    const outcome = appendEntry(
      { entries, redo: journal.redo() },
      {
        verbId: target.verbId,
        actor: undoActor,
        channel: undoChannel,
        label: `Undo ${target.label}`,
        effect: 'mutation',
        placePath: currentContext().placePath,
        target: target.target,
        patch: { before: beforeUndo, after: inverse },
        inverse: beforeUndo,
        external: false,
        consequence: null,
        exitedBy: 'none',
        coalesceKey: null,
      },
      now(),
    );
    // Redo is oldest-first; a newer undo is prepended, so the stack stays ascending.
    journal.commit(outcome.state.entries, [
      target.seq,
      ...journal.redo().filter((redoSeq) => redoSeq !== target.seq),
    ]);
    commit(navUndoMessage(target.label));
    return { status: 'performed', entry: outcome.entry };
  }

  /* ── map + reset ── */

  function openMap(filterPlaceId: string | null = null): void {
    const nextFilter = filterPlaceId ?? null;
    if (mapOpen && mapFilterPlaceId === nextFilter) return;
    mapOpen = true;
    mapFilterPlaceId = nextFilter;
    commit();
  }

  function closeMap(): void {
    if (!mapOpen && mapFilterPlaceId === null) return;
    mapOpen = false;
    mapFilterPlaceId = null;
    commit();
  }

  function reset(): void {
    path = seedPath();
    pending = null;
    mapOpen = false;
    mapFilterPlaceId = null;
    announcement = '';
    if (ownsJournal) journal.commit([], []);
    resetNavigationAnnouncer();
    epoch += 1;
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    handleStroke,
    describeContext,
    refreshContext,
    runIntent,
    runVerb: (verbId, channel = 'pointer', args = {}) => run(verbId, channel, args),
    undoLast: () => run(JOURNAL_UNDO_VERB_ID, 'pointer', {}),
    undoEntry,
    openMap,
    closeMap,
    reset,
  };
}

/** §5 — subscribe a component to the host's stable snapshot (React's external-store contract). */
export function useNavigationHostSnapshot(host: NavigationHost): NavigationHostSnapshot {
  return useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
}
