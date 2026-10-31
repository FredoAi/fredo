/**
 * SQL Studio (`database-client`) navigation surface (Spec #3121, ST-4 — P7 fleet migration).
 *
 * Behaviour-preserving re-homing (Architect §B.2–B.6 / UI/UX §3.1 + §6): SQL Studio gains the
 * shared `CommandRail` / `NavigationMap` / `ActivityTrail` over ONE declaration — it does NOT
 * gain a capability. The declaration is pure data; the live outcomes are delegated to a
 * module-scoped handler set registered by the components that already own them
 * (`DatabaseClientFeature`, `QueryTabs`, `SqlEditor`, `ResultsGrid`, `ExportMenu`,
 * `HistoryPanel`) — the same seam shape ST-1 used for the terminal.
 *
 * CLOSED SURFACE (D-3(b)): SQL Studio declares **zero place keys**. `Ctrl/Cmd+Enter` stays on
 * `SqlEditor` (the text-entry owner) and calls the identical `runSingle`; the declared
 * `sql-studio.query.run` reproduces that same outcome. No `data-hotkey`, no `g+*`, no new chord.
 *
 * SELECTION (Architect §D.4 / C-4): `ctx.selection` carries the active connection, the selected
 * schema node (`table`), the active query tab (`query`) and the active result set (`resultSet`)
 * — ids and kinds in that fixed order. Every `available(ctx)` predicate reads ONLY `ctx`
 * (AC5): no app-local boolean decides availability.
 *
 * D-8: `resultRow` is declared NON-selectable — the shipped grid has no row click /
 * `aria-selected`; result-scoped verbs act on the active result set.
 *
 * D-9: each child place id is ALSO declared as a navigation-only, unbound, `publish:false`
 * verb so the rail's child-place rows are live affordances (no dead rows).
 */

import type {
  ContextSnapshot,
  PlaceNode,
  Risk,
  SelectionSnapshot,
  Surface,
  VerbArg,
  VerbDescriptor,
  VerbEffect,
} from '../../shared/navigation';

/* ───────────────────────────── bound names (§B.2–§B.5) ───────────────────────────── */

/** §B.2 — the surface app id (`DatabaseClientFeature`'s `id`). */
export const DATABASE_CLIENT_SURFACE_APP_ID = 'database-client';

/** §B.3 — the root place (all connection-level verbs live here). */
export const SQL_STUDIO_WORKSPACE_PLACE_ID = 'sql-studio.workspace';

/** §B.3 — the table-scoped child place. */
export const SQL_STUDIO_SCHEMA_PLACE_ID = 'sql-studio.schema';

/** §B.3 — the editor/tab-scoped child place. */
export const SQL_STUDIO_QUERY_PLACE_ID = 'sql-studio.query';

/** §B.3 — the result-set-scoped child place. */
export const SQL_STUDIO_RESULTS_PLACE_ID = 'sql-studio.results';

/** §B.4 — the object-type vocabulary the verbs apply to. */
export const SQL_STUDIO_OBJECT_TYPES = {
  workspace: 'workspace',
  connection: 'connection',
  table: 'table',
  query: 'query',
  resultSet: 'resultSet',
  resultRow: 'result row',
} as const;

/** §B.5 — the action verb ids, kept as constants so tests/parity rows never spell them twice. */
export const SQL_STUDIO_VERB_IDS = {
  connectionNew: 'sql-studio.connection.new',
  connectionEdit: 'sql-studio.connection.edit',
  connectionDelete: 'sql-studio.connection.delete',
  connectionDisconnect: 'sql-studio.connection.disconnect',
  connectionRetry: 'sql-studio.connection.retry',
  schemaViewColumns: 'sql-studio.schema.viewColumns',
  schemaOpenData: 'sql-studio.schema.openData',
  schemaNewQuery: 'sql-studio.schema.newQuery',
  queryRun: 'sql-studio.query.run',
  queryRunAll: 'sql-studio.query.runAll',
  tabNew: 'sql-studio.tab.new',
  tabClose: 'sql-studio.tab.close',
  resultsLoadMore: 'sql-studio.results.loadMore',
  resultsExportCsv: 'sql-studio.results.exportCsv',
  resultsExportJson: 'sql-studio.results.exportJson',
  historyClear: 'sql-studio.history.clear',
  appMap: 'app.map',
} as const;

