/**
 * Spec #3121 (P7), ST-3 — the ONE Mission Monitor surface declaration.
 *
 * Mission Monitor becomes an ordinary NavigationEngine consumer: two places and the six
 * verbs the shipped panel already exposes are DATA here, not a Mission-Monitor-specific
 * runtime. The provider (`components/MissionMonitorNavigationProvider.tsx`) mounts the P4
 * `CommandRail` / `NavigationMap` / `ActivityTrail` over this declaration, and the panel
 * registers the live callbacks that actually run the verbs.
 *
 * BEHAVIOUR-PRESERVING (Architect §0 / §B.6): the ONE stroke the shipped UI declared —
 * `s` on the session filter input (`SessionHistoryDrawer.tsx:297`) — is re-homed here as
 * `mission-monitor.session.search`. `s` still only focuses the filter input and still
 * no-ops when the drawer is collapsed (the input is not mounted). No `n`/`p` session
 * navigation is invented (`selectRelativeSession` in the panel is dead code with no
 * caller), and the shipped `Escape` detail-close window listeners
 * (`DetailPanel.tsx:314-328`, `:343-349`) stay exactly where they are. `drawerOpen`
 * defaults to `true` and the window title stays `Sessions`.
 *
 * SELECTION (Architect §D.4 / §B.5): the injected `ContextSnapshot.selection` projects
 * the panel's `selectedSessionId` (`['session']` / `[id]`). `mission-monitor.session.delete`
 * and `mission-monitor.detail.close` gate on `count >= 1`, so their map rows disable with no
 * selection and enable with one — availability is derived from `ctx` alone, never an
 * app-local boolean (AC5).
 *
 * PURE DATA + SYNCHRONOUS RUNS: no timers, no IPC, no clock. The only module state is the
 * registered handler set (the panel's live callbacks), which is session-scoped and never
 * persisted.
 */

import type {
  ContextSnapshot,
  Intent,
  PlaceNode,
  Risk,
  Surface,
  VerbArg,
  VerbDescriptor,
  VerbEffect,
} from '../../shared/navigation';

/* ───────────────────────────── bound names ───────────────────────────── */

/** Architect §B.2 — the surface app id (`MissionMonitorFeature`'s `id`). */
export const MISSION_MONITOR_SURFACE_APP_ID = 'mission-monitor';

/** Architect §B.3 — the root place (the session drawer + canvas). */
export const MISSION_MONITOR_SESSIONS_PLACE_ID = 'mission-monitor.sessions';

/** Architect §B.3 — the sticky detail child place (the open detail panel). */
export const MISSION_MONITOR_DETAIL_PLACE_ID = 'mission-monitor.detail';

/* Architect §B.5 — the declared verb ids (the QA/parity rows read these constants, so the
 * declaration and the tests never spell an id twice). */
export const MISSION_MONITOR_SEARCH_VERB_ID = 'mission-monitor.session.search';
export const MISSION_MONITOR_DRAWER_TOGGLE_VERB_ID = 'mission-monitor.drawer.toggle';
export const MISSION_MONITOR_DELETE_VERB_ID = 'mission-monitor.session.delete';
export const MISSION_MONITOR_DETAIL_CLOSE_VERB_ID = 'mission-monitor.detail.close';

/* ───────────────────────────── handler seam ───────────────────────────── */

/**
 * The live panel callbacks the action verbs delegate to.
 *
 * Each handler returns `true` when it DID something and `false` when the target is absent in
 * the current panel state (the drawer is collapsed so the filter input is not mounted, no
 * detail panel is open, …); a `false` makes the verb a `noop` with no journal entry (R-04's
 * "at most a noop"). The panel registers the CURRENT closures, so no verb captures stale
 * React state.
 */
export interface MissionMonitorActionHandlers {
  /** Focus the session filter input; `false` when the drawer is collapsed (no input). */
  readonly focusSearch: () => boolean;
  /** Toggle the session drawer. */
  readonly toggleDrawer: () => boolean;
  /** Delete one stored session by id. */
  readonly deleteSession: (sessionId: string) => boolean;
  /** Close the open detail panel; `false` when no panel is open (the shipped no-op). */
  readonly closeDetail: () => boolean;
}

