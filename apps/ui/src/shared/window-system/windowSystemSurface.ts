/**
 * Window-traversal navigation surface (Spec #3121, ST-2 — P7 fleet migration).
 *
 * The window system is platform chrome, not an application window, so it declares the ONE
 * place `window-system.root` (windows are OBJECTS, not places) and the four verbs of the
 * plan's §B.5 window row, in the reserved `window.*` verb namespace (§3.3). The three
 * modifier chords that drive it are NOT expressible in the §4.4 grammar (D-3(a)), so they
 * stay kept platform globals and DELEGATE into this surface's host through
 * `runIntent({channel:'keyboard'})` — key → verb id → outcome is provable, and no
 * app-local key table is introduced.
 *
 * Probe 1 (§B.4): the object type is `window`; the focused window id is the selection.
 * Probe 2 (§B.3): the root sets NEITHER `transient` NOR `sticky` (a plain root place).
 * Probe 3 (§B.5): `app.map` is declared `publish:false` with NO key.
 *
 * No behaviour change: `window.focus.next` / `window.focus.previous` run the SHIPPED
 * `focusNextWindow()` / `focusPreviousWindow()` (raise + DOM focus placement,
 * `traversal.ts:223-230`), and `window.launcher.toggle` runs the SHIPPED launcher toggle
 * handler registered with the shared hotkeys registry (`LauncherShell.tsx:1538-1559`).
 */

import type {
  ContextSnapshot,
  PlaceNode,
  Surface,
  VerbDescriptor,
  VerbEffect,
} from '../navigation';
import { focusNextWindow, focusPreviousWindow } from '../hotkeys/traversal';
import { runWindowLauncherToggle } from './launcherToggleSeam';
import { getWindowSnapshot } from './windowStore';

/* ───────────────────────────── bound names ───────────────────────────── */

/** §B.2 — the surface app id. */
export const WINDOW_SYSTEM_APP_ID = 'window-system';

/** §B.3 — the one root place (windows are objects, never places). */
export const WINDOW_SYSTEM_ROOT_PLACE_ID = 'window-system.root';

/** §B.5 — the four declared verb ids (`window.*` namespace). */
export const WINDOW_FOCUS_NEXT_VERB_ID = 'window.focus.next';
export const WINDOW_FOCUS_PREVIOUS_VERB_ID = 'window.focus.previous';
export const WINDOW_LAUNCHER_TOGGLE_VERB_ID = 'window.launcher.toggle';
export const WINDOW_APP_MAP_VERB_ID = 'app.map';

/** §B.4 — the object type every window verb applies to. */
export const WINDOW_OBJECT_TYPE = 'window';

/* ───────────────────────────── effects ───────────────────────────── */

/** A `patch:null` effect — the engine reports `noop` and writes no journal entry. */
function noop(label: string): VerbEffect {
  return { effect: 'mutation', label, patch: null, inverse: null, target: [] };
}

/** An attributed, non-undoable navigation effect (a focus move / affordance). */
function navigation(label: string): VerbEffect {
  return { effect: 'navigation', label, patch: null, inverse: null, target: [] };
}

/* ───────────────────────────── declaration ───────────────────────────── */

const ROOT = WINDOW_SYSTEM_ROOT_PLACE_ID;
const OBJECTS = [WINDOW_OBJECT_TYPE] as const;
const always = (): boolean => true;

/**
 * The launcher toggle run. The SHIPPED toggle lives in `LauncherShell` and registers itself
 * with the window-system seam (`launcherToggleSeam.ts`) for its mounted lifetime, so the
 * declared verb reproduces the exact shipped outcome (`selectCtrlSpaceAction` verdict +
 * `openOverlay`) without a second toggle path and WITHOUT re-entering the shared hotkeys
 * registry (whose launcher run is the delegating override — a registry round-trip would
 * recurse). No shell mounted ⇒ no launcher to toggle ⇒ `noop` (no journal entry).
 */
function toggleLauncher(): VerbEffect {
  return runWindowLauncherToggle()
    ? navigation('Toggle launcher')
    : noop('Toggle launcher');
}

const VERBS: readonly VerbDescriptor[] = [
  {
    id: WINDOW_FOCUS_NEXT_VERB_ID,
    title: 'Next window',
    description: 'Raise the next open window and place keyboard focus inside it.',
    appliesTo: { objects: [...OBJECTS], places: [ROOT] },
    args: [],
    available: always,
    risk: 'safe',
    aliases: [],
    run: () => (focusNextWindow() ? navigation('Next window') : noop('Next window')),
    publish: true,
  },
  {
    id: WINDOW_FOCUS_PREVIOUS_VERB_ID,
    title: 'Previous window',
    description: 'Raise the previous open window and place keyboard focus inside it.',
    appliesTo: { objects: [...OBJECTS], places: [ROOT] },
    args: [],
    available: always,
    risk: 'safe',
    aliases: [],
    run: () => (focusPreviousWindow() ? navigation('Previous window') : noop('Previous window')),
    publish: true,
  },
  {
    id: WINDOW_LAUNCHER_TOGGLE_VERB_ID,
    title: 'Toggle launcher',
    description: 'Show or focus the launcher command bar.',
    appliesTo: { objects: [...OBJECTS], places: [ROOT] },
    args: [],
    available: always,
    risk: 'safe',
    aliases: [],
    run: () => toggleLauncher(),
    publish: false,
  },
  {
    id: WINDOW_APP_MAP_VERB_ID,
    title: 'Map',
    description: 'Open the navigation map of every place, verb and key.',
    appliesTo: { objects: [...OBJECTS], places: [ROOT] },
    args: [],
    available: always,
    risk: 'safe',
    aliases: [],
    run: () => navigation('Map'),
    publish: false,
  },
];

/** §B.3 — the single place. `transient`/`sticky` are both false on a root place. */
const PLACES: readonly PlaceNode[] = [
  {
    id: ROOT,
    label: 'Window',
    parent: null,
    transient: false,
    sticky: false,
    cursor: null,
    operator: null,
    keys: {},
    entryHooks: [],
    exitHooks: [],
  },
];

/** The ONE window-system surface declaration (ST-2). */
export const windowSystemSurface: Surface = {
  tree: {
    appId: WINDOW_SYSTEM_APP_ID,
    root: ROOT,
    places: PLACES,
    directAliases: {},
  },
  verbs: VERBS,
  companion: {
    appName: 'Window System',
    description: 'Traverse, raise and focus the open windows.',
  },
};

/* ───────────────────────────── context projection ───────────────────────────── */

/**
 * The injected read model (§D.4 window row): the focused window id is the selection;
 * the place path is the single root. The provider publishes focus changes through
 * `host.refreshContext()` — never a remount or a poll.
 */
export function getWindowSystemContext(): ContextSnapshot {
  const focusedId = getWindowSnapshot().find((win) => win.focused)?.id ?? null;
  return {
    appId: WINDOW_SYSTEM_APP_ID,
    placePath: [ROOT],
    selection:
      focusedId === null
        ? { count: 0, kinds: [], label: null, ids: [] }
        : { count: 1, kinds: [WINDOW_OBJECT_TYPE], label: WINDOW_OBJECT_TYPE, ids: [focusedId] },
    dirty: false,
  };
}