/** The kind reported for a selected schema node (§D.4 — the node is the `table` selection). */
const TABLE_KIND = SQL_STUDIO_OBJECT_TYPES.table;
const CONNECTION_KIND = SQL_STUDIO_OBJECT_TYPES.connection;
const QUERY_KIND = SQL_STUDIO_OBJECT_TYPES.query;
const RESULT_SET_KIND = SQL_STUDIO_OBJECT_TYPES.resultSet;
const WORKSPACE_KIND = SQL_STUDIO_OBJECT_TYPES.workspace;

/* ───────────────────────────── action handler seam ───────────────────────────── */

/**
 * The live SQL Studio callbacks the declared action verbs delegate to.
 *
 * Every handler returns `true` when it DID something and `false` when its target is absent in
 * the current UI state (no active connection / no selected node / no result set / one tab …);
 * a `false` becomes a `noop` with no journal entry (R-04's "at most a noop"). Components
 * register only the keys they own, and each component reads its CURRENT closures through a
 * latest-value ref so a declaration never captures stale React state.
 */
export interface DatabaseClientActionHandlers {
  readonly connectionNew: () => boolean;
  readonly connectionEdit: (connectionId: string) => boolean;
  readonly connectionDelete: (connectionId: string) => boolean;
  readonly connectionDisconnect: () => boolean;
  readonly connectionRetry: () => boolean;
  readonly schemaViewColumns: () => boolean;
  readonly schemaOpenData: () => boolean;
  readonly schemaNewQuery: () => boolean;
  readonly queryRun: () => boolean;
  readonly queryRunAll: () => boolean;
  readonly tabNew: () => boolean;
  readonly tabClose: (tabId: string) => boolean;
  readonly resultsLoadMore: () => boolean;
  readonly resultsExportCsv: () => boolean;
  readonly resultsExportJson: () => boolean;
  readonly historyClear: () => boolean;
}

type PartialActionHandlers = Partial<DatabaseClientActionHandlers>;

let actionHandlers: PartialActionHandlers = {};

/**
 * Register the handlers one component owns. The returned disposer removes ONLY the keys still
 * pointing at this registration (so a sibling registration is never clobbered).
 */
export function registerDatabaseClientActionHandlers(
  handlers: PartialActionHandlers,
): () => void {
  actionHandlers = { ...actionHandlers, ...handlers };
  return () => {
    const next: PartialActionHandlers = { ...actionHandlers };
    for (const key of Object.keys(handlers) as (keyof DatabaseClientActionHandlers)[]) {
      if (next[key] === handlers[key]) delete next[key];
    }
    actionHandlers = next;
  };
}

/** Test-only: drop every registered handler so a suite starts from the unmounted state. */
export function resetDatabaseClientActionHandlersForTests(): void {
  actionHandlers = {};
}

/* ───────────────────────────── helpers ───────────────────────────── */

const always = (): boolean => true;

/** The selection id carried for `kind`, or `null` (§D.4 kinds/ids are index-aligned). */
export function selectedIdOf(ctx: ContextSnapshot, kind: string): string | null {
  const index = ctx.selection.kinds.indexOf(kind);
  return index < 0 ? null : (ctx.selection.ids[index] ?? null);
}

/** A selection-scoped availability predicate — reads ONLY `ctx` (AC5). */
function selectionHas(kind: string): (ctx: ContextSnapshot) => boolean {
  return (ctx) => ctx.selection.kinds.includes(kind);
}

/**
 * Build the §D.4 selection from the live app state. Kinds/ids are index-aligned in the FIXED
 * order `connection, table, query, resultSet`; absent objects are omitted.
 */
export function buildDatabaseClientSelection(input: {
  readonly connectionId: string | null;
  readonly tableId: string | null;
  readonly queryId: string | null;
  readonly resultSetId: string | null;
}): SelectionSnapshot {
  const kinds: string[] = [];
  const ids: string[] = [];
  const push = (kind: string, id: string | null): void => {
    if (id === null) return;
    kinds.push(kind);
    ids.push(id);
  };
  push(CONNECTION_KIND, input.connectionId);
  push(TABLE_KIND, input.tableId);
  push(QUERY_KIND, input.queryId);
  push(RESULT_SET_KIND, input.resultSetId);
  return {
    count: ids.length,
    kinds,
    ids,
    label: kinds.length > 0 ? kinds[kinds.length - 1] : null,
  };
}

/** A non-undoable, attributed action (identity / focus / session — never a document edit). */
function navigation(label: string): VerbEffect {
  return { effect: 'navigation', label, patch: null, inverse: null, target: [] };
}

