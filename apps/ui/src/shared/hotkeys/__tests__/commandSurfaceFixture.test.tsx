/**
 * Spec #3097 ST-6 — the DEV fixture bridge + fixture DOM contract, and the
 * prompt-focus stability integration pin for the store's display-identity fallback.
 *
 * Pins:
 *   - `activate()` is idempotent (one window per fixture app, one registry entry
 *     per id, one panel each);
 *   - `deactivate()` closes both windows, resets their mode/prompt/panel state
 *     (`getModePath` → `[]` — the bridge reports an empty path for a closed app;
 *     the store itself derives the root `['browse']` while the app is open) and a
 *     subsequent `activate()` works again;
 *   - the bridge API (`executeCommand` without args ⇒ no prompt, args JSON +
 *     `data-command-runs` +1; `getModePath`);
 *   - the binding fixture DOM contract (root attributes, tool control, element
 *     `x` click receipt, the plain in-app input, the value sink);
 *   - focusing the bar's prompt input does NOT clear the snapshot (`appId` /
 *     `modePath` / `prompt`) and the prompt stays mounted + focused.
 */

import React, { Fragment, useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, waitFor } from '@testing-library/react';

import { getApplications } from '@/applications/applicationRegistry';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  getWindowSnapshot,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';

import { APP_ROOT_ATTR, resolveFocusedApplicationId } from '../applicationFocus';
import { getApplicationCommandMode } from '../commandSurface';
import {
  executeCommand,
  getCommandSurfaceSnapshot,
  getModePath,
  getOpenCommandPrompt,
  installCommandSurfaceRuntime,
  pushMode,
  resetCommandSurfaceForTests,
  resolveCommandSurface,
  useCommandSurface,
} from '../commandSurfaceStore';
import type { CommandSurfaceSnapshot } from '../commandSurfaceStore';
import {
  HOTKEY_BAR_PROMPT_INPUT_TESTID,
  HOTKEY_BAR_PROMPT_TESTID,
  HotkeyBar,
} from '../HotkeyBar';
import { buildHotkeyBarModel } from '../hotkeyBarModel';
import type { HotkeyBarModeView, HotkeyBarPromptView } from '../hotkeyBarModel';
import type { FocusSnapshot } from '../engine';
import { installCommandSurfaceFixtureBridge } from '../commandSurfaceFixtureBridge';
import { HotkeysProvider } from '../HotkeysProvider';
import {
  FIXTURE_ALPHA_ID,
  FIXTURE_APP_IDS,
  FIXTURE_BETA_ID,
  FIXTURE_BETA_CAPTURE_COMMAND_ID,
  FIXTURE_BROWSE_MODE_ID,
  FIXTURE_CAPTURE_COMMAND_ID,
  FIXTURE_ELEMENT_KEY,
  FIXTURE_ELEMENT_TESTID,
  FIXTURE_ELEMENT_VALUE,
  FIXTURE_PIN_MODE_ID,
  FIXTURE_ROOT_TESTID,
  FIXTURE_TOOL_MODE_ID,
  FIXTURE_TOOL_TESTID,
  FIXTURE_VALUE_TESTID,
} from '../commandSurfaceFixture';

// ── Helpers ──────────────────────────────────────────────────────────────────

function bridge(): NonNullable<Window['__fredoCommandSurfaceFixture']> {
  const installed = window.__fredoCommandSurfaceFixture;
  if (installed === undefined) throw new Error('fixture bridge not installed');
  return installed;
}

function fixtureWindows() {
  return getWindowSnapshot().filter((entry) => FIXTURE_APP_IDS.includes(entry.id));
}

function fixtureApplications() {
  return getApplications().filter((application) => FIXTURE_APP_IDS.includes(application.id));
}

const DEFAULT_FOCUS: FocusSnapshot = { context: 'default', nativeConsumes: false, textEntry: false };

