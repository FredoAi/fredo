/**
 * Spec #3195 ST-1 — the pane-local capture-liveness read.
 *
 * Pins the WHOLE mapping (healthy→running, degraded→notRunning, unreadable→
 * unknown), the typed `ingestFailure` carry rule (present case + ABSENT-key case
 * + malformed-dropped, G-413), the fail-closed default, and the equality guard
 * that keeps a steady poll from re-writing state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: vi.fn(),
    listen: vi.fn().mockResolvedValue(() => {}),
  },
}));

import { adapterBridge } from '@/shared/utils/adapterBridge';
import { STREAM_HEARTBEAT_STALE_MS } from '@/shared/hooks/streamHealth';
import {
  getCaptureStatus,
  normalizeCaptureSnapshot,
  sameCaptureStatus,
  UNKNOWN_CAPTURE_STATUS,
  type CaptureStatusView,
} from '../captureStatus';

const invokeMock = vi.mocked(adapterBridge.invoke);

// ── Wire fixtures (the REAL `stream_health` snapshot shape) ──────────────────

const HEALTHY_SNAPSHOT = {
  seq: 12,
  ingestConnected: true,
  ageMs: 120,
  forced: false,
};

const TYPED_FAILURE = {
  receiver: 'grpc' as const,
  port: 4317,
  code: 'addrInUse' as const,
  message: 'address already in use',
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe('#3195 ST-1 — normalizeCaptureSnapshot', () => {
  it('maps a healthy snapshot to running', () => {
    expect(normalizeCaptureSnapshot(HEALTHY_SNAPSHOT)).toEqual({
      state: 'running',
      ingestFailure: null,
    });
  });

  it('maps ingestConnected: false to notRunning with no typed cause', () => {
    expect(normalizeCaptureSnapshot({ ...HEALTHY_SNAPSHOT, ingestConnected: false })).toEqual({
      state: 'notRunning',
      ingestFailure: null,
    });
  });

  it('maps a stale heartbeat to notRunning even when ingest reports connected', () => {
    expect(
      normalizeCaptureSnapshot({
        ...HEALTHY_SNAPSHOT,
        ageMs: STREAM_HEARTBEAT_STALE_MS + 1,
      }),
    ).toEqual({ state: 'notRunning', ingestFailure: null });
  });

  it('carries a well-formed ingestFailure (present-key wire case)', () => {
    const view = normalizeCaptureSnapshot({
      ...HEALTHY_SNAPSHOT,
      ingestConnected: false,
      ingestFailure: TYPED_FAILURE,
    });
    expect(view.state).toBe('notRunning');
    expect(view.ingestFailure).toEqual(TYPED_FAILURE);
  });

  it('leaves ingestFailure null when the key is ABSENT (absent-key wire rule, G-413)', () => {
    const raw: Record<string, unknown> = {
      ...HEALTHY_SNAPSHOT,
      ingestConnected: false,
    };
    expect('ingestFailure' in raw).toBe(false);
    expect(normalizeCaptureSnapshot(raw).ingestFailure).toBeNull();
  });

  it('drops a malformed ingestFailure instead of rendering a partial cause', () => {
    // Non-positive port, non-string message, unknown receiver/code — each must
    // fail `isIngestFailure` so the detail falls back to the generic sentence.
    const malformed = [
      { ...TYPED_FAILURE, port: 0 },
      { ...TYPED_FAILURE, port: '4317' },
      { ...TYPED_FAILURE, message: 42 },
      { ...TYPED_FAILURE, receiver: 'udp' },
      { ...TYPED_FAILURE, code: 'exploded' },
      'addrInUse',
    ];
    for (const failure of malformed) {
      const view = normalizeCaptureSnapshot({
        ...HEALTHY_SNAPSHOT,
        ingestConnected: false,
        ingestFailure: failure,
      });
      expect(view.state).toBe('notRunning');
      expect(view.ingestFailure).toBeNull();
    }
  });

  it('fails closed to unknown for anything that is not a snapshot', () => {
    const notSnapshots = [undefined, null, {}, [], 'healthy', 42, { ageMs: 10 }];
    for (const raw of notSnapshots) {
      expect(normalizeCaptureSnapshot(raw)).toEqual(UNKNOWN_CAPTURE_STATUS);
    }
  });

  it('fails closed to unknown when ingestConnected is not a boolean', () => {
    expect(normalizeCaptureSnapshot({ ...HEALTHY_SNAPSHOT, ingestConnected: 'true' })).toEqual(
      UNKNOWN_CAPTURE_STATUS,
    );
  });

  it('treats an unreadable ageMs as stale, never as running', () => {
    expect(
      normalizeCaptureSnapshot({ seq: 1, ingestConnected: true, ageMs: 'soon', forced: false }),
    ).toEqual({ state: 'notRunning', ingestFailure: null });
  });
});

describe('#3195 ST-1 — getCaptureStatus', () => {
  it('reads the existing stream_health command', async () => {
    invokeMock.mockResolvedValue(HEALTHY_SNAPSHOT);
    await expect(getCaptureStatus()).resolves.toEqual({
      state: 'running',
      ingestFailure: null,
    });
    expect(invokeMock).toHaveBeenCalledWith('stream_health');
  });

  it('resolves to unknown (never notRunning) when the invoke rejects', async () => {
    invokeMock.mockRejectedValue(new Error('ipc unavailable'));
    await expect(getCaptureStatus()).resolves.toEqual(UNKNOWN_CAPTURE_STATUS);
  });

  it('resolves to unknown when the transport returns nothing', async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(getCaptureStatus()).resolves.toEqual(UNKNOWN_CAPTURE_STATUS);
  });
});

describe('#3195 ST-1 — sameCaptureStatus', () => {
  const running: CaptureStatusView = { state: 'running', ingestFailure: null };

  it('treats two identical settled projections as unchanged', () => {
    expect(sameCaptureStatus(running, { state: 'running', ingestFailure: null })).toBe(true);
    expect(sameCaptureStatus(UNKNOWN_CAPTURE_STATUS, { ...UNKNOWN_CAPTURE_STATUS })).toBe(true);
  });

  it('detects a changed state', () => {
    expect(sameCaptureStatus(running, { state: 'notRunning', ingestFailure: null })).toBe(false);
  });

  it('compares the typed cause the reason sentence is built from', () => {
    const withCause: CaptureStatusView = { state: 'notRunning', ingestFailure: TYPED_FAILURE };
    expect(sameCaptureStatus(withCause, { state: 'notRunning', ingestFailure: TYPED_FAILURE })).toBe(
      true,
    );
    expect(
      sameCaptureStatus(withCause, {
        state: 'notRunning',
        ingestFailure: { ...TYPED_FAILURE, port: 4318 },
      }),
    ).toBe(false);
    expect(sameCaptureStatus(withCause, { state: 'notRunning', ingestFailure: null })).toBe(false);
  });
});
