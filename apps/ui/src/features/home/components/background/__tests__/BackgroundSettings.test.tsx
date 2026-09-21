/**
 * BackgroundSettings chooser tests (Spec #2899 ST-4).
 *
 * The Settings → Appearance "Desktop Background" gallery: it renders None + the
 * six procedural tiles + the engine-backed Life tile (Spec #2915), defaults to
 * None, writes through the module store on click and on keyboard selection, and
 * exposes the documented test hooks.
 *
 * `settingsService` is mocked (the established host-agnostic seam) so the real
 * store can run without a Tauri host. `selectBackground` is wrapped in a spy via
 * `vi.mock` + `importOriginal` so the assertions can prove the component calls
 * it — while the wrapped implementation stays the REAL store write (the DOM
 * `data-selected`/`aria-checked` assertions observe the same-tick re-render).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

vi.mock('../../../../settings', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('none'),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../backgroundStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backgroundStore')>();
  return { ...actual, selectBackground: vi.fn(actual.selectBackground) };
});

import { BackgroundSettings } from '../BackgroundSettings';
import { selectBackground, resetBackgroundStoreForTests } from '../backgroundStore';
import { settingsService } from '../../../../settings';

const selectBackgroundMock = selectBackground as unknown as ReturnType<typeof vi.fn>;
const getMock = settingsService.get as ReturnType<typeof vi.fn>;
const setMock = settingsService.set as ReturnType<typeof vi.fn>;

const PROCEDURAL_IDS = ['aurora', 'nebula', 'mesh', 'topography', 'constellation', 'halo'] as const;

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  resetBackgroundStoreForTests();
  getMock.mockResolvedValue('none');
  setMock.mockResolvedValue(undefined);
});

describe('BackgroundSettings — Desktop Background chooser (ST-4)', () => {
  it('renders a Desktop Background radiogroup with None + six procedural tiles + Life', () => {
    renderWithChakra(<BackgroundSettings />);

    const group = screen.getByTestId('desktop-background-chooser');
    expect(group).toHaveAttribute('role', 'radiogroup');
    // Accessible name comes from the visible "Desktop Background" label.
    expect(screen.getByRole('radiogroup', { name: 'Desktop Background' })).toBe(group);

    expect(screen.getAllByRole('radio')).toHaveLength(8);
    expect(screen.getByTestId('desktop-background-option-none')).toBeInTheDocument();
    // The singled-out None hook (alias of the None tile).
    expect(screen.getByTestId('desktop-background-none')).toHaveTextContent('None');
    for (const id of PROCEDURAL_IDS) {
      expect(screen.getByTestId(`desktop-background-option-${id}`)).toBeInTheDocument();
    }
    // #2915: the engine-backed Life tile is the 8th option, appended after Halo.
    expect(screen.getByTestId('desktop-background-option-life')).toBeInTheDocument();

    expect(
      screen.getByText('Renders behind your windows and never blocks clicks.'),
    ).toBeInTheDocument();
  });

  it('renders the Life tile with its accessible description + the always-visible licence notice', () => {
    renderWithChakra(<BackgroundSettings />);

    const life = screen.getByTestId('desktop-background-option-life');
    expect(life).toHaveAttribute('aria-label', 'Life');
    expect(life).toHaveAttribute('aria-description', "Living Conway's Game of Life");
    expect(life).toHaveAttribute('aria-describedby', 'desktop-background-life-attribution');

    // Not colour-only: the tile is a real radio button like the others.
    expect(life).toHaveAttribute('role', 'radio');
    expect(life).toHaveAttribute('aria-checked', 'false');

    // The notice always renders (independent of the current selection) and its
    // id IS the tile's aria-describedby target.
    const notice = screen.getByTestId('desktop-background-life-attribution');
    expect(notice).toHaveAttribute('id', 'desktop-background-life-attribution');
    expect(notice).toHaveTextContent('Patterns: Life Lexicon (Stephen Silver), CC BY-SA 3.0.');

    // No other tile gains a description (the radiogroup scan stays homogeneous).
    expect(screen.getByTestId('desktop-background-option-halo')).not.toHaveAttribute(
      'aria-description',
    );
  });

  it('keeps the Life chooser thumbnail STATIC — the automaton never runs in the chooser', () => {
    renderWithChakra(<BackgroundSettings />);

    const thumb = screen.getByTestId('desktop-background-life-thumb');
    expect(thumb).toHaveAttribute('data-life-preview', 'static');
    expect(thumb).toHaveAttribute('aria-hidden', 'true');

    // No engine, no canvas, no frame loop anywhere in the settings tree.
    expect(screen.queryByTestId('desktop-backdrop-life-canvas')).toBeNull();
    expect(document.querySelector('[data-background-layer="life-field"]')).toBeNull();

    // Token-only founder frame: ground + cell tokens, never a colour literal.
    expect(thumb.innerHTML).toContain('var(--body-bg)');
    expect(thumb.innerHTML).toContain('var(--accent-primary)');
    expect(thumb.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(thumb.innerHTML).not.toMatch(/\brgba?\s*\(/);
    expect(thumb.innerHTML).not.toMatch(/\bhsla?\s*\(/);
  });

  it('defaults to None selected (aria-checked + data-selected + roving tabindex)', () => {
    renderWithChakra(<BackgroundSettings />);

    const none = screen.getByTestId('desktop-background-option-none');
    expect(none).toHaveAttribute('aria-checked', 'true');
    expect(none).toHaveAttribute('data-selected', 'true');
    expect(none).toHaveAttribute('tabindex', '0');

    const aurora = screen.getByTestId('desktop-background-option-aurora');
    expect(aurora).toHaveAttribute('aria-checked', 'false');
    expect(aurora).toHaveAttribute('data-selected', 'false');
    expect(aurora).toHaveAttribute('tabindex', '-1');
  });

  it('renders a live preview swatch (descriptor css) inside each tile', () => {
    renderWithChakra(<BackgroundSettings />);

    const aurora = screen.getByTestId('desktop-background-option-aurora');
    const swatch = aurora.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(swatch).not.toBeNull();
    expect(getComputedStyle(swatch).pointerEvents).toBe('none');
  });

  it('selects on click, calls selectBackground, and moves the selected state', async () => {
    renderWithChakra(<BackgroundSettings />);

    fireEvent.click(screen.getByTestId('desktop-background-option-aurora'));

    expect(selectBackgroundMock).toHaveBeenCalledWith('aurora');
    await waitFor(() => {
      expect(screen.getByTestId('desktop-background-option-aurora')).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    // Selected state is never colour-only: the check glyph shows on the selected
    // tile and not on the deselected one.
    expect(screen.getByTestId('desktop-background-option-aurora').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('desktop-background-option-none').querySelector('svg')).toBeNull();

    // The real store persisted the raw id through settingsService.
    expect(setMock).toHaveBeenCalledWith('Fredo_desktop_background', 'aurora');
  });

  it('keyboard: ArrowRight/ArrowLeft move + select; Home/End jump to the ends', async () => {
    renderWithChakra(<BackgroundSettings />);

    const none = screen.getByTestId('desktop-background-option-none');
    none.focus();
    fireEvent.keyDown(none, { key: 'ArrowRight' });
    expect(selectBackgroundMock).toHaveBeenLastCalledWith('aurora');
    await waitFor(() => {
      expect(screen.getByTestId('desktop-background-option-aurora')).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
    // Focus follows selection.
    expect(document.activeElement).toBe(screen.getByTestId('desktop-background-option-aurora'));

    fireEvent.keyDown(screen.getByTestId('desktop-background-option-aurora'), { key: 'ArrowLeft' });
    expect(selectBackgroundMock).toHaveBeenLastCalledWith('none');

    fireEvent.keyDown(screen.getByTestId('desktop-background-option-none'), { key: 'End' });
    // The last option is now the engine-backed Life tile (#2915).
    expect(selectBackgroundMock).toHaveBeenLastCalledWith('life');
    await waitFor(() => {
      expect(screen.getByTestId('desktop-background-option-life')).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    fireEvent.keyDown(screen.getByTestId('desktop-background-option-life'), { key: 'Home' });
    expect(selectBackgroundMock).toHaveBeenLastCalledWith('none');
  });

  it('keyboard: Enter/Space activate the focused tile (native button)', async () => {
    const user = userEvent.setup();
    renderWithChakra(<BackgroundSettings />);

    const mesh = screen.getByTestId('desktop-background-option-mesh');
    mesh.focus();
    await user.keyboard('{Enter}');
    expect(selectBackgroundMock).toHaveBeenCalledWith('mesh');

    // Space re-selects the (now) selected tile — idempotent, no error.
    await user.keyboard(' ');
    expect(selectBackgroundMock).toHaveBeenLastCalledWith('mesh');
  });
});
