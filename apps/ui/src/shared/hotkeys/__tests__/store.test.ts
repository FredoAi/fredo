/**
 * Spec #2946 ST-2 — keymap store tests (R-4.3/R-4.4, store contract block 6).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { settingsService } from '../../../features/settings';
import { createDefaultKeymap, saveKeymap } from '../persistence';
import {
  clearPendingSequence,
  getBinding,
  getHotkeyCandidates,
  getHotkeyRevision,
  getKeymap,
  hydrateKeymap,
  resetAllBindings,
  resetBinding,
  resetKeymapStoreForTests,
  setBinding,
  setMacroRecording,
  setMacros,
  setPassthrough,
  setPendingSequence,
  subscribeHotkeyEvents,
  subscribeHotkeys,
  useHotkeyCandidates,
  useHotkeyRevision,
} from '../store';
import type { HotkeyCandidate, HotkeyEvent, PersistedMacro } from '../types';

beforeEach(() => {
  localStorage.clear();
  resetKeymapStoreForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('hydration (idempotent + dirty-guarded)', () => {
  it('reads the persisted document exactly once', async () => {
    await saveKeymap({ ...createDefaultKeymap(), leader: 'space' });
    const getSpy = vi.spyOn(settingsService, 'get');

    await hydrateKeymap();
    await hydrateKeymap();

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getKeymap().leader).toBe('space');
  });

  it('never clobbers a user mutation made while the read is in flight', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const getSpy = vi.spyOn(settingsService, 'get').mockReturnValueOnce(pending as never);

    const hydration = hydrateKeymap();
    await setBinding('fredo.launcher.toggle', ['primary+shift+l']);
    release(createDefaultKeymap());
    await hydration;

    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+shift+l']);
    getSpy.mockRestore();
  });
});

describe('optimistic write-through (R-4.3)', () => {
  it('reverts the in-memory change when persistence fails', async () => {
    vi.spyOn(settingsService, 'set').mockRejectedValueOnce(new Error('persist failed'));

    await expect(setBinding('fredo.launcher.toggle', ['primary+shift+l'])).rejects.toThrow(
      'persist failed',
    );
    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
  });

  it('advances the revision only on a real mutation', async () => {
    const start = getHotkeyRevision();

    await setBinding('fredo.launcher.toggle', ['primary+space']); // same as default → no-op
    expect(getHotkeyRevision()).toBe(start);

    await setBinding('fredo.launcher.toggle', ['primary+shift+l']);
    expect(getHotkeyRevision()).toBe(start + 1);

    await setBinding('fredo.launcher.toggle', ['primary+shift+l']); // identical → no-op
    expect(getHotkeyRevision()).toBe(start + 1);
  });

  it('notifies subscribers on mutation and stops after unsubscribe', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHotkeys(listener);

    await setBinding('fredo.launcher.toggle', ['primary+shift+l']);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await setBinding('fredo.launcher.toggle', ['primary+shift+k']);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('resets (R-4.4)', () => {
  it('reset-one restores only the affected binding', async () => {
    await setBinding('fredo.launcher.toggle', ['primary+shift+l']);
    await setBinding('fredo.help.cheatsheet', ['primary+shift+h']);

    await resetBinding('fredo.launcher.toggle');

    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
    expect(getBinding('fredo.help.cheatsheet')).toEqual(['primary+shift+h']);
  });

  it('reset-all restores defaults and keeps macros, unbinding their triggers', async () => {
    const macro: PersistedMacro = {
      id: 'm1',
      name: 'Macro one',
      steps: ['fredo.launcher.toggle'],
      trigger: 'primary+alt+m',
      onStepError: 'abort',
    };
    await setMacros([macro]);
    await setBinding('fredo.help.cheatsheet', ['primary+shift+h']);

    await resetAllBindings();

    expect(getBinding('fredo.help.cheatsheet')).toEqual(['?']);
    expect(getKeymap().macros).toHaveLength(1);
    expect(getKeymap().macros[0].trigger).toBeNull();
  });
});

describe('read stability', () => {
  it('returns a stable empty reference for an unknown action', () => {
    expect(getBinding('unknown.action')).toEqual([]);
    expect(getBinding('unknown.action')).toBe(getBinding('unknown.action'));
  });
});

describe('in-process event stream', () => {
  it('emits keymap:changed and the transient events', async () => {
    const events: HotkeyEvent[] = [];
    const unsubscribe = subscribeHotkeyEvents((event) => events.push(event));

    await setBinding('fredo.launcher.toggle', ['primary+shift+l']);
    setPendingSequence('g', []);
    setPassthrough(true);
    setMacroRecording(true, 'macro-1', 123);

    expect(events.map((event) => event.type)).toEqual([
      'keymap:changed',
      'sequence:pending',
      'passthrough:changed',
      'macro:recording',
    ]);
    unsubscribe();
  });
});

describe('transient candidate state', () => {
  it('replaces candidates on pending and restores the frozen empty singleton on reset', () => {
    const empty = getHotkeyCandidates();
    const candidate: HotkeyCandidate = {
      strokeToken: 'g',
      display: 'G',
      actionId: 'demo-widget.focus',
      title: 'Focus',
      tier: 'feature',
    };

    setPendingSequence('g', [candidate]);
    expect(getHotkeyCandidates()).toHaveLength(1);

    clearPendingSequence('timeout');
    expect(getHotkeyCandidates()).toBe(empty);
  });
});

describe('React bindings (no re-render loop)', () => {
  it('useHotkeyRevision re-renders only on a real keymap mutation', async () => {
    const revision = renderHook(() => useHotkeyRevision());
    expect(revision.result.current).toBe(0);

    await act(async () => {
      await setBinding('fredo.launcher.toggle', ['primary+shift+l']);
    });
    expect(revision.result.current).toBe(1);

    await act(async () => {
      await setBinding('fredo.launcher.toggle', ['primary+shift+l']); // no-op
    });
    expect(revision.result.current).toBe(1);
  });

  it('useHotkeyCandidates re-renders when the candidate set changes', () => {
    const candidates = renderHook(() => useHotkeyCandidates());
    expect(candidates.result.current).toHaveLength(0);

    act(() => {
      setPendingSequence('g', [
        {
          strokeToken: 'g',
          display: 'G',
          actionId: 'demo-widget.focus',
          title: 'Focus',
          tier: 'feature',
        },
      ]);
    });
    expect(candidates.result.current).toHaveLength(1);

    act(() => {
      clearPendingSequence('escape');
    });
    expect(candidates.result.current).toHaveLength(0);
  });
});
