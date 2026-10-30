/**
 * Wireframe place-scoped key table (Spec #3119, ST-4 — R-2/AC2).
 *
 * Drives the REAL provider + the ONE element-scoped key adapter against the
 * declared `wireframeSurface`. Every assertion reads the host snapshot (place
 * path, journal entries, map flag), the session-scoped armed kind, or the store
 * document — never a component-local key table.
 *
 * Titles are authored to the QA Expert's literal manifest (G-419).
 */

import React from 'react';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { resetNavigationAnnouncer } from '@/shared/navigation/ui/announce';
import type { NavigationHost } from '@/shared/navigation/ui/host';
import { createDefaultElement } from '../model/elements';
import {
  dispatch,
  getNavigationJournal,
  getSnapshot,
  resetWireframeStoreForTests,
  select,
  selectMany,
} from '../store/wireframeDocumentStore';
import {
  getArmedWireframeShape,
  resetWireframeSurfaceForTests,
} from '../wireframeSurface';
import {
  WireframeNavigationProvider,
  handleWireframeKeyDown,
  useWireframeNavigation,
} from '../components/WireframeNavigationProvider';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

let currentHost: NavigationHost | null = null;

function Harness(): React.ReactElement {
  const { host } = useWireframeNavigation();
  currentHost = host;

  return React.createElement(
    'div',
    {
      'data-testid': 'harness-root',
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) =>
        handleWireframeKeyDown(event, host, performance.now()),
    },
    React.createElement('button', { 'data-testid': 'trigger', type: 'button' }, 'Trigger'),
  );
}

function renderHarness(): void {
  renderWithChakra(
    React.createElement(
      WireframeNavigationProvider,
      null,
      React.createElement(Harness),
    ),
  );
}

function host(): NavigationHost {
  if (currentHost === null) throw new Error('host not mounted');
  return currentHost;
}

function place(): string {
  const path = host().getSnapshot().context.placePath;
  return path[path.length - 1] ?? '';
}

function entries() {
  return getNavigationJournal().entries();
}

async function press(key: string): Promise<void> {
  const trigger = screen.getByTestId('trigger');
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key });
  });
}

function seedElement(type: 'shape' | 'text', id: string, x: number, width = 40): void {
  const { page } = getSnapshot().document;
  const element = createDefaultElement(type, { page, elements: [], id });
  dispatch('element.add', { element: { ...element, x, y: 10, width, height: 40 } });
}

function xs(): number[] {
  return getSnapshot().document.elements.map((element) => element.x);
}

function primaryFill(): string | undefined {
  const state = getSnapshot();
  const id = state.selectedId;
  const element = state.document.elements.find((candidate) => candidate.id === id);
  return element?.type === 'shape' ? element.fill : undefined;
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
  currentHost = null;
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
  currentHost = null;
  vi.restoreAllMocks();
});

