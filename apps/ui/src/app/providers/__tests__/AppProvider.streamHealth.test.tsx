/**
 * AppProvider stream-health routing + producer pins — Spec #3064 ST-3.
 *
 * The `{"streamHealth": …}` heartbeat rides the EXISTING "fredo-stream-event"
 * channel and MUST be discriminated BEFORE the application/row validators (it
 * can never be mis-routed into the row store). The producer hook drives the
 * shared three-valued health from the heartbeat (event-driven, zero IPC) and
 * from ONE bounded `stream_health` probe per tick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, screen } from '@testing-library/react';
import React from 'react';

import { AppProvider } from '../AppProvider';
import {
  StreamProvider,
  resetRowStoreForTests,
  getRowEpoch,
  useStreamHealth,
} from '../../../shared/contexts/StreamContext';
import { isStreamHealthEnvelope } from '../../../shared/classes/EventSubscription';
import {
  resolveStreamHealthForce,
  FORCE_STREAM_HEALTH_STORAGE_KEY,
} from '../../../shared/hooks/useStreamHealthProducer';
import { STREAM_HEALTH_CHECK_INTERVAL_MS } from '../../../shared/hooks/streamHealth';
import type { HostAdapter } from '../../adapters/HostAdapter';
import type { RowDelivery } from '../../../shared/classes/EventSubscription';

function makeAdapter(
  invokeImpl: (command: string, args?: Record<string, unknown>) => Promise<unknown> = () =>
    Promise.resolve(undefined),
): { adapter: HostAdapter; dispatch: (msg: Record<string, unknown>) => void } {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  const adapter: HostAdapter = {
    onMessage(h: (msg: any) => void) {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    invoke: vi.fn(invokeImpl),
    llmChat: vi.fn().mockResolvedValue(undefined),
    llmChatWithImage: vi.fn().mockResolvedValue(undefined),
  };
  return {
    adapter,
    dispatch: (msg) => {
      if (!handler) throw new Error('onMessage handler not registered yet');
      handler(msg);
    },
  };
}

const HealthProbe = () => {
  const { health, isConnected } = useStreamHealth();
  return (
    <span
      data-testid="health"
      data-health={health}
      data-connected={String(isConnected)}
    />
  );
};

const HEALTHY_SNAPSHOT = {
  seq: 3,
  ingestConnected: true,
  ageMs: 0,
  forced: false,
};

const ROW_DELIVERY: RowDelivery = {
  queryId: 'q-1',
  eventType: 'Chat',
  kind: 'insert',
  seq: 1,
  key: { sessionId: 'ses_a', correlationId: 'ses_a_1' },
  patch: {
    sessionId: 'ses_a',
    correlationId: 'ses_a_1',
    seq: 1,
    state: 'Init',
    userMessage: 'hello',
    rawJson: '{}',
  } as RowDelivery['patch'],
  timestamp: '2026-09-01T00:00:00+00:00',
};

function healthOf(): string | null {
  return screen.queryByTestId('health')?.getAttribute('data-health') ?? null;
}

/** Narrow view of the test-injectable `window` key (no global augmentation). */
interface TestWindow {
  __FREDO_STREAM_HEALTH_FORCE__?: unknown;
}

function testWindow(): TestWindow {
  return window as unknown as TestWindow;
}

describe('isStreamHealthEnvelope', () => {
  it('accepts a well-formed heartbeat envelope', () => {
    expect(
      isStreamHealthEnvelope({
        streamHealth: { seq: 1, ingestConnected: true, ageMs: 0, emittedAtMs: 42 },
      }),
    ).toBe(true);
  });

  it('rejects malformed / partial envelopes', () => {
    expect(isStreamHealthEnvelope(null)).toBe(false);
    expect(isStreamHealthEnvelope({})).toBe(false);
    expect(isStreamHealthEnvelope({ streamHealth: null })).toBe(false);
    expect(isStreamHealthEnvelope({ streamHealth: { seq: 1 } })).toBe(false);
    expect(
      isStreamHealthEnvelope({
        streamHealth: { seq: 1, ingestConnected: true, ageMs: 0 },
      }),
      'emittedAtMs is required',
    ).toBe(false);
  });
});

