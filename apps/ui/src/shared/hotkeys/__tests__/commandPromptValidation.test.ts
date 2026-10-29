/**
 * Spec #3098 ST-1 — `ApplicationCommandPrompt.validate` (AC2 R3).
 *
 * Pins the additive guard on the ONE prompt commit path:
 *   - `false` keeps the SAME prompt open with its draft (no run, no mode change,
 *     no body-hook change, no focus restore);
 *   - `true` commits exactly once, closes, auto-returns and restores focus;
 *   - absent ⇒ today's merge behaviour (every draft commits);
 *   - Escape still cancels without running, even for a valid draft;
 *   - a rejected draft never poisons the prompt.
 */

import type { ReactElement } from 'react';
import { LuAppWindow } from 'react-icons/lu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerApplication } from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes';
import { resetHotkeyAnnouncer } from '../announcer';
import { APP_ROOT_ATTR } from '../applicationFocus';
import type { ApplicationCommandSpec, ApplicationCommandSurface } from '../commandSurface';
import {
  BODY_ACTIVE_MODE_ATTR,
  BODY_COMMAND_PROMPT_ATTR,
  cancelCommandPrompt,
  commitCommandPrompt,
  executeCommand,
  getModePath,
  getOpenCommandPrompt,
  installCommandSurfaceRuntime,
  pushMode,
  resetCommandSurfaceForTests,
  setCommandPromptValue,
} from '../commandSurfaceStore';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const APP_ID = 'prompt-validate-app';

const applyFill = vi.fn();
const plainRun = vi.fn();
/** Raw-draft guard: trims, so `' accent '` is accepted and only real tokens pass. */
const validateFill = vi.fn((value: string) => value.trim() === 'accent');

function surface(): ApplicationCommandSurface {
  const commands: ApplicationCommandSpec[] = [
    {
      id: 'edit-fill',
      title: 'Fill',
      prompt: {
        label: 'Fill token',
        placeholder: 'accent',
        validate: (value) => validateFill(value),
      },
      run: applyFill,
    },
    {
      id: 'plain',
      title: 'Plain',
      prompt: { label: 'Plain value' },
      run: plainRun,
    },
  ];
  return {
    modes: [
      { id: 'select', label: 'Select', parent: null, keymap: {} },
      { id: 'tool', label: 'Tool', parent: 'select', keymap: {} },
    ],
    commands,
  };
}

class PromptStub extends FredoApplicationClass {
  readonly id = APP_ID;
  readonly name = 'Prompt validate app';
  readonly icon = LuAppWindow;
  readonly commandSurface = surface();

  render(): ReactElement {
    return null as unknown as ReactElement;
  }
}

registerApplication(new PromptStub());

interface MountedApp {
  readonly root: HTMLDivElement;
  readonly button: HTMLButtonElement;
}

function mountApp(): MountedApp {
  const root = document.createElement('div');
  root.setAttribute(APP_ROOT_ATTR, APP_ID);
  document.body.appendChild(root);
  const button = document.createElement('button');
  root.appendChild(button);
  return { root, button };
}

let app: MountedApp;

beforeEach(() => {
  document.body.innerHTML = '';
  resetCommandSurfaceForTests();
  resetHotkeyAnnouncer();
  applyFill.mockClear();
  plainRun.mockClear();
  validateFill.mockClear();
  app = mountApp();
});

