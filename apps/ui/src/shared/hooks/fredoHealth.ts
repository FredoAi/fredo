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
 *   - postgres      : `ready`/`attached` → healthy; `starting` → unknown; `failed`/`disabled` → down
 *                     (with a typed cause + remedy + raw detail — #3180 R-5).
 *   - llamaServer   : `healthy` → healthy; `starting` (in-flight) → unknown "Starting";
 *                     running-but-not-ready → degraded; a TYPED failure → down with a
 *                     remedy + detail; otherwise (idle) → unknown "Idle". NEVER a false
 *                     `down` for idle/starting (#3180); companion not configured (no
 *                     model files) → notSetUp.
 *   - companionModel: model files complete → healthy; companion configured but files
 *                     missing → down; companion not configured → notSetUp.
 *
 * "Companion configured" means **the model files are present** (Spec #3141 ST-6) —
 * the runtime ships inside Fredo, so there is no separate runtime-install signal.
 * It is an explicit input (not inferred here) so the derivation stays pure.
 */

// ── Aggregate (worst-wins over enabled subsystems) ───────────────────────────

import type { StreamHealth } from './streamHealth';
import {
  engineFailureCopy,
  type CompanionEngineErrorCode,
} from '../components/companion/companionReadiness';

/** The three-valued overall health. There is deliberately NO `unknown`/`checking` value. */
export type FredoHealthState = 'healthy' | 'degraded' | 'down';

/**
 * Postgres failure cause (#3180 ST-3; extended by #3188 ST-3) — the camelCase
 * subset of the backend `PgFailureKind` the health surface renders. The closed
 * set is `authMismatch` | `portInUse` | `dataDirNotEmpty` |
 * `dataDirPermissionDenied` | `unknown`. A `null`/absent kind is treated as
 * `unknown`.
 */
export type FredoPgFailureKind =
  | 'authMismatch'
  | 'portInUse'
  | 'dataDirNotEmpty'
  | 'dataDirPermissionDenied'
  | 'unknown';

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
  /**
   * The next step a user can take — one sentence, present only on a `down` row
   * (#3180 R-5.3). ABSENT KEY when unset — never `null`.
   */
  remedy?: string;
  /**
   * Raw, untranslated backend evidence (a typed engine code, a Postgres error).
   * ABSENT KEY when unset — never `null` (#3180, wire rule G-413).
   */
  technicalDetail?: string;
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
  /**
   * An engine start is in flight (#3180 ST-2). A NON-optional boolean — always
   * present on the wire, exactly like `backendMode`/`devices`; absent/foreign
   * payloads settle to `false` (idle) in the normalizer.
   */
  starting: boolean;
  /** Typed failure of the most recent start — ABSENT KEY when none. */
  lastErrorCode?: CompanionEngineErrorCode;
  /** Raw persisted engine error — ABSENT KEY when unset/empty. */
  lastError?: string;
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
  postgres: {
    state: FredoPgState;
    /** Additive typed cause (#3180); `null`/absent → treated as `unknown`. */
    failureKind?: FredoPgFailureKind | null;
    /** Raw backend error carried verbatim to `technicalDetail`. */
    error?: string | null;
  } | null;
}

/**
 * Build a line, adding the two optional fields ONLY when they carry a value —
 * they are ABSENT KEYS when unset (never `null`; #3180 wire rule / G-413).
 */
function makeLine(
  id: FredoSubsystemId,
  label: string,
  state: SubsystemHealth,
  detail: string,
  extra?: { remedy?: string; technicalDetail?: string },
): FredoHealthLine {
  const line: FredoHealthLine = { id, label, state, detail };
  if (extra?.remedy) line.remedy = extra.remedy;
  if (extra?.technicalDetail) line.technicalDetail = extra.technicalDetail;
  return line;
}

/**
 * Postgres failure copy (#3180 ST-3; extended by #3188 ST-3), authored from the
 * typed causes. `cause` is the row `detail`; `remedy` is the user's next step
 * (R-5.1/R-5.3). No SQLSTATE, stack trace or raw library string appears in the
 * remedy — that belongs in `technicalDetail` (`status.error`). The
 * `dataDirNotEmpty` remedy names the cluster folder and says move/rename; the
 * `dataDirPermissionDenied` remedy names the modify-permission / writable-folder
 * paths. NEITHER ever tells the user to delete data (R-2.2 — recovery is a
 * rename, never a delete).
 */
const PG_FAILURE_COPY: Record<FredoPgFailureKind, { cause: string; remedy: string }> = {
  dataDirNotEmpty: {
    cause: 'The database folder Fredo uses already contains files.',
    remedy:
      "Move or rename the PostgreSQL cluster folder (postgres/cluster in Fredo's app-data folder), then restart Fredo. Nothing is removed.",
  },
  dataDirPermissionDenied: {
    cause: 'Windows is blocking Fredo from preparing the database folder.',
    remedy:
      "Grant your Windows user modify permission on the PostgreSQL cluster folder's parent, or choose a writable folder with FREDO_PG_DATA_DIR, then restart Fredo. Nothing is removed.",
  },
  portInUse: {
    cause: 'The database port Fredo needs is already in use.',
    remedy: 'Change the port in Settings → Database, then restart Fredo.',
  },
  authMismatch: {
    cause: 'Fredo cannot sign in to the database with its saved password.',
    remedy:
      'Open Settings → Database and reset the database. This deletes local Fredo data.',
  },
  unknown: {
    cause: "The database didn't start and the cause is unknown.",
    remedy: 'Restart Fredo. If it keeps failing, open Settings → Database.',
  },
};

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

/**
 * Companion engine line — the #3180 honest-state precedence (G-220: every
 * branch stays reachable). `down` is reserved for a TYPED failure and then
 * always carries a remedy + technical detail; an idle or in-flight engine is
 * NEUTRAL (`unknown`), never a false `down`/`Not running`.
 */
function llamaServerLine(snapshots: FredoHealthSnapshots): FredoHealthLine {
  const { companion, llamaServer } = snapshots;
  const line = (
    state: SubsystemHealth,
    detail: string,
    extra?: { remedy?: string; technicalDetail?: string },
  ): FredoHealthLine => makeLine('llamaServer', SUBSYSTEM_LABELS.llamaServer, state, detail, extra);

  // 1. Unresolved companion probe → neutral `unknown`.
  if (!companion) return line('unknown', 'Checking');
  // 2. Not configured (no model files) → neutral `notSetUp` (never degrades — AC4).
  // Spec #3141 ST-6: this gate used to read the retired runtime-install flag;
  // "configured" now means the model files are present.
  if (!companion.modelFilesComplete) return line('notSetUp', 'Not set up');
  // 3. Unresolved engine probe → neutral `unknown`.
  if (!llamaServer) return line('unknown', 'Checking');
  // 4. Loaded and ready to accept a turn.
  if (llamaServer.healthy) return line('healthy', 'Running');
  // 5. An engine start is in flight (#3180 ST-2) — neutral, NEVER `down`.
  if (llamaServer.starting) return line('unknown', 'Starting');
  // 6. Loaded-but-not-ready fallback (the legacy branch, now reachable) — a
  //    transition, not a failure.
  if (llamaServer.running) return line('degraded', 'Starting');
  // 7. A TYPED start failure owns `down`, always with a remedy + raw detail.
  if (llamaServer.lastErrorCode) {
    const copy = engineFailureCopy(llamaServer.lastErrorCode);
    const technicalDetail = llamaServer.lastError
      ? `${llamaServer.lastErrorCode} · ${llamaServer.lastError}`
      : llamaServer.lastErrorCode;
    return line('down', 'Could not start', {
      remedy: `${copy.sentence} Open Settings → Companion.`,
      technicalDetail,
    });
  }
  // 8. Configured but idle, with no failure on record → neutral `unknown`
  //    ("Idle"), NEVER `down` (a launch start or the first turn owns the start).
  return line('unknown', 'Idle');
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
  const line = (
    state: SubsystemHealth,
    detail: string,
    extra?: { remedy?: string; technicalDetail?: string },
  ): FredoHealthLine => makeLine('postgres', SUBSYSTEM_LABELS.postgres, state, detail, extra);
  if (!status) return line('unknown', 'Starting');
  switch (status.state) {
    case 'ready':
    case 'attached':
      return line('healthy', 'Ready');
    case 'starting':
      return line('unknown', 'Starting');
    case 'failed': {
      // A typed cause plus the user's next step — never a bare "Not available".
      // A `null`/absent kind falls through to `unknown` (fail-closed copy).
      const copy = PG_FAILURE_COPY[status.failureKind ?? 'unknown'];
      return line('down', copy.cause, {
        remedy: copy.remedy,
        technicalDetail: status.error ?? undefined,
      });
    }
    case 'disabled':
      // Resolution (a): keep the shipped `down` classification, but R-5.3 now
      // demands a remedy + raw detail on EVERY down row.
      return line('down', 'Not available', {
        remedy: 'Turn Postgres on in Settings → Database.',
        technicalDetail: 'state=disabled',
      });
    default:
      return line('unknown', 'Starting');
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
