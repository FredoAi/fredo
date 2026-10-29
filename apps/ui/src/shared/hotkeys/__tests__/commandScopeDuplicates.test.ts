/**
 * Spec #3097 ST-2 — per-scope duplicate detection.
 *
 * Pins the ADDITIVE contract on `detectDuplicateHotkeys`:
 *   - `detectDuplicateHotkeys(candidate)` (ONE argument) is byte-identical to
 *     the shipped global rule — same result object, same order;
 *   - with `scopeOf`, entries in different non-null scopes never collide,
 *     entries in the same scope do, and null-scope entries keep the global
 *     bucket;
 *   - the flush buckets by the element's command-surface scope, so two opting
 *     applications can both bind `c` while a duplicate INSIDE one scope still
 *     throws (DEV), publishes the hook and logs.
 */

import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LuAppWindow } from 'react-icons/lu';

import { registerApplication } from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes';
import type { ApplicationCommandSurface } from '../commandSurface';
import { parseDataHotkey } from '../hotkeyGrammar';
import { buildHotkeyBarModel } from '../hotkeyBarModel';
import type { FocusSnapshot } from '../engine';
import {
  BODY_HOTKEY_DUPLICATE_ATTR,
  DuplicateHotkeyError,
  detectDuplicateHotkeys,
  flushElementHotkeys,
  listElementHotkeys,
  resetHotkeyElementDiscoveryForTests,
  type HotkeyElementEntry,
} from '../hotkeyElements';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function surface(): ApplicationCommandSurface {
  return {
    modes: [{ id: 'browse', label: 'Browse', parent: null, keymap: {} }],
    commands: [],
  };
}

class ScopeStub extends FredoApplicationClass {
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

registerApplication(new ScopeStub('scope-a', surface()));
registerApplication(new ScopeStub('scope-b', surface()));
registerApplication(new ScopeStub('scope-plain'));

function entry(key: string, scope?: string): HotkeyElementEntry {
  const element = document.createElement('button');
  if (scope !== undefined) element.dataset.scope = scope;
  const grammar = parseDataHotkey(key);
  if (grammar === null) throw new Error(`bad fixture key ${key}`);
  return {
    element,
    actionId: `fredo.element.${key}#${scope ?? 'global'}`,
    grammar,
    title: key.toUpperCase(),
    source: 'element',
  };
}

/** Test scope accessor — the element's `data-scope` (mirrors the app-root read). */
function scopeOf(element: HotkeyElementEntry): string | null {
  return element.element.dataset.scope ?? null;
}

/** Append a `data-hotkey` button to `parent` (document.body by default). */
function appendHotkey(
  key: string,
  parent: HTMLElement = document.body,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.setAttribute('data-hotkey', key);
  parent.appendChild(button);
  return button;
}

function appendAppRoot(id: string): HTMLDivElement {
  const root = document.createElement('div');
  root.setAttribute('data-fredo-app-id', id);
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetHotkeyElementDiscoveryForTests();
  vi.restoreAllMocks();
});

// ── One-argument call: unchanged ─────────────────────────────────────────────

describe('detectDuplicateHotkeys(candidate) — one-argument call is unchanged', () => {
  it('reports the same object shape and entry order for a shared serialization', () => {
    const first = entry('a');
    const second = entry('a');

    expect(detectDuplicateHotkeys([first, second])).toEqual({
      duplicate: true,
      key: 'a',
      entries: [first, second],
    });
  });

  it('reports a strict-prefix shadow exactly as before', () => {
    const bare = entry('g');
    const sequence = entry('g+i');

    expect(detectDuplicateHotkeys([bare, sequence])).toEqual({
      duplicate: true,
      key: 'g',
      entries: [bare, sequence],
    });
  });

  it('returns the unchanged negative result', () => {
    expect(detectDuplicateHotkeys([entry('g+g'), entry('g+a')])).toEqual({
      duplicate: false,
      key: null,
      entries: [],
    });
  });
});

// ── Scoped call ──────────────────────────────────────────────────────────────

describe('detectDuplicateHotkeys — scoped buckets', () => {
  it('does NOT collide identical keys in two different non-null scopes', () => {
    const first = entry('c', 'scope-a');
    const second = entry('c', 'scope-b');

    expect(detectDuplicateHotkeys([first, second], { scopeOf })).toEqual({
      duplicate: false,
      key: null,
      entries: [],
    });
  });

  it('collides identical keys inside the same scope, preserving order', () => {
    const first = entry('c', 'scope-a');
    const second = entry('c', 'scope-a');
    const other = entry('c', 'scope-b');

    expect(detectDuplicateHotkeys([first, other, second], { scopeOf })).toEqual({
      duplicate: true,
      key: 'c',
      entries: [first, second],
    });
  });

  it('keeps null-scope entries in today’s global bucket', () => {
    const first = entry('c');
    const second = entry('c');
    expect(detectDuplicateHotkeys([first, second], { scopeOf }).duplicate).toBe(true);

    // A null-scope entry does not collide with a scoped entry.
    const scoped = entry('c', 'scope-a');
    expect(detectDuplicateHotkeys([first, scoped], { scopeOf }).duplicate).toBe(false);
  });

  it('applies the strict-prefix rule inside a scope only', () => {
    const bareA = entry('g', 'scope-a');
    const sequenceA = entry('g+i', 'scope-a');
    expect(detectDuplicateHotkeys([bareA, sequenceA], { scopeOf })).toEqual({
      duplicate: true,
      key: 'g',
      entries: [bareA, sequenceA],
    });

    const bareB = entry('g', 'scope-b');
    expect(detectDuplicateHotkeys([bareA, bareB], { scopeOf }).duplicate).toBe(false);
  });
});

