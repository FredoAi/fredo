/**
 * WorkspaceToolbar + LayoutMenu tests — Spec #2949 ST-5 (R6 save, R7 restore).
 *
 * Pins the named-layout management UI and the arrangement presets on the real
 * `WindowManager` toolbar:
 *
 *   - the toolbar is hidden at 0 tiled panes and appears with ≥1 (R1);
 *   - preset controls (`workspace-preset-*`) rearrange the tiled panes;
 *   - `layout-menu-button` → `layout-save` → `layout-name-input` saves the
 *     current arrangement and lists it as `layout-restore-<id>` (R6);
 *   - name validation rejects empty / whitespace-only / duplicates / >40 chars;
 *   - `layout-restore-<id>` re-places the panes at their saved regions (R7);
 *   - `layout-delete-<id>` removes a saved layout;
 *   - actions are announced in the single `workspace-announcer` status region.
 *
 * jsdom has no layout engine, so the measured tiling region is stubbed at the
 * prototype level for `[data-testid="workspace-tiles"]`. `settingsService` is
 * mocked (the layout store persists through it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowManager } from '../WindowManager';
import {
  focusWindow,
  openWindow,
  resetWindowStoreForTests,
} from '../windowStore';
import {
  addPane,
  getLayoutSnapshot,
  movePane,
  resetWorkspaceLayoutStoreForTests,
  setLayoutWorkspace,
} from '../workspaceLayoutStore';
import { MAX_LAYOUT_NAME_LENGTH } from '../LayoutMenu';
import type { OpenWindowParams } from '../windowTypes';

vi.mock('../../../features/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../features/settings')>();
  return {
    ...actual,
    settingsService: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const WS = { width: 1000, height: 800 };

function rectOf(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function openFeature(id: string, overrides: Partial<OpenWindowParams> = {}): void {
  openWindow({
    id,
    title: id.toUpperCase(),
    icon: <span data-testid={`icon-${id}`} />,
    component: <div data-testid={`content-${id}`}>{id} body</div>,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    ...overrides,
  });
}

/** Place `ids` as tiled panes starting from a clean workspace. */
function tile(...ids: string[]): void {
  for (const id of ids) {
    openFeature(id, { isMaximized: false });
    addPane(id, 'center');
  }
}

function regionOf(id: string): string | null {
  return screen.getByTestId(`workspace-pane-${id}`).getAttribute('data-pane-region');
}

/** Open the menu, start a save, type `name`, confirm. */
function saveViaMenu(name: string): void {
  fireEvent.click(screen.getByTestId('layout-menu-button'));
  fireEvent.click(screen.getByTestId('layout-save'));
  fireEvent.change(screen.getByTestId('layout-name-input'), { target: { value: name } });
  fireEvent.click(screen.getByTestId('layout-save-confirm'));
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetWindowStoreForTests();
  resetWorkspaceLayoutStoreForTests();
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.testid === 'workspace-tiles') {
        return rectOf(WS.width, WS.height);
      }
      return rectOf(0, 0);
    });
});

afterEach(() => {
  rectSpy.mockRestore();
  cleanup();
  resetWindowStoreForTests();
  resetWorkspaceLayoutStoreForTests();
});

describe('WorkspaceToolbar — visibility + presets', () => {
  it('renders only while at least one pane is tiled', () => {
    renderWithChakra(<WindowManager />);
    expect(screen.queryByTestId('workspace-toolbar')).toBeNull();

    act(() => {
      openFeature('a'); // open but un-tiled (full-bleed)
    });
    expect(screen.queryByTestId('workspace-toolbar')).toBeNull();

    act(() => {
      openFeature('a', { isMaximized: false });
      addPane('a', 'center');
    });
    expect(screen.getByTestId('workspace-toolbar')).toBeTruthy();
  });

  it('exposes the preset group as a radiogroup and the menu as a menu', () => {
    setLayoutWorkspace(WS);
    tile('a');
    renderWithChakra(<WindowManager />);

    expect(screen.getByRole('radiogroup', { name: 'Pane arrangement presets' })).toBeTruthy();
    expect(screen.getByTestId('workspace-preset-single')).toBeTruthy();
    expect(screen.getByTestId('workspace-preset-columns-2')).toBeTruthy();
    expect(screen.getByTestId('workspace-preset-columns-3')).toBeTruthy();
    expect(screen.getByTestId('workspace-preset-grid-2x2')).toBeTruthy();
    expect(screen.getByTestId('workspace-preset-main-side')).toBeTruthy();

    const trigger = screen.getByTestId('layout-menu-button');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Saved layouts' })).toBeTruthy();
  });

  it('columns-2 arranges two panes left / right', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-preset-columns-2'));

    expect(regionOf('a')).toBe('left');
    expect(regionOf('b')).toBe('right');
    expect(screen.getByTestId('workspace-preset-columns-2').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('columns-3 arranges three panes left / center / right', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b', 'c');
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-preset-columns-3'));

    expect(regionOf('a')).toBe('left');
    expect(regionOf('b')).toBe('center');
    expect(regionOf('c')).toBe('right');
  });

  it('grid-2x2 arranges four panes into the four corners', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b', 'c', 'd');
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-preset-grid-2x2'));

    expect(regionOf('a')).toBe('top-left');
    expect(regionOf('b')).toBe('top-right');
    expect(regionOf('c')).toBe('bottom-left');
    expect(regionOf('d')).toBe('bottom-right');
  });

  it('main-side puts the first pane on the left and stacks the rest right', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b', 'c');
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-preset-main-side'));

    expect(regionOf('a')).toBe('left');
    expect(regionOf('b')).toBe('top-right');
    expect(regionOf('c')).toBe('bottom-right');
  });

  it('announces an applied preset', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-preset-single'));
    expect(screen.getByTestId('workspace-announcer').textContent).toContain('Single');
  });
});