describe('resolveStreamHealthForce (inert-by-default lever)', () => {
  afterEach(() => {
    window.sessionStorage.clear();
    delete testWindow().__FREDO_STREAM_HEALTH_FORCE__;
  });

  it('is inert when unset', () => {
    expect(resolveStreamHealthForce()).toBeNull();
  });

  it('is inert for blank/unknown tokens', () => {
    window.sessionStorage.setItem(FORCE_STREAM_HEALTH_STORAGE_KEY, '');
    expect(resolveStreamHealthForce()).toBeNull();
    window.sessionStorage.setItem(FORCE_STREAM_HEALTH_STORAGE_KEY, 'unknown');
    expect(resolveStreamHealthForce()).toBeNull();
  });

  it('resolves degraded/down from sessionStorage and the window key', () => {
    window.sessionStorage.setItem(FORCE_STREAM_HEALTH_STORAGE_KEY, 'down');
    expect(resolveStreamHealthForce()).toBe('down');
    window.sessionStorage.clear();
    testWindow().__FREDO_STREAM_HEALTH_FORCE__ = 'degraded';
    expect(resolveStreamHealthForce()).toBe('degraded');
  });
});

describe('AppProvider — streamHealth routing + producer (Spec #3064 ST-3)', () => {
  beforeEach(() => {
    resetRowStoreForTests();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    delete testWindow().__FREDO_STREAM_HEALTH_FORCE__;
  });

  it('applies a heartbeat envelope immediately (healthy) and never touches the row store', async () => {
    const { adapter, dispatch } = makeAdapter(() => Promise.resolve(HEALTHY_SNAPSHOT));
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <HealthProbe />
        </AppProvider>
      </StreamProvider>,
    );
    await waitFor(() => expect(healthOf()).toBe('healthy'));

    act(() => {
      dispatch({
        streamHealth: { seq: 9, ingestConnected: true, ageMs: 0, emittedAtMs: 1000 },
      });
    });

    expect(healthOf()).toBe('healthy');
    expect(getRowEpoch('Chat')).toBe(0, 'a heartbeat is never mis-routed into the row store');
  });

  it('reads degraded when the heartbeat reports ingest disconnected', async () => {
    const { adapter, dispatch } = makeAdapter(() => Promise.resolve(HEALTHY_SNAPSHOT));
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <HealthProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({
        streamHealth: { seq: 4, ingestConnected: false, ageMs: 0, emittedAtMs: 2000 },
      });
    });

    expect(healthOf()).toBe('degraded');
  });

  it('derives healthy from a fresh, connected probe', async () => {
    const { adapter } = makeAdapter(() => Promise.resolve(HEALTHY_SNAPSHOT));
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <HealthProbe />
        </AppProvider>
      </StreamProvider>,
    );

    await waitFor(() => expect(healthOf()).toBe('healthy'));
    expect(adapter.invoke).toHaveBeenCalledWith('stream_health');
  });

  it('reads down when the probe rejects', async () => {
    const { adapter } = makeAdapter(() => Promise.reject(new Error('ipc unavailable')));
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <HealthProbe />
        </AppProvider>
      </StreamProvider>,
    );

    await waitFor(() => expect(healthOf()).toBe('down'));
  });

  it('reads degraded from a stale (ok) probe', async () => {
    const { adapter } = makeAdapter(() =>
      Promise.resolve({ seq: 1, ingestConnected: true, ageMs: 20_000, forced: false }),
    );
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <HealthProbe />
        </AppProvider>
      </StreamProvider>,
    );

    await waitFor(() => expect(healthOf()).toBe('degraded'));
  });

  it('applies the runtime force lever (down) without probing', async () => {
    window.sessionStorage.setItem(FORCE_STREAM_HEALTH_STORAGE_KEY, 'down');
    const { adapter } = makeAdapter(() => Promise.resolve(HEALTHY_SNAPSHOT));
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <HealthProbe />
        </AppProvider>
      </StreamProvider>,
    );

    await waitFor(() => expect(healthOf()).toBe('down'));
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it('issues ONE probe on mount and ZERO extra on a re-render', async () => {
    const { adapter, dispatch } = makeAdapter(() => Promise.resolve(HEALTHY_SNAPSHOT));
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <HealthProbe />
        </AppProvider>
      </StreamProvider>,
    );
    await waitFor(() => expect(adapter.invoke).toHaveBeenCalledTimes(1));

    // A row delivery re-renders the provider; the stable probe callback must
    // NOT re-run the effect (zero extra IPC).
    act(() => {
      dispatch(ROW_DELIVERY as unknown as Record<string, unknown>);
    });

    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(getRowEpoch('Chat')).toBe(1);
  });

  it('keeps probing on the bounded interval', async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = makeAdapter(() => Promise.resolve(HEALTHY_SNAPSHOT));
      render(
        <StreamProvider>
          <AppProvider adapter={adapter}>
            <HealthProbe />
          </AppProvider>
        </StreamProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(adapter.invoke).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(STREAM_HEALTH_CHECK_INTERVAL_MS);
      });
      expect(adapter.invoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
