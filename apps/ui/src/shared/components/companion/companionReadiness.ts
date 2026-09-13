/**
 * Companion setup readiness — wire types for the backend
 * `check_companion_readiness` / `install_llama_cpp` commands (Spec #2855).
 *
 * The backend owns the prerequisite SET; these ids are the stable join key
 * between the backend reports and the ordered `COMPANION_SETUP_STEPS` registry.
 * #2857 appends `'serverLaunch'` here and to the registry.
 */

export type PrerequisiteId = 'llamaServer' | 'modelFiles' | 'serverLaunch';

/** Determined states returned by the backend. */
export type PrerequisiteState = 'missing' | 'installed' | 'error';

/**
 * UI state vocabulary: `checking` exists only while a probe is in flight.
 * The gate is never satisfied by `checking`/`missing`/`error`.
 */
export type PrerequisiteUiState = 'checking' | PrerequisiteState;

export interface PrerequisiteReport {
  id: PrerequisiteId;
  state: PrerequisiteState;
  detail: string;
  resolvedPath: string | null;
}

export interface CompanionReadiness {
  /** true iff EVERY prerequisite is `installed`. */
  ready: boolean;
  prerequisites: PrerequisiteReport[];
}

export type LlamaCppInstallCode =
  | 'wingetUnavailable'
  | 'installFailed'
  | 'spawnFailed';

export interface LlamaCppInstallResult {
  success: boolean;
  output: string;
  error: string | null;
  code: LlamaCppInstallCode | null;
}

// ── Model file acquisition (#2856) — wire types ──────────────────────────────
//
// `check_model_files` returns per-file status (`ModelFilesStatus`); `download_model`
// acquires the non-present files and returns `ModelDownloadResult`. Progress is
// streamed over the EXISTING `setup:download-progress` channel with an additive
// `fileId` + `state` pair joined to each per-file row.

/** The three required model files, in fixed display/acquisition order. */
export type ModelFileId = 'model' | 'vision' | 'mtp';

/**
 * Per-file state vocabulary. A truncated/partial file stays `missing` (with a
 * shortfall `detail`) — there is deliberately no fifth state.
 */
export type ModelFileState = 'missing' | 'downloading' | 'present' | 'error';

export interface ModelFileStatus {
  id: ModelFileId;
  filename: string;
  relativePath: string;
  state: ModelFileState;
  downloadedBytes: number;
  expectedBytes: number;
  /** Actionable per-file qualifier (e.g. `Incomplete — 123 of 456 bytes`). */
  detail: string | null;
  /** Absolute path when the file exists on disk. */
  path: string | null;
}

/**
 * Extended `check_model_files` result. The legacy snake_case fields are
 * preserved for the standalone `SetupWizard` model step (#2855 contract).
 */
export interface ModelFilesStatus {
  complete: boolean;
  files: ModelFileStatus[];
  gguf_exists?: boolean;
  gguf_path?: string | null;
  mmproj_exists?: boolean;
  mmproj_path?: string | null;
  mtp_exists?: boolean;
  mtp_path?: string | null;
}

/** `download_model` result (additive to the legacy `SetupStepResult` surface). */
export interface ModelDownloadResult {
  success: boolean;
  output?: string;
  error?: string;
  files: ModelFileStatus[];
}

/** `setup:download-progress` payload for a model-file transfer (#2856). */
export interface ModelDownloadProgress {
  /** Join key for the per-file row; absent on legacy (pre-#2856) emissions. */
  fileId: ModelFileId;
  /** Legacy field retained for the standalone `SetupWizard` listener. */
  file: string;
  relativePath: string;
  total: number;
  downloaded: number;
  /** 0–100 (legacy contract). */
  percent: number;
  state: 'downloading' | 'present' | 'skipped' | 'error';
}

// ── Companion server launch (#2857) — wire + derived types ───────────────────
//
// `check_companion_readiness` stays a 2-prerequisite backend command (Spec #2857
// binding resolution — no cross-feature import). The third `serverLaunch`
// prerequisite is COMPOSED in the frontend from `get_llama_server_status`, and
// the overall gate is the backend readiness AND a healthy server.