/**
 * A minimal stand-in for the provider's wiring: the live snapshot → the bar
 * model → the shipped `HotkeyBar`. Deliberately the same derivation the
 * `HotkeysProvider` uses, without the engine/discovery side effects.
 */
function BarHarness(): React.ReactElement {
  const snapshot = useCommandSurface();
  const activeMode = useMemo<HotkeyBarModeView | null>(() => {
    const { appId, modePath } = snapshot;
    if (appId === null || modePath.length === 0) return null;
    const surface = resolveCommandSurface(appId);
    if (surface === null) return null;
    const modeId = modePath[modePath.length - 1];
    const mode = getApplicationCommandMode(surface, modeId);
    if (mode === null) return null;
    return { appId, modeId, label: mode.label, path: modePath };
  }, [snapshot]);
  const prompt = useMemo<HotkeyBarPromptView | null>(() => {
    const { appId, prompt: state } = snapshot;
    if (appId === null || state === null) return null;
    return {
      appId,
      commandId: state.commandId,
      label: state.label,
      placeholder: state.placeholder,
      value: state.value,
    };
  }, [snapshot]);
  const model = useMemo(
    () => buildHotkeyBarModel({ entries: [], pending: null, focus: DEFAULT_FOCUS, activeMode, prompt }),
    [activeMode, prompt],
  );
  return <HotkeyBar model={model} reducedMotion />;
}

function renderFixturePanel(appId: string) {
  const entry = fixtureWindows().find((candidate) => candidate.id === appId);
  if (entry === undefined) throw new Error(`fixture window not open: ${appId}`);
  return renderWithChakra(entry.component as React.ReactElement);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let uninstallBridge: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  resetWindowStoreForTests();
  resetCommandSurfaceForTests();
  uninstallBridge = installCommandSurfaceFixtureBridge();
});

afterEach(() => {
  cleanup();
  uninstallBridge?.();
  uninstallBridge = null;
  resetCommandSurfaceForTests();
  resetWindowStoreForTests();
  document.body.innerHTML = '';
});

// ── activate / deactivate ────────────────────────────────────────────────────

describe('commandSurfaceFixture — activate / deactivate', () => {
  it('activate() is idempotent: two calls open exactly one window + one registry entry per app', () => {
    bridge().activate();
    bridge().activate();

    expect(fixtureWindows().map((entry) => entry.id).sort()).toEqual(
      [FIXTURE_ALPHA_ID, FIXTURE_BETA_ID].sort(),
    );
    expect(fixtureApplications().map((application) => application.id).sort()).toEqual(
      [FIXTURE_ALPHA_ID, FIXTURE_BETA_ID].sort(),
    );

    const { container } = renderWithChakra(
      <>
        {fixtureWindows().map((entry) => (
          <Fragment key={entry.id}>{entry.component}</Fragment>
        ))}
      </>,
    );
    expect(container.querySelectorAll(`[data-testid="${FIXTURE_ROOT_TESTID}"]`)).toHaveLength(2);
  });

  it('deactivate() closes both windows, resets modes/prompts, and a fresh activate() works', () => {
    bridge().activate();
    pushMode(FIXTURE_ALPHA_ID, FIXTURE_TOOL_MODE_ID);
    pushMode(FIXTURE_BETA_ID, FIXTURE_PIN_MODE_ID);
    expect(bridge().getModePath(FIXTURE_ALPHA_ID)).toEqual([
      FIXTURE_BROWSE_MODE_ID,
      FIXTURE_TOOL_MODE_ID,
    ]);

    bridge().deactivate();

    expect(fixtureWindows()).toHaveLength(0);
    // The bridge reports an EMPTY path for a closed app (the store derives the
    // root path only while a surface is resolvable/displayed).
    expect(bridge().getModePath(FIXTURE_ALPHA_ID)).toEqual([]);
    expect(bridge().getModePath(FIXTURE_BETA_ID)).toEqual([]);
    expect(getOpenCommandPrompt(FIXTURE_ALPHA_ID)).toBeNull();
    expect(getModePath(FIXTURE_ALPHA_ID)).toEqual([FIXTURE_BROWSE_MODE_ID]);

    bridge().activate();
    expect(fixtureWindows()).toHaveLength(2);
  });

  it('openApp() opens one fixture window and ignores unknown ids', () => {
    bridge().openApp(FIXTURE_ALPHA_ID);
    expect(fixtureWindows().map((entry) => entry.id)).toEqual([FIXTURE_ALPHA_ID]);

    bridge().openApp('not-a-fixture');
    expect(fixtureWindows().map((entry) => entry.id)).toEqual([FIXTURE_ALPHA_ID]);
  });

  it('the provider installs the DEV bridge on mount and removes it on unmount', async () => {
    // Drop the per-test manual install so the provider's own DEV effect owns it.
    uninstallBridge?.();
    uninstallBridge = null;
    expect(window.__fredoCommandSurfaceFixture).toBeUndefined();

    const { unmount } = renderWithChakra(
      <HotkeysProvider>
        <span />
      </HotkeysProvider>,
    );

    await waitFor(() => expect(window.__fredoCommandSurfaceFixture).toBeDefined());

    unmount();
    await waitFor(() => expect(window.__fredoCommandSurfaceFixture).toBeUndefined());
  });
});

