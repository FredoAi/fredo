/**
 * Spec #3121 (P7), ST-5 — the ONE Dev Mode surface declaration.
 *
 * Dev Mode becomes an ordinary NavigationEngine consumer: its two views are the TWO places of
 * the declaration (Architect §B.3) and the four shipped element-hotkey keys become place
 * bindings (x → clear events, i → focus filter, b → show all states, v → Application Data).
 * The provider (`components/DevModeNavigationProvider.tsx`) mounts the P4 `CommandRail` /
 * `NavigationMap` / `ActivityTrail` over this declaration; `DevMode` registers the live
 * handlers the verbs delegate to, so no verb captures stale React state.
 *
 * BEHAVIOUR-PRESERVING (Architect §B.6):
 *   - `x` clears the event buffer in BOTH views (the Clear control renders in both today);
 *   - `v` switches to Application Data and moves the cursor into `dev-mode.applicationData`;
 *     in the Application Data view it stays the same visible no-op (one navigation entry);
 *   - `i` focuses the event filter (rows view only) and is absent elsewhere;
 *   - `b` activates every state (rows view only) and no-ops when all are already active.
 *
 * The `applicationData` place is sticky (§2.1: exactly one of transient/sticky on a non-root
 * place) and its id is ALSO a declared navigation-only, unpublished verb (D-9), so the rail's
 * child-place row is a live affordance rather than a dead row.
 *
 * PURE DATA + SYNCHRONOUS RUNS: no timers, no IPC, no clock. The only module state is the
 * registered handler set (the mounted Dev Mode callbacks), session-scoped and never persisted.
 */

import type {
  ContextSnapshot,
  Intent,
  PlaceNode,
  Risk,
  Surface,
  VerbDescriptor,
  VerbEffect,
} from '../../shared/navigation';

/* ───────────────────────────── bound names ───────────────────────────── */

/** Architect §B.2 — the surface app id (`DevModeFeature`'s `id`). */
export const DEV_MODE_SURFACE_APP_ID = 'dev-mode';

/** Architect §B.3 — the root place (the RTDB row stream view). */
export const DEV_MODE_EVENTS_PLACE_ID = 'dev-mode.events';

/** Architect §B.3 — the Application Data child place (sticky). */
export const DEV_MODE_APPLICATION_DATA_PLACE_ID = 'dev-mode.applicationData';

/** The two shipped Dev Mode views, in declaration/view-toggle order. */
export type DevModeViewId = 'rows' | 'application-data';

/** The view ids as they appear in the selection projection (§D.4) and the places. */
export const DEV_MODE_VIEW_ROWS: DevModeViewId = 'rows';
export const DEV_MODE_VIEW_APPLICATION_DATA: DevModeViewId = 'application-data';

/** Architect §B.5 — the four bound action verb ids. */
export const DEV_MODE_EVENTS_CLEAR_VERB_ID = 'dev-mode.events.clear';
export const DEV_MODE_SEARCH_FOCUS_VERB_ID = 'dev-mode.search.focus';
export const DEV_MODE_STATES_ALL_VERB_ID = 'dev-mode.states.all';
export const DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID = 'dev-mode.view.applicationData';
export const DEV_MODE_VIEW_ROWS_VERB_ID = 'dev-mode.view.rows';

/** §2.3 — the observable hook id every place carries. */
const OBSERVABLE_HOOK = 'observable';

/* ───────────────────────────── handler seam ───────────────────────────── */

/**
 * The live Dev Mode callbacks the verbs delegate to.
 *
 * Each handler returns `true` when it DID something and `false` when the control/target is
 * absent in the current view (zero events, no filter input, every state already active, …);
 * a `false` makes the verb a `noop` with no journal entry (R-04's "at most a noop"). The
 * handler set is registered by the provider from the component's CURRENT closures, so no
 * verb captures stale React state.
 */
export interface DevModeActionHandlers {
  /** Clear the accumulated event buffer (both views); `false` when the buffer is empty. */
  readonly clearEvents: () => boolean;
  /** Focus the event filter input (rows view only); `false` when it is absent. */
  readonly focusFilter: () => boolean;
  /** Activate every event state (rows view only); `false` when all are already active. */
  readonly showAllStates: () => boolean;
  /** Switch to the Application Data view. */
  readonly showApplicationData: () => boolean;
  /** Switch to the rows view. */
  readonly showRows: () => boolean;
}