/** `get_llama_server_status` snapshot (camelCase, IPC). */
export interface LlamaServerStatus {
  running: boolean;
  healthy: boolean;
  port: number | null;
  pid: number | null;
  configPath: string;
  logPath: string;
  lastError: string | null;
}

/** Why a launch could not reach a healthy server (`launch_llama_server`). */
export type LlamaServerLaunchCode =
  | 'spawnFailed'
  | 'portInUse'
  | 'healthTimeout'
  | 'notConfigured';

/** `launch_llama_server` result — always returned, never a hang. */
export interface LlamaServerLaunchResult {
  success: boolean;
  state: PrerequisiteState;
  detail: string;
  port: number | null;
  configPath: string;
  error: string | null;
  code: LlamaServerLaunchCode | null;
}

/** Non-row payload of the backend `llama-server-status` exit event. */
export interface LlamaServerStatusEvent {
  running: boolean;
  healthy: boolean;
  port: number | null;
  code: LlamaServerLaunchCode | null;
}

/**
 * The frontend-composed `serverLaunch` step snapshot (#2857). `check_companion_
 * readiness` stays a 2-prerequisite command; this is derived from
 * `get_llama_server_status` by `useCompanionReadiness` (no cross-feature import).
 */
export interface CompanionServerLaunchInfo {
  state: ServerLaunchState;
  port: number | null;
  configPath: string | null;
  /** Backend failure verdict (`spawnFailed`/`portInUse`/`healthTimeout`/…). */
  code: LlamaServerLaunchCode | null;
  /** Raw backend detail (fallback for the card's copy). */
  detail: string | null;
}

/**
 * Process-specific presentation state for the `serverLaunch` step. Distinct from
 * `PrerequisiteState` (which has no notion of a running-but-loading process).
 */
export type ServerLaunchState =
  | 'notRunning'
  | 'starting'
  | 'healthy'
  | 'exited'
  | 'failed';

/** Fallback host/port for the phase caption before the backend reports one. */
export const DEFAULT_LLAMA_SERVER_PORT = 8080;
export const DEFAULT_LLAMA_SERVER_HOST = '127.0.0.1';

export function llamaServerEndpoint(port: number | null | undefined): string {
  return `http://${DEFAULT_LLAMA_SERVER_HOST}:${port ?? DEFAULT_LLAMA_SERVER_PORT}`;
}

/**
 * Derive the `serverLaunch` step state from the backend status + local action
 * outcome. Pure — unit-testable without a Tauri host. `status.lastError` is the
 * backend-persisted failure marker, so a failed launch is never silently retried
 * as `notRunning`.
 */
export function deriveServerLaunchState(input: {
  /** A `launch_llama_server` run is in flight. */
  launching: boolean;
  /** The last launch attempt failed (invoke rejection or `success:false`). */
  error: boolean;
  status: LlamaServerStatus | null;
  /** A previously-healthy server was observed to have exited. */
  exited: boolean;
}): ServerLaunchState {
  if (input.launching) return 'starting';
  if (input.status?.healthy) return 'healthy';
  if (input.status?.running) return 'starting';
  if (input.error || input.status?.lastError) return 'failed';
  if (input.exited) return 'exited';
  return 'notRunning';
}

/**
 * AC4 actionable start-failure copy. Names the concrete fix; the endpoint is the
 * active/config port. A `healthTimeout` is a distinct (non-spawn) condition.
 */
export function serverLaunchFailureCopy(
  code: LlamaServerLaunchCode | null | undefined,
  endpoint: string,
): string {
  if (code === 'healthTimeout') {
    return "The companion server started but didn't answer its health check in time. It may still be loading the model — choose Retry to try again.";
  }
  // spawnFailed / portInUse / notConfigured / a raw invoke rejection all share the
  // actionable start-failure copy (never a raw stack/IPC string).
  return `Couldn't start the companion server. Check that ${endpoint} is free and llama-server is installed, then choose Retry.`;
}

