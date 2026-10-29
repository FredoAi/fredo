/**
 * Spec #3097 ST-4 — the bottom bar as the focused application's live keymap.
 *
 * Pins, ADDITIVELY (the shipped `hotkeyBarModel.test.ts` / `HotkeyBar.test.tsx`
 * stay unmodified):
 *   - the non-opting model/DOM is exactly today's (no badge, no prompt, no
 *     focusables, no live region);
 *   - the leading mode badge's binding attributes + root-mode badge;
 *   - mode rows = the active mode's declared keymap ONLY, in declaration order,
 *     with `command:` action ids and `data-hotkey-mode-id`;
 *   - the prompt replaces the list/fade/pending, its wrapper is the one
 *     `pointer-events:auto` island, and the input is the bar's ONLY focusable;
 *   - the draft is module-owned (`setCommandPromptValue`) with NO local
 *     Enter/Escape handler;
 *   - focus: the input is focused on mount and the STORE restores
 *     `restoreElement` on commit/cancel (the bar never restores on unmount);
 *   - the inset focus-visible ring (`outline-offset:-2px`, no colour literal);
 *   - a long title never clips the keycap, and an empty mode keymap renders the
 *     badge only.
 */

import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LuAppWindow } from 'react-icons/lu';

import { registerApplication } from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import { APP_ROOT_ATTR } from '../applicationFocus';
import type { ApplicationCommandSurface } from '../commandSurface';
import {
  cancelCommandPrompt,
  commitCommandPrompt,
  executeCommand,
  getOpenCommandPrompt,
  resetCommandSurfaceForTests,
} from '../commandSurfaceStore';
import { buildHotkeyBarModel } from '../hotkeyBarModel';
import type { HotkeyBarModeView, HotkeyBarPromptView } from '../hotkeyBarModel';
import {
  HOTKEY_BAR_LIST_TESTID,
  HOTKEY_BAR_MODE_TESTID,
  HOTKEY_BAR_PENDING_TESTID,
  HOTKEY_BAR_PROMPT_INPUT_TESTID,
  HOTKEY_BAR_PROMPT_TESTID,
  HOTKEY_BAR_ROW_TESTID,
  HOTKEY_BAR_TESTID,
  HotkeyBar,
} from '../HotkeyBar';
import { parseDataHotkey } from '../hotkeyGrammar';
import type { HotkeyElementEntry } from '../hotkeyElements';
import type { FocusSnapshot } from '../engine';
import type { FocusContext } from '../types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const APP_ID = 'bar-fixture-app';

const LONG_TITLE =
  'A deliberately very long command title that must never be allowed to clip the keycap on the left';

const capture = vi.fn();
const pin = vi.fn();
const runLong = vi.fn();

function surface(): ApplicationCommandSurface {
  return {
    modes: [
      { id: 'browse', label: 'Browse', parent: null, keymap: { t: 'open-tool', p: 'pin' } },
      { id: 'tool', label: 'Tool', parent: 'browse', keymap: { c: 'capture' } },
      { id: 'empty', label: 'Empty', parent: 'browse', keymap: {} },
      { id: 'long', label: 'Long', parent: 'browse', keymap: { z: 'long-command' } },
    ],
    commands: [
      { id: 'open-tool', title: 'Open tool', run: () => {} },
      { id: 'pin', title: 'Pin', run: pin },
      {
        id: 'capture',
        title: 'Capture value',
        prompt: { label: 'Capture value', placeholder: 'Type a value' },
        run: capture,
      },
      { id: 'long-command', title: LONG_TITLE, run: runLong },
    ],
  };
}

class BarFixtureApp extends FredoApplicationClass {
  readonly id = APP_ID;
  readonly name = 'Bar fixture';
  readonly icon = LuAppWindow;
  readonly commandSurface: ApplicationCommandSurface = surface();

  render(): ReactElement {
    return null as unknown as ReactElement;
  }
}