afterEach(() => {
  resetCommandSurfaceForTests();
  resetHotkeyAnnouncer();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ── Rejected commit ──────────────────────────────────────────────────────────

describe('commitCommandPrompt — validate returns false', () => {
  it('keeps the SAME prompt open with its draft and changes nothing', () => {
    const release = installCommandSurfaceRuntime();
    app.button.focus();
    pushMode(APP_ID, 'tool');
    executeCommand(APP_ID, 'edit-fill');
    setCommandPromptValue(APP_ID, 'chartreuse');
    const before = getOpenCommandPrompt(APP_ID);
    app.button.blur();
    expect(document.activeElement).toBe(document.body);

    commitCommandPrompt(APP_ID);

    expect(validateFill).toHaveBeenCalledTimes(1);
    expect(validateFill).toHaveBeenCalledWith('chartreuse');
    expect(applyFill).not.toHaveBeenCalled();
    // The SAME prompt record survives — draft, command id and restore target.
    expect(getOpenCommandPrompt(APP_ID)).toBe(before);
    expect(getOpenCommandPrompt(APP_ID)).toMatchObject({
      commandId: 'edit-fill',
      value: 'chartreuse',
    });
    // No mode change (an accidental commit would auto-return to `select`).
    expect(getModePath(APP_ID)).toEqual(['select', 'tool']);
    expect(document.body.getAttribute(BODY_ACTIVE_MODE_ATTR)).toBe('tool');
    // No document/body mutation.
    expect(document.body.getAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe('edit-fill');
    // No focus restore on a rejected commit — the caller stays where it was.
    expect(document.activeElement).toBe(document.body);
    release();
  });

  it('does not poison the prompt: a later valid draft commits exactly once', () => {
    app.button.focus();
    executeCommand(APP_ID, 'edit-fill');
    setCommandPromptValue(APP_ID, 'chartreuse');
    commitCommandPrompt(APP_ID);

    expect(applyFill).not.toHaveBeenCalled();
    expect(getOpenCommandPrompt(APP_ID)).not.toBeNull();

    setCommandPromptValue(APP_ID, 'accent');
    commitCommandPrompt(APP_ID);

    expect(applyFill).toHaveBeenCalledTimes(1);
    expect(applyFill).toHaveBeenCalledWith({ value: 'accent' });
    expect(getOpenCommandPrompt(APP_ID)).toBeNull();
  });
});

// ── Accepted commit ──────────────────────────────────────────────────────────

describe('commitCommandPrompt — validate returns true', () => {
  it('commits once, closes, auto-returns and restores focus', () => {
    const release = installCommandSurfaceRuntime();
    app.button.focus();
    pushMode(APP_ID, 'tool');
    executeCommand(APP_ID, 'edit-fill');
    setCommandPromptValue(APP_ID, 'accent');
    app.button.blur();

    commitCommandPrompt(APP_ID);

    expect(validateFill).toHaveBeenCalledTimes(1);
    expect(applyFill).toHaveBeenCalledTimes(1);
    expect(applyFill).toHaveBeenCalledWith({ value: 'accent' });
    expect(getOpenCommandPrompt(APP_ID)).toBeNull();
    expect(getModePath(APP_ID)).toEqual(['select']);
    expect(document.body.hasAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(false);
    expect(document.activeElement).toBe(app.button);
    release();
  });
});

// ── No guard (today's behaviour) ─────────────────────────────────────────────

describe('commitCommandPrompt — validate absent', () => {
  it('keeps today’s merge behaviour: every draft commits', () => {
    app.button.focus();
    executeCommand(APP_ID, 'plain');
    setCommandPromptValue(APP_ID, 'anything');

    commitCommandPrompt(APP_ID);

    expect(plainRun).toHaveBeenCalledTimes(1);
    expect(plainRun).toHaveBeenCalledWith({ value: 'anything' });
    expect(getOpenCommandPrompt(APP_ID)).toBeNull();
  });
});

// ── Escape still cancels ─────────────────────────────────────────────────────

describe('cancelCommandPrompt — a guarded prompt still cancels', () => {
  it('Escape cancels without running, keeps the mode and restores focus', () => {
    const release = installCommandSurfaceRuntime();
    app.button.focus();
    pushMode(APP_ID, 'tool');
    executeCommand(APP_ID, 'edit-fill');
    // Even a VALID draft is not committed on cancel.
    setCommandPromptValue(APP_ID, 'accent');
    app.button.blur();

    cancelCommandPrompt(APP_ID);

    expect(validateFill).not.toHaveBeenCalled();
    expect(applyFill).not.toHaveBeenCalled();
    expect(getOpenCommandPrompt(APP_ID)).toBeNull();
    expect(getModePath(APP_ID)).toEqual(['select', 'tool']);
    expect(document.body.hasAttribute(BODY_COMMAND_PROMPT_ATTR)).toBe(false);
    expect(document.activeElement).toBe(app.button);
    release();
  });
});