let actionHandlers: DevModeActionHandlers | null = null;

/** Register the live handlers (the provider does this on mount). */
export function setDevModeActionHandlers(next: DevModeActionHandlers | null): void {
  actionHandlers = next;
}

/** The currently registered handlers, or `null` outside a mounted Dev Mode window. */
export function getDevModeActionHandlers(): DevModeActionHandlers | null {
  return actionHandlers;
}

/* ───────────────────────────── helpers ───────────────────────────── */

/** B.4 — the surface-level object noun (`stream`, non-selectable). */
const OBJECT_STREAM = ['stream'] as const;
/** B.4 — the selectable object noun the panel-scoped verbs apply to. */
const OBJECT_PANEL = ['panel'] as const;

const always = (): boolean => true;
/** R-11 — the panel object exists (its id is the active view). */
const hasPanel = (ctx: ContextSnapshot): boolean => ctx.selection.kinds.includes('panel');
/** R-11 — the active panel is the rows view. */
const inRows = (ctx: ContextSnapshot): boolean =>
  hasPanel(ctx) && ctx.selection.ids.includes(DEV_MODE_VIEW_ROWS);
/** R-11 — the active panel is the Application Data view. */
const inApplicationData = (ctx: ContextSnapshot): boolean =>
  hasPanel(ctx) && ctx.selection.ids.includes(DEV_MODE_VIEW_APPLICATION_DATA);

/** A non-undoable, attributed outcome (a state/focus change that has no document patch). */
function navigation(label: string): VerbEffect {
  return { effect: 'navigation', label, patch: null, inverse: null, target: [] };
}

/** `patch: null` ⇒ the funnel reports `did-nothing` and writes NO journal entry. */
function noop(label: string): VerbEffect {
  return { effect: 'mutation', label, patch: null, inverse: null, target: [] };
}

/** Delegates to the registered handlers; `false` (or no handlers) is a noop. */
function runHandler(
  run: (handlers: DevModeActionHandlers) => boolean,
  label: string,
): VerbEffect {
  const handlers = getDevModeActionHandlers();
  return handlers !== null && run(handlers) ? navigation(label) : noop(label);
}

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
  readonly publish?: boolean;
}

function defineVerb(spec: VerbSpec): VerbDescriptor {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    appliesTo: { objects: spec.objects, places: spec.places },
    // No verb needs an argument: every outcome is a view-local action with no target.
    args: [],
    available: spec.available,
    risk: spec.risk,
    aliases: [],
    run: spec.run,
    publish: spec.publish ?? true,
  };
}

/* ───────────────────────────── the 7 verbs (§B.5) ───────────────────────────── */

const EVENTS = [DEV_MODE_EVENTS_PLACE_ID] as const;
const APPLICATION_DATA = [DEV_MODE_APPLICATION_DATA_PLACE_ID] as const;
const BOTH_PLACES = [DEV_MODE_EVENTS_PLACE_ID, DEV_MODE_APPLICATION_DATA_PLACE_ID] as const;