describe('LayoutMenu — save / restore / delete (R6, R7)', () => {
  it('saves the current arrangement under a name and lists it (R6)', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    saveViaMenu('twopane');

    const saved = getLayoutSnapshot().savedLayouts;
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('twopane');
    // Saving closes the menu.
    expect(screen.queryByTestId('layout-menu')).toBeNull();

    fireEvent.click(screen.getByTestId('layout-menu-button'));
    expect(screen.getByTestId(`layout-restore-${saved[0].id}`)).toBeTruthy();
    expect(screen.getByText('twopane')).toBeTruthy();
  });

  it('announces a save through the single status region', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    saveViaMenu('twopane');

    const announcer = screen.getByTestId('workspace-announcer');
    expect(announcer.getAttribute('role')).toBe('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toContain('Saved layout twopane');
  });

  it('restores a saved arrangement at its regions (R7)', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    saveViaMenu('twopane');
    const layoutId = getLayoutSnapshot().savedLayouts[0].id;

    act(() => {
      movePane('a', 'top-left');
    });
    expect(regionOf('a')).toBe('top-left');

    fireEvent.click(screen.getByTestId('layout-menu-button'));
    fireEvent.click(screen.getByTestId(`layout-restore-${layoutId}`));

    expect(regionOf('a')).toBe('left');
    expect(regionOf('b')).toBe('right');
    expect(screen.queryByTestId('layout-menu')).toBeNull();
  });

  it('deletes a saved layout', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    saveViaMenu('twopane');
    const layoutId = getLayoutSnapshot().savedLayouts[0].id;

    fireEvent.click(screen.getByTestId('layout-menu-button'));
    fireEvent.click(screen.getByTestId(`layout-delete-${layoutId}`));

    expect(getLayoutSnapshot().savedLayouts).toHaveLength(0);
    expect(screen.queryByTestId(`layout-restore-${layoutId}`)).toBeNull();
  });

  it('rejects a whitespace-only name without saving', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    saveViaMenu('   ');

    expect(screen.getByTestId('layout-name-error')).toBeTruthy();
    expect(getLayoutSnapshot().savedLayouts).toHaveLength(0);
  });

  it('rejects a duplicate name (case-insensitive, trimmed)', () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    saveViaMenu('twopane');
    fireEvent.click(screen.getByTestId('layout-menu-button'));
    fireEvent.click(screen.getByTestId('layout-save'));
    fireEvent.change(screen.getByTestId('layout-name-input'), {
      target: { value: '  TwoPane ' },
    });
    fireEvent.click(screen.getByTestId('layout-save-confirm'));

    expect(screen.getByTestId('layout-name-error')).toBeTruthy();
    expect(getLayoutSnapshot().savedLayouts).toHaveLength(1);
  });

  it(`rejects a name longer than ${MAX_LAYOUT_NAME_LENGTH} characters`, () => {
    setLayoutWorkspace(WS);
    tile('a', 'b');
    renderWithChakra(<WindowManager />);

    saveViaMenu('x'.repeat(MAX_LAYOUT_NAME_LENGTH + 1));

    expect(screen.getByTestId('layout-name-error')).toBeTruthy();
    expect(getLayoutSnapshot().savedLayouts).toHaveLength(0);
  });
});
