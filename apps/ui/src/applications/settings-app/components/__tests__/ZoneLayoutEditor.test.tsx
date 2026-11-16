/**
 * ZoneLayoutEditor DOM suite (Spec #2980 ST-3; EARS R-2.1, R-2.2, R-2.4, R-2.5;
 * plan UI/UX §1 ZoneLayoutEditor + QA Rows R-2.1..R-2.5).
 *
 * Integration through the live editor: template selection paints the preview,
 * count/main-fraction updates rebuild the zones, a custom split (`splitZone`)
 * replaces a selected zone with two, the confirm is disabled with zero zones and a
 * submit attempt still surfaces the error, an empty name blocks the save, cancel
 * discards with no store write, and confirm upserts through `saveZoneLayout` only
 * (so editing the active layout cannot corrupt the running workspace). A source
 * audit pins the token-first chrome (no hex/rgba, no `var(--x)NN` alpha-append).
 *
 * `settingsService` is mocked at the same seam as the ST-1 store test so the suite
 * stays host-agnostic; `saveZoneLayout` is a pass-through spy over the real store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { buildTemplateZones, type ZoneLayout } from '@/shared/window-system/zoneLayout';
import {
  getZoneLayoutSnapshot,
  resetZoneLayoutStoreForTests,
  saveZoneLayout,
} from '@/shared/window-system/zoneLayoutStore';

import { ZoneLayoutEditor } from '../ZoneLayoutEditor';

vi.mock('@/applications/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/applications/settings')>();
  return {
    ...actual,
    settingsService: {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('@/shared/window-system/zoneLayoutStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/shared/window-system/zoneLayoutStore')>();
  return {
    ...actual,
    saveZoneLayout: vi.fn(actual.saveZoneLayout),
  };
});

const saveMock = vi.mocked(saveZoneLayout);

function zoneButtons(): HTMLElement[] {
  return screen.queryAllByTestId(/^layout-editor-zone-/);
}

function layoutFixture(overrides: Partial<ZoneLayout> = {}): ZoneLayout {
  return {
    id: 'l1',
    name: 'Work',
    template: 'columns',
    zones: buildTemplateZones('columns', { columns: 3 }),
    ...overrides,
  };
}

function renderEditor(props: Parameters<typeof ZoneLayoutEditor>[0] = {}) {
  return renderWithChakra(<ZoneLayoutEditor {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetZoneLayoutStoreForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  resetZoneLayoutStoreForTests();
  cleanup();
  document.body.innerHTML = '';
});

// ── 1. Surface + initial (zero-zone) state ───────────────────────────────────

describe('layout editor surface', () => {
  it('opens in place with the zero-zone state and a disabled confirm', () => {
    renderEditor();

    expect(screen.getByTestId('layout-editor')).toHaveAttribute('role', 'group');
    expect(screen.getByTestId('layout-editor')).toHaveAttribute(
      'aria-label',
      'Zone layout editor',
    );
    expect(screen.getByTestId('layout-editor-name')).toHaveValue('Untitled 1');
    expect(zoneButtons()).toHaveLength(0);
    expect(screen.getByTestId('layout-editor-preview')).toHaveTextContent(
      'Add a template or split to create zones.',
    );
    expect(screen.getByTestId('layout-editor-confirm')).toBeDisabled();
    expect(screen.getByTestId('layout-template-count')).toBeDisabled();
  });
});

// ── 2. Templates render zones (R-2.1) ────────────────────────────────────────

describe('templates render zones (R-2.1)', () => {
  it('paints columns / rows / grid zones with the radiogroup state', () => {
    renderEditor();

    fireEvent.click(screen.getByTestId('layout-template-columns'));
    expect(screen.getByTestId('layout-template-columns')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('layout-template-rows')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(zoneButtons()).toHaveLength(2);

    fireEvent.click(screen.getByTestId('layout-template-rows'));
    expect(zoneButtons()).toHaveLength(2);

    fireEvent.click(screen.getByTestId('layout-template-grid'));
    expect(zoneButtons()).toHaveLength(4);
    expect(screen.getByTestId('layout-template-count')).toHaveValue('2x2');
  });

  it('updates the zone count (columns/rows 2–4, grid 2×2 / 3×3)', () => {
    renderEditor();

    fireEvent.click(screen.getByTestId('layout-template-columns'));
    fireEvent.change(screen.getByTestId('layout-template-count'), {
      target: { value: '4' },
    });
    expect(zoneButtons()).toHaveLength(4);

    fireEvent.click(screen.getByTestId('layout-template-grid'));
    expect(zoneButtons()).toHaveLength(4);
    fireEvent.change(screen.getByTestId('layout-template-count'), {
      target: { value: '3x3' },
    });
    expect(zoneButtons()).toHaveLength(9);
  });

  it('main-side renders two zones and a working main-fraction control', () => {
    renderEditor();

    fireEvent.click(screen.getByTestId('layout-template-main-side'));
    expect(zoneButtons()).toHaveLength(2);
    expect(screen.getByTestId('layout-template-count')).toBeDisabled();

    const fraction = screen.getByTestId('layout-template-main-fraction');
    expect(fraction).toHaveValue('0.6');
    expect(screen.getByTestId('layout-editor-zone-zone-0')).toHaveStyle({ width: '60%' });

    fireEvent.change(fraction, { target: { value: '0.3' } });
    expect(screen.getByTestId('layout-editor-zone-zone-0')).toHaveStyle({ width: '30%' });
    expect(screen.getByTestId('layout-editor-zone-zone-1')).toHaveStyle({
      left: '30%',
      width: '70%',
    });
  });
});

// ── 3. Custom split (R-2.1) ──────────────────────────────────────────────────

describe('custom split', () => {
  it('is disabled until a zone is selected, then splits it in two', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('layout-template-columns'));

    const splitH = screen.getByTestId('layout-editor-split-h');
    const splitV = screen.getByTestId('layout-editor-split-v');
    expect(splitH).toBeDisabled();
    expect(splitV).toBeDisabled();

    fireEvent.click(screen.getByTestId('layout-editor-zone-zone-0'));
    expect(screen.getByTestId('layout-editor-zone-zone-0')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(splitH).toBeEnabled();

    fireEvent.click(splitH);
    const ids = zoneButtons().map((button) =>
      button.getAttribute('data-testid')?.replace('layout-editor-zone-', ''),
    );
    expect(ids).toEqual(['zone-0-a', 'zone-0-b', 'zone-1']);

    // The first child stays selected, so it can be split again (recursive).
    expect(screen.getByTestId('layout-editor-zone-zone-0-a')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(splitV);
    expect(zoneButtons()).toHaveLength(4);
  });
});

// ── 4. Zero-zone guard (R-2.4) ───────────────────────────────────────────────

describe('zero-zone guard (R-2.4)', () => {
  it('keeps confirm disabled and surfaces the error on a submit attempt', () => {
    renderEditor();
    const confirm = screen.getByTestId('layout-editor-confirm');
    expect(confirm).toBeDisabled();

    const form = confirm.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    expect(screen.getByTestId('layout-editor-error')).toHaveTextContent(
      'Add at least one zone before saving.',
    );
    expect(saveMock).not.toHaveBeenCalled();
  });
});

// ── 5. Empty-name guard (R-2.2) ──────────────────────────────────────────────

describe('empty-name guard (R-2.2)', () => {
  it('blocks the save and reports the error', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('layout-template-columns'));

    fireEvent.change(screen.getByTestId('layout-editor-name'), {
      target: { value: '   ' },
    });
    expect(screen.getByTestId('layout-editor-confirm')).toBeEnabled();
    fireEvent.click(screen.getByTestId('layout-editor-confirm'));

    expect(screen.getByTestId('layout-editor-error')).toHaveTextContent(
      'Enter a name for the layout.',
    );
    expect(saveMock).not.toHaveBeenCalled();
  });
});

// ── 6. Confirm saves through the store (R-2.2) ───────────────────────────────

describe('confirm saves through saveZoneLayout (R-2.2)', () => {
  it('upserts the draft and closes with the stored layout', () => {
    const onClose = vi.fn();
    renderEditor({ onClose });

    fireEvent.click(screen.getByTestId('layout-template-columns'));
    fireEvent.change(screen.getByTestId('layout-editor-name'), {
      target: { value: 'Work' },
    });
    fireEvent.click(screen.getByTestId('layout-editor-confirm'));

    expect(saveMock).toHaveBeenCalledTimes(1);
    const draft = saveMock.mock.calls[0][0];
    expect(draft.name).toBe('Work');
    expect(draft.template).toBe('columns');
    expect(draft.zones).toHaveLength(2);

    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ name: 'Work' }));
    expect(getZoneLayoutSnapshot().layouts).toHaveLength(1);
    expect(getZoneLayoutSnapshot().layouts[0].name).toBe('Work');
  });
});

// ── 7. Cancel discards the draft (R-2.5) ─────────────────────────────────────

describe('cancel discards the draft (R-2.5)', () => {
  it('writes nothing to the store and closes with null', () => {
    const onClose = vi.fn();
    renderEditor({ onClose });

    fireEvent.click(screen.getByTestId('layout-template-columns'));
    fireEvent.change(screen.getByTestId('layout-editor-name'), {
      target: { value: 'Discarded' },
    });
    fireEvent.click(screen.getByTestId('layout-editor-cancel'));

    expect(saveMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(null);
    expect(getZoneLayoutSnapshot().layouts).toHaveLength(0);
  });
});

// ── 8. Editing an existing layout upserts by id (R-2.5) ──────────────────────

describe('editing a layout (R-2.5)', () => {
  it('loads the draft, splits, and upserts the same id with updated zones', () => {
    renderEditor({ layout: layoutFixture() });

    expect(screen.getByTestId('layout-editor-name')).toHaveValue('Work');
    expect(zoneButtons()).toHaveLength(3);
    expect(screen.getByTestId('layout-template-columns')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByTestId('layout-editor-zone-zone-1'));
    fireEvent.click(screen.getByTestId('layout-editor-split-v'));
    expect(zoneButtons()).toHaveLength(4);

    fireEvent.click(screen.getByTestId('layout-editor-confirm'));
    expect(saveMock).toHaveBeenCalledTimes(1);
    const draft = saveMock.mock.calls[0][0];
    expect(draft.id).toBe('l1');
    expect(draft.zones).toHaveLength(4);
    expect(getZoneLayoutSnapshot().layouts).toHaveLength(1);
    expect(getZoneLayoutSnapshot().layouts[0].id).toBe('l1');
  });

  it('defaults a new layout name from the existing layout count', () => {
    saveZoneLayout(layoutFixture());
    saveMock.mockClear();

    renderEditor({ untitledIndex: 2 });
    expect(screen.getByTestId('layout-editor-name')).toHaveValue('Untitled 2');
  });
});

// ── 9. Source audit — token-first chrome ─────────────────────────────────────

describe('ZoneLayoutEditor source audit', () => {
  const SOURCE = readFileSync(
    resolve(process.cwd(), 'src/applications/settings-app/components/ZoneLayoutEditor.tsx'),
    'utf8',
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('contains no hex / rgb() / hsl() colour literal', () => {
    expect([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0])).toEqual([]);
  });

  it('contains no var(--x)NN alpha-append and uses the tint helper', () => {
    expect([...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0])).toEqual([]);
    expect(code).toContain("tint('var(--accent-primary)'");
  });
});
