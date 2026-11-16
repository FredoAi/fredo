/**
 * Spec #3121 (P7), ST-1 — the ONE Terminal surface declaration.
 *
 * Terminal becomes an ordinary NavigationEngine consumer: two places and the twelve verbs the
 * shipped window already exposes are DATA here, not a Terminal-specific runtime. The provider
 * (`components/TerminalNavigationProvider.tsx`) mounts the P4 `CommandRail` /
 * `NavigationMap` / `ActivityTrail` over this declaration and owns the terminal's passthrough
 * seam (Architect §B.7); `TerminalWindow` registers the handlers that actually run the verbs.
 *
 * BEHAVIOUR-PRESERVING (Architect §0 D-2 / §B.6): the terminal declares NO stroke binding —
 * `terminal.window` and `terminal.session` both bind zero keys and there are no direct
 * aliases, because every keystroke belongs to the PTY while it owns focus. Nothing is
 * invented: there is no split / new-tab / new-window / clear / kill verb, and the only copy
 * action is `terminal.session.copyAuthCommand`.
 *
 * The `terminal.session` place is the PASSTHROUGH place (Architect §B.3): non-root, sticky
 * (a verb never auto-exits it), operated by the PTY (`operator: 'terminal.pty'`), entered by
 * the system on focus-in and left by `place.exit` on focus-out. Its `entryHooks`/`exitHooks`
 * name the observable hook so entry and exit are journaled without application cooperation.
 *
 * PURE DATA + SYNCHRONOUS RUNS: no timers, no IPC, no clock. The only module state is the
 * registered handler set (the TerminalWindow's live callbacks), which is session-scoped and
 * never persisted.
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

/** Architect §B.2 — the surface app id (`TerminalFeature`'s `id`). */
export const TERMINAL_SURFACE_APP_ID = 'terminal';

/** Architect §B.3 — the single root place (every app-level verb lives here). */
export const TERMINAL_WINDOW_PLACE_ID = 'terminal.window';

/** Architect §B.3 — the passthrough child place (the PTY owns the keyboard here). */
export const TERMINAL_SESSION_PLACE_ID = 'terminal.session';

/** Architect §B.3 — the opaque pointer operator the PTY arms. */
export const TERMINAL_PTY_OPERATOR = 'terminal.pty';

/** §2.3 — the observable hook id every place MUST carry. */
const OBSERVABLE_HOOK = 'observable';

/**
 * Architect §B.5 — the ONLY copy-command verb id. Kept as a constant so the QA/parity rows
 * and the declaration never spell it twice.
 */
export const TERMINAL_COPY_AUTH_COMMAND_VERB_ID = 'terminal.session.copyAuthCommand';

/**
 * Architect §B.5/§B.7 — the system-owned entry verb the focus adapter dispatches on focus-in.
 * It navigates; it publishes nothing to the companion manifest.
 */
export const TERMINAL_SESSION_ENTER_VERB_ID = 'terminal.session.enter';

/* ───────────────────────────── handler seam ───────────────────────────── */

/**
 * The live TerminalWindow callbacks the action verbs delegate to.
 *
 * Each handler returns `true` when it DID something and `false` when the target is absent in
 * the current window state (no live session, no persisted record, …); a `false` makes the verb
 * a `noop` with no journal entry (R-04's "at most a noop"). The handler set is registered by
 * the provider from the window's CURRENT closures, so no verb captures stale React state.
 */
export interface TerminalActionHandlers {
  readonly newSession: () => boolean;
  readonly closeSession: (id: string) => boolean;
  /** Open the same inline rename editor the `F2` row path opens. */
  readonly openRename: (id: string) => boolean;
  readonly renameSession: (id: string, name: string) => boolean;
  readonly resumeSession: (id: string) => boolean;
  readonly startFresh: (id: string) => boolean;
  readonly retrySession: (id: string) => boolean;
  readonly chooseDirectory: (id: string) => boolean;
  readonly deleteRecord: (id: string) => boolean;
  readonly copyAuthCommand: () => boolean;
}

let actionHandlers: TerminalActionHandlers | null = null;

/** Register the live handlers (the provider does this on mount). */
export function setTerminalActionHandlers(next: TerminalActionHandlers | null): void {
  actionHandlers = next;
}

/** The currently registered handlers, or `null` outside a mounted terminal window. */
export function getTerminalActionHandlers(): TerminalActionHandlers | null {
  return actionHandlers;
}

