/**
 * fredoHealth — the frozen shared contract for the whole-system health LED.
 *
 * Spec #3052 ST-1. This module is PURE: no React, no IPC, no polling. It owns
 * the five names every consumer (the `useFredoHealth` aggregator, the LED, QA)
 * reads — `FredoHealthState`, `SubsystemHealth`, `FredoSubsystemId`,
 * `FredoHealthLine`, `FredoHealth` — plus the two pure derivations:
 *
 *   - `aggregateFredoHealth(lines)`  — worst-wins over the ENABLED subsystems.
 *   - `deriveSubsystemLines(snaps)`  — raw source snapshots → the four lines.
 *
 * The aggregate has EXACTLY THREE values (`healthy` | `degraded` | `down`) —
 * there is NO "checking"/`unknown` aggregate state (binding). A per-subsystem
 * `unknown`/`notSetUp` is NEUTRAL and NEVER degrades the aggregate (R-7 / AC4).
 *
 * Worst-wins precedence:
 *   1. any MANDATORY subsystem (`telemetry`, `postgres`) `down` → overall `down`;
 *   2. else any non-neutral subsystem `down`                  → overall `degraded`;
 *   3. else any non-neutral subsystem `degraded`              → overall `degraded`;
 *   4. else                                                     → overall `healthy`.
 *
 * State-source → state mapping (frozen by the plan's Binding Names Block):
 *   - telemetry     : `StreamHealth` 1:1 → `healthy`/`degraded`/`down` (event-driven; never polled).
 *   - postgres      : `ready`/`attached` → healthy; `starting` → unknown; `failed`/`disabled` → down.
 *   - llamaServer   : `healthy` → healthy; running-but-not-ready → degraded; otherwise
 *                     (configured but not running) → down; companion not configured
 *                     (no model files) → notSetUp.
 *   - companionModel: model files complete → healthy; companion configured but files
 *                     missing → down; companion not configured → notSetUp.
 *
 * "Companion configured" means **the model files are present** (Spec #3141 ST-6) —
 * the runtime ships inside Fredo, so there is no separate runtime-install signal.
 * It is an explicit input (not inferred here) so the derivation stays pure.
 */

// ── Aggregate (worst-wins over enabled subsystems) ───────────────────────────

import type { StreamHealth } from './streamHealth';

/** The three-valued overall health. There is deliberately NO `unknown`/`checking` value. */
export type FredoHealthState = 'healthy' | 'degraded' | 'down';

/**
 * Per-subsystem health. `notSetUp` and `unknown` are NEUTRAL: neither by itself
 * changes the aggregate (AC4 / R-7); only `down` (and, since #3064, a non-neutral
 * `degraded`) degrades. `degraded` is the #3064 addition — a stalled telemetry
 * pipeline reads `degraded` (not fully healthy, but the IPC is alive).
 */
export type SubsystemHealth = 'healthy' | 'degraded' | 'down' | 'notSetUp' | 'unknown';

/**
 * Stable subsystem ids. The frozen tooltip/array order is
 * `telemetry → llamaServer → companionModel → postgres`.
 */
export type FredoSubsystemId = 'telemetry' | 'llamaServer' | 'companionModel' | 'postgres';

/** One subsystem line: stable id + fixed label + current state + short human detail. */
export interface FredoHealthLine {
  id: FredoSubsystemId;
  label: string;
  state: SubsystemHealth;
  detail: string;
}

/** The whole-system readout: one overall state + exactly the four subsystem lines, fixed order. */
export interface FredoHealth {
  overall: FredoHealthState;
  subsystems: FredoHealthLine[];
}

/** The subsystems whose `down` escalates the aggregate to `down`. */
const MANDATORY_SUBSYSTEMS: readonly FredoSubsystemId[] = ['telemetry', 'postgres'];

/** Fixed labels, in the frozen order. */
const SUBSYSTEM_LABELS: Record<FredoSubsystemId, string> = {
  telemetry: 'Agent telemetry',
  // The subsystem ID stays `llamaServer` (the frozen tooltip/array order key and
  // the `health-line-llamaServer` QA hook); only the LABEL changes. A line
  // reading "Llama server" for an in-process engine is exactly the false claim
  // Spec #3141 retires.
  llamaServer: 'Companion engine',
  companionModel: 'Companion model',
  postgres: 'Postgres',
};

/**
 * Fold the four lines into the overall state by worst-wins precedence.
 * Mandatory `down` → `down`; else any non-neutral `down` → `degraded`; else any
 * non-neutral `degraded` → `degraded`; else `healthy`.
 * `notSetUp`/`unknown` are neutral and never degrade the aggregate (AC4 / R-7).
 */
export function aggregateFredoHealth(lines: FredoHealthLine[]): FredoHealthState {
  const stateById = new Map<FredoSubsystemId, SubsystemHealth>();
  for (const line of lines) stateById.set(line.id, line.state);

  for (const id of MANDATORY_SUBSYSTEMS) {
    if (stateById.get(id) === 'down') return 'down';
  }
  if (lines.some((line) => line.state === 'down')) return 'degraded';
  if (lines.some((line) => line.state === 'degraded')) return 'degraded';
  return 'healthy';
}

// ── Raw source snapshots → subsystem lines ───────────────────────────────────

/** The supervisor lifecycle states exposed by `pg_supervisor_status.state`. */
export type FredoPgState = 'disabled' | 'starting' | 'ready' | 'attached' | 'failed';