// `applicationRegistry` has no reset (the module registry persists for the
// webview's lifetime) — register ONE stub at module load.
registerApplication(new BarFixtureApp());

function entry(key: string, title: string): HotkeyElementEntry {
  const grammar = parseDataHotkey(key);
  if (grammar === null) throw new Error(`bad fixture key ${key}`);
  return {
    element: document.createElement('button'),
    actionId: `fredo.element.${key}#fixture`,
    grammar,
    title,
    source: 'element',
  };
}

function focus(context: FocusContext, textEntry = false): FocusSnapshot {
  return { context, nativeConsumes: false, textEntry };
}

function modeView(modeId: string, path: readonly string[]): HotkeyBarModeView {
  const mode = surface().modes.find((candidate) => candidate.id === modeId);
  if (mode === undefined) throw new Error(`bad fixture mode ${modeId}`);
  return { appId: APP_ID, modeId, label: mode.label, path };
}

function promptView(overrides: Partial<HotkeyBarPromptView> = {}): HotkeyBarPromptView {
  return {
    appId: APP_ID,
    commandId: 'capture',
    label: 'Capture value',
    placeholder: 'Type a value',
    value: '',
    ...overrides,
  };
}

function focusElement(): HTMLButtonElement {
  const root = document.createElement('div');
  root.setAttribute(APP_ROOT_ATTR, APP_ID);
  document.body.appendChild(root);
  const button = document.createElement('button');
  button.textContent = 'element';
  root.appendChild(button);
  return button;
}

function promptModelFromStore(): ReturnType<typeof buildHotkeyBarModel> {
  const prompt = getOpenCommandPrompt(APP_ID);
  if (prompt === null) throw new Error('expected an open prompt');
  return buildHotkeyBarModel({
    entries: [],
    pending: null,
    focus: focus('default'),
    prompt: {
      appId: APP_ID,
      commandId: prompt.commandId,
      label: prompt.label,
      placeholder: prompt.placeholder,
      value: prompt.value,
    },
  });
}

function root(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${HOTKEY_BAR_TESTID}"]`);
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`[data-testid="${HOTKEY_BAR_ROW_TESTID}"]`),
  );
}

function modeBadge(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${HOTKEY_BAR_MODE_TESTID}"]`);
}

function promptWrapper(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${HOTKEY_BAR_PROMPT_TESTID}"]`);
}

function promptInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `[data-testid="${HOTKEY_BAR_PROMPT_INPUT_TESTID}"]`,
  );
  if (input === null) throw new Error('prompt input not rendered');
  return input;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetWindowStoreForTests();
  resetCommandSurfaceForTests();
  capture.mockClear();
  pin.mockClear();
  runLong.mockClear();
});

afterEach(() => {
  cleanup();
  resetCommandSurfaceForTests();
  resetWindowStoreForTests();
  document.body.innerHTML = '';
});

// ── Non-opting callers keep today's model + DOM (R-1.1) ──────────────────────

describe('commandSurfaceBar — non-opting model/DOM is unchanged', () => {
  it('projects byte-identical element rows, with mode/prompt null', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('s', 'Find session'), entry('a+b', 'Two step')],
      pending: null,
      focus: focus('default'),
    });

    expect(model.mode).toBeNull();
    expect(model.prompt).toBeNull();
    expect(model.empty).toBe(false);
    expect(model.rows).toEqual([
      {
        actionId: 'fredo.element.s#fixture',
        key: 's',
        serialized: 's',
        title: 'Find session',
        availability: 'available',
      },
      {
        actionId: 'fredo.element.a+b#fixture',
        key: 'a',
        serialized: 'a b',
        title: 'Two step',
        availability: 'available',
      },
    ]);
  });

  it('renders exactly the shipped bar: no badge, no prompt, no focusable, no live region', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={buildHotkeyBarModel({
          entries: [entry('s', 'Find session')],
          pending: 'g',
          focus: focus('default'),
        })}
        reducedMotion
      />,
    );

    const bar = root(container);
    expect(bar).not.toBeNull();
    expect(bar).toHaveAttribute('role', 'region');
    expect(bar).toHaveAttribute('aria-label', 'Available hotkeys');
    expect(bar?.style.pointerEvents).toBe('none');
    expect(getComputedStyle(bar as HTMLElement).height).toBe('34px');
    expect(bar?.querySelectorAll('button, [tabindex], [href], input, textarea, select')).toHaveLength(0);
    expect(modeBadge(container)).toBeNull();
    expect(promptWrapper(container)).toBeNull();
    expect(container.querySelector(`[data-testid="${HOTKEY_BAR_LIST_TESTID}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="${HOTKEY_BAR_PENDING_TESTID}"]`)).not.toBeNull();
    expect(container.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(0);
  });
});