/* ───────────────────────────── helpers ───────────────────────────── */

const always = (): boolean => true;
const hasSelection = (ctx: ContextSnapshot): boolean => ctx.selection.count >= 1;

/** A non-undoable, attributed action (identity, selection or focus — never a document edit). */
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
  const argId = intent.args.id;
  if (argId !== undefined && argId.trim().length > 0) return argId;
  return ctx.selection.ids[0] ?? null;
}

const optionalId: VerbArg = { name: 'id', type: 'string', required: false };
const optionalName: VerbArg = { name: 'name', type: 'string', required: false };

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

/* ───────────────────────────── the 12 verbs (§B.5) ───────────────────────────── */

const SESSION = ['session'] as const;
const WINDOW_PLACE = [TERMINAL_WINDOW_PLACE_ID] as const;
const SESSION_PLACE = [TERMINAL_SESSION_PLACE_ID] as const;

const VERBS: readonly VerbDescriptor[] = [
  /* ── app-level session actions (root place) ── */
  defineVerb({
    id: 'terminal.session.new',
    title: 'New session',
    description: 'Open the New Session dialog to start a terminal session.',
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'safe',
    available: always,
    run: () => {
      const handlers = getTerminalActionHandlers();
      return handlers !== null && handlers.newSession()
        ? navigation('New session')
        : noop('New session');
    },
  }),
  defineVerb({
    id: 'terminal.session.close',
    title: 'Close session',
    description: 'End the selected terminal session process.',
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'destructive',
    consequence: "Ends the terminal session's process. The CLI's own transcript is not removed.",
    available: hasSelection,
    args: [optionalId],
    run: (intent, ctx) => {
      const id = sessionIdOf(intent, ctx);
      const handlers = getTerminalActionHandlers();
      return id !== null && handlers !== null && handlers.closeSession(id)
        ? navigation('Close session')
        : noop('Close session');
    },
  }),
  defineVerb({
    id: 'terminal.session.rename',
    title: 'Rename session',
    description: "Rename the selected session's persisted record, or open its inline editor.",
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'mutating',
    available: hasSelection,
    args: [optionalId, optionalName],
    run: (intent, ctx) => {
      const id = sessionIdOf(intent, ctx);
      const handlers = getTerminalActionHandlers();
      if (id === null || handlers === null) return noop('Rename session');
      const name = intent.args.name;
      // No name supplied ⇒ the same inline rename editor the `F2` row path opens (D-3(c)).
      const acted =
        name === undefined || name.trim().length === 0
          ? handlers.openRename(id)
          : handlers.renameSession(id, name.trim());
      return acted ? navigation('Rename session') : noop('Rename session');
    },
  }),
  defineVerb({
    id: 'terminal.session.resume',
    title: 'Resume session',
    description: 'Resume a persisted session record as a live process.',
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'mutating',
    available: hasSelection,
    args: [optionalId],
    run: (intent, ctx) => {
      const id = sessionIdOf(intent, ctx);
      const handlers = getTerminalActionHandlers();
      return id !== null && handlers !== null && handlers.resumeSession(id)
        ? navigation('Resume session')
        : noop('Resume session');
    },
  }),
  defineVerb({
    id: 'terminal.session.startFresh',
    title: 'Start fresh',
    description: 'Replace a persisted session record with a new session.',
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'mutating',
    available: hasSelection,
    args: [optionalId],
    run: (intent, ctx) => {
      const id = sessionIdOf(intent, ctx);
      const handlers = getTerminalActionHandlers();
      return id !== null && handlers !== null && handlers.startFresh(id)
        ? navigation('Start fresh')
        : noop('Start fresh');
    },
  }),
  defineVerb({
    id: 'terminal.session.retry',
    title: 'Retry session',
    description: 'Close a failed session and spawn it again with the same CLI and directory.',
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'mutating',
    available: hasSelection,
    args: [optionalId],
    run: (intent, ctx) => {
      const id = sessionIdOf(intent, ctx);
      const handlers = getTerminalActionHandlers();
      return id !== null && handlers !== null && handlers.retrySession(id)
        ? navigation('Retry session')
        : noop('Retry session');
    },
  }),
  defineVerb({
    id: 'terminal.session.chooseDirectory',
    title: 'Choose directory',
    description: 'Open the session dialog to pick a different working directory.',
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'mutating',
    available: hasSelection,
    args: [optionalId],
    run: (intent, ctx) => {
      const id = sessionIdOf(intent, ctx);
      const handlers = getTerminalActionHandlers();
      return id !== null && handlers !== null && handlers.chooseDirectory(id)
        ? navigation('Choose directory')
        : noop('Choose directory');
    },
  }),
  defineVerb({
    id: 'terminal.session.deleteRecord',
    title: 'Delete record',
    description: "Remove Fredo's persisted record for a session.",
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'destructive',
    consequence: "Removes Fredo's session record. The CLI's own transcript is not removed.",
    available: hasSelection,
    args: [optionalId],
    run: (intent, ctx) => {
      const id = sessionIdOf(intent, ctx);
      const handlers = getTerminalActionHandlers();
      return id !== null && handlers !== null && handlers.deleteRecord(id)
        ? navigation('Delete record')
        : noop('Delete record');
    },
  }),
  defineVerb({
    id: TERMINAL_COPY_AUTH_COMMAND_VERB_ID,
    title: 'Copy auth command',
    description: 'Copy the CLI authentication command to the clipboard.',
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'safe',
    available: always,
    run: () => {
      const handlers = getTerminalActionHandlers();
      return handlers !== null && handlers.copyAuthCommand()
        ? navigation('Copy auth command')
        : noop('Copy auth command');
    },
  }),

  /* ── navigation-only verbs (never published; never a companion row) ── */
  defineVerb({
    id: TERMINAL_SESSION_ENTER_VERB_ID,
    title: 'Session (passthrough)',
    description: 'Enter the passthrough place when the PTY takes the keyboard.',
    objects: SESSION,
    places: SESSION_PLACE,
    risk: 'safe',
    available: always,
    run: () => navigation('Session'),
    publish: false,
  }),
  defineVerb({
    // D-9 — the child-place id IS a declared navigation verb so the rail place row is live.
    id: TERMINAL_SESSION_PLACE_ID,
    title: 'Session place',
    description: 'Move the cursor into the passthrough session place.',
    objects: SESSION,
    places: SESSION_PLACE,
    risk: 'safe',
    available: always,
    run: () => navigation('Session'),
    publish: false,
  }),
  defineVerb({
    id: 'app.map',
    title: 'Map',
    description: 'Open the navigation map of every place, verb and key.',
    objects: SESSION,
    places: WINDOW_PLACE,
    risk: 'safe',
    available: always,
    run: () => navigation('Map'),
    publish: false,
  }),
];