/** `patch: null` ⇒ the funnel reports `did-nothing` and writes NO journal entry. */
function noop(label: string): VerbEffect {
  return { effect: 'mutation', label, patch: null, inverse: null, target: [] };
}

/** Run one registered action; `false` (or no handler) is a noop. */
function acted(handlers: PartialActionHandlers, key: keyof DatabaseClientActionHandlers): boolean {
  const handler = handlers[key];
  return handler === undefined ? false : (handler as () => boolean)();
}

const optionalConnectionId: VerbArg = {
  name: 'connectionId',
  type: 'string',
  required: false,
};
const optionalTabId: VerbArg = { name: 'tabId', type: 'string', required: false };

/* ───────────────────────────── verb descriptor builder ───────────────────────────── */

interface VerbSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly objects: readonly string[];
  readonly places: readonly string[];
  readonly risk: Risk;
  readonly available: (ctx: ContextSnapshot) => boolean;
  readonly run: (intent: { readonly args: Readonly<Record<string, string>> }, ctx: ContextSnapshot) => VerbEffect;
  readonly args?: readonly VerbArg[];
  readonly publish?: boolean;
  readonly consequence?: string;
  readonly externalParty?: string;
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
    ...(spec.externalParty === undefined ? {} : { externalParty: spec.externalParty }),
    publish: spec.publish ?? true,
  };
}

/* ───────────────────────────── the 20 verbs (§B.5) ───────────────────────────── */

const CONNECTION = [CONNECTION_KIND] as const;
const TABLE = [TABLE_KIND] as const;
const QUERY = [QUERY_KIND] as const;
const RESULT_SET = [RESULT_SET_KIND] as const;
const WORKSPACE = [WORKSPACE_KIND] as const;

const WORKSPACE_PLACES = [SQL_STUDIO_WORKSPACE_PLACE_ID] as const;
const SCHEMA_PLACES = [SQL_STUDIO_SCHEMA_PLACE_ID] as const;
const QUERY_PLACES = [SQL_STUDIO_QUERY_PLACE_ID] as const;
const RESULTS_PLACES = [SQL_STUDIO_RESULTS_PLACE_ID] as const;