let actionHandlers: MissionMonitorActionHandlers | null = null;

/** Register the live handlers (the provider does this on mount). */
export function setMissionMonitorActionHandlers(
  next: MissionMonitorActionHandlers | null,
): void {
  actionHandlers = next;
}

/** The currently registered handlers, or `null` outside a mounted Mission Monitor panel. */
export function getMissionMonitorActionHandlers(): MissionMonitorActionHandlers | null {
  return actionHandlers;
}

/* ───────────────────────────── helpers ───────────────────────────── */

const always = (): boolean => true;
const hasSelection = (ctx: ContextSnapshot): boolean => ctx.selection.count >= 1;

/** A non-undoable, attributed action (focus / identity / overlay — never a document edit). */
function navigation(label: string): VerbEffect {
  return { effect: 'navigation', label, patch: null, inverse: null, target: [] };
}

/** `patch: null` ⇒ the funnel reports `did-nothing` and writes NO journal entry. */
function noop(label: string): VerbEffect {
  return { effect: 'mutation', label, patch: null, inverse: null, target: [] };
}

/**
 * Architect §B.5 argument rule — the target id comes from the call when supplied, else from
 * the single selected session in `ContextSnapshot` (never from an app-local table).
 */
function sessionIdOf(intent: Intent, ctx: ContextSnapshot): string | null {
  const argId = intent.args.sessionId;
  if (argId !== undefined && argId.trim().length > 0) return argId;
  return ctx.selection.ids[0] ?? null;
}

const optionalSessionId: VerbArg = { name: 'sessionId', type: 'string', required: false };

/* ───────────────────────────── verb descriptor builder ───────────────────────────── */

interface VerbSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly objects: readonly string[];
  readonly places: readonly string[];
  readonly risk: Risk;
  readonly available: (ctx: ContextSnapshot) => boolean;
  readonly run: (intent: Intent, ctx: ContextSnapshot) => VerbEffect;
  readonly args?: readonly VerbArg[];
  readonly publish?: boolean;
  readonly consequence?: string;
}

function defineVerb(spec: VerbSpec): VerbDescriptor {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    appliesTo: { objects: spec.objects, places: spec.places },
    args: spec.args ?? [],
    available: spec.available,
    risk: spec.risk,
    aliases: [],
    run: spec.run,
    ...(spec.consequence === undefined ? {} : { consequence: spec.consequence }),
    publish: spec.publish ?? true,
  };
}

/* ───────────────────────────── the 6 verbs (§B.5) ───────────────────────────── */

const SESSIONS = MISSION_MONITOR_SESSIONS_PLACE_ID;
const DETAIL = MISSION_MONITOR_DETAIL_PLACE_ID;

/* Architect §B.4 — the two Mission Monitor object nouns. */
const OBJECT_MONITOR = ['monitor'] as const;
const OBJECT_SESSION = ['session'] as const;

const ROOT_PLACE = [SESSIONS] as const;
const DETAIL_PLACE = [DETAIL] as const;

