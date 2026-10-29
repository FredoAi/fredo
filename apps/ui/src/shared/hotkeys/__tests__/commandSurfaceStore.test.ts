/**
 * Spec #3097 ST-2 — the application command-surface runtime store + the ONE
 * command executor.
 *
 * Pins module-scoped mode state (survives blur / remount), root seeding,
 * push/pop/reset, sticky vs non-sticky auto-return, INVOCATION-TIME return
 * (a root command that pushes a mode leaves it active), the inline prompt
 * lifecycle (open/type/commit/cancel + focus restore), the single `run`
 * invocation, body hooks, announcements, app-close pruning, and the snapshot's
 * stable identity.
 */

import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LuAppWindow } from 'react-icons/lu';

import { registerApplication } from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes';
import {
  closeWindow,
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';
import { getAnnouncement, resetHotkeyAnnouncer } from '../announcer';
import { APP_ROOT_ATTR } from '../applicationFocus';
import type {
  ApplicationCommandSpec,
  ApplicationCommandSurface,
} from '../commandSurface';
import {
  BODY_ACTIVE_MODE_ATTR,
  BODY_COMMAND_PROMPT_ATTR,
  cancelCommandPrompt,
  commitCommandPrompt,
  executeCommand,
  getActiveCommandMode,
  getCommandSurfaceSnapshot,
  getModePath,
  getOpenCommandPrompt,
  installCommandSurfaceRuntime,
  popMode,
  pushMode,
  resetApplicationMode,
  resetCommandSurfaceForTests,
  resolveCommandSurface,
  setCommandPromptValue,
  subscribeCommandSurface,
} from '../commandSurfaceStore';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const openTool = vi.fn();
const capture = vi.fn();
const stickyCapture = vi.fn();
const find = vi.fn();
const withArgs = vi.fn();
const exploding = vi.fn(() => {
  throw new Error('boom');
});
const asyncOk = vi.fn(() => Promise.resolve());
const asyncReject = vi.fn(() => Promise.reject(new Error('nope')));

function surfaceApp(): ApplicationCommandSurface {
  const commands: ApplicationCommandSpec[] = [
    {
      id: 'open-tool',
      title: 'Open tool',
      run: () => {
        openTool();
        pushMode('surface-app', 'tool');
      },
    },
    { id: 'capture', title: 'Capture', run: capture },
    { id: 'sticky-capture', title: 'Sticky capture', run: stickyCapture },
    {
      id: 'find',
      title: 'Find file',
      prompt: { label: 'Search', placeholder: 'Term', initialValue: 'x' },
      run: find,
    },
    { id: 'with-args', title: 'With args', prompt: { label: 'Value' }, run: withArgs },
    { id: 'explode', title: 'Explode', run: exploding },
    { id: 'async-ok', title: 'Async ok', run: asyncOk },
    { id: 'async-reject', title: 'Async reject', run: asyncReject },
  ];
  return {
    modes: [
      { id: 'browse', label: 'Browse', parent: null, keymap: { t: 'open-tool' } },
      { id: 'tool', label: 'Tool', parent: 'browse', keymap: { c: 'capture' } },
      {
        id: 'sticky-tool',
        label: 'Sticky',
        parent: 'browse',
        sticky: true,
        keymap: {},
      },
      { id: 'deep', label: 'Deep', parent: 'tool', keymap: {} },
    ],
    commands,
  };
}

function secondSurface(): ApplicationCommandSurface {
  return {
    modes: [
      { id: 'browse', label: 'Browse', parent: null, keymap: {} },
      { id: 'tool', label: 'Tool', parent: 'browse', keymap: {} },
    ],
    commands: [],
  };
}

class SurfaceStub extends FredoApplicationClass {
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

registerApplication(new SurfaceStub('surface-app', surfaceApp()));
registerApplication(new SurfaceStub('second-app', secondSurface()));
registerApplication(new SurfaceStub('plain-app'));

/** The exact surface instance the registry holds (identity is part of the contract). */
const REGISTERED_SURFACE = resolveCommandSurface('surface-app');

function open(id: string): void {
  openWindow({ id, title: id, icon: null, component: null });
}

interface MountedApp {
  readonly root: HTMLDivElement;
  readonly button: HTMLButtonElement;
}

function mountApp(id: string): MountedApp {
  const root = document.createElement('div');
  root.setAttribute(APP_ROOT_ATTR, id);
  document.body.appendChild(root);
  const button = document.createElement('button');
  root.appendChild(button);
  return { root, button };
}

/** Let a resolved-promise `run` settle its auto-return microtask. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
  resetWindowStoreForTests();
  resetCommandSurfaceForTests();
  resetHotkeyAnnouncer();
  for (const handler of [
    openTool,
    capture,
    stickyCapture,
    find,
    withArgs,
    exploding,
    asyncOk,
    asyncReject,
  ]) {
    handler.mockClear();
  }
  const mounted = mountApp('surface-app');
  mounted.button.focus();
});

afterEach(() => {
  resetCommandSurfaceForTests();
  resetWindowStoreForTests();
  document.body.innerHTML = '';
  resetHotkeyAnnouncer();
  vi.restoreAllMocks();
});

// ── Surface + derived path ───────────────────────────────────────────────────

describe('resolveCommandSurface / getModePath', () => {
  it('resolves only opted-in applications', () => {
    expect(REGISTERED_SURFACE).not.toBeNull();
    expect(resolveCommandSurface('surface-app')).toBe(REGISTERED_SURFACE);
    expect(resolveCommandSurface('plain-app')).toBeNull();
    expect(resolveCommandSurface('missing-app')).toBeNull();
    expect(resolveCommandSurface(null)).toBeNull();
  });

  it('derives the root path without mutating the store', () => {
    expect(getModePath('surface-app')).toEqual(['browse']);
    expect(getActiveCommandMode('surface-app')?.id).toBe('browse');
    expect(getModePath('plain-app')).toEqual([]);
    expect(getActiveCommandMode('plain-app')).toBeNull();
    expect(getActiveCommandMode(null)).toBeNull();

    // A pure read never seeded a stack: a root pop is still a no-op.
    expect(popMode('surface-app')).toBe(false);
    expect(getModePath('surface-app')).toEqual(['browse']);
  });

  it('publishes the focused app + root mode as body hooks', () => {
    installCommandSurfaceRuntime();
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe('browse');
    expect(document.body.hasAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(false);
  });
});

// ── Push / pop / reset ───────────────────────────────────────────────────────

describe('pushMode / popMode / resetApplicationMode', () => {
  it('pushes, ignores an unknown mode, and is a no-op when already the top', () => {
    pushMode('surface-app', 'tool');
    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);
    expect(getAnnouncement()).toBe('Tool mode');

    const revision = getCommandSurfaceSnapshot().revision;
    pushMode('surface-app', 'tool');
    pushMode('surface-app', 'not-a-mode');
    expect(getCommandSurfaceSnapshot().revision).toBe(revision);

    pushMode('surface-app', 'deep');
    expect(getModePath('surface-app')).toEqual(['browse', 'tool', 'deep']);
  });

  it('pops one level, announces the new top, and refuses to pop the root', () => {
    pushMode('surface-app', 'tool');
    pushMode('surface-app', 'deep');

    expect(popMode('surface-app')).toBe(true);
    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);
    expect(getAnnouncement()).toBe('Tool mode');

    expect(popMode('surface-app')).toBe(true);
    expect(getModePath('surface-app')).toEqual(['browse']);
    expect(getAnnouncement()).toBe('Browse mode');

    expect(popMode('surface-app')).toBe(false);
    expect(getModePath('surface-app')).toEqual(['browse']);
    expect(getAnnouncement()).toBe('Browse mode');
  });

  it('resets to the root, drops the prompt, and announces the root label', () => {
    pushMode('surface-app', 'tool');
    executeCommand('surface-app', 'find');
    expect(getOpenCommandPrompt('surface-app')).not.toBeNull();

    resetApplicationMode('surface-app');

    expect(getModePath('surface-app')).toEqual(['browse']);
    expect(getOpenCommandPrompt('surface-app')).toBeNull();
    expect(getAnnouncement()).toBe('Browse mode');
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe('browse');
    expect(document.body.hasAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(false);
  });
});

// ── The executor: auto-return ────────────────────────────────────────────────

describe('executeCommand — auto-return semantics', () => {
  it('returns a non-sticky non-root invocation mode to its parent', () => {
    pushMode('surface-app', 'tool');

    executeCommand('surface-app', 'capture', {});

    expect(capture).toHaveBeenCalledTimes(1);
    expect(getModePath('surface-app')).toEqual(['browse']);
    expect(getAnnouncement()).toBe('Browse mode');
  });

  it('keeps a sticky mode active', () => {
    pushMode('surface-app', 'sticky-tool');

    executeCommand('surface-app', 'sticky-capture', {});

    expect(stickyCapture).toHaveBeenCalledTimes(1);
    expect(getModePath('surface-app')).toEqual(['browse', 'sticky-tool']);
  });

  it('keeps the root active (root stays root)', () => {
    executeCommand('surface-app', 'capture', {});

    expect(capture).toHaveBeenCalledTimes(1);
    expect(getModePath('surface-app')).toEqual(['browse']);
  });

  it('does not pop a mode pushed by a root command (invocation-time semantics)', () => {
    executeCommand('surface-app', 'open-tool');

    expect(openTool).toHaveBeenCalledTimes(1);
    // The invocation mode was the ROOT — the pushed `tool` must survive.
    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);
    expect(getActiveCommandMode('surface-app')?.id).toBe('tool');
  });

  it('does not change the mode when run throws synchronously', () => {
    pushMode('surface-app', 'tool');

    expect(() => executeCommand('surface-app', 'explode', {})).not.toThrow();

    expect(exploding).toHaveBeenCalledTimes(1);
    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);
  });

  it('does not change the mode when run rejects, and swallows the rejection', async () => {
    pushMode('surface-app', 'tool');

    executeCommand('surface-app', 'async-reject', {});
    await settle();

    expect(asyncReject).toHaveBeenCalledTimes(1);
    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);
  });

  it('applies the auto-return after a resolved promise', async () => {
    pushMode('surface-app', 'tool');

    executeCommand('surface-app', 'async-ok', {});
    // Still on the invocation mode until the promise resolves.
    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);

    await settle();
    expect(getModePath('surface-app')).toEqual(['browse']);
  });

  it('is a no-op for an unknown app, surface command id, or non-opted-in app', () => {
    expect(() => executeCommand('missing-app', 'capture', {})).not.toThrow();
    executeCommand('surface-app', 'not-a-command', {});
    executeCommand('plain-app', 'capture', {});
    expect(capture).not.toHaveBeenCalled();
    expect(getModePath('surface-app')).toEqual(['browse']);
  });
});

// ── Inline prompt ────────────────────────────────────────────────────────────

describe('executeCommand — inline prompt', () => {
  it('opens the prompt without running when invoked without args', () => {
    executeCommand('surface-app', 'find');

    expect(find).not.toHaveBeenCalled();
    const prompt = getOpenCommandPrompt('surface-app');
    expect(prompt).not.toBeNull();
    expect(prompt).toMatchObject({
      commandId: 'find',
      label: 'Search',
      placeholder: 'Term',
      value: 'x',
    });
    expect(prompt?.restoreElement).toBe(document.activeElement);
    expect(document.body.getAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe('find');
    expect(getAnnouncement()).toBe('Find file value');
    expect(getCommandSurfaceSnapshot().prompt?.commandId).toBe('find');
  });

  it('skips the prompt and runs once when args are supplied', () => {
    executeCommand('surface-app', 'with-args', { value: 'v' });

    expect(withArgs).toHaveBeenCalledTimes(1);
    expect(withArgs).toHaveBeenCalledWith({ value: 'v' });
    expect(getOpenCommandPrompt('surface-app')).toBeNull();
  });

  it('updates the draft only on a real change', () => {
    executeCommand('surface-app', 'find');
    const before = getCommandSurfaceSnapshot();

    setCommandPromptValue('surface-app', 'x'); // unchanged
    expect(getCommandSurfaceSnapshot()).toBe(before);

    setCommandPromptValue('surface-app', 'y');
    const after = getCommandSurfaceSnapshot();
    expect(after).not.toBe(before);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.prompt?.value).toBe('y');
  });

  it('commits the value to that command exactly once, closes, and restores focus', () => {
    const button = document.querySelector('button') as HTMLButtonElement;
    executeCommand('surface-app', 'find');
    setCommandPromptValue('surface-app', 'alpha');
    button.blur();
    expect(document.activeElement).toBe(document.body);

    commitCommandPrompt('surface-app');

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ value: 'alpha' });
    expect(getOpenCommandPrompt('surface-app')).toBeNull();
    expect(document.body.hasAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('applies the invocation mode captured when the prompt opened (non-sticky return)', () => {
    pushMode('surface-app', 'tool');
    executeCommand('surface-app', 'find');

    commitCommandPrompt('surface-app');

    expect(find).toHaveBeenCalledTimes(1);
    expect(getModePath('surface-app')).toEqual(['browse']);
  });

  it('cancels without running, closes the prompt, and restores focus', () => {
    const button = document.querySelector('button') as HTMLButtonElement;
    pushMode('surface-app', 'tool');
    executeCommand('surface-app', 'find');
    button.blur();

    cancelCommandPrompt('surface-app');

    expect(find).not.toHaveBeenCalled();
    expect(getOpenCommandPrompt('surface-app')).toBeNull();
    expect(document.activeElement).toBe(button);
    // Escape pops the prompt only — the mode stays active.
    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);
  });

  it('does not crash when the restore element was detached', () => {
    const button = document.querySelector('button') as HTMLButtonElement;
    executeCommand('surface-app', 'find');
    button.remove();

    expect(() => commitCommandPrompt('surface-app')).not.toThrow();
    expect(find).toHaveBeenCalledTimes(1);
    expect(getOpenCommandPrompt('surface-app')).toBeNull();
  });
});

// ── Body hooks ───────────────────────────────────────────────────────────────

describe('body hooks follow the focused application', () => {
  it('tracks the top mode and the open prompt', () => {
    pushMode('surface-app', 'tool');
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe('tool');

    executeCommand('surface-app', 'find');
    expect(document.body.getAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe('find');

    popMode('surface-app');
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe('browse');
  });

  it('removes both hooks when the focused application has no surface', () => {
    installCommandSurfaceRuntime();
    pushMode('surface-app', 'tool');
    executeCommand('surface-app', 'find');

    const plain = mountApp('plain-app');
    plain.button.focus();

    expect(document.body.hasAttribute(BODY_ACTIVE_MODE_ATTR)).toBe(false);
    expect(document.body.hasAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(false);
  });
});

// ── Snapshot identity ────────────────────────────────────────────────────────

describe('getCommandSurfaceSnapshot — stable identity', () => {
  it('returns the same object between real changes and a new one after a change', () => {
    const first = getCommandSurfaceSnapshot();
    expect(getCommandSurfaceSnapshot()).toBe(first);
    expect(first).toMatchObject({ appId: 'surface-app', modePath: ['browse'], prompt: null });

    pushMode('surface-app', 'tool');
    const second = getCommandSurfaceSnapshot();
    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.modePath).toEqual(['browse', 'tool']);
    expect(getCommandSurfaceSnapshot()).toBe(second);
  });

  it('reports a null app when focus resolves to an app without a surface', () => {
    const plain = mountApp('plain-app');
    plain.button.focus();

    const snapshot = getCommandSurfaceSnapshot();
    expect(snapshot.appId).toBeNull();
    expect(snapshot.modePath).toEqual([]);
    expect(snapshot.prompt).toBeNull();
  });

  it('notifies subscribers only on a real change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCommandSurface(listener);

    pushMode('surface-app', 'tool');
    expect(listener).toHaveBeenCalledTimes(1);

    pushMode('surface-app', 'tool'); // no-op
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

// ── Runtime: blur survives, app close prunes ─────────────────────────────────

describe('installCommandSurfaceRuntime', () => {
  it('keeps the active mode through a window blur/focus', () => {
    const release = installCommandSurfaceRuntime();
    pushMode('surface-app', 'tool');

    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));

    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe('tool');
    release();
  });

  it('re-derives the focused app on focusin/focusout and re-syncs the hooks', () => {
    const release = installCommandSurfaceRuntime();
    const second = mountApp('second-app');
    const surfaceButton = document.querySelector<HTMLButtonElement>(
      `[${APP_ROOT_ATTR}="surface-app"] button`,
    );
    if (surfaceButton === null) throw new Error('missing surface button');

    second.button.focus();
    // focusin is synchronous in jsdom.
    expect(getCommandSurfaceSnapshot().appId).toBe('second-app');
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe('browse');

    surfaceButton.focus();
    expect(getCommandSurfaceSnapshot().appId).toBe('surface-app');
    release();
  });

  it('prunes mode + prompt state for an application window that closes', () => {
    const release = installCommandSurfaceRuntime();
    open('surface-app');
    pushMode('surface-app', 'tool');
    executeCommand('surface-app', 'find');
    expect(getOpenCommandPrompt('surface-app')).not.toBeNull();

    open('second-app');
    pushMode('second-app', 'tool');
    closeWindow('surface-app');

    expect(getModePath('surface-app')).toEqual(['browse']);
    expect(getOpenCommandPrompt('surface-app')).toBeNull();
    // The other application's state is untouched.
    expect(getModePath('second-app')).toEqual(['browse', 'tool']);
    release();
  });

  it('never prunes an application this webview never saw open', () => {
    const release = installCommandSurfaceRuntime();
    pushMode('surface-app', 'tool');

    open('window-only');
    closeWindow('window-only');

    expect(getModePath('surface-app')).toEqual(['browse', 'tool']);
    release();
  });

  it('is idempotent by reference count and clears the hooks on the last release', () => {
    const releaseA = installCommandSurfaceRuntime();
    const releaseB = installCommandSurfaceRuntime();
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe('browse');

    releaseA();
    releaseA();
    expect(getCommandSurfaceSnapshot().appId).toBe('surface-app');

    releaseB();
    expect(document.body.hasAttribute(BODY_ACTIVE_MODE_ATTR)).toBe(false);
    expect(document.body.hasAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(false);
  });
});