describe('the place-scoped key table (R-2 / AC2)', () => {
  it('c enters create and c r arms a rectangle', async () => {
    renderHarness();

    await press('c');
    expect(place()).toBe('wireframe.create');
    expect(entries()).toHaveLength(1);

    const afterEnter = entries().length;
    await press('r');
    // A bare `r` in Create arms the rectangle: a noop, no journal entry, no pop.
    expect(place()).toBe('wireframe.create');
    expect(getArmedWireframeShape()).toBe('rect');
    expect(entries()).toHaveLength(afterEnter);
  });

  it('r at the root arms a rectangle without entering create', async () => {
    renderHarness();

    await press('r');

    expect(place()).toBe('wireframe.canvas');
    expect(getArmedWireframeShape()).toBe('rect');
    expect(entries()).toHaveLength(0);
  });

  it('s enters style at the root and toggles snap inside arrange', async () => {
    renderHarness();

    await press('s');
    expect(place()).toBe('wireframe.style');

    await press('Escape');
    expect(place()).toBe('wireframe.canvas');

    await press('a');
    expect(place()).toBe('wireframe.arrange');
    const before = getSnapshot().snapToGrid;

    await press('s');
    expect(place()).toBe('wireframe.arrange');
    expect(getSnapshot().snapToGrid).toBe(!before);
    expect(entries()[entries().length - 1]?.verbId).toBe('wireframe.arrange.toggleSnap');
  });

  it('f enters file at the root brings forward inside arrange and sets fill inside style', async () => {
    renderHarness();

    await press('f');
    expect(place()).toBe('wireframe.file');

    await press('Escape');
    expect(place()).toBe('wireframe.canvas');

    seedElement('shape', 'shape-1', 10);
    seedElement('text', 'text-1', 200);
    select('shape-1');

    await press('a');
    expect(place()).toBe('wireframe.arrange');

    await press('f');
    expect(place()).toBe('wireframe.arrange');
    expect(getSnapshot().document.elements.map((element) => element.id)).toEqual([
      'text-1',
      'shape-1',
    ]);
    expect(entries()[entries().length - 1]?.verbId).toBe('wireframe.arrange.bringForward');

    await press('Escape');
    expect(place()).toBe('wireframe.canvas');

    await press('s');
    expect(place()).toBe('wireframe.style');
    const fillBefore = primaryFill();
    expect(fillBefore).toBe('muted');

    await press('f');
    expect(place()).toBe('wireframe.style');
    expect(primaryFill()).not.toBe(fillBefore);
    expect(entries()[entries().length - 1]?.verbId).toBe('wireframe.style.fill');
  });

  it('ArrowLeft and ArrowRight align the selection inside arrange', async () => {
    renderHarness();

    seedElement('shape', 'a', 10, 40);
    seedElement('shape', 'b', 90, 20);
    selectMany(['a', 'b']);

    await press('a');
    expect(place()).toBe('wireframe.arrange');

    await press('ArrowLeft');
    expect(xs()).toEqual([10, 10]);
    expect(entries()[entries().length - 1]?.verbId).toBe('wireframe.arrange.alignLeft');

    await press('ArrowRight');
    expect(xs()).toEqual([10, 30]);
    expect(entries()[entries().length - 1]?.verbId).toBe('wireframe.arrange.alignRight');
  });

  it('ArrowLeft and ArrowRight move the selection at the root', async () => {
    renderHarness();

    seedElement('shape', 'a', 10, 40);
    seedElement('shape', 'b', 200, 40);
    select('a');

    await press('ArrowRight');
    expect(getSnapshot().selectedIds).toEqual(['b']);
    expect(entries()[entries().length - 1]?.verbId).toBe('wireframe.selection.next');

    await press('ArrowLeft');
    expect(getSnapshot().selectedIds).toEqual(['a']);
    expect(entries()[entries().length - 1]?.verbId).toBe('wireframe.selection.previous');
  });

  it('Escape pops exactly one level from a child place', async () => {
    renderHarness();

    await press('e');
    expect(place()).toBe('wireframe.edit');
    expect(host().getSnapshot().context.placePath).toHaveLength(2);

    await press('Escape');
    expect(place()).toBe('wireframe.canvas');
    expect(host().getSnapshot().context.placePath).toHaveLength(1);

    await press('c');
    expect(place()).toBe('wireframe.create');
    await press('Escape');
    expect(host().getSnapshot().context.placePath).toHaveLength(1);
  });

  it('a completed create in the transient place pops exactly one level', async () => {
    renderHarness();

    await press('c');
    expect(place()).toBe('wireframe.create');

    await act(async () => {
      await host().runVerb('wireframe.create.rect', 'pointer', {
        x: '10',
        y: '10',
        width: '120',
        height: '80',
      });
    });

    expect(place()).toBe('wireframe.canvas');
    expect(host().getSnapshot().context.placePath).toHaveLength(1);
    const creates = entries().filter((entry) => entry.verbId === 'wireframe.create.rect');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.actor).toBe('human');
    expect(creates[0]?.placePath).toEqual(['wireframe.canvas', 'wireframe.create']);
    expect(getSnapshot().document.elements).toHaveLength(1);
  });

  it('a create verb without bounds is a noop and does not pop', async () => {
    renderHarness();

    await press('c');
    expect(place()).toBe('wireframe.create');
    const before = entries().length;

    await press('r');

    expect(place()).toBe('wireframe.create');
    expect(host().getSnapshot().context.placePath).toHaveLength(2);
    expect(getArmedWireframeShape()).toBe('rect');
    expect(entries()).toHaveLength(before);
    expect(entries().some((entry) => entry.verbId === 'wireframe.create.rect')).toBe(false);
  });

  it('question mark opens the map through app.map and slash is inert', async () => {
    renderHarness();

    await press('?');
    expect(host().getSnapshot().mapOpen).toBe(true);
    expect(entries().some((entry) => entry.verbId === 'app.map')).toBe(true);

    await act(async () => {
      host().closeMap();
    });
    const afterClose = entries().length;

    await press('/');
    expect(host().getSnapshot().mapOpen).toBe(false);
    expect(entries()).toHaveLength(afterClose);
  });

  it('every listed stroke resolves synchronously in the same task', async () => {
    renderHarness();
    const hostInstance = host();
    const handleStroke = vi.spyOn(hostInstance, 'handleStroke');
    const preventDefault = vi.fn();
    const tokens = [
      'a',
      'c',
      'r',
      's',
      'f',
      'ArrowLeft',
      'ArrowRight',
      'Escape',
      '+',
      '-',
      '0',
    ];

    await act(async () => {
      for (const key of tokens) {
        const before = handleStroke.mock.calls.length;
        handleWireframeKeyDown(
          {
            key,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            defaultPrevented: false,
            preventDefault,
            nativeEvent: { isComposing: false },
            target: document.body,
          } as unknown as ReactKeyboardEvent<HTMLElement>,
          hostInstance,
          1000,
        );
        // The adapter-to-host call happens BEFORE the keydown task returns.
        expect(handleStroke.mock.calls.length, key).toBe(before + 1);
        expect(handleStroke, key).toHaveBeenLastCalledWith(key, 1000);
      }
    });

    expect(handleStroke).toHaveBeenCalledTimes(tokens.length);
    expect(preventDefault).toHaveBeenCalledTimes(tokens.length);
  });
});