const VERBS: readonly VerbDescriptor[] = [
  defineVerb({
    id: MISSION_MONITOR_SEARCH_VERB_ID,
    title: 'Search sessions',
    description: 'Focus the session filter input.',
    objects: OBJECT_SESSION,
    places: ROOT_PLACE,
    risk: 'safe',
    available: always,
    run: () => {
      const handlers = getMissionMonitorActionHandlers();
      // The drawer is collapsed ⇒ the input is not mounted ⇒ at most a noop (R-04).
      return handlers !== null && handlers.focusSearch()
        ? navigation('Search sessions')
        : noop('Search sessions');
    },
  }),

  defineVerb({
    id: MISSION_MONITOR_DRAWER_TOGGLE_VERB_ID,
    title: 'Toggle sessions',
    description: 'Show or hide the session drawer.',
    objects: OBJECT_MONITOR,
    places: ROOT_PLACE,
    risk: 'safe',
    available: always,
    run: () => {
      const handlers = getMissionMonitorActionHandlers();
      return handlers !== null && handlers.toggleDrawer()
        ? navigation('Toggle sessions')
        : noop('Toggle sessions');
    },
  }),

  defineVerb({
    id: MISSION_MONITOR_DELETE_VERB_ID,
    title: 'Delete session',
    description: 'Remove the selected stored session.',
    objects: OBJECT_SESSION,
    places: ROOT_PLACE,
    risk: 'destructive',
    consequence: 'Removes the stored session record. Its agent history cannot be restored.',
    available: hasSelection,
    args: [optionalSessionId],
    run: (intent, ctx) => {
      const id = sessionIdOf(intent, ctx);
      const handlers = getMissionMonitorActionHandlers();
      return id !== null && handlers !== null && handlers.deleteSession(id)
        ? navigation('Delete session')
        : noop('Delete session');
    },
  }),

  defineVerb({
    id: MISSION_MONITOR_DETAIL_CLOSE_VERB_ID,
    title: 'Close detail',
    description: 'Close the open detail panel.',
    objects: OBJECT_SESSION,
    places: ROOT_PLACE,
    risk: 'safe',
    available: hasSelection,
    run: () => {
      const handlers = getMissionMonitorActionHandlers();
      // A selected session with no panel open is the shipped no-op (setFocusTarget(null)).
      return handlers !== null && handlers.closeDetail()
        ? navigation('Close detail')
        : noop('Close detail');
    },
  }),

  /* ── navigation-only verbs (never published; never a companion row) ── */
  defineVerb({
    // D-9 — the child-place id IS a declared navigation verb so the rail place row is live.
    id: MISSION_MONITOR_DETAIL_PLACE_ID,
    title: 'Detail',
    description: 'Move the cursor into the detail place.',
    objects: OBJECT_SESSION,
    places: DETAIL_PLACE,
    risk: 'safe',
    available: always,
    run: () => navigation('Detail'),
    publish: false,
  }),
  defineVerb({
    // §11.1 / §B.3 — `app.map` is declared with NO key and is never published.
    id: 'app.map',
    title: 'Map',
    description: 'Open the navigation map of every place, verb and key.',
    objects: OBJECT_MONITOR,
    places: ROOT_PLACE,
    risk: 'safe',
    available: always,
    run: () => navigation('Map'),
    publish: false,
  }),
];

/* ───────────────────────────── places (§B.3) ───────────────────────────── */

const verbBinding = (verbId: string): PlaceNode['keys'][string] => ({ kind: 'verb', verbId });

function place(
  id: string,
  label: string,
  parent: string | null,
  keys: PlaceNode['keys'],
  flags: Partial<Pick<PlaceNode, 'transient' | 'sticky' | 'operator' | 'cursor'>> = {},
): PlaceNode {
  return {
    id,
    label,
    parent,
    transient: false,
    sticky: false,
    cursor: null,
    operator: null,
    keys,
    entryHooks: [],
    exitHooks: [],
    ...flags,
  };
}

const PLACES: readonly PlaceNode[] = [
  // The root sets neither `transient` nor `sticky` (§2.1) and binds the ONE shipped stroke.
  place(SESSIONS, 'Sessions', null, {
    s: verbBinding(MISSION_MONITOR_SEARCH_VERB_ID),
  }),
  // The detail place is sticky (a verb never auto-exits it); no key enters it.
  place(DETAIL, 'Detail', SESSIONS, {}, { sticky: true }),
];

/* ───────────────────────────── the declaration ───────────────────────────── */

/** The ONE Mission Monitor surface declaration (P7). */
export const missionMonitorSurface: Surface = {
  tree: {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    root: SESSIONS,
    places: PLACES,
    // `s` is the only shipped stroke — no `g+*` sequence, no direct alias.
    directAliases: {},
  },
  verbs: VERBS,
  companion: {
    appName: 'Mission Monitor',
    description: 'Watch agent sessions and inspect their activity graphs.',
  },
};

/** The complete declared verb-id set (QA R-01 / R-21 read this instead of a literal list). */
export const MISSION_MONITOR_VERB_IDS: readonly string[] = VERBS.map((verb) => verb.id);

/** Test-only: drop the registered handlers so a suite starts from the unmounted state. */
export function resetMissionMonitorSurfaceForTests(): void {
  actionHandlers = null;
}
