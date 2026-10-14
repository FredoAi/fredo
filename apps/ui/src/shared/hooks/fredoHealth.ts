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
 *   3. else                                                     → overall `healthy`.
 *
 * State-source → state mapping (frozen by the plan's Binding Names Block):
 *   - telemetry     : `isConnected ? healthy : down` (event-driven; never polled).
 *   - postgres      : `ready`/`attached` → healthy; `starting` → unknown; `failed`/`disabled` → down.
 *   - llamaServer   : `healthy` → healthy; otherwise (installed but stopped/unhealthy) → down;
 *                     companion not installed/configured → notSetUp.
 *   - companionModel: model files complete → healthy; companion installed but files missing → down;
 *                     companion not installed/configured → notSetUp.
 *
 * "Companion configured" is the llama-server (llama.cpp) prerequisite being
 * installed — the SAME signal the companion setup wizard gates on. It is an
 * explicit input (not inferred here) so the derivation stays pure and testable.
 */

// ── Aggregate (worst-wins over enabled subsystems) ───────────────────────────

/** The three-valued overall health. There is deliberately NO `unknown`/`checking` value. */
export type FredoHealthState = 'healthy' | 'degraded' | 'down';

/**
 * Per-subsystem health. `notSetUp` and `unknown` are NEUTRAL: neither by itself
 * changes the aggregate (AC4 / R-7); only `down` degrades.
 */
export type SubsystemHealth = 'healthy' | 'down' | 'notSetUp' | 'unknown';

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
  llamaServer: 'Llama server',
  companionModel: 'Companion model',
  postgres: 'Postgres',
};

/**
 * Fold the four lines into the overall state by worst-wins precedence.
 * Mandatory `down` → `down`; else any non-neutral `down` → `degraded`; else `healthy`.
 * `notSetUp`/`unknown` are neutral and never degrade the aggregate (AC4 / R-7).
 */
export function aggregateFredoHealth(lines: FredoHealthLine[]): FredoHealthState {
  const stateById = new Map<FredoSubsystemId, SubsystemHealth>();
  for (const line of lines) stateById.set(line.id, line.state);

  for (const id of MANDATORY_SUBSYSTEMS) {
    if (stateById.get(id) === 'down') return 'down';
  }
  if (lines.some((line) => line.state === 'down')) return 'degraded';
  return 'healthy';
}

// ── Raw source snapshots → subsystem lines ───────────────────────────────────

/** The supervisor lifecycle states exposed by `pg_supervisor_status.state`. */
export type FredoPgState = 'disabled' | 'starting' | 'ready' | 'attached' | 'failed';

/**
 * The companion setup signal, derived from the SAME `check_companion_readiness`
 * probe the wizard uses: `llamaServerInstalled` is the llama.cpp prerequisite
 * (`installed`), and `modelFilesComplete` is the model-files prerequisite
 * (`installed`, equivalent to `check_model_files.complete`).
 */
export interface FredoCompanionSnapshot {
  llamaServerInstalled: boolean;
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
  /** The StreamContext connection flag (event-driven; never polled). */
  telemetryConnected: boolean;
  /** Companion readiness probe; `null` while unresolved/unavailable. */
  companion: FredoCompanionSnapshot | null;
  /** Llama-server status probe; `null` while unresolved/unavailable. */
  llamaServer: FredoLlamaServerSnapshot | null;
  /** Postgres supervisor status probe; `null` while unresolved/unavailable. */
  postgres: { state: FredoPgState } | null;
}

function telemetryLine(connected: boolean): FredoHealthLine {
  return {
    id: 'telemetry',
    label: SUBSYSTEM_LABELS.telemetry,
    state: connected ? 'healthy' : 'down',
    detail: connected ? 'Streaming' : 'Stream stopped',
  };
}

function llamaServerLine(snapshots: FredoHealthSnapshots): FredoHealthLine {
  const { companion, llamaServer } = snapshots;
  // Unresolved companion probe → neutral `unknown`.
  if (!companion) {
    return { id: 'llamaServer', label: SUBSYSTEM_LABELS.llamaServer, state: 'unknown', detail: 'Checking' };
  }
  // Never-installed companion → neutral `notSetUp` (never degrades — AC4).
  if (!companion.llamaServerInstalled) {
    return { id: 'llamaServer', label: SUBSYSTEM_LABELS.llamaServer, state: 'notSetUp', detail: 'Not set up' };
  }
  // Installed companion: the managed server must be healthy to read healthy.
  if (!llamaServer) {
    return { id: 'llamaServer', label: SUBSYSTEM_LABELS.llamaServer, state: 'unknown', detail: 'Checking' };
  }
  if (llamaServer.healthy) {
    return { id: 'llamaServer', label: SUBSYSTEM_LABELS.llamaServer, state: 'healthy', detail: 'Running' };
  }
  // running && !healthy, or exited/failed (not running) → down (optional ⇒ degraded).
  return { id: 'llamaServer', label: SUBSYSTEM_LABELS.llamaServer, state: 'down', detail: 'Stopped or unhealthy' };
}

function companionModelLine(snapshots: FredoHealthSnapshots): FredoHealthLine {
  const { companion } = snapshots;
  if (!companion) {
    return { id: 'companionModel', label: SUBSYSTEM_LABELS.companionModel, state: 'unknown', detail: 'Checking' };
  }
  if (companion.modelFilesComplete) {
    return { id: 'companionModel', label: SUBSYSTEM_LABELS.companionModel, state: 'healthy', detail: 'Model files present' };
  }
  if (!companion.llamaServerInstalled) {
    return { id: 'companionModel', label: SUBSYSTEM_LABELS.companionModel, state: 'notSetUp', detail: 'Not set up' };
  }
  // Installed companion with a missing/incomplete model set → down (optional ⇒ degraded).
  return { id: 'companionModel', label: SUBSYSTEM_LABELS.companionModel, state: 'down', detail: 'Model files missing' };
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
    telemetryLine(snapshots.telemetryConnected),
    llamaServerLine(snapshots),
    companionModelLine(snapshots),
    postgresLine(snapshots),
  ];
}