// ── Bridge API ───────────────────────────────────────────────────────────────

describe('commandSurfaceFixture — bridge executor', () => {
  it('executeCommand() with args skips the prompt, runs once, records value + args JSON', () => {
    bridge().activate();
    const { container } = renderFixturePanel(FIXTURE_ALPHA_ID);

    act(() => {
      bridge().executeCommand(FIXTURE_ALPHA_ID, FIXTURE_CAPTURE_COMMAND_ID, { value: '42' });
    });

    expect(getOpenCommandPrompt(FIXTURE_ALPHA_ID)).toBeNull();
    const root = container.querySelector<HTMLElement>(
      `[data-testid="${FIXTURE_ROOT_TESTID}"]`,
    );
    const sink = container.querySelector<HTMLElement>(
      `[data-testid="${FIXTURE_VALUE_TESTID}"]`,
    );
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute('data-command-runs', '1');
    expect(sink).not.toBeNull();
    expect(sink).toHaveTextContent('42');
    expect(sink).toHaveAttribute('data-command-id', FIXTURE_CAPTURE_COMMAND_ID);
    expect(sink).toHaveAttribute('data-command-args-capture', '{"value":"42"}');
  });

  it('the two apps bind `c` to DIFFERENT command ids (the same-key discriminator)', () => {
    bridge().activate();
    const alphaSurface = resolveCommandSurface(FIXTURE_ALPHA_ID);
    const betaSurface = resolveCommandSurface(FIXTURE_BETA_ID);
    expect(alphaSurface).not.toBeNull();
    expect(betaSurface).not.toBeNull();

    const alphaTool = getApplicationCommandMode(alphaSurface!, FIXTURE_TOOL_MODE_ID);
    const betaTool = getApplicationCommandMode(betaSurface!, FIXTURE_TOOL_MODE_ID);
    expect(alphaTool?.keymap.c).toBe(FIXTURE_CAPTURE_COMMAND_ID);
    expect(betaTool?.keymap.c).toBe(FIXTURE_BETA_CAPTURE_COMMAND_ID);
    expect(alphaTool?.keymap.c).not.toBe(betaTool?.keymap.c);
  });
});

// ── DOM contract ─────────────────────────────────────────────────────────────