/** Lifecycle copy shown when a previously-healthy server has exited (UI §6). */
export const SERVER_EXITED_COPY =
  'The companion server stopped unexpectedly. Choose Restart to connect Fredo again.';

/** Wait affordance copy — shown after the client watchdog; NEVER an AC4 failure. */
export const SERVER_WATCHDOG_COPY =
  'The server is taking longer than expected. You can keep waiting, or choose Retry.';

// ── Curated failure copy (#2865 ST-2/H3) ─────────────────────────────────────
//
// The action handlers capture RAW backend/IPC strings (`result.error`, a thrown
// `String(err)`). Those must never be the primary user-facing error sentence
// (R-2.2). `errorCopyFor` maps a step + optional backend code to a curated,
// actionable sentence naming cause + next step, and returns the raw string as a
// secondary `technicalDetail` (rendered as a labelled mono line, or omitted).

export interface ErrorCopy {
  /** Curated, actionable primary sentence — never a raw backend/IPC string. */
  message: string;
  /** Raw backend/IPC detail, demoted to a labelled "Technical details" line. */
  technicalDetail: string | null;
}

/** Human name for each step, used by the generic fallback sentence. */
const STEP_ERROR_LABEL: Record<PrerequisiteId, string> = {
  llamaServer: 'the llama.cpp install',
  modelFiles: 'the model download',
  serverLaunch: 'the server launch',
};

/** Curated install-failure copy keyed by the backend's typed install code. */
const INSTALL_ERROR_COPY: Record<LlamaCppInstallCode, string> = {
  wingetUnavailable:
    "Couldn't install llama.cpp — winget isn't available. Install llama.cpp manually, then choose Re-check.",
  installFailed:
    "The llama.cpp installation didn't finish. Check your network connection, then choose Retry.",
  spawnFailed:
    "The llama.cpp installer couldn't start. Close other installers, then choose Retry.",
};

/**
 * Cause-naming copy for download failures, keyed on the backend detail (the
 * download path carries no typed code). First match wins; no match → generic.
 */
const DOWNLOAD_CAUSE_COPY: ReadonlyArray<{ re: RegExp; message: string }> = [
  {
    re: /space|storage|enospc|disk full/i,
    message:
      'Not enough disk space to download the model files. Free space on the models drive, then choose Retry.',
  },
  {
    re: /permission|denied|read-?only|access|create|write|folder|directory/i,
    message:
      "Couldn't write the model files to disk. Check the models folder is writable and has free space, then choose Retry.",
  },
  {
    re: /network|connection|reset|timed?\s?out|offline|dns|econn|socket|tls|certificate|unreachable/i,
    message:
      'The download lost its connection. Check your network connection, then choose Retry.',
  },
];

function genericErrorCopy(id: PrerequisiteId): string {
  return `Something went wrong during ${STEP_ERROR_LABEL[id]}. Choose Retry; if it persists, re-check.`;
}

/**
 * Normalize a raw step/file failure into curated primary copy + optional raw
 * technical detail. `code` is the backend's typed failure code when available;
 * `errorText` is the raw backend/IPC string captured by the action handler.
 */
export function errorCopyFor(
  id: PrerequisiteId,
  code?: string | null,
  errorText?: string | null,
): ErrorCopy {
  const raw =
    typeof errorText === 'string' && errorText.trim().length > 0
      ? errorText.trim()
      : null;

  let message: string;
  if (id === 'serverLaunch') {
    message = serverLaunchFailureCopy(
      (code as LlamaServerLaunchCode | null | undefined) ?? null,
      llamaServerEndpoint(null),
    );
  } else if (id === 'llamaServer' && code && code in INSTALL_ERROR_COPY) {
    message = INSTALL_ERROR_COPY[code as LlamaCppInstallCode];
  } else if (id === 'modelFiles' && raw) {
    const cause = DOWNLOAD_CAUSE_COPY.find((entry) => entry.re.test(raw));
    message = cause?.message ?? genericErrorCopy(id);
  } else {
    message = genericErrorCopy(id);
  }

  return { message, technicalDetail: raw && raw !== message ? raw : null };
}