// ── Mode badge (R-2.2) ───────────────────────────────────────────────────────

describe('commandSurfaceBar — mode badge', () => {
  it('renders the binding attributes as leading plain text (no role/tabIndex/live region)', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={buildHotkeyBarModel({
          entries: [],
          pending: null,
          focus: focus('default'),
          activeMode: modeView('tool', ['browse', 'tool']),
        })}
        reducedMotion
      />,
    );

    const badge = modeBadge(container);
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute('data-mode-id', 'tool');
    expect(badge).toHaveAttribute('data-mode-app', APP_ID);
    expect(badge).toHaveAttribute('data-mode-path', 'browse>tool');
    expect(badge).toHaveTextContent('Tool');
    expect(badge).not.toHaveAttribute('role');
    expect(badge).not.toHaveAttribute('tabindex');
    expect(badge).not.toHaveAttribute('aria-live');
    expect(badge).not.toHaveAttribute('aria-hidden');

    // Leading: the badge precedes the LIST region in DOM order.
    const list = container.querySelector(`[data-testid="${HOTKEY_BAR_LIST_TESTID}"]`);
    expect(list).not.toBeNull();
    expect(
      (badge as HTMLElement).compareDocumentPosition(list as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the ROOT mode badge at rest', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={buildHotkeyBarModel({
          entries: [],
          pending: null,
          focus: focus('default'),
          activeMode: modeView('browse', ['browse']),
        })}
        reducedMotion
      />,
    );

    const badge = modeBadge(container);
    expect(badge).toHaveAttribute('data-mode-id', 'browse');
    expect(badge).toHaveAttribute('data-mode-path', 'browse');
    expect(badge).toHaveTextContent('Browse');
  });
});

// ── Mode rows (R-2.2) ────────────────────────────────────────────────────────