const VERBS: readonly VerbDescriptor[] = [
  /* ── connection-level verbs (root place) ── */
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.connectionNew,
    title: 'New connection',
    description: 'Open the connection form to add a saved connection.',
    objects: CONNECTION,
    places: WORKSPACE_PLACES,
    risk: 'safe',
    available: always,
    run: () => (acted(actionHandlers, 'connectionNew') ? navigation('New connection') : noop('New connection')),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.connectionEdit,
    title: 'Edit connection',
    description: 'Open the connection form pre-filled from the selected connection.',
    objects: CONNECTION,
    places: WORKSPACE_PLACES,
    risk: 'safe',
    available: selectionHas(CONNECTION_KIND),
    args: [optionalConnectionId],
    run: (intent, ctx) => {
      const id = intent.args.connectionId ?? selectedIdOf(ctx, CONNECTION_KIND);
      const ok = id !== null && (actionHandlers.connectionEdit?.(id) ?? false);
      return ok ? navigation('Edit connection') : noop('Edit connection');
    },
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.connectionDelete,
    title: 'Delete connection',
    description: 'Remove the selected saved connection and its local SQL Studio data.',
    objects: CONNECTION,
    places: WORKSPACE_PLACES,
    risk: 'destructive',
    consequence:
      'Removes the saved connection, its query history and its saved queries from Fredo.',
    available: selectionHas(CONNECTION_KIND),
    args: [optionalConnectionId],
    run: (intent, ctx) => {
      const id = intent.args.connectionId ?? selectedIdOf(ctx, CONNECTION_KIND);
      const ok = id !== null && (actionHandlers.connectionDelete?.(id) ?? false);
      return ok ? navigation('Delete connection') : noop('Delete connection');
    },
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.connectionDisconnect,
    title: 'Disconnect',
    description: 'Close the live pool session for the active connection.',
    objects: CONNECTION,
    places: WORKSPACE_PLACES,
    risk: 'mutating',
    available: selectionHas(CONNECTION_KIND),
    run: () =>
      acted(actionHandlers, 'connectionDisconnect')
        ? navigation('Disconnect')
        : noop('Disconnect'),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.connectionRetry,
    title: 'Retry connections',
    description: 'Reload the saved-connection list from the backend.',
    objects: CONNECTION,
    places: WORKSPACE_PLACES,
    risk: 'mutating',
    available: always,
    run: () =>
      acted(actionHandlers, 'connectionRetry') ? navigation('Retry connections') : noop('Retry connections'),
  }),

  /* ── table-scoped verbs (schema place) ── */
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.schemaViewColumns,
    title: 'View columns',
    description: 'Show the selected table’s columns in the schema inspector.',
    objects: TABLE,
    places: SCHEMA_PLACES,
    risk: 'safe',
    available: selectionHas(TABLE_KIND),
    run: () =>
      acted(actionHandlers, 'schemaViewColumns') ? navigation('View columns') : noop('View columns'),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.schemaOpenData,
    title: 'Open table data',
    description: 'Open a new tab with the bounded, read-only SELECT for the selected table.',
    objects: TABLE,
    places: SCHEMA_PLACES,
    risk: 'safe',
    available: selectionHas(TABLE_KIND),
    run: () =>
      acted(actionHandlers, 'schemaOpenData') ? navigation('Open table data') : noop('Open table data'),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.schemaNewQuery,
    title: 'New query from object',
    description: 'Open a new, empty query tab for the selected schema object.',
    objects: TABLE,
    places: SCHEMA_PLACES,
    risk: 'safe',
    available: selectionHas(TABLE_KIND),
    run: () =>
      acted(actionHandlers, 'schemaNewQuery') ? navigation('New query from object') : noop('New query from object'),
  }),

  /* ── editor + tab verbs (query place) ── */
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.queryRun,
    title: 'Run query',
    description: 'Execute the selection, or the statement at the caret (Ctrl/Cmd+Enter).',
    objects: QUERY,
    places: QUERY_PLACES,
    risk: 'destructive',
    consequence: 'Executes SQL against the live database.',
    available: always,
    run: () => (acted(actionHandlers, 'queryRun') ? navigation('Run query') : noop('Run query')),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.queryRunAll,
    title: 'Run all',
    description: 'Execute every statement in the active tab.',
    objects: QUERY,
    places: QUERY_PLACES,
    risk: 'destructive',
    consequence: 'Executes every statement in the tab against the live database.',
    available: always,
    run: () => (acted(actionHandlers, 'queryRunAll') ? navigation('Run all') : noop('Run all')),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.tabNew,
    title: 'New query tab',
    description: 'Append a new query tab and activate it.',
    objects: QUERY,
    places: QUERY_PLACES,
    risk: 'safe',
    available: always,
    run: () => (acted(actionHandlers, 'tabNew') ? navigation('New query tab') : noop('New query tab')),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.tabClose,
    title: 'Close query tab',
    description: 'Close the active query tab.',
    objects: QUERY,
    places: QUERY_PLACES,
    risk: 'destructive',
    consequence: "Discards the tab's SQL text and result sets.",
    available: selectionHas(QUERY_KIND),
    args: [optionalTabId],
    run: (intent, ctx) => {
      const id = intent.args.tabId ?? selectedIdOf(ctx, QUERY_KIND);
      const ok = id !== null && (actionHandlers.tabClose?.(id) ?? false);
      return ok ? navigation('Close query tab') : noop('Close query tab');
    },
  }),

  /* ── result-set verbs (results place) ── */
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.resultsLoadMore,
    title: 'Load more rows',
    description: 'Slice the next page from the already-executed result set.',
    objects: RESULT_SET,
    places: RESULTS_PLACES,
    risk: 'mutating',
    available: selectionHas(RESULT_SET_KIND),
    run: () =>
      acted(actionHandlers, 'resultsLoadMore') ? navigation('Load more rows') : noop('Load more rows'),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.resultsExportCsv,
    title: 'Export CSV',
    description: 'Export the loaded result rows as a CSV file.',
    objects: RESULT_SET,
    places: RESULTS_PLACES,
    risk: 'external',
    consequence: 'Writes a CSV file to your file system.',
    externalParty: 'your file system',
    available: selectionHas(RESULT_SET_KIND),
    run: () =>
      acted(actionHandlers, 'resultsExportCsv') ? navigation('Export CSV') : noop('Export CSV'),
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.resultsExportJson,
    title: 'Export JSON',
    description: 'Export the loaded result rows as a JSON file.',
    objects: RESULT_SET,
    places: RESULTS_PLACES,
    risk: 'external',
    consequence: 'Writes a JSON file to your file system.',
    externalParty: 'your file system',
    available: selectionHas(RESULT_SET_KIND),
    run: () =>
      acted(actionHandlers, 'resultsExportJson') ? navigation('Export JSON') : noop('Export JSON'),
  }),

  /* ── history verb (root place) ── */
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.historyClear,
    title: 'Clear history',
    description: "Remove this connection's local query history.",
    objects: CONNECTION,
    places: WORKSPACE_PLACES,
    risk: 'destructive',
    consequence: "Removes this connection's local query history from Fredo.",
    available: selectionHas(CONNECTION_KIND),
    run: () => (acted(actionHandlers, 'historyClear') ? navigation('Clear history') : noop('Clear history')),
  }),

  /* ── navigation-only verbs (never published; never a companion row) ── */
  defineVerb({
    // D-9 — the child-place id IS a declared navigation verb so the rail place row is live.
    id: SQL_STUDIO_SCHEMA_PLACE_ID,
    title: 'Schema place',
    description: 'Move the cursor into the schema place.',
    objects: WORKSPACE,
    places: SCHEMA_PLACES,
    risk: 'safe',
    available: always,
    run: () => navigation('Schema'),
    publish: false,
  }),
  defineVerb({
    id: SQL_STUDIO_QUERY_PLACE_ID,
    title: 'Query place',
    description: 'Move the cursor into the query place.',
    objects: WORKSPACE,
    places: QUERY_PLACES,
    risk: 'safe',
    available: always,
    run: () => navigation('Query'),
    publish: false,
  }),
  defineVerb({
    id: SQL_STUDIO_RESULTS_PLACE_ID,
    title: 'Results place',
    description: 'Move the cursor into the results place.',
    objects: WORKSPACE,
    places: RESULTS_PLACES,
    risk: 'safe',
    available: always,
    run: () => navigation('Results'),
    publish: false,
  }),
  defineVerb({
    id: SQL_STUDIO_VERB_IDS.appMap,
    title: 'Map',
    description: 'Open the navigation map of every place, verb and key.',
    objects: WORKSPACE,
    places: WORKSPACE_PLACES,
    risk: 'safe',
    available: always,
    run: () => navigation('Map'),
    publish: false,
  }),
];

