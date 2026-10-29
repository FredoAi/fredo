/**
 * Spec #3097 ST-3 — AC5 single-execution guard + the engine wiring.
 *
 * Pins, through the REAL keydown path (`handleHotkeyKeydown`):
 *   - one handler invocation per trigger (never twice for one keystroke), driven
 *     through BOTH a declared mode key and `executeCommand(appId, commandId, args)`,
 *     with deep-equal resolved args;
 *   - a mode-key-triggered prompt commit running the handler exactly once with
 *     `{ value }`;
 *   - invocation-time mode semantics (a root command that pushes a mode leaves it
 *     active; a command invoked inside a non-sticky mode pops exactly that mode);
 *   - in-app text-entry precedence (a mode key typed into an in-app control is
 *     inert);
 *   - `resolveActiveBindings(focusedAppId)` scoping (an element inside another
 *     application's root never fires, an app-less element still resolves).
 *
 * `engine.test.ts` / `sequence.test.ts` stay unmodified; this file is additive.
 */

import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LuAppWindow } from 'react-icons/lu';

import { registerApplication } from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import { getAnnouncement, resetHotkeyAnnouncer } from '../announcer';
import { APP_ROOT_ATTR } from '../applicationFocus';
import type { ApplicationCommandSurface } from '../commandSurface';
import {
  executeCommand,
  getModePath,
  getOpenCommandPrompt,
  pushMode,
  resetCommandSurfaceForTests,
  setCommandPromptValue,
} from '../commandSurfaceStore';
import {
  handleHotkeyKeydown,
  resolveActiveBindings,
  resetHotkeyEngineForTests,
} from '../engine';
import {
  flushElementHotkeys,
  resetHotkeyElementDiscoveryForTests,
} from '../hotkeyElements';
import { resetRegistryForTests } from '../registry';
import type { DispatchDecision } from '../types';

const ALPHA = 'exec-alpha';
const BETA = 'exec-beta';

// ── Fixtures (registered once per module) ────────────────────────────────────

const capture = vi.fn();
const find = vi.fn();
const betaCommand = vi.fn();
const openTool = vi.fn(() => {
  pushMode(ALPHA, 'tool');
});

function alphaSurface(): ApplicationCommandSurface {
  return {
    modes: [
      { id: 'browse', label: 'Browse', parent: null, keymap: { t: 'open-tool', q: 'capture', f: 'find' } },
      { id: 'tool', label: 'Tool', parent: 'browse', keymap: { c: 'capture' } },
    ],
    commands: [
      { id: 'open-tool', title: 'Open tool', run: openTool },
      { id: 'capture', title: 'Capture', run: capture },
      { id: 'find', title: 'Find', prompt: { label: 'Find value' }, run: find },
    ],
  };
}

function betaSurface(): ApplicationCommandSurface {
  return {
    modes: [{ id: 'browse', label: 'Browse', parent: null, keymap: { t: 'beta-command' } }],
    commands: [{ id: 'beta-command', title: 'Beta command', run: betaCommand }],
  };
}

class StubApplication extends FredoApplicationClass {
  readonly id: string;
  readonly name: string;
  readonly icon = LuAppWindow;
  readonly commandSurface?: ApplicationCommandSurface;

  constructor(id: string, commandSurface?: ApplicationCommandSurface) {
    super();
    this.id = id;
    this.name = id;
    this.commandSurface = commandSurface;
  }

  render(): ReactElement {
    return null as unknown as ReactElement;
  }
}

registerApplication(new StubApplication(ALPHA, alphaSurface()));
registerApplication(new StubApplication(BETA, betaSurface()));

// ── Harness helpers ──────────────────────────────────────────────────────────

interface MountedApp {
  readonly root: HTMLDivElement;
  readonly focus: HTMLDivElement;
}

function mountApp(appId: string): MountedApp {
  const root = document.createElement('div');
  root.setAttribute(APP_ROOT_ATTR, appId);
  const focus = document.createElement('div');
  focus.tabIndex = -1;
  root.appendChild(focus);
  document.body.appendChild(root);
  return { root, focus };
}

/** Simulate the bar's rendered prompt (ST-4 owns the component; this is its DOM). */
function mountPromptUi(appId: string): HTMLInputElement {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-testid', 'hotkeys-keybar-prompt');
  wrapper.setAttribute('data-app-id', appId);
  const input = document.createElement('input');
  input.setAttribute('data-testid', 'hotkeys-keybar-prompt-input');
  wrapper.appendChild(input);
  document.body.appendChild(wrapper);
  input.focus();
  return input;
}

