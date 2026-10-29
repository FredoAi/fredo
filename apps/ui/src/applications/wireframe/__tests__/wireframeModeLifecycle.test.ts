/**
 * Mode-lifecycle proof (Spec #3098, ST-6) — AC5 against the REAL Wireframe
 * surface.
 *
 * Pins, with no product change and no mocks of the surface:
 *   - CLOSE RESET: an application window closing prunes its mode stack + open
 *     prompt through the SAME runtime path the chrome close uses
 *     (`closeWindow` → `handleWindowSnapshotChange` in `commandSurfaceStore`),
 *     leaving `getModePath('wireframe')` at the DERIVED root and no prompt,
 *     with both body hooks cleared and no Wireframe badge left in the bar;
 *   - REOPEN: after the reset the derived root read is
 *     `['wireframe.select']`; a FRESH provider mount resolves the body hook and
 *     the bar badge to `wireframe.select`, with no prompt restored and no stale
 *     recorded stack underneath;
 *   - STICKY vs TRANSIENT: with the real `wireframeCommandSurface` +
 *     `commandSurfaceStore`, `wireframe.pan` survives a command invocation
 *     (sticky) while a draw mode returns to `wireframe.select` through the
 *     executor's invocation-time return;
 *   - BAR FOLLOWS FOCUS: the bottom bar is the focused surface app's
 *     (badge `data-mode-app`/`data-mode-id` moves off Wireframe, and no
 *     `command:wireframe.` row remains), and the A1 carrier scope keeps the
 *     Wireframe `g+*` carrier at ZERO listed rows / ZERO resolved bindings
 *     while another application is displayed — surface or non-surface.
 *
 * Only the real modules are used: `@/applications/wireframe` (the registered
 * app), `wireframeCommandSurface`, the module-scoped store, the window kernel,
 * the real `HotkeysProvider`/`HotkeyBar` wiring, the real hidden carrier, and
 * the shipped DEV fixture application as the "second surface app" lever
 * (`commandSurfaceBar.test.tsx` / `commandSurfaceFixtureBridge.ts` pattern).
 */

import { act, cleanup } from '@testing-library/react';
import { createElement, type HTMLAttributes, type ReactElement } from 'react';
import { LuAppWindow } from 'react-icons/lu';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Registers the real Wireframe application (barrel side-effect).
import '@/applications/wireframe';
import {
  WIREFRAME_DRAW_RECT_COMMAND_ID,
  WIREFRAME_DRAW_RECT_MODE_ID,
  WIREFRAME_EDIT_FILL_COMMAND_ID,
  WIREFRAME_PAN_MODE_ID,
  WIREFRAME_SELECT_MODE_COMMAND_ID,
  WIREFRAME_SELECT_MODE_ID,
  WIREFRAME_TOGGLE_PAN_COMMAND_ID,
} from '@/applications/wireframe/wireframeCommandSurface';
import { WireframeHotkeyCarrier } from '@/applications/wireframe/components/WireframeHotkeyCarrier';
import { WIREFRAME_APP_ID } from '@/applications/wireframe/model/document';
import { getApplications, registerApplication } from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes';
import { resolveFocusedApplicationId } from '@/shared/hotkeys/applicationFocus';
import {
  ensureFixtureApplicationsRegistered,
  FIXTURE_ALPHA_ID,
} from '@/shared/hotkeys/commandSurfaceFixture';
import {
  BODY_ACTIVE_MODE_ATTR,
  BODY_COMMAND_PROMPT_ATTR,
  executeCommand,
  getCommandSurfaceSnapshot,
  getModePath,
  getOpenCommandPrompt,
  installCommandSurfaceRuntime,
  pushMode,
  resetCommandSurfaceForTests,
} from '@/shared/hotkeys/commandSurfaceStore';
import {
  getFocusSnapshot,
  resetHotkeyEngineForTests,
  resolveActiveBindings,
} from '@/shared/hotkeys/engine';
import { HOTKEY_BAR_MODE_TESTID, HOTKEY_BAR_ROW_TESTID } from '@/shared/hotkeys/HotkeyBar';
import { buildHotkeyBarModel } from '@/shared/hotkeys/hotkeyBarModel';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';
import {
  flushElementHotkeys,
  listElementHotkeys,
  resetHotkeyElementDiscoveryForTests,
} from '@/shared/hotkeys/hotkeyElements';
import {
  closeWindow,
  focusWindow,
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A registered application that declares NO command surface (the non-opting leg). */
const NON_SURFACE_APP_ID = 'lifecycle-non-surface';
const NON_SURFACE_FOCUS_TESTID = 'lifecycle-non-surface-focus';

/** The carrier binding count (the 12 hidden `g+*` table bindings). */
const CARRIER_BINDING_COUNT = 12;

const CARRIER_SELECTOR = '[data-testid="wireframe-hotkey-carrier"]';

class NonSurfaceStubApp extends FredoApplicationClass {
  readonly id = NON_SURFACE_APP_ID;
  readonly name = 'Lifecycle non-surface';
  readonly icon = LuAppWindow;

  render(): ReactElement {
    return null as unknown as ReactElement;
  }
}

// The registry has no reset (module state for the webview's lifetime) — register
// the stub ONCE, exactly like `commandSurfaceBar.test.tsx` does.
registerApplication(new NonSurfaceStubApp());

/**
 * A `data-*`-only props bag for `createElement` — the object-literal excess
 * property check does not know the `data-*` vocabulary, the DOM does.
 */
function dataProps<T extends HTMLElement>(props: Record<string, string>): HTMLAttributes<T> {
  return props as unknown as HTMLAttributes<T>;
}

/** Open one registered application's window exactly like the DEV bridge does. */
function openApplicationWindow(appId: string): void {
  const application = getApplications().find((candidate) => candidate.id === appId);
  if (application === undefined) throw new Error(`application not registered: ${appId}`);
  openWindow({
    id: application.id,
    title: application.name,
    icon: createElement(application.icon),
    component: application.render(),
    canClose: true,
  });
}

function modeBadge(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${HOTKEY_BAR_MODE_TESTID}"]`);
}

function rowActionIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`[data-testid="${HOTKEY_BAR_ROW_TESTID}"]`),
  ).map((row) => row.getAttribute('data-hotkey-action') ?? '');
}