/* ───────────────────────────── places (§B.3) ───────────────────────────── */

/** §2.3 — the observable hook every place MUST carry. */
const OBSERVABLE_HOOK = 'observable';

function place(id: string, label: string, parent: string | null, sticky: boolean): PlaceNode {
  return {
    id,
    label,
    parent,
    // The root sets NEITHER transient NOR sticky (§2.1); a child sets exactly one.
    transient: false,
    sticky,
    cursor: null,
    operator: null,
    // No place key exists in SQL Studio — Ctrl/Cmd+Enter stays on the editor (D-3(b)).
    keys: {},
    entryHooks: [OBSERVABLE_HOOK],
    exitHooks: [OBSERVABLE_HOOK],
  };
}

const PLACES: readonly PlaceNode[] = [
  place(SQL_STUDIO_WORKSPACE_PLACE_ID, 'Workspace', null, false),
  place(SQL_STUDIO_SCHEMA_PLACE_ID, 'Schema', SQL_STUDIO_WORKSPACE_PLACE_ID, true),
  place(SQL_STUDIO_QUERY_PLACE_ID, 'Query', SQL_STUDIO_WORKSPACE_PLACE_ID, true),
  place(SQL_STUDIO_RESULTS_PLACE_ID, 'Results', SQL_STUDIO_WORKSPACE_PLACE_ID, true),
];

/* ───────────────────────────── the declaration ───────────────────────────── */

/** The ONE SQL Studio surface declaration (ST-4). */
export const databaseClientSurface: Surface = {
  tree: {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    root: SQL_STUDIO_WORKSPACE_PLACE_ID,
    places: PLACES,
    // No `data-hotkey` / `g+*` migrates: SQL Studio owns no grammar-expressible key.
    directAliases: {},
  },
  verbs: VERBS,
  companion: {
    appName: 'SQL Studio',
    description: 'Browse schemas, run queries and manage connections.',
  },
};

/** The complete declared verb-id set (QA R-01 / R-21 read this instead of a literal list). */
export const DATABASE_CLIENT_VERB_IDS: readonly string[] = VERBS.map((verb) => verb.id);
