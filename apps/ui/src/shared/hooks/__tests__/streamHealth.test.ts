/**
 * streamHealth — pure derivation unit pins (Spec #3064 ST-2).
 *
 * Covers the frozen three-state contract every consumer reads: the cadence
 * constants, the `deriveStreamHealth` truth table (1:1 with the plan's binding
 * formula `ok && ageMs<=STALE && ingestConnected ? healthy : (!ok ? down :
 * degraded)`), and the `isStreamHealth` narrowing predicate.
 */

import { describe, it, expect } from 'vitest';

import {
  deriveStreamHealth,
  isStreamHealth,
  STREAM_HEARTBEAT_STALE_MS,
  STREAM_HEALTH_CHECK_INTERVAL_MS,
  type StreamHealthProbe,
} from '../streamHealth';

function probe(overrides: Partial<StreamHealthProbe> = {}): StreamHealthProbe {
  return { ok: true, ageMs: 0, ingestConnected: true, ...overrides };
}

describe('streamHealth — cadence constants (binding)', () => {
  it('pins the stale window at 3× cadence and the bounded check interval', () => {
    expect(STREAM_HEARTBEAT_STALE_MS).toBe(15_000);
    expect(STREAM_HEALTH_CHECK_INTERVAL_MS).toBe(5_000);
  });
});

describe('deriveStreamHealth — truth table', () => {
  it('ok + fresh + ingest connected → healthy', () => {
    expect(deriveStreamHealth(probe())).toBe('healthy');
  });

  it('ok + fresh + ingest NOT connected → degraded (the REQ-5 path)', () => {
    expect(deriveStreamHealth(probe({ ingestConnected: false }))).toBe('degraded');
  });

  it('ok + stale (ageMs > STALE) → degraded', () => {
    expect(deriveStreamHealth(probe({ ageMs: STREAM_HEARTBEAT_STALE_MS + 1 }))).toBe('degraded');
  });

  it('ok + stale + ingest NOT connected → degraded', () => {
    expect(deriveStreamHealth(probe({ ageMs: STREAM_HEARTBEAT_STALE_MS + 1, ingestConnected: false }))).toBe(
      'degraded',
    );
  });

  it('boundary: ageMs exactly STALE still counts as fresh → healthy', () => {
    expect(deriveStreamHealth(probe({ ageMs: STREAM_HEARTBEAT_STALE_MS }))).toBe('healthy');
  });

  it('probe failed (!ok) → down, regardless of freshness/ingest', () => {
    expect(deriveStreamHealth(probe({ ok: false }))).toBe('down');
    expect(deriveStreamHealth(probe({ ok: false, ageMs: STREAM_HEARTBEAT_STALE_MS + 1 }))).toBe('down');
    expect(deriveStreamHealth(probe({ ok: false, ingestConnected: false }))).toBe('down');
  });
});

describe('isStreamHealth — narrowing predicate', () => {
  it('accepts exactly the three states', () => {
    expect(isStreamHealth('healthy')).toBe(true);
    expect(isStreamHealth('degraded')).toBe(true);
    expect(isStreamHealth('down')).toBe(true);
  });

  it('rejects anything else (including the old binary shape)', () => {
    expect(isStreamHealth('connected')).toBe(false);
    expect(isStreamHealth('unknown')).toBe(false);
    expect(isStreamHealth('')).toBe(false);
    expect(isStreamHealth(undefined)).toBe(false);
    expect(isStreamHealth(null)).toBe(false);
    expect(isStreamHealth(true)).toBe(false);
    expect(isStreamHealth(0)).toBe(false);
    expect(isStreamHealth({})).toBe(false);
  });
});
