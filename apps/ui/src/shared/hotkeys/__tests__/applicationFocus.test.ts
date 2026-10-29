/**
 * Spec #3097 ST-2 — the application focus resolver.
 *
 * Pins the ONE answer to "which application owns keyboard focus": nearest
 * `[data-fredo-app-id]` ancestor (incl. self), the own-window focused id for a
 * body/null active element, the single-root standalone fallback, and — critically
 * — `null` for a non-body active element outside every application root, so a
 * mode key never leaks into an application while the launcher owns focus.
 */

import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LuAppWindow } from 'react-icons/lu';

import { registerApplication } from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes';
import {
  APP_ROOT_ATTR,
  getCommandSurfaceScopeId,
  getElementApplicationId,
  resolveFocusedApplicationId,
} from '../applicationFocus';
import type { ApplicationCommandSurface } from '../commandSurface';
import { resetCommandSurfaceForTests } from '../commandSurfaceStore';
import {
  focusWindow,
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';

/** Minimal registered feature stub — only the surface declaration is read. */
class FocusStub extends FredoApplicationClass {
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

function surface(): ApplicationCommandSurface {
  return {
    modes: [{ id: 'browse', label: 'Browse', parent: null, keymap: {} }],
    commands: [],
  };
}

registerApplication(new FocusStub('app-with-surface', surface()));
registerApplication(new FocusStub('app-without-surface'));

function appendRoot(id: string, parent: HTMLElement = document.body): HTMLDivElement {
  const root = document.createElement('div');
  root.setAttribute(APP_ROOT_ATTR, id);
  parent.appendChild(root);
  return root;
}

function appendButton(parent: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  parent.appendChild(button);
  return button;
}

function open(id: string): void {
  openWindow({ id, title: id, icon: null, component: null });
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetWindowStoreForTests();
  resetCommandSurfaceForTests();
});

describe('getElementApplicationId — nearest ancestor incl. self', () => {
  it('resolves the element itself when it carries the attribute', () => {
    const root = appendRoot('self-app');
    expect(getElementApplicationId(root)).toBe('self-app');
  });

  it('walks to the nearest ancestor and prefers a nested root', () => {
    const outer = appendRoot('outer-app');
    const button = appendButton(outer);
    expect(getElementApplicationId(button)).toBe('outer-app');

    const inner = appendRoot('inner-app', outer);
    const deep = appendButton(inner);
    expect(getElementApplicationId(deep)).toBe('inner-app');
  });

  it('returns null for an element outside every application root and for null', () => {
    const orphan = appendButton(document.body);
    expect(getElementApplicationId(orphan)).toBeNull();
    expect(getElementApplicationId(null)).toBeNull();
  });
});

describe('resolveFocusedApplicationId — precedence', () => {
  it('uses the focused element inside an application root', () => {
    const root = appendRoot('focused-app');
    const button = appendButton(root);
    button.focus();

    // The focused window must NOT win over the element that owns focus.
    open('window-app');
    expect(document.activeElement).toBe(button);
    expect(resolveFocusedApplicationId()).toBe('focused-app');
  });

  it('falls back to the focused window for a body active element', () => {
    open('window-a');
    open('window-b');
    focusWindow('window-a');
    expect(document.activeElement).toBe(document.body);
    expect(resolveFocusedApplicationId()).toBe('window-a');
  });

  it('falls back to the single application root when no window is focused (standalone)', () => {
    appendRoot('standalone-app');
    expect(resolveFocusedApplicationId()).toBe('standalone-app');
  });

  it('returns null when no window, no focus and multiple roots exist', () => {
    appendRoot('app-one');
    appendRoot('app-two');
    expect(resolveFocusedApplicationId()).toBeNull();
  });

  it('returns null for a non-body active element outside every root (never falls through)', () => {
    appendRoot('some-app');
    open('window-app');
    const chromeButton = appendButton(document.body); // launcher / desktop chrome
    chromeButton.focus();

    expect(getElementApplicationId(chromeButton)).toBeNull();
    expect(resolveFocusedApplicationId()).toBeNull();
  });
});

describe('getCommandSurfaceScopeId — only opted-in applications', () => {
  it('returns the id for an application that declares a command surface', () => {
    const root = appendRoot('app-with-surface');
    const button = appendButton(root);
    expect(getCommandSurfaceScopeId(button)).toBe('app-with-surface');
    expect(getCommandSurfaceScopeId(root)).toBe('app-with-surface');
  });

  it('returns null for an application without a surface, an orphan element, and null', () => {
    const plain = appendRoot('app-without-surface');
    expect(getCommandSurfaceScopeId(appendButton(plain))).toBeNull();
    expect(getCommandSurfaceScopeId(appendButton(document.body))).toBeNull();
    expect(getCommandSurfaceScopeId(null)).toBeNull();
  });

  it('returns null for an unregistered app id (the element alone never opts in)', () => {
    const root = appendRoot('unregistered-app');
    expect(getCommandSurfaceScopeId(appendButton(root))).toBeNull();
  });
});
