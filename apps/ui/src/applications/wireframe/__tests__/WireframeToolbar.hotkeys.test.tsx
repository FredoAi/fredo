/**
 * Wireframe toolbar (Spec #3070, ST-3, R-5.1 / R-5.4 / R-5.5 + UI/UX 2.1/2.2/
 * 3.13/3.14).
 *
 * The toolbar is table-driven: the bindings and testids asserted here come from
 * `WIREFRAME_ACTIONS`, and every activation is checked against the store so
 * "the shortcut performs the same action as the visible control" is pinned on
 * the real markup.
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WireframeToolbar } from '../components/WireframeToolbar';
import {
  getSnapshot,
  markSaved,
  resetWireframeStoreForTests,
  setStatus,
} from '../store/wireframeDocumentStore';

const hostFocus = vi.hoisted(() => ({ focused: true }));

vi.mock('../hooks/useWireframeHostFocused', () => ({
  useWireframeHostFocused: () => hostFocus.focused,
}));

function elements() {
  return getSnapshot().document.elements;
}

function button(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  hostFocus.focused = true;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('toolbar markup (UI/UX 2.1)', () => {
  it('renders a group labelled "Wireframe tools" with 23 action controls', () => {
    renderWithChakra(<WireframeToolbar />);

    const toolbar = button('wireframe-toolbar');
    expect(toolbar).toHaveAttribute('role', 'group');
    expect(toolbar).toHaveAttribute('aria-label', 'Wireframe tools');
    expect(toolbar).toHaveStyle({ flexWrap: 'wrap' });

    expect(screen.getAllByTestId(/^wireframe-action-/)).toHaveLength(23);
    // The two Companion-only ids never render a control.
    expect(screen.queryByTestId('wireframe-action-companion-listActions')).toBeNull();
    expect(screen.queryByTestId('wireframe-action-companion-draftApp')).toBeNull();
  });

  it('uses the C7 testid suffixes (dot -> dash, camelCase preserved)', () => {
    renderWithChakra(<WireframeToolbar />);

    for (const testId of [
      'wireframe-action-add-text',
      'wireframe-action-element-toggleLock',
      'wireframe-action-view-fitPage',
      'wireframe-action-file-saveAs',
      'wireframe-action-document-new',
    ]) {
      expect(button(testId), testId).toBeInTheDocument();
    }
  });

  it('renders the insert menus with labelled chevrons that carry no hotkey', () => {
    renderWithChakra(<WireframeToolbar />);

    const section = screen.getByRole('button', { name: 'Section presets' });
    const shape = screen.getByRole('button', { name: 'Shape kinds' });
    expect(section).toHaveAttribute('aria-haspopup', 'menu');
    expect(shape).toHaveAttribute('aria-haspopup', 'menu');
    expect(section).not.toHaveAttribute('data-hotkey');
    expect(shape).not.toHaveAttribute('data-hotkey');
  });
});

describe('hotkey attributes (R-5.1 / R-5.4)', () => {
  it('mounts data-hotkey from the table while the host is focused', () => {
    renderWithChakra(<WireframeToolbar />);

    const expected: readonly [string, string][] = [
      ['wireframe-action-add-text', '1'],
      ['wireframe-action-add-line', '9'],
      ['wireframe-action-element-duplicate', 'p'],
      ['wireframe-action-element-delete', 'k'],
      ['wireframe-action-element-toggleLock', 'l'],
      ['wireframe-action-edit-undo', 'u'],
      ['wireframe-action-edit-redo', 'y'],
      ['wireframe-action-zoom-in', 'g'],
      ['wireframe-action-zoom-out', 'm'],
      ['wireframe-action-view-fitPage', 'n'],
      ['wireframe-action-view-resetView', '0'],
      ['wireframe-action-view-togglePan', 'h'],
      ['wireframe-action-file-saveAs', 'w'],
      ['wireframe-action-file-open', 'o'],
      ['wireframe-action-file-exportPng', 't'],
    ];
    for (const [testId, key] of expected) {
      expect(button(testId), testId).toHaveAttribute('data-hotkey', key);
    }

    // document.new has no binding at all.
    expect(button('wireframe-action-document-new')).not.toHaveAttribute('data-hotkey');

    // The always-on bar shows the action title, not the composed aria-label.
    expect(button('wireframe-action-add-text')).toHaveAttribute('data-hotkey-label', 'Text');
    expect(button('wireframe-action-element-duplicate')).toHaveAttribute(
      'data-hotkey-label',
      'Duplicate',
    );

    const chip = button('wireframe-action-add-text').querySelector(
      '[data-testid="wireframe-hotkey-chip"]',
    );
    expect(chip).not.toBeNull();
    expect(chip).toHaveStyle({ visibility: 'visible' });
  });

  it('removes the attribute and hides (without dropping) the chip when unfocused', () => {
    hostFocus.focused = false;
    const { container } = renderWithChakra(<WireframeToolbar />);

    expect(container.querySelectorAll('[data-hotkey]')).toHaveLength(0);

    const chip = button('wireframe-action-add-text').querySelector(
      '[data-testid="wireframe-hotkey-chip"]',
    );
    expect(chip).not.toBeNull();
    expect(chip).toHaveStyle({ visibility: 'hidden' });
  });
});

describe('insert actions (R-1.2 / R-1.3)', () => {
  it('adds an element per insert button and selects it', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    await user.click(button('wireframe-action-add-text'));
    expect(elements()).toHaveLength(1);
    expect(elements()[0].type).toBe('text');
    expect(getSnapshot().selectedId).toBe(elements()[0].id);

    await user.click(button('wireframe-action-add-line'));
    expect(elements()).toHaveLength(2);
    expect(elements()[1].type).toBe('line');
  });

  it('the Section menu adds the chosen preset and selects it', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    await user.click(screen.getByRole('button', { name: 'Section presets' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Nav bar' }));

    await waitFor(() => expect(elements()).toHaveLength(1));
    expect(elements()[0]).toMatchObject({ type: 'section', preset: 'navbar' });
    expect(getSnapshot().selectedId).toBe(elements()[0].id);
  });

  it('the Shape menu adds the chosen kind and selects it', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    await user.click(screen.getByRole('button', { name: 'Shape kinds' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Triangle' }));

    await waitFor(() => expect(elements()).toHaveLength(1));
    expect(elements()[0]).toMatchObject({ type: 'shape', shape: 'triangle' });
    expect(getSnapshot().selectedId).toBe(elements()[0].id);
  });
});

describe('selection and history actions (R-2.4 / R-4.1)', () => {
  it('disables the element actions with no selection and enables them with one', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    expect(button('wireframe-action-element-duplicate')).toBeDisabled();
    expect(button('wireframe-action-element-delete')).toBeDisabled();
    expect(button('wireframe-action-element-toggleLock')).toBeDisabled();

    await user.click(button('wireframe-action-add-text'));

    expect(button('wireframe-action-element-duplicate')).not.toBeDisabled();
    expect(button('wireframe-action-element-delete')).not.toBeDisabled();
    expect(button('wireframe-action-element-toggleLock')).not.toBeDisabled();
  });

  it('duplicate / lock / delete act on the selection', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    await user.click(button('wireframe-action-add-text'));
    await user.click(button('wireframe-action-element-duplicate'));
    expect(elements()).toHaveLength(2);

    await user.click(button('wireframe-action-element-toggleLock'));
    expect(elements()[1]).toMatchObject({ locked: true });
    expect(button('wireframe-action-element-toggleLock')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(button('wireframe-action-element-delete'));
    expect(elements()).toHaveLength(1);
  });

  it('undo/redo disabled states follow the store history', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    expect(button('wireframe-action-edit-undo')).toBeDisabled();
    expect(button('wireframe-action-edit-redo')).toBeDisabled();

    await user.click(button('wireframe-action-add-text'));
    expect(button('wireframe-action-edit-undo')).not.toBeDisabled();

    await user.click(button('wireframe-action-edit-undo'));
    expect(elements()).toHaveLength(0);
    expect(button('wireframe-action-edit-undo')).toBeDisabled();
    expect(button('wireframe-action-edit-redo')).not.toBeDisabled();

    await user.click(button('wireframe-action-edit-redo'));
    expect(elements()).toHaveLength(1);
  });

  it('pan toggles and reports aria-pressed', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    const pan = button('wireframe-action-view-togglePan');
    expect(pan).toHaveAttribute('aria-pressed', 'false');
    await user.click(pan);
    expect(getSnapshot().panMode).toBe(true);
    expect(pan).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('file group (UI/UX 2.1)', () => {
  it('disables the file controls while a file operation is pending', () => {
    renderWithChakra(<WireframeToolbar />);

    act(() => setStatus('saving'));

    for (const testId of [
      'wireframe-action-document-new',
      'wireframe-action-file-open',
      'wireframe-action-file-saveAs',
      'wireframe-action-file-exportPng',
    ]) {
      expect(button(testId), testId).toBeDisabled();
    }

    act(() => setStatus('idle'));
    expect(button('wireframe-action-file-saveAs')).not.toBeDisabled();
  });
});

describe('post-activation focus (UI/UX 3.14 / G-327)', () => {
  it('a pointer activation blurs the control so the next bare key fires', () => {
    renderWithChakra(<WireframeToolbar />);

    const text = button('wireframe-action-add-text');
    text.focus();
    expect(document.activeElement).toBe(text);

    fireEvent.click(text, { detail: 1 });

    expect(elements()).toHaveLength(1);
    expect(document.activeElement).toBe(document.body);
  });

  it('a keyboard activation keeps focus for Tab users', () => {
    renderWithChakra(<WireframeToolbar />);

    const text = button('wireframe-action-add-text');
    text.focus();
    fireEvent.click(text, { detail: 0 });

    expect(elements()).toHaveLength(1);
    expect(document.activeElement).toBe(text);
  });
});

describe('New document (UI/UX 3.11 / R-4.12)', () => {
  it('asks before discarding a dirty document, and Cancel keeps it', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    await user.click(button('wireframe-action-add-text'));
    await user.click(button('wireframe-action-document-new'));

    const dialog = await screen.findByTestId('wireframe-new-document-dialog');
    expect(dialog).toBeInTheDocument();
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();

    await user.click(screen.getByTestId('wireframe-new-document-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('wireframe-new-document-dialog')).toBeNull(),
    );
    expect(elements()).toHaveLength(1);
    expect(getSnapshot().dirty).toBe(true);
  });

  it('Discard starts a new empty document', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    await user.click(button('wireframe-action-add-text'));
    await user.click(button('wireframe-action-document-new'));
    await screen.findByTestId('wireframe-new-document-dialog');

    await user.click(screen.getByTestId('wireframe-new-document-discard'));

    await waitFor(() => expect(elements()).toHaveLength(0));
    expect(getSnapshot().selectedId).toBeNull();
    expect(getSnapshot().filePath).toBeNull();
    expect(getSnapshot().dirty).toBe(true);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('a clean document starts over immediately with no dialog', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframeToolbar />);

    act(() => markSaved('C:\\docs\\clean.wireframe.json'));
    expect(getSnapshot().dirty).toBe(false);

    await user.click(button('wireframe-action-document-new'));
    await settle();

    expect(screen.queryByTestId('wireframe-new-document-dialog')).toBeNull();
    expect(elements()).toHaveLength(0);
    expect(getSnapshot().filePath).toBeNull();
    expect(getSnapshot().dirty).toBe(true);
  });
});