describe('commandSurfaceBar — mode rows', () => {
  it('projects ONLY the active mode keymap in declaration order with command: action ids', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('x', 'Element x')],
      pending: null,
      focus: focus('default'),
      activeMode: modeView('browse', ['browse']),
    });

    expect(model.rows.map((row) => row.key)).toEqual(['t', 'p']);
    expect(model.rows.map((row) => row.actionId)).toEqual([
      `command:${APP_ID}.open-tool`,
      `command:${APP_ID}.pin`,
    ]);
    expect(model.rows.map((row) => row.serialized)).toEqual(['t', 'p']);
    expect(model.rows.map((row) => row.title)).toEqual(['Open tool', 'Pin']);
    expect(model.rows.map((row) => row.kind)).toEqual(['mode', 'mode']);
    expect(model.rows.map((row) => row.modeId)).toEqual(['browse', 'browse']);
    // Element rows are NOT merged while a mode is active (R-2.2).
    expect(model.rows.map((row) => row.title)).not.toContain('Element x');
  });

  it('renders mode rows with data-hotkey-mode-id and the focus-derived availability', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={buildHotkeyBarModel({
          entries: [],
          pending: null,
          focus: focus('default'),
          activeMode: modeView('tool', ['browse', 'tool']),
        })}
        reducedMotion
      />,
    );

    const rendered = rows(container);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toHaveAttribute('data-hotkey-key', 'c');
    expect(rendered[0]).toHaveAttribute('data-hotkey-action', `command:${APP_ID}.capture`);
    expect(rendered[0]).toHaveAttribute('data-hotkey-availability', 'available');
    expect(rendered[0]).toHaveAttribute('data-hotkey-mode-id', 'tool');
  });

  it('greys mode rows out exactly like element rows in a text-entry context', () => {
    const model = buildHotkeyBarModel({
      entries: [],
      pending: null,
      focus: focus('text-entry', true),
      activeMode: modeView('tool', ['browse', 'tool']),
    });
    expect(model.rows.every((row) => row.availability === 'disabled')).toBe(true);
  });

  it('renders the badge only for an EMPTY mode keymap (never empty/nulled)', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('x', 'Element x')],
      pending: null,
      focus: focus('default'),
      activeMode: modeView('empty', ['browse', 'empty']),
    });
    expect(model.rows).toHaveLength(0);
    expect(model.empty).toBe(false);

    const { container } = renderWithChakra(<HotkeyBar model={model} reducedMotion />);
    expect(modeBadge(container)).not.toBeNull();
    expect(rows(container)).toHaveLength(0);
  });

  it('does not let a long command title clip the keycap', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={buildHotkeyBarModel({
          entries: [],
          pending: null,
          focus: focus('default'),
          activeMode: modeView('long', ['browse', 'long']),
        })}
        reducedMotion
      />,
    );

    const row = rows(container)[0];
    expect(row).toHaveAttribute('data-hotkey-key', 'z');
    const title = row.querySelector('p');
    expect(title).toHaveTextContent(LONG_TITLE);
    expect(getComputedStyle(title as HTMLElement).textOverflow).toBe('ellipsis');

    const group = row.querySelector('[data-testid="hotkeys-keycap-group"]');
    expect(group).not.toBeNull();
    expect(getComputedStyle(group?.parentElement as HTMLElement).flexShrink).toBe('0');
  });
});

// ── Prompt open (R-4.1) ──────────────────────────────────────────────────────

describe('commandSurfaceBar — prompt replaces the rows', () => {
  it('unmounts the list + pending and hosts the ONLY focusable descendant', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('x', 'Element x')],
      pending: 'g',
      focus: focus('default'),
      prompt: promptView({ value: '42' }),
    });
    // The MODEL keeps its rows (replacement happens at the DOM).
    expect(model.rows).toHaveLength(1);
    expect(model.empty).toBe(false);

    const { container } = renderWithChakra(<HotkeyBar model={model} reducedMotion />);
    const bar = root(container);
    expect(bar).not.toBeNull();
    expect(bar?.style.pointerEvents).toBe('none');
    expect(container.querySelector(`[data-testid="${HOTKEY_BAR_LIST_TESTID}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="${HOTKEY_BAR_PENDING_TESTID}"]`)).toBeNull();
    expect(rows(container)).toHaveLength(0);

    const wrapper = promptWrapper(container);
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('data-command-id', 'capture');
    expect(wrapper).toHaveAttribute('data-app-id', APP_ID);
    expect(wrapper?.style.pointerEvents).toBe('auto');

    const input = promptInput(container);
    expect(input).toHaveAttribute('aria-label', 'Capture value');
    expect(input).toHaveAttribute('placeholder', 'Type a value');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input.value).toBe('42');

    // The input is the bar's ONLY focusable descendant while open.
    expect(
      bar?.querySelectorAll('button, [tabindex], [href], input, textarea, select'),
    ).toHaveLength(1);
  });

  it('falls back to the label as placeholder and keeps the badge visible', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={buildHotkeyBarModel({
          entries: [],
          pending: null,
          focus: focus('default'),
          activeMode: modeView('tool', ['browse', 'tool']),
          prompt: promptView({ placeholder: undefined }),
        })}
        reducedMotion
      />,
    );

    expect(promptInput(container)).toHaveAttribute('placeholder', 'Capture value');
    expect(modeBadge(container)).toHaveAttribute('data-mode-id', 'tool');
  });
});