function dispatch(init: KeyboardEventInit): { decision: DispatchDecision; prevented: boolean } {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  const decision = handleHotkeyKeydown(event);
  return { decision, prevented: event.defaultPrevented };
}

function mountHotkeyButton(root: HTMLElement, hotkey: string): { button: HTMLButtonElement; clicks: () => number } {
  let count = 0;
  const button = document.createElement('button');
  button.setAttribute('data-hotkey', hotkey);
  button.addEventListener('click', () => {
    count += 1;
  });
  root.appendChild(button);
  return { button, clicks: () => count };
}

function featureBindings(): string[] {
  return resolveActiveBindings()
    .filter((binding) => binding.tier === 'feature')
    .map((binding) => binding.serialized);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
  resetWindowStoreForTests();
  resetCommandSurfaceForTests();
  resetHotkeyAnnouncer();
  resetHotkeyEngineForTests();
  resetHotkeyElementDiscoveryForTests();
  resetRegistryForTests();
  for (const handler of [capture, find, betaCommand, openTool]) handler.mockClear();
});

afterEach(() => {
  resetCommandSurfaceForTests();
  resetHotkeyElementDiscoveryForTests();
  resetHotkeyEngineForTests();
  resetWindowStoreForTests();
  resetHotkeyAnnouncer();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── AC5 — one execution per trigger, identical resolved args ─────────────────

describe('#3097 AC5 — a mode key runs the handler exactly once', () => {
  it('fires once per keystroke and never re-runs on a second dispatch', () => {
    const app = mountApp(ALPHA);
    app.focus.focus();

    const first = dispatch({ key: 'q' });
    expect(first.decision.outcome).toBe('command');
    expect(first.decision.command).toEqual({
      appId: ALPHA,
      commandId: 'capture',
      promptAction: 'none',
    });
    expect(first.prevented).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);

    // A different key never re-runs the previous command.
    dispatch({ key: 'z' });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(betaCommand).not.toHaveBeenCalled();

    // One more trigger = exactly one more call (never a double dispatch).
    dispatch({ key: 'q' });
    expect(capture).toHaveBeenCalledTimes(2);
  });
});

describe('#3097 AC5 — both entry paths resolve identical args', () => {
  it('mode key → prompt commit and executeCommand(..., args) produce deep-equal calls', () => {
    const app = mountApp(ALPHA);
    app.focus.focus();

    // Path A: the declared mode key opens the prompt; Enter commits the draft.
    dispatch({ key: 'f' });
    expect(getOpenCommandPrompt(ALPHA)).not.toBeNull();
    expect(find).not.toHaveBeenCalled();

    setCommandPromptValue(ALPHA, '42');
    mountPromptUi(ALPHA);
    const commit = dispatch({ key: 'Enter' });
    expect(commit.decision.outcome).toBe('command');
    expect(commit.decision.reason).toBe('command:prompt-commit');
    expect(find).toHaveBeenCalledTimes(1);
    const fromModeKey = find.mock.calls[0];

    // Path B: the same command id through the ONE executor, with explicit args.
    find.mockClear();
    executeCommand(ALPHA, 'find', { value: '42' });
    expect(find).toHaveBeenCalledTimes(1);
    const fromExecutor = find.mock.calls[0];

    expect(fromExecutor).toEqual(fromModeKey);
    expect(fromModeKey).toEqual([{ value: '42' }]);
    expect(getOpenCommandPrompt(ALPHA)).toBeNull();
  });

  it('a non-prompt command is invoked exactly once on both paths with the same (absent) args', () => {
    const app = mountApp(ALPHA);
    app.focus.focus();

    dispatch({ key: 'q' });
    expect(capture).toHaveBeenCalledTimes(1);
    const fromModeKey = capture.mock.calls[0];

    capture.mockClear();
    executeCommand(ALPHA, 'capture');
    expect(capture).toHaveBeenCalledTimes(1);

    expect(capture.mock.calls[0]).toEqual(fromModeKey);
  });

  it('a prompt-backed command invoked WITH args never opens the prompt', () => {
    const app = mountApp(ALPHA);
    app.focus.focus();

    executeCommand(ALPHA, 'find', { value: 'direct' });

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ value: 'direct' });
    expect(getOpenCommandPrompt(ALPHA)).toBeNull();
  });
});

// ── Invocation-time mode semantics (UI/UX U4) ────────────────────────────────