/** Feature-tier resolved bindings for one displayed application (`[]` = nothing live). */
function liveFeatureBindings(focusedAppId: string | null): string[] {
  return resolveActiveBindings(focusedAppId)
    .filter((binding) => binding.tier === 'feature')
    .map((binding) => binding.serialized);
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetWindowStoreForTests();
  resetCommandSurfaceForTests();
  resetHotkeyElementDiscoveryForTests();
  resetHotkeyEngineForTests();
});

afterEach(() => {
  cleanup();
  resetCommandSurfaceForTests();
  resetHotkeyElementDiscoveryForTests();
  resetHotkeyEngineForTests();
  resetWindowStoreForTests();
  document.body.innerHTML = '';
});

// ── AC5 — close resets the mode stack + drops the prompt ─────────────────────

describe('wireframe mode lifecycle — window close', () => {
  it('resets to the root, drops the open prompt and unmounts the Wireframe badge', () => {
    // The real provider installs the ONE command-surface runtime — the same
    // runtime whose window subscription owns `handleWindowSnapshotChange`
    // (commandSurfaceStore.ts:537-548), the prune path the chrome close uses.
    const { container } = renderWithChakra(createElement(HotkeysProvider));

    act(() => {
      openApplicationWindow(WIREFRAME_APP_ID);
      executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_COMMAND_ID);
      executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID);
    });

    // Pre-close state: a transient draw mode pushed on top of the root, the
    // fill prompt open, both body hooks mirroring the focused app.
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_RECT_MODE_ID,
    ]);
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).not.toBeNull();
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe(
      WIREFRAME_DRAW_RECT_MODE_ID,
    );
    expect(document.body.getAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(
      WIREFRAME_EDIT_FILL_COMMAND_ID,
    );
    expect(modeBadge(container)).toHaveAttribute('data-mode-app', WIREFRAME_APP_ID);
    expect(modeBadge(container)).toHaveAttribute(
      'data-mode-id',
      WIREFRAME_DRAW_RECT_MODE_ID,
    );

    // Drive the SAME path the chrome close drives (no reimplementation):
    // closeWindow → window subscription → handleWindowSnapshotChange prunes.
    act(() => closeWindow(WIREFRAME_APP_ID));

    // The recorded stack is gone: the pure read derives [root] again.
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).toBeNull();
    expect(getCommandSurfaceSnapshot()).toMatchObject({
      appId: null,
      modePath: [],
      prompt: null,
    });

    // Nothing is displayed any more: both body hooks clear and the bar drops
    // the Wireframe badge entirely (no mode, no rows, no prompt).
    expect(document.body.hasAttribute(BODY_ACTIVE_MODE_ATTR)).toBe(false);
    expect(document.body.hasAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(false);
    expect(modeBadge(container)).toBeNull();
    expect(rowActionIds(container)).toHaveLength(0);
  });
});

