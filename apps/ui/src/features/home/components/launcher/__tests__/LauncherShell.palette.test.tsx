/**
 * Spec #2946 ST-9 — the launcher command-bar `>` action palette (integration).
 *
 * Pins (over the real shell + the ONE shared hotkey engine):
 *   1. Typing `>` switches the below-bar results list to the declared actions
 *      (the app grid is replaced, not decorated), with `Keycap` binding chips.
 *   2. Enter on the focused action row runs it with `source: 'palette'`.
 *   3. A query WITHOUT the prefix keeps the shipped app path — the grid renders
 *      and Enter launches the app (`resolveEnterAction` untouched).
 *   4. The shipped `fredo.palette.openActions` default (`primary+P`) opens the
 *      command bar with `>` PRE-FILLED.
 *   5. Palette mode never moves the app grid's roving index (#2826): the grid is
 *      not rendered, and the app roving still works for a non-prefix query.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';
import { registerFredoAction, resetRegistryForTests } from '@/shared/hotkeys/registry';
import { resetKeymapStoreForTests } from '@/shared/hotkeys/store';
import { resetHotkeyEngineForTests } from '@/shared/hotkeys/engine';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { FredoFeatureClass } from '@/shared/classes/FredoFeatureClass';
import { LauncherShell } from '../LauncherShell';

type BarField = HTMLInputElement | HTMLTextAreaElement;

// LauncherShell reads the live connection flag via useConnectionStatus (no
// StreamProvider in this isolated harness) — stub the one consumer.
vi.mock('@/shared/contexts/StreamContext', () => ({
  useConnectionStatus: () => ({ isConnected: true }),
}));

const companionMock = vi.hoisted(() => ({
  current: {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    replyInFlight: false,
    queuedSendCount: 0,
  },
}));
vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => companionMock.current,
}));

vi.mock('@/shared/components/companion', () => ({
  CompanionEntity: () => null,
  askActiveCompanion: vi.fn(() => ({ outcome: 'dispatched' as const })),
  askActiveCompanionWithAudio: vi.fn(() => ({ outcome: 'dispatched' as const })),
}));

const APP = { id: 'settings', name: 'Settings', icon: () => null } as unknown as FredoFeatureClass;
const APP_TWO = {
  id: 'mission-monitor',
  name: 'Mission Monitor',
  icon: () => null,
} as unknown as FredoFeatureClass;

const STUB_ACTION_ID = 'fredo.test.action';

describe('LauncherShell — the `>` action palette (ST-9)', () => {
  const input = () => screen.getByRole('searchbox') as BarField;

  const renderShell = (features: FredoFeatureClass[] = [APP, APP_TWO]) => {
    const onOpenFeature = vi.fn();
    renderWithChakra(
      <HotkeysProvider>
        <LauncherShell showableFeatures={features} onOpenFeature={onOpenFeature} />
      </HotkeysProvider>,
    );
    return onOpenFeature;
  };

  const type = (value: string) => {
    act(() => {
      fireEvent.change(input(), { target: { value } });
    });
  };

  const keyDown = (key: string, init: KeyboardEventInit = {}) => {
    act(() => {
      fireEvent.keyDown(input(), { key, ...init });
    });
  };

  let actionRun: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    actionRun = vi.fn();
    resetRegistryForTests();
    resetKeymapStoreForTests();
    companionMock.current = {
      state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
      voiceEnabled: true,
      replyInFlight: false,
      queuedSendCount: 0,
    };
    adapterBridge.setInvoke((async () => undefined) as never);
    adapterBridge.setListen((async () => () => {}) as never);
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Element.prototype.scrollIntoView = vi.fn();
    // The action the palette must surface + run.
    registerFredoAction({
      actionId: STUB_ACTION_ID,
      title: 'Test action',
      description: 'does a test thing',
      defaultSequence: 'primary+t',
      run: actionRun,
    });
  });

  afterEach(() => {
    cleanup();
    resetHotkeyEngineForTests();
    resetRegistryForTests();
    resetKeymapStoreForTests();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('typing `>` switches the results list to the declared actions (app grid replaced)', () => {
    renderShell();

    type('>');

    const list = screen.getByTestId('launcher-action-list');
    expect(list).toHaveAttribute('role', 'listbox');
    // The app grid is REPLACED, not decorated (no second palette component, no
    // app tiles under an action list).
    expect(screen.queryByRole('grid')).toBeNull();

    const row = document.querySelector(`[data-testid="launcher-action-entry"][data-action-id="${STUB_ACTION_ID}"]`);
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('Test action');
    expect(row?.querySelector('[data-testid="launcher-action-binding"]')).not.toBeNull();
    expect(row?.querySelector('[data-testid="hotkeys-keycap"]')).not.toBeNull();
  });

  it('Enter on the focused action runs it with source: "palette"', () => {
    renderShell();

    type('>test');
    keyDown('Enter');

    expect(actionRun).toHaveBeenCalledTimes(1);
    const ctx = actionRun.mock.calls[0][0] as { actionId: string; source: string };
    expect(ctx.actionId).toBe(STUB_ACTION_ID);
    expect(ctx.source).toBe('palette');
  });

  it('a non-`>` query keeps the shipped app path (grid renders; Enter launches)', () => {
    const onOpenFeature = renderShell();

    type('set');

    expect(screen.queryByTestId('launcher-action-list')).toBeNull();
    expect(screen.getByRole('grid')).toBeInTheDocument();

    keyDown('Enter');
    expect(onOpenFeature).toHaveBeenCalledWith('settings', APP);
    expect(actionRun).not.toHaveBeenCalled();
  });

  it('the shipped `primary+P` default opens the bar with `>` pre-filled', () => {
    renderShell();

    act(() => {
      fireEvent.keyDown(document, { key: 'P', ctrlKey: true });
    });

    expect(input().value).toBe('>');
    expect(screen.getByTestId('launcher-action-list')).toBeInTheDocument();
  });

  it('palette mode never moves the app grid roving index (#2826); app roving still works', () => {
    renderShell();

    // Non-prefix path: focus engages the grid, ArrowRight advances the app tile.
    act(() => {
      const searchbox = input();
      searchbox.focus();
      fireEvent.focus(searchbox);
    });
    expect(screen.getByRole('grid')).toBeInTheDocument();
    keyDown('ArrowRight');
    const selectedTileId = () =>
      screen
        .getAllByRole('gridcell')
        .find((t) => t.querySelector('[role="button"]')?.getAttribute('tabindex') === '0')
        ?.querySelector('[role="button"]')
        ?.getAttribute('aria-label');
    expect(selectedTileId()).toBe('Mission Monitor');

    // Palette mode: the app grid is gone; arrows move the ACTION selection only.
    type('>');
    expect(screen.queryByRole('grid')).toBeNull();
    keyDown('ArrowDown');
    expect(document.querySelector('[data-testid="launcher-action-entry"][tabindex="0"]')?.id).toBe(
      'fredo-launcher-action-1',
    );
  });
});
