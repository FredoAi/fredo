/**
 * Spec #2970 ST-6 (R-4.a, UI/UX §2) — the launcher voice affordance is gated on
 * the module-scoped `performanceGate`.
 *
 * While Doom Mode suppresses the voice/audio pipeline the bar receives
 * `voiceEnabled=false` and `holdAvailable=false`, and the error surface is
 * FORCED empty (`voiceErrorMessage=null`) so no `role="alert"` copy renders —
 * the suppression is silent (AC4) and the main window reveals nothing (AC3).
 * Restoring the gate restores every affordance.
 *
 * `LauncherCommandBar` is stubbed to capture the props the shell passes down,
 * which is the exact seam the gate drives.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { setPerformanceGateActive } from '@/shared/doom-mode';
import { LauncherShell } from '../LauncherShell';

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

const barProps = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));
vi.mock('../LauncherCommandBar', () => ({
  LauncherCommandBar: (props: Record<string, unknown>) => {
    barProps.current.push(props);
    return null;
  },
}));

const lastProps = () => barProps.current[barProps.current.length - 1];

beforeEach(() => {
  setPerformanceGateActive(false);
  barProps.current.length = 0;
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
});

afterEach(() => {
  cleanup();
  setPerformanceGateActive(false);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Spec #2970 ST-6 — launcher voice suppression gate', () => {
  it('closes every voice affordance while suppressed and restores it after', async () => {
    renderWithChakra(
      <HotkeysProvider>
        <LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />
      </HotkeysProvider>,
    );

    await waitFor(() => expect(lastProps()).toBeTruthy());
    expect(lastProps().voiceEnabled).toBe(true);
    expect(lastProps().holdAvailable).toBe(true);

    act(() => setPerformanceGateActive(true));
    await waitFor(() => expect(lastProps().voiceEnabled).toBe(false));
    expect(lastProps().holdAvailable).toBe(false);
    expect(lastProps().voiceErrorMessage).toBeNull();

    act(() => setPerformanceGateActive(false));
    await waitFor(() => expect(lastProps().voiceEnabled).toBe(true));
    expect(lastProps().holdAvailable).toBe(true);
  });
});