// ── AC5 — reopen starts in Select ────────────────────────────────────────────

describe('wireframe mode lifecycle — reopen', () => {
  it('derives the root, mounts a fresh select badge and restores no prompt/stack', () => {
    const release = installCommandSurfaceRuntime();
    openApplicationWindow(WIREFRAME_APP_ID);
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_COMMAND_ID);
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID);
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).not.toBeNull();

    act(() => closeWindow(WIREFRAME_APP_ID));
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
    release();

    // Reopen the window, then mount the shipped provider FRESH.
    act(() => openApplicationWindow(WIREFRAME_APP_ID));
    const { container } = renderWithChakra(createElement(HotkeysProvider));

    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).toBeNull();
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe(
      WIREFRAME_SELECT_MODE_ID,
    );
    expect(modeBadge(container)).toHaveAttribute('data-mode-id', WIREFRAME_SELECT_MODE_ID);
    expect(modeBadge(container)).toHaveAttribute('data-mode-app', WIREFRAME_APP_ID);
    // No prompt is restored on the fresh mount.
    expect(container.querySelector('[data-testid="hotkeys-keybar-prompt"]')).toBeNull();

    // There is no STALE stack underneath the root: a new pan push nests one
    // level deep off the root only (a surviving draw stack would yield
    // [select, draw.rect, pan]).
    act(() => pushMode(WIREFRAME_APP_ID, WIREFRAME_PAN_MODE_ID));
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_PAN_MODE_ID,
    ]);
  });
});

// ── Sticky vs transient on the REAL surface ──────────────────────────────────

describe('wireframe mode lifecycle — sticky vs transient', () => {
  it('keeps pan (sticky) after a command and returns a draw mode to select (transient)', () => {
    const release = installCommandSurfaceRuntime();
    openApplicationWindow(WIREFRAME_APP_ID);

    // Root command → pushes the STICKY pan mode; the root invocation itself
    // never auto-returns (root stays root).
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_TOGGLE_PAN_COMMAND_ID);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_PAN_MODE_ID,
    ]);

    // A real table command invoked while pan is active leaves pan on the stack.
    executeCommand(WIREFRAME_APP_ID, 'wireframe.zoom.in');
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_PAN_MODE_ID,
    ]);

    // Disabling pan returns to the root through the same command.
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_TOGGLE_PAN_COMMAND_ID);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);

    // Draw modes are TRANSIENT: the executor captures the invocation mode and
    // returns it to its parent after a non-throwing run.
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_COMMAND_ID);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_RECT_MODE_ID,
    ]);

    executeCommand(WIREFRAME_APP_ID, 'wireframe.zoom.in');
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);

    executeCommand(WIREFRAME_APP_ID, WIREFRAME_SELECT_MODE_COMMAND_ID);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
    release();
  });
});

// ── AC5 R2 — the bar follows focus; the carrier is dead off-surface (A1) ─────

