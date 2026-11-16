/**
 * Spec #2971 ST-6 — cross-layer Doom visual pins.
 *
 * The existing ST-2/ST-4/ST-5 pins cover the store in isolation, the
 * `ThemeProvider` palette apply/revert, and the armor overlay in isolation.
 * This file pins the wiring BETWEEN them:
 *
 * - ST-3 funnel: `useDoomMode().applyStatus` drives the module-scoped
 *   `doomVisual` store from `isDoomModeEngaged(phase)` (so `entering`/`exiting`
 *   engage, not only `active`), on BOTH the mount seed and every broadcast.
 * - R-7 continuity: the restyle + armor survive a consumer unmount/remount
 *   while engaged — carried by the module-scoped store, never a `useRef`.
 * - R-8 fail-enter: a `mark_enter_failed → Inactive` broadcast reverts the
 *   theme AND the armor with no residue.
 * - R-2 token-first: engaging writes only the pre-existing `--*` contract —
 *   never a new `--doom-*` namespace.
 */
import React from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('../../utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: invokeMock,
    listen: listenMock,
  },
}));

vi.mock('../../../applications/settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
  serializeValue: (v: unknown) => JSON.stringify(v),
}));

import { ThemeProvider } from '../../../app/providers/ThemeProvider';
import { DOOM_PALETTE } from '../../../app/theme/doomTheme';
import { FredoAvatar } from '../../components/fredo-avatar/FredoAvatar';
import { settingsService } from '../../../applications/settings';
import { isDoomVisualEngaged, setDoomVisualEngaged } from '../doomVisual';
import {
  DOOM_MODE_EVENT,
  DOOM_MODE_INACTIVE_STATUS,
  type DoomModePhase,
  type DoomModeStatus,
} from '../types';
import { useDoomMode } from '../useDoomMode';

type Handler = (payload: unknown) => void;

let handlers: Record<string, Handler[]>;

const getMock = settingsService.get as ReturnType<typeof vi.fn>;

const statusFor = (phase: DoomModePhase): DoomModeStatus => ({
  phase,
  active: phase === 'active',
  voiceSuppressed: phase === 'active',
  origin: phase === 'inactive' ? null : 'code',
  enteredAt: phase === 'inactive' ? null : '2026-10-05T00:00:00+00:00',
  lastError: null,
  code: null,
});

const emit = (payload: DoomModeStatus) => {
  act(() => {
    (handlers[DOOM_MODE_EVENT] ?? []).forEach((handler) => handler(payload));
  });
};

/** A realistic consumer tree: the theme layer wrapping the armored avatar. */
function Consumer() {
  return (
    <ThemeProvider>
      <FredoAvatar size="sm" state="idle" />
    </ThemeProvider>
  );
}

const doomClass = () => document.documentElement.classList.contains('doom-mode');
const doomAttr = () => document.documentElement.getAttribute('data-doom-mode');
const bodyBg = () => document.documentElement.style.getPropertyValue('--body-bg');
const accentPrimary = () => document.documentElement.style.getPropertyValue('--accent-primary');
const armor = (container: HTMLElement) => container.querySelector('#fredo-armor');

const stylePropNames = (): string[] => {
  const names: string[] = [];
  const style = document.documentElement.style;
  for (let i = 0; i < style.length; i += 1) names.push(style.item(i));
  return names;
};

const flush = async () => {
  await act(async () => {});
};

const clearPaint = () => {
  document.documentElement.removeAttribute('style');
  document.documentElement.classList.remove('doom-mode');
  document.documentElement.removeAttribute('data-doom-mode');
  document.body.removeAttribute('style');
};

beforeEach(() => {
  handlers = {};
  setDoomVisualEngaged(false);
  clearPaint();
  invokeMock.mockReset();
  listenMock.mockReset();
  invokeMock.mockResolvedValue(DOOM_MODE_INACTIVE_STATUS);
  getMock.mockReset();
  // Resolve every persisted theme key to its typed default (stock base).
  getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);
  listenMock.mockImplementation(async (event: string, handler: Handler) => {
    (handlers[event] ??= []).push(handler);
    return vi.fn();
  });
});

