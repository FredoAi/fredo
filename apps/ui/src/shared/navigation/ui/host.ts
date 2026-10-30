/**
 * Spec #3118 (P4), ST-5 — the navigation host: the ONE stateful seam the P4 surfaces read.
 *
 * The host owns the presentation state the components cannot derive (the pending prefix, the
 * map's open/filter, the last announcement) and the epoch-driven snapshot (NFR memoisation):
 * the snapshot object is rebuilt ONLY on a mutation, `epoch` advances exactly once per
 * mutation, and `getSnapshot()` returns the SAME reference between mutations — React's
 * `useSyncExternalStore` contract. No polling, no interval; the only timer in the whole P4
 * layer is the one-shot `PENDING_TIMEOUT_MS` the caller supplies as `nowMs`.
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
  readonly confirm?: (request: ConfirmationRequest) => boolean;
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

export interface NavigationHost {
  readonly getSnapshot: () => NavigationHostSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Resolves + dispatches one stroke. `null` ⇒ not handled (text-entry / passthrough). */
  readonly handleStroke: (
    stroke: string,
    nowMs: number,
    options?: { readonly target?: Element | null },
  ) => Promise<DispatchResult | null>;
  readonly runVerb: (
    verbId: string,
    channel?: Channel,
    args?: Readonly<Record<string, string>>,
  ) => Promise<DispatchResult>;
  /** Convenience: `JOURNAL_UNDO_VERB_ID` through the funnel (newest entry). */
  readonly undoLast: () => Promise<DispatchResult>;
  /** Per-entry undo: selects the journal entry BY `seq` and undoes THAT entry. */
  readonly undoEntry: (seq: number) => Promise<DispatchResult>;
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

  /** ONE mutation = ONE epoch advance + ONE subscription notification. */
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
        if (entry.actor === 'system' && entry.label.startsWith('Undo ')) {
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

  /** Commit exactly one mutation for a finished dispatch. */
  function commitResult(result: DispatchResult): DispatchResult {
    const previous = path;
    const next =
      result.status === 'performed' && result.entry.effect === 'navigation'
        ? navigationPath(result.entry.verbId)
        : previous;
    const message = announcementFor(result, previous, next);
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

  async function run(verbId: string, channel: Channel, args: Readonly<Record<string, string>>) {
    const intent: Intent = {
      verbId,
      args,
      channel,
      actor: isCompanionChannel(channel) ? 'companion' : 'human',
    };
    return commitResult(await dispatch(deps, intent));
  }

  /* ── the stroke path (R-4.5 / §5 algorithm) ── */

  async function handleStroke(
    stroke: string,
    nowMs: number,
    strokeOptions?: { readonly target?: Element | null },
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
      keyboardOwner: 'engine',
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
        return commitResult(await dispatch(deps, resolution.intent));
    }
  }

  /* ── per-entry undo (Architect §5; QA GAP 10) ── */

  async function undoEntry(seq: number): Promise<DispatchResult> {
    const entries = journal.entries();
    const target = entries.find((entry) => entry.seq === seq);
    const inverse = target?.inverse ?? null;

    // Unknown seq or a non-invertible entry: the shipped empty-undo outcome, one message.
    if (target === undefined || inverse === null) {
      commit(navUndoNothingMessage());
      return { status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO };
    }

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
        actor: 'system',
        channel: 'system',
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