describe('wireframe mode lifecycle — bar follows focus', () => {
  it('moves the badge off Wireframe and keeps the carrier at zero live bindings (A1)', () => {
    ensureFixtureApplicationsRegistered();

    act(() => {
      openApplicationWindow(WIREFRAME_APP_ID);
      executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_COMMAND_ID);
    });

    // The real provider + the REAL hidden carrier mounted inside a real
    // `[data-fredo-app-id="wireframe"]` root; the non-surface stub gives the
    // no-surface focused leg its own root.
    const { container } = renderWithChakra(
      createElement(
        HotkeysProvider,
        null,
        createElement(
          'div',
          dataProps<HTMLDivElement>({ 'data-fredo-app-id': WIREFRAME_APP_ID }),
          createElement(WireframeHotkeyCarrier),
        ),
        createElement(
          'div',
          dataProps<HTMLDivElement>({ 'data-fredo-app-id': NON_SURFACE_APP_ID }),
          createElement(
            'button',
            dataProps<HTMLButtonElement>({ 'data-testid': NON_SURFACE_FOCUS_TESTID }),
            'focus me',
          ),
        ),
      ),
    );

    // Deterministic listing (the provider installed the ONE discovery).
    flushElementHotkeys();
    const listing = listElementHotkeys();
    expect(listing).toHaveLength(CARRIER_BINDING_COUNT);
    expect(
      listing.filter(
        (entry) => entry.element.closest(CARRIER_SELECTOR) !== null,
      ),
    ).toHaveLength(CARRIER_BINDING_COUNT);

    // Wireframe focused IN A MODE → the bar is Wireframe's, rows are that
    // mode's own keymap (r/e/c/v in keymapOrder).
    expect(modeBadge(container)).toHaveAttribute('data-mode-app', WIREFRAME_APP_ID);
    expect(modeBadge(container)).toHaveAttribute('data-mode-id', WIREFRAME_DRAW_RECT_MODE_ID);
    expect(rowActionIds(container)).toEqual([
      'command:wireframe.wireframe.mode.draw.rect',
      'command:wireframe.wireframe.mode.draw.ellipse',
      'command:wireframe.wireframe.element.editFill',
      'command:wireframe.wireframe.mode.select',
    ]);
    // Control: while Wireframe is the displayed surface its carrier is LIVE.
    expect(liveFeatureBindings(WIREFRAME_APP_ID)).toHaveLength(CARRIER_BINDING_COUNT);

    // Return to Select so the refocus leg observes the ROOT badge.
    act(() => executeCommand(WIREFRAME_APP_ID, WIREFRAME_SELECT_MODE_COMMAND_ID));
    expect(modeBadge(container)).toHaveAttribute('data-mode-id', WIREFRAME_SELECT_MODE_ID);

    // Focus a DIFFERENT surface app (the shipped DEV fixture) → the bar is that
    // app's, with no Wireframe badge and no Wireframe row anywhere.
    act(() => openApplicationWindow(FIXTURE_ALPHA_ID));
    expect(resolveFocusedApplicationId()).toBe(FIXTURE_ALPHA_ID);
    const otherBadge = modeBadge(container);
    expect(otherBadge).not.toBeNull();
    expect(otherBadge).toHaveAttribute('data-mode-app', FIXTURE_ALPHA_ID);
    expect(otherBadge?.getAttribute('data-mode-id') ?? '').not.toMatch(/^wireframe\./);
    expect(
      container.querySelectorAll('[data-hotkey-action^="command:wireframe."]'),
    ).toHaveLength(0);

    // A1 — the occupied carrier contributes ZERO resolved bindings …
    expect(liveFeatureBindings(FIXTURE_ALPHA_ID)).toEqual([]);
    // … and ZERO listed element rows on the real listing path.
    const elementRows = buildHotkeyBarModel({
      entries: listElementHotkeys(),
      pending: null,
      focus: getFocusSnapshot(),
      activeMode: null,
      prompt: null,
    });
    expect(elementRows.rows).toHaveLength(0);

    // Refocusing Wireframe restores the `wireframe.select` badge.
    act(() => focusWindow(WIREFRAME_APP_ID));
    expect(resolveFocusedApplicationId()).toBe(WIREFRAME_APP_ID);
    expect(modeBadge(container)).toHaveAttribute('data-mode-app', WIREFRAME_APP_ID);
    expect(modeBadge(container)).toHaveAttribute('data-mode-id', WIREFRAME_SELECT_MODE_ID);

    // Non-surface leg: a focused app with NO surface shows no badge at all, and
    // the carrier still resolves/list nothing.
    const stubButton = container.querySelector<HTMLButtonElement>(
      `[data-testid="${NON_SURFACE_FOCUS_TESTID}"]`,
    );
    if (stubButton === null) throw new Error('missing non-surface focus target');
    act(() => stubButton.focus());
    expect(resolveFocusedApplicationId()).toBe(NON_SURFACE_APP_ID);
    expect(modeBadge(container)).toBeNull();
    expect(
      container.querySelectorAll('[data-hotkey-action^="command:wireframe."]'),
    ).toHaveLength(0);
    expect(liveFeatureBindings(NON_SURFACE_APP_ID)).toEqual([]);
    const nonSurfaceRows = buildHotkeyBarModel({
      entries: listElementHotkeys(),
      pending: null,
      focus: getFocusSnapshot(),
      activeMode: null,
      prompt: null,
    });
    expect(nonSurfaceRows.rows).toHaveLength(0);
  });
});