describe('#3097 invocation-time mode semantics', () => {
  it('a root command that pushes a mode leaves that mode active (no pop, no flash)', () => {
    const app = mountApp(ALPHA);
    app.focus.focus();

    dispatch({ key: 't' });

    expect(openTool).toHaveBeenCalledTimes(1);
    expect(getModePath(ALPHA)).toEqual(['browse', 'tool']);
    expect(getAnnouncement()).toBe('Tool mode');
  });

  it('a command invoked inside a non-sticky mode pops exactly that invocation mode', () => {
    const app = mountApp(ALPHA);
    app.focus.focus();
    pushMode(ALPHA, 'tool');
    expect(getModePath(ALPHA)).toEqual(['browse', 'tool']);

    dispatch({ key: 'c' });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(getModePath(ALPHA)).toEqual(['browse']);
  });
});

// ── Escape wiring ────────────────────────────────────────────────────────────

describe('#3097 Escape stack rule through the engine', () => {
  it('prompt Escape cancels exactly once (no handler) and restores focus', () => {
    const app = mountApp(ALPHA);
    app.focus.focus();

    dispatch({ key: 'f' });
    setCommandPromptValue(ALPHA, '99');
    mountPromptUi(ALPHA);

    const { decision, prevented } = dispatch({ key: 'Escape' });

    expect(decision.outcome).toBe('prompt-cancel');
    expect(decision.reason).toBe('prompt-cancel:escape');
    expect(prevented).toBe(true);
    expect(find).not.toHaveBeenCalled();
    expect(getOpenCommandPrompt(ALPHA)).toBeNull();
    expect(document.activeElement).toBe(app.focus);
  });

  it('Escape pops one mode, then is a consumed root no-op', () => {
    const app = mountApp(ALPHA);
    app.focus.focus();
    pushMode(ALPHA, 'tool');

    const pop = dispatch({ key: 'Escape' });
    expect(pop.decision.outcome).toBe('mode-pop');
    expect(pop.decision.reason).toBe('mode-pop:escape');
    expect(pop.prevented).toBe(true);
    expect(getModePath(ALPHA)).toEqual(['browse']);

    const root = dispatch({ key: 'Escape' });
    expect(root.decision.outcome).toBe('suppress');
    expect(root.decision.reason).toBe('mode-escape:root');
    expect(root.prevented).toBe(true);
    expect(getModePath(ALPHA)).toEqual(['browse']);
  });
});

// ── Text-entry precedence ────────────────────────────────────────────────────

describe('#3097 in-app text entry stays inert', () => {
  it('a mode key typed into an in-app input neither dispatches nor is prevented', () => {
    const app = mountApp(ALPHA);
    const input = document.createElement('input');
    app.root.appendChild(input);
    input.focus();

    const { decision, prevented } = dispatch({ key: 'q' });

    expect(decision.outcome).toBe('passthrough');
    expect(decision.reason).toBe('text-entry-passthrough');
    expect(decision.command).toBeUndefined();
    expect(prevented).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});

// ── resolveActiveBindings scoping ────────────────────────────────────────────

describe('#3097 resolveActiveBindings(focusedAppId)', () => {
  it('keeps today’s list with no argument or for a non-opting app', () => {
    const alpha = mountApp(ALPHA);
    const beta = mountApp(BETA);
    mountHotkeyButton(alpha.root, 'y');
    mountHotkeyButton(beta.root, 'y');
    flushElementHotkeys();

    expect(featureBindings()).toEqual(['y', 'y']);
    // 'not-an-app' declares no surface ⇒ unchanged list.
    expect(
      resolveActiveBindings('not-an-app').filter((binding) => binding.tier === 'feature'),
    ).toHaveLength(2);
  });

  it('scopes element bindings to the focused application root', () => {
    const alpha = mountApp(ALPHA);
    const beta = mountApp(BETA);
    const alphaButton = mountHotkeyButton(alpha.root, 'y');
    const betaButton = mountHotkeyButton(beta.root, 'y');
    flushElementHotkeys();

    expect(resolveActiveBindings(ALPHA).filter((b) => b.tier === 'feature')).toHaveLength(1);

    alpha.focus.focus();
    expect(dispatch({ key: 'y' }).prevented).toBe(true);
    expect(alphaButton.clicks()).toBe(1);
    expect(betaButton.clicks()).toBe(0);

    beta.focus.focus();
    expect(dispatch({ key: 'y' }).prevented).toBe(true);
    expect(betaButton.clicks()).toBe(1);
    expect(alphaButton.clicks()).toBe(1);
  });

  it('keeps an app-less (global) element reachable while an opting app is focused', () => {
    const alpha = mountApp(ALPHA);
    const globalButton = mountHotkeyButton(document.body, 'y');
    flushElementHotkeys();

    alpha.focus.focus();
    expect(dispatch({ key: 'y' }).prevented).toBe(true);
    expect(globalButton.clicks()).toBe(1);
  });
});