// ── The flush consequence ────────────────────────────────────────────────────

describe('flushElementHotkeys — scope-aware enforcement', () => {
  it('does NOT report the same key in two different application scopes', () => {
    appendHotkey('c', appendAppRoot('scope-a'));
    appendHotkey('c', appendAppRoot('scope-b'));
    appendHotkey('c', appendAppRoot('scope-plain')); // registered but no surface
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => flushElementHotkeys()).not.toThrow();
    expect(document.body.hasAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('still reports (and DEV-throws) a duplicate INSIDE one opting scope', () => {
    const root = appendAppRoot('scope-a');
    appendHotkey('c', root);
    appendHotkey('c', root);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    if (import.meta.env.DEV) {
      expect(() => flushElementHotkeys()).toThrow(DuplicateHotkeyError);
    } else {
      expect(() => flushElementHotkeys()).not.toThrow();
    }
    expect(document.body.getAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe('true');
    expect(error).toHaveBeenCalled();
  });

  it('keeps the global bucket for elements outside every application root', () => {
    // `scope-plain` has no surface, so its element keeps the global bucket —
    // and a duplicate with another null-scope element is still an error.
    appendHotkey('c', appendAppRoot('scope-plain'));
    appendHotkey('c');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    if (import.meta.env.DEV) {
      expect(() => flushElementHotkeys()).toThrow(DuplicateHotkeyError);
    } else {
      expect(() => flushElementHotkeys()).not.toThrow();
    }
    expect(document.body.getAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe('true');
  });

  it('clears the duplicate hook once the in-scope duplicate is removed', () => {
    const root = appendAppRoot('scope-a');
    appendHotkey('c', root);
    const second = appendHotkey('c', root);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      flushElementHotkeys();
    } catch {
      // DEV throw expected; the hook is published first.
    }
    expect(document.body.getAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe('true');

    second.remove();
    flushElementHotkeys();
    expect(document.body.hasAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe(false);
  });
});

// ── The BAR banner channel (ST-4R regression) ────────────────────────────────

/**
 * Flush the REAL listing for the bar model. DEV throws a `DuplicateHotkeyError`
 * for a collision — AFTER publishing the listing and the body hook — so the
 * throw is expected and must not abort the fixture (the file's precedent).
 */
function flushListing(): void {
  try {
    flushElementHotkeys();
  } catch (error) {
    if (!(error instanceof DuplicateHotkeyError)) throw error;
  }
}

const DEFAULT_FOCUS: FocusSnapshot = {
  context: 'default',
  nativeConsumes: false,
  textEntry: false,
};

/** The bar model over the flushed listing — the shipped input shape. */
function barModel() {
  return buildHotkeyBarModel({
    entries: listElementHotkeys(),
    pending: null,
    focus: DEFAULT_FOCUS,
  });
}

describe('buildHotkeyBarModel — the banner uses the runtime per-scope buckets', () => {
  it('stays silent for the same key in two different command-surface scopes', () => {
    appendHotkey('x', appendAppRoot('scope-a'));
    appendHotkey('x', appendAppRoot('scope-b'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    flushListing();

    const model = barModel();
    expect(model.duplicate).toBe(false);
    expect(model.duplicateKey).toBeNull();
  });

  it('reports the same key twice INSIDE one scope', () => {
    const root = appendAppRoot('scope-a');
    appendHotkey('x', root);
    appendHotkey('x', root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    flushListing();

    const model = barModel();
    expect(model.duplicate).toBe(true);
    expect(model.duplicateKey).toBe('x');
  });

  it('reports two null-scope elements (global bucket)', () => {
    appendHotkey('x');
    appendHotkey('x');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    flushListing();

    const model = barModel();
    expect(model.duplicate).toBe(true);
    expect(model.duplicateKey).toBe('x');
  });

  it('reports an app WITHOUT a surface colliding through the global bucket', () => {
    // `scope-plain` is registered but declares no command surface, so its
    // element keeps the null bucket — exactly as the runtime flush buckets it.
    appendHotkey('x', appendAppRoot('scope-plain'));
    appendHotkey('x');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    flushListing();

    const model = barModel();
    expect(model.duplicate).toBe(true);
    expect(model.duplicateKey).toBe('x');
  });
});