/**
 * The companion setup signal, derived from the SAME `check_companion_readiness`
 * probe the wizard uses.
 *
 * Spec #3141 ST-6: the companion runtime ships INSIDE Fredo, so there is no
 * separate install signal any more. "Set up" now means **the model files are
 * present** — the model-files prerequisite is the backend's only one (AC-17).
 */
export interface FredoCompanionSnapshot {
  modelFilesComplete: boolean;
}

/** The minimal `get_llama_server_status` fields the derivation consumes. */
export interface FredoLlamaServerSnapshot {
  running: boolean;
  healthy: boolean;
}

/**
 * Raw, un-derived source snapshots. A `null` source means the probe is still in
 * flight (or unavailable) → the dependent line(s) read `unknown` (neutral,
 * never degrade — R-7). Telemetry is event-driven and therefore always known.
 */
export interface FredoHealthSnapshots {
  /** The three-valued stream health (Spec #3064; event-driven; never polled). */
  telemetry: StreamHealth;
  /** Companion readiness probe; `null` while unresolved/unavailable. */
  companion: FredoCompanionSnapshot | null;
  /** Llama-server status probe; `null` while unresolved/unavailable. */
  llamaServer: FredoLlamaServerSnapshot | null;
  /** Postgres supervisor status probe; `null` while unresolved/unavailable. */
  postgres: { state: FredoPgState } | null;
}

/**
 * Map the three-valued `StreamHealth` 1:1 onto the telemetry subsystem line
 * (Spec #3064 ST-4). Binding copy: `Streaming` (healthy) / `Telemetry stalled`
 * (degraded) / `Stream stopped` (down). The telemetry line is MANDATORY, so a
 * `down` escalates the aggregate to `down` and a `degraded` to `degraded`.
 */
function telemetryLine(health: StreamHealth): FredoHealthLine {
  switch (health) {
    case 'healthy':
      return { id: 'telemetry', label: SUBSYSTEM_LABELS.telemetry, state: 'healthy', detail: 'Streaming' };
    case 'degraded':
      return { id: 'telemetry', label: SUBSYSTEM_LABELS.telemetry, state: 'degraded', detail: 'Telemetry stalled' };
    case 'down':
      return { id: 'telemetry', label: SUBSYSTEM_LABELS.telemetry, state: 'down', detail: 'Stream stopped' };
  }
}

function llamaServerLine(snapshots: FredoHealthSnapshots): FredoHealthLine {
  const { companion, llamaServer } = snapshots;
  const line = (state: SubsystemHealth, detail: string): FredoHealthLine => ({
    id: 'llamaServer',
    label: SUBSYSTEM_LABELS.llamaServer,
    state,
    detail,
  });
  // Unresolved companion probe → neutral `unknown`.
  if (!companion) return line('unknown', 'Checking');
  // Not configured (no model files) → neutral `notSetUp` (never degrades — AC4).
  // Spec #3141 ST-6: this gate used to read the retired runtime-install flag;
  // "configured" now means the model files are present.
  if (!companion.modelFilesComplete) return line('notSetUp', 'Not set up');
  // Configured: the engine must be running AND ready to read healthy.
  if (!llamaServer) return line('unknown', 'Checking');
  if (llamaServer.healthy) return line('healthy', 'Running');
  // Loaded but not yet accepting a turn — a transition, not a failure.
  if (llamaServer.running) return line('degraded', 'Starting');
  // Configured but idle: the shot the LED must never hide behind `unknown`.
  return line('down', 'Not running');
}

function companionModelLine(snapshots: FredoHealthSnapshots): FredoHealthLine {
  const { companion } = snapshots;
  const line = (state: SubsystemHealth, detail: string): FredoHealthLine => ({
    id: 'companionModel',
    label: SUBSYSTEM_LABELS.companionModel,
    state,
    detail,
  });
  if (!companion) return line('unknown', 'Checking');
  if (companion.modelFilesComplete) return line('healthy', 'Model files present');
  // No model files = not set up. Neutral, so a fresh offline machine boots the
  // LED healthy-ish instead of a spurious `degraded` before the user does anything
  // (Spec #3141 ST-6 — "set up" means the model files are present).
  return line('notSetUp', 'Not set up');
}

function postgresLine(snapshots: FredoHealthSnapshots): FredoHealthLine {
  const status = snapshots.postgres;
  const base = { id: 'postgres' as const, label: SUBSYSTEM_LABELS.postgres };
  if (!status) return { ...base, state: 'unknown', detail: 'Starting' };
  switch (status.state) {
    case 'ready':
    case 'attached':
      return { ...base, state: 'healthy', detail: 'Ready' };
    case 'starting':
      return { ...base, state: 'unknown', detail: 'Starting' };
    case 'failed':
    case 'disabled':
      return { ...base, state: 'down', detail: 'Not available' };
    default:
      return { ...base, state: 'unknown', detail: 'Starting' };
  }
}

/**
 * Derive the four subsystem lines, in the frozen order
 * `telemetry → llamaServer → companionModel → postgres`. Pure — no React/IPC.
 */
export function deriveSubsystemLines(snapshots: FredoHealthSnapshots): FredoHealthLine[] {
  return [
    telemetryLine(snapshots.telemetry),
    llamaServerLine(snapshots),
    companionModelLine(snapshots),
    postgresLine(snapshots),
  ];
}