const VERBS: readonly VerbDescriptor[] = [
  defineVerb({
    id: DEV_MODE_EVENTS_CLEAR_VERB_ID,
    title: 'Clear events',
    description: 'Clear the accumulated Dev Mode event buffer.',
    objects: OBJECT_PANEL,
    // The Clear control renders in BOTH views (the header), so the key resolves in both.
    places: BOTH_PLACES,
    risk: 'mutating',
    available: hasPanel,
    run: () =>
      runHandler((handlers) => handlers.clearEvents(), 'Clear events'),
  }),
  defineVerb({
    id: DEV_MODE_SEARCH_FOCUS_VERB_ID,
    title: 'Filter events',
    description: 'Focus the event filter input.',
    objects: OBJECT_PANEL,
    // Map-visible in both places; the rows-view predicate (AC5) disables it elsewhere.
    places: BOTH_PLACES,
    risk: 'safe',
    available: inRows,
    run: () =>
      runHandler((handlers) => handlers.focusFilter(), 'Filter events'),
  }),
  defineVerb({
    id: DEV_MODE_STATES_ALL_VERB_ID,
    title: 'Show all states',
    description: 'Activate every event state filter at once.',
    objects: OBJECT_PANEL,
    places: BOTH_PLACES,
    risk: 'safe',
    available: inRows,
    run: () =>
      runHandler((handlers) => handlers.showAllStates(), 'Show all states'),
  }),
  defineVerb({
    id: DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
    title: 'Application data',
    description: 'Switch the Dev Mode view to the application-data probe feed.',
    objects: OBJECT_PANEL,
    places: BOTH_PLACES,
    risk: 'safe',
    // B.5 — always available; in its own view it is a visible no-op (one navigation entry).
    available: always,
    run: () =>
      runHandler((handlers) => handlers.showApplicationData(), 'Application data'),
  }),
  defineVerb({
    id: DEV_MODE_VIEW_ROWS_VERB_ID,
    title: 'Rows',
    description: 'Switch the Dev Mode view back to the RTDB row stream.',
    objects: OBJECT_PANEL,
    places: BOTH_PLACES,
    risk: 'safe',
    // B.5 — only meaningful from the Application Data view (AC5).
    available: inApplicationData,
    run: () => runHandler((handlers) => handlers.showRows(), 'Rows'),
  }),

  /* ── navigation-only verbs (never published; never a companion row) ── */
  defineVerb({
    // D-9 — the child-place id IS a declared navigation verb so the rail row is live.
    id: DEV_MODE_APPLICATION_DATA_PLACE_ID,
    title: 'Application data place',
    description: 'Move the cursor into the Application Data place.',
    objects: OBJECT_PANEL,
    places: APPLICATION_DATA,
    risk: 'safe',
    available: always,
    run: () => navigation('Application data'),
    publish: false,
  }),
  defineVerb({
    id: 'app.map',
    title: 'Map',
    description: 'Open the navigation map of every place, verb and key.',
    objects: OBJECT_STREAM,
    places: EVENTS,
    risk: 'safe',
    available: always,
    run: () => navigation('Map'),
    publish: false,
  }),
];

/* ───────────────────────────── places (§B.3) ───────────────────────────── */

const verbBinding = (verbId: string): PlaceNode['keys'][string] => ({ kind: 'verb', verbId });

const PLACES: readonly PlaceNode[] = [
  // The root sets neither `transient` nor `sticky` (§2.1).
  {
    id: DEV_MODE_EVENTS_PLACE_ID,
    label: 'Events',
    parent: null,
    transient: false,
    sticky: false,
    cursor: null,
    operator: null,
    keys: {
      x: verbBinding(DEV_MODE_EVENTS_CLEAR_VERB_ID),
      i: verbBinding(DEV_MODE_SEARCH_FOCUS_VERB_ID),
      b: verbBinding(DEV_MODE_STATES_ALL_VERB_ID),
      v: verbBinding(DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID),
    },
    entryHooks: [OBSERVABLE_HOOK],
    exitHooks: [OBSERVABLE_HOOK],
  },
  // The Application Data place: sticky (a verb never auto-exits it). `v` is bound in BOTH
  // places on purpose — the Application Data view button renders in both views today, so a
  // resolvable key must stay resolvable (Architect §B.3); it is the same visible no-op.
  {
    id: DEV_MODE_APPLICATION_DATA_PLACE_ID,
    label: 'Application Data',
    parent: DEV_MODE_EVENTS_PLACE_ID,
    transient: false,
    sticky: true,
    cursor: null,
    operator: null,
    keys: {
      x: verbBinding(DEV_MODE_EVENTS_CLEAR_VERB_ID),
      v: verbBinding(DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID),
    },
    entryHooks: [OBSERVABLE_HOOK],
    exitHooks: [OBSERVABLE_HOOK],
  },
];

/* ───────────────────────────── the declaration ───────────────────────────── */

/** The ONE Dev Mode surface declaration (P7). */
export const devModeSurface: Surface = {
  tree: {
    appId: DEV_MODE_SURFACE_APP_ID,
    root: DEV_MODE_EVENTS_PLACE_ID,
    places: PLACES,
    // No app-level alias: every legacy key is a place binding here.
    directAliases: {},
  },
  verbs: VERBS,
  companion: {
    appName: 'Dev Mode',
    description: 'Inspect the RTDB row stream and the application-data probe feed.',
  },
};

/** The complete declared verb-id set (QA R-01 / R-21 read this instead of a literal list). */
export const DEV_MODE_VERB_IDS: readonly string[] = VERBS.map((verb) => verb.id);

/** Test-only: drop the registered handlers so a suite starts from the unmounted state. */
export function resetDevModeSurfaceForTests(): void {
  actionHandlers = null;
}
