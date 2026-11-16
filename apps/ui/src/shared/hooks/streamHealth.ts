/**
 * streamHealth — the frozen shared three-state stream/telemetry health contract
 * (Spec #3064 ST-2).
 *
 * This module is PURE: no React, no IPC, no polling. It owns the ONE canonical
 * name every consumer reads — `StreamHealth` (`healthy` | `degraded` | `down`) —
 * plus the two bounded cadence constants and the pure derivation the producer
 * hook (`useStreamHealthProducer`, ST-3) and the `StreamContext` provider use.
 *
 * The defect this fixes (#3064): the desktop stream flag was a MOUNT constant
 * (`isConnected: false` initialised, set `true` on mount), so a stalled or dead
 * telemetry stream always read "connected". A three-valued status lets a stalled
 * pipeline (`degraded`) be visible at a glance without pretending the IPC is
 * dead (`down`).
 *
 * State derivation (`deriveStreamHealth`) — 1:1 with the plan's binding formula:
 *   ok && ageMs <= STALE && ingestConnected  → `healthy`
 *   !ok                                       → `down`   (the probe failed ⇒ IPC unavailable)
 *   otherwise (ok but stale, or ingest down)  → `degraded`
 *
 * Cadence (NFR): one heartbeat every `STREAM_HEARTBEAT_INTERVAL_MS` (backend,
 * ST-1); the stale window is 3× that; the frontend probes on
 * `STREAM_HEALTH_CHECK_INTERVAL_MS`.
 */

// ── The three-valued stream status ───────────────────────────────────────────

/** The three observable stream states. There is deliberately no `unknown`/`checking`. */
export type StreamHealth = 'healthy' | 'degraded' | 'down';

/**
 * The stale window: a heartbeat older than this (while the IPC probe still
 * succeeds) reads `degraded` — 3 × the backend heartbeat cadence.
 */
export const STREAM_HEARTBEAT_STALE_MS = 15_000;

/** The frontend bounded check interval — ONE probe per tick while mounted. */
export const STREAM_HEALTH_CHECK_INTERVAL_MS = 5_000;

/**
 * The backend liveness heartbeat envelope (wire shape, camelCase) carried on the
 * existing `fredo-stream-event` channel as `{ "streamHealth": StreamHealthHeartbeat }`.
 * `ageMs` is the freshness of the last heartbeat as computed by the backend;
 * `emittedAtMs` is the emission wall-clock (ms since epoch).
 */
export interface StreamHealthHeartbeat {
  /** Monotonic per-process sequence — advances on every emission (idle ≠ outage). */
  seq: number;
  /** Whether the OTLP ingest pipeline currently reports connected. */
  ingestConnected: boolean;
  /** Age of the last heartbeat at emission time, in milliseconds. */
  ageMs: number;
  /** Emission wall-clock, milliseconds since epoch. */
  emittedAtMs: number;
}

/**
 * The resolved probe result the frontend derives from — either from a fresh
 * heartbeat or from ONE bounded `stream_health` IPC probe.
 */
export interface StreamHealthProbe {
  /** Whether the probe succeeded (proves IPC liveness). */
  ok: boolean;
  /** Age of the last observed heartbeat, in milliseconds. */
  ageMs: number;
  /** Whether the OTLP ingest pipeline reports connected. */
  ingestConnected: boolean;
}

/**
 * Derive the three-valued stream status from a probe result. Pure — no React/IPC.
 *
 * - probe failed (`!ok`)                    → `down`   (IPC unavailable; freshness alone cannot tell)
 * - fresh heartbeat AND ingest connected    → `healthy`
 * - probe ok but stale, or ingest not connected → `degraded`
 */
export function deriveStreamHealth(p: StreamHealthProbe): StreamHealth {
  if (!p.ok) return 'down';
  if (p.ageMs <= STREAM_HEARTBEAT_STALE_MS && p.ingestConnected) return 'healthy';
  return 'degraded';
}

/** Narrowing predicate for a wire/unknown value that must be one of the three states. */
export function isStreamHealth(v: unknown): v is StreamHealth {
  return v === 'healthy' || v === 'degraded' || v === 'down';
}