/* ───────────────────────────── places (§B.3) ───────────────────────────── */

function place(
  id: string,
  label: string,
  parent: string | null,
  flags: Partial<Pick<PlaceNode, 'sticky' | 'operator'>> = {},
): PlaceNode {
  return {
    id,
    label,
    parent,
    transient: false,
    sticky: false,
    cursor: null,
    operator: null,
    // §2.3 — every place carries the observable hook on entry AND exit.
    keys: {},
    entryHooks: [OBSERVABLE_HOOK],
    exitHooks: [OBSERVABLE_HOOK],
    ...flags,
  };
}

const PLACES: readonly PlaceNode[] = [
  // The root sets neither `transient` nor `sticky` (§2.1).
  place(TERMINAL_WINDOW_PLACE_ID, 'Terminal', null),
  // The passthrough place: sticky (a verb never auto-exits it), operated by the PTY.
  place(TERMINAL_SESSION_PLACE_ID, 'Session', TERMINAL_WINDOW_PLACE_ID, {
    sticky: true,
    operator: TERMINAL_PTY_OPERATOR,
  }),
];

/* ───────────────────────────── the declaration ───────────────────────────── */

/** The ONE Terminal surface declaration (P7). */
export const terminalSurface: Surface = {
  tree: {
    appId: TERMINAL_SURFACE_APP_ID,
    root: TERMINAL_WINDOW_PLACE_ID,
    places: PLACES,
    // Every keystroke reaches the PTY while it owns focus — the terminal binds NO stroke.
    directAliases: {},
  },
  verbs: VERBS,
  companion: {
    appName: 'Terminal',
    description: 'Run and manage terminal sessions.',
  },
};

/** The complete declared verb-id set (QA R-01 / R-21 read this instead of a literal list). */
export const TERMINAL_VERB_IDS: readonly string[] = VERBS.map((verb) => verb.id);

/** Test-only: drop the registered handlers so a suite starts from the unmounted state. */
export function resetTerminalSurfaceForTests(): void {
  actionHandlers = null;
}
