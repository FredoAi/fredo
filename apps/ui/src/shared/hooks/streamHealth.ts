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
 *
 * Spec #3194 ST-3 (additive): both carriers also carry an OPTIONAL typed
 * `ingestFailure` (`{receiver, port, code, message}` — absent key when none).
 * It is NOT part of the truth table: `deriveStreamHealth` stays byte-identical
 * (three states). The typed cause only decorates the `degraded` health row.
 */

// ── The three-valued stream status ───────────────────────────────────────────

/** The three observable stream states. There is deliberately no `unknown`/`checking`. */
export type StreamHealth = 'healthy' | 'degraded' | 'down';

// ── The typed OTLP ingest start failure (Spec #3194 ST-3) ────────────────────
//
// A port conflict at startup is a TYPED failure, not a bare boolean (#3194 AC3):
// the backend carries `ingestFailure` on BOTH stream-health carriers. The wire
// shape is the Rust `IngestStartError` (`receiver`, `port`, `code`, `message`);
// the key is ABSENT when no failure has been recorded — never `null`.

/** Which OTLP receiver failed to become ready (wire: `grpc` | `http`). */
export type IngestReceiverKind = 'grpc' | 'http';

/** Why it failed (wire: `addrInUse` is the classification AC3 names). */
export type IngestFailureCode = 'addrInUse' | 'bindFailed';

/** The typed ingest start failure — one value names receiver + port + class + raw text. */
export interface IngestFailure {
  receiver: IngestReceiverKind;
  port: number;
  code: IngestFailureCode;
  message: string;
}

const INGEST_RECEIVER_KINDS: readonly IngestReceiverKind[] = ['grpc', 'http'];
const INGEST_FAILURE_CODES: readonly IngestFailureCode[] = ['addrInUse', 'bindFailed'];

function isReceiverKind(value: unknown): value is IngestReceiverKind {
  return typeof value === 'string' && (INGEST_RECEIVER_KINDS as readonly string[]).includes(value);
}

function isFailureCode(value: unknown): value is IngestFailureCode {
  return typeof value === 'string' && (INGEST_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Narrow an unknown wire value to a well-formed `IngestFailure`.
 *
 * FAILS CLOSED (UI/UX Asset 1, malformed-failure rule): the `port` must be a
 * POSITIVE INTEGER and the `code` a known member, so a malformed payload can
 * never render `Port undefined is in use` / `Port NaN is in use` — the caller
 * treats a `false` result as "no failure" and falls back to `Telemetry stalled`.
 */
export function isIngestFailure(v: unknown): v is IngestFailure {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const failure = v as Record<string, unknown>;
  return (
    isReceiverKind(failure.receiver) &&
    isFailureCode(failure.code) &&
    typeof failure.port === 'number' &&
    Number.isInteger(failure.port) &&
    failure.port > 0 &&
    typeof failure.message === 'string'
  );
}

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
  /**
   * The typed OTLP ingest start failure (Spec #3194 ST-3). ABSENT KEY when no
   * failure has been recorded — never `null` (wire rule G-413).
   */
  ingestFailure?: IngestFailure;
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
  /**
   * The typed OTLP ingest start failure (Spec #3194 ST-3). ABSENT KEY when no
   * failure has been recorded; a malformed value is dropped by `isIngestFailure`
   * so `deriveStreamHealth` (unchanged, three-state) never sees it.
   */
  ingestFailure?: IngestFailure;
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