afterEach(() => {
  cleanup();
  setDoomVisualEngaged(false);
});

describe('#2971 ST-6 Doom visual wiring', () => {
  it('drives the store from the phase funnel: entering/active/exiting engage, inactive reverts (ST-3)', async () => {
    renderHook(() => useDoomMode());
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    for (const phase of ['entering', 'active', 'exiting'] as DoomModePhase[]) {
      emit(statusFor(phase));
      expect(isDoomVisualEngaged(), `phase ${phase} should engage`).toBe(true);
    }

    emit(DOOM_MODE_INACTIVE_STATUS);
    expect(isDoomVisualEngaged()).toBe(false);
  });

  it('engages from the mount seed when the backend is already active (ST-3)', async () => {
    invokeMock.mockResolvedValue(statusFor('active'));
    renderHook(() => useDoomMode());

    await waitFor(() => expect(isDoomVisualEngaged()).toBe(true));
  });

  it('R-7: the restyle + armor survive a consumer remount while engaged (module-scoped store)', async () => {
    const driver = renderHook(() => useDoomMode());
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    emit(statusFor('active'));
    expect(isDoomVisualEngaged()).toBe(true);

    const first = render(<Consumer />);
    await flush();
    expect(doomClass()).toBe(true);
    expect(doomAttr()).toBe('engaged');
    expect(bodyBg()).toBe(DOOM_PALETTE.bodyBg);
    expect(armor(first.container)).not.toBeNull();

    // Unmount the consumer and WIPE its paint, so a remount must re-derive
    // engagement from the module-scoped store — a `useRef` would reset here.
    first.unmount();
    clearPaint();
    expect(isDoomVisualEngaged()).toBe(true);

    const second = render(<Consumer />);
    await flush();
    expect(doomClass()).toBe(true);
    expect(doomAttr()).toBe('engaged');
    expect(bodyBg()).toBe(DOOM_PALETTE.bodyBg);
    expect(accentPrimary()).toBe(DOOM_PALETTE.accentPrimary);
    expect(armor(second.container)).not.toBeNull();
    expect(second.container.querySelector('svg')!.getAttribute('data-doom-armor')).toBe('true');

    driver.unmount();
  });

  it('R-8: a failed-enter inactive broadcast reverts the theme and armor with no residue', async () => {
    const driver = renderHook(() => useDoomMode());
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    const view = render(<Consumer />);
    await flush();

    // Engaged (active) → Doom theme + armor.
    emit(statusFor('active'));
    await flush();
    expect(doomClass()).toBe(true);
    expect(doomAttr()).toBe('engaged');
    expect(bodyBg()).toBe(DOOM_PALETTE.bodyBg);
    expect(armor(view.container)).not.toBeNull();

    // mark_enter_failed → Inactive travels the SAME broadcast path.
    emit(DOOM_MODE_INACTIVE_STATUS);
    await flush();

    expect(isDoomVisualEngaged()).toBe(false);
    expect(doomClass()).toBe(false);
    expect(doomAttr()).toBeNull();
    expect(bodyBg()).not.toBe(DOOM_PALETTE.bodyBg);
    expect(accentPrimary()).not.toBe(DOOM_PALETTE.accentPrimary);
    expect(armor(view.container)).toBeNull();
    expect(view.container.querySelector('svg')!.hasAttribute('data-doom-armor')).toBe(false);

    driver.unmount();
  });

  it('R-2: engaging writes only the pre-existing --* contract — no --doom-* namespace', async () => {
    const driver = renderHook(() => useDoomMode());
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    emit(statusFor('active'));
    const view = render(<Consumer />);
    await flush();
    expect(doomClass()).toBe(true);

    expect(stylePropNames().filter((name) => name.startsWith('--doom'))).toEqual([]);
    // Sanity: the Doom layer really did write the shared contract vars.
    expect(bodyBg()).toBe(DOOM_PALETTE.bodyBg);
    expect(accentPrimary()).toBe(DOOM_PALETTE.accentPrimary);

    view.unmount();
    driver.unmount();
  });
});
