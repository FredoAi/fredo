/**
 * Spec #3097 ST-6 — the DEV-ONLY runtime bridge for the command-surface fixture.
 *
 * The live tester cannot append a boot URL param to an already-loaded Tauri
 * webview, so the plan's sanctioned lever (QA Q-2 / deployment notes) is a
 * single DEV-only global:
 *
 *   window.__fredoCommandSurfaceFixture = {
 *     activate(),            // idempotent — registers the two stub apps + opens both windows ONCE
 *     deactivate(),          // closes the fixture windows + resets their mode/prompt/state
 *     openApp(id),           // re-open ONE fixture window
 *     executeCommand(appId, commandId, args?),  // the ONE executor, for the AC5 direct path
 *     getModePath(appId),    // [] while the app's window is closed, else root..top
 *   }
 *
 * It is installed ONLY from `HotkeysProvider`'s `import.meta.env.DEV`-gated
 * dynamic import (and from tests) — a production build tree-shakes this module,
 * its fixture apps and the global. There is NO `document` keydown listener here
 * and nothing is persisted.
 */

import { createElement } from 'react';

import { getApplications } from '../../applications/applicationRegistry';
import { closeWindow, getWindowSnapshot, openWindow } from '../window-system/windowStore';
import type { ApplicationCommandArgs } from './commandSurface';
import {
  executeCommand as executeSurfaceCommand,
  getModePath as getStoreModePath,
  resetApplicationMode,
} from './commandSurfaceStore';
import {
  ensureFixtureApplicationsRegistered,
  FIXTURE_ALPHA_ID,
  FIXTURE_APP_IDS,
  FIXTURE_BETA_ID,
  resetCommandFixtureState,
} from './commandSurfaceFixture';

// ── The public DEV surface ───────────────────────────────────────────────────

export interface CommandSurfaceFixtureBridge {
  /** Idempotent: a second call opens NO duplicate window / re-registers NO stub app. */
  activate(): void;
  /** Close the fixture windows and reset their mode/prompt/panel state. */
  deactivate(): void;
  /** Open one fixture window (`command-fixture-alpha` | `command-fixture-beta`). */
  openApp(id: string): void;
  /** Run one command through the ONE executor (no prompt when `args` are supplied). */
  executeCommand(appId: string, commandId: string, args?: ApplicationCommandArgs): void;
  /** `root..top` mode path while the app's window is open; `[]` once it is closed. */
  getModePath(appId: string): string[];
}

declare global {
  interface Window {
    /** DEV only — absent in a production build. */
    __fredoCommandSurfaceFixture?: CommandSurfaceFixtureBridge;
  }
}

let activated = false;

function findFixtureApplication(appId: string) {
  return getApplications().find((application) => application.id === appId) ?? null;
}

/** Open ONE fixture window unless it is already open (never duplicates). */
function openFixtureWindow(appId: string): void {
  const application = findFixtureApplication(appId);
  if (application === null) return;
  if (getWindowSnapshot().some((entry) => entry.id === appId)) return;
  openWindow({
    id: application.id,
    title: application.name,
    icon: createElement(application.icon),
    component: application.render(),
    canClose: true,
    canMaximize: true,
  });
}

function activate(): void {
  ensureFixtureApplicationsRegistered();
  if (activated) return;
  activated = true;
  for (const appId of FIXTURE_APP_IDS) openFixtureWindow(appId);
}

function deactivate(): void {
  for (const appId of FIXTURE_APP_IDS) {
    closeWindow(appId);
    resetApplicationMode(appId);
    resetCommandFixtureState(appId);
  }
  activated = false;
}

function openApp(id: string): void {
  if (!FIXTURE_APP_IDS.includes(id)) return;
  ensureFixtureApplicationsRegistered();
  openFixtureWindow(id);
}

function executeCommand(
  appId: string,
  commandId: string,
  args?: ApplicationCommandArgs,
): void {
  executeSurfaceCommand(appId, commandId, args);
}

function getModePath(appId: string): string[] {
  if (!getWindowSnapshot().some((entry) => entry.id === appId)) return [];
  return [...getStoreModePath(appId)];
}

const BRIDGE: CommandSurfaceFixtureBridge = Object.freeze({
  activate,
  deactivate,
  openApp,
  executeCommand,
  getModePath,
});

// ── Install / uninstall ──────────────────────────────────────────────────────

let installCount = 0;

/**
 * Install the DEV bridge global. Idempotent by reference count; the returned
 * uninstall removes the global + tears the fixture windows down on the last
 * release (so a provider unmount never strands an orphan dev surface).
 */
export function installCommandSurfaceFixtureBridge(): () => void {
  if (typeof window === 'undefined') return () => {};

  if (installCount === 0) {
    window.__fredoCommandSurfaceFixture = BRIDGE;
  }
  installCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    installCount = Math.max(0, installCount - 1);
    if (installCount === 0) {
      deactivate();
      delete window.__fredoCommandSurfaceFixture;
    }
  };
}

/** Re-exported for tests/tools that want the fixture ids without the panel. */
export { FIXTURE_ALPHA_ID, FIXTURE_BETA_ID };