describe('commandSurfaceFixture — binding DOM contract', () => {
  it('exposes the root attributes, the tool control, the element receipt and the input', () => {
    bridge().activate();
    const { container } = renderFixturePanel(FIXTURE_ALPHA_ID);

    const root = container.querySelector<HTMLElement>(
      `[data-testid="${FIXTURE_ROOT_TESTID}"]`,
    );
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute('data-command-operator', 'fixture-drag');
    expect(root).toHaveAttribute('data-command-cursor', 'crosshair');
    expect(root).toHaveAttribute('data-command-runs', '0');
    expect(root?.querySelector('input')).not.toBeNull();

    const tool = container.querySelector<HTMLElement>(
      `[data-testid="${FIXTURE_TOOL_TESTID}"]`,
    );
    if (tool === null) throw new Error('tool control missing');
    act(() => {
      tool.click();
    });
    expect(getModePath(FIXTURE_ALPHA_ID)).toEqual([
      FIXTURE_BROWSE_MODE_ID,
      FIXTURE_TOOL_MODE_ID,
    ]);

    const element = container.querySelector<HTMLElement>(
      `[data-testid="${FIXTURE_ELEMENT_TESTID}"]`,
    );
    if (element === null) throw new Error('element receipt missing');
    expect(element).toHaveAttribute('data-hotkey', FIXTURE_ELEMENT_KEY);
    act(() => {
      element.click();
    });

    const sink = container.querySelector<HTMLElement>(
      `[data-testid="${FIXTURE_VALUE_TESTID}"]`,
    );
    expect(root).toHaveAttribute('data-command-runs', '1');
    expect(sink).toHaveTextContent(FIXTURE_ELEMENT_VALUE);
  });

  it('beta has NO `data-hotkey="x"` element (the same stroke must not activate it)', () => {
    bridge().activate();
    const { container } = renderFixturePanel(FIXTURE_BETA_ID);
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${FIXTURE_ELEMENT_TESTID}"]`,
    );
    expect(element).not.toBeNull();
    expect(element).not.toHaveAttribute('data-hotkey');
  });
});

// ── Prompt-focus stability (store display-identity fallback) ─────────────────

describe('commandSurfaceFixture — prompt focus keeps the bar bound', () => {
  it('focusing the prompt input does NOT clear appId/modePath/prompt; the prompt stays mounted + focused', () => {
    bridge().activate();
    const release = installCommandSurfaceRuntime();

    const appRoot = document.createElement('div');
    appRoot.setAttribute(APP_ROOT_ATTR, FIXTURE_ALPHA_ID);
    document.body.appendChild(appRoot);
    const restoreTarget = document.createElement('button');
    appRoot.appendChild(restoreTarget);
    restoreTarget.focus();
    expect(resolveFocusedApplicationId()).toBe(FIXTURE_ALPHA_ID);

    const { container } = renderWithChakra(<BarHarness />);

    act(() => {
      executeCommand(FIXTURE_ALPHA_ID, FIXTURE_CAPTURE_COMMAND_ID);
    });

    const promptInput = container.querySelector<HTMLInputElement>(
      `[data-testid="${HOTKEY_BAR_PROMPT_INPUT_TESTID}"]`,
    );
    expect(promptInput).not.toBeNull();
    expect(document.activeElement).toBe(promptInput);

    // The bar is platform chrome: the PURE resolver sees no application while
    // the prompt input owns focus...
    expect(resolveFocusedApplicationId()).toBeNull();

    // ...but the store's display identity falls back to the prompt wrapper's
    // `data-app-id`, so the snapshot (and therefore the mounted prompt) is kept.
    const snapshot: CommandSurfaceSnapshot = getCommandSurfaceSnapshot();
    expect(snapshot.appId).toBe(FIXTURE_ALPHA_ID);
    expect(snapshot.modePath).toEqual([FIXTURE_BROWSE_MODE_ID]);
    expect(snapshot.prompt?.commandId).toBe(FIXTURE_CAPTURE_COMMAND_ID);

    expect(
      container.querySelector(`[data-testid="${HOTKEY_BAR_PROMPT_TESTID}"]`),
    ).not.toBeNull();
    expect(document.activeElement).toBe(promptInput);

    release();
  });
});
