/**
 * Companion setup readiness — wire types for the backend
 * `check_companion_readiness` / `install_llama_cpp` commands (Spec #2855).
 *
 * The backend owns the prerequisite SET; these ids are the stable join key
 * between the backend reports and the ordered `COMPANION_SETUP_STEPS` registry.
 * #2857 appends `'serverLaunch'` here and to the registry.
 */

export type PrerequisiteId = 'llamaServer' | 'modelFiles';

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