// ── Draft + no local key handler (R-4.2 / R-4.3) ─────────────────────────────

describe('commandSurfaceBar — module-owned draft, engine-owned keys', () => {
  it('wires onChange to setCommandPromptValue and adds NO local Enter/Escape handler', () => {
    const restoreTarget = focusElement();
    restoreTarget.focus();
    executeCommand(APP_ID, 'capture');
    expect(getOpenCommandPrompt(APP_ID)).not.toBeNull();

    const { container } = renderWithChakra(
      <HotkeyBar model={promptModelFromStore()} reducedMotion />,
    );
    const input = promptInput(container);

    fireEvent.change(input, { target: { value: '42' } });
    expect(getOpenCommandPrompt(APP_ID)?.value).toBe('42');

    // Enter / Escape on the input are engine-owned: the input itself must not
    // commit, cancel, or run the command (a local handler would double-fire).
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(capture).not.toHaveBeenCalled();
    expect(getOpenCommandPrompt(APP_ID)).not.toBeNull();

    // Source pin: no `onKeyDown` exists on the component at all.
    const source = readFileSync(
      resolve(process.cwd(), 'src/shared/hotkeys/HotkeyBar.tsx'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/onKeyDown/);
  });

  it('is NOT empty when only a prompt is present (no rows needed to render)', () => {
    const model = buildHotkeyBarModel({
      entries: [],
      pending: null,
      focus: focus('default'),
      prompt: promptView(),
    });
    expect(model.rows).toHaveLength(0);
    expect(model.empty).toBe(false);
  });
});

// ── Focus lifecycle (R-4.4) ──────────────────────────────────────────────────

describe('commandSurfaceBar — focus lifecycle', () => {
  it('focuses the input on mount and the STORE restores focus on commit', () => {
    const restoreTarget = focusElement();
    restoreTarget.focus();
    executeCommand(APP_ID, 'capture');

    const { container, unmount } = renderWithChakra(
      <HotkeyBar model={promptModelFromStore()} reducedMotion />,
    );
    const input = promptInput(container);
    expect(document.activeElement).toBe(input);

    commitCommandPrompt(APP_ID);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({ value: '' });
    expect(document.activeElement).toBe(restoreTarget);

    // Unmounting the bar never restores focus itself (the store owns it).
    unmount();
    expect(document.activeElement).toBe(restoreTarget);
  });

  it('restores focus on cancel without running the handler', () => {
    const restoreTarget = focusElement();
    restoreTarget.focus();
    executeCommand(APP_ID, 'capture');

    const { container } = renderWithChakra(
      <HotkeyBar model={promptModelFromStore()} reducedMotion />,
    );
    expect(document.activeElement).toBe(promptInput(container));

    cancelCommandPrompt(APP_ID);
    expect(capture).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(restoreTarget);
  });
});

// ── Focus-visible ring (theme contract, no colour literal) ───────────────────

describe('commandSurfaceBar — inset focus-visible ring', () => {
  it('pins the computed outline-offset to -2px (inset inside the 34 px clip)', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={buildHotkeyBarModel({
          entries: [],
          pending: null,
          focus: focus('default'),
          prompt: promptView(),
        })}
        reducedMotion
      />,
    );
    const input = promptInput(container);
    input.focus();
    const style = getComputedStyle(input);
    expect(style.outlineOffset).toBe('-2px');

    // The ring writes the theme var, never a hex value (token hygiene).
    const source = readFileSync(
      resolve(process.cwd(), 'src/shared/hotkeys/HotkeyBar.tsx'),
      'utf8',
    );
    expect(source).toContain("outline: '2px solid var(--accent-strong)'");
  });
});
