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

/**
 * The companion's three required model files (fixed display/acquisition order).
 * The id is the join key between the backend reports and the live
 * `setup:download-progress` stream; widening the union is additive — the
 * companion ids never change. (The four OPTIONAL STT (voice input) ids were
 * removed with the on-device engine in Spec #2914 — the backend no longer
 * reports them, so they are not part of the vocabulary.)
 */
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

// ── STT input-device enumeration — #2877 ST-2 ────────────────────────────────
//
// `stt_list_devices` enumerates the cpal input devices so the Companion voice
// settings row can offer a device picker (R-3.2). cpal exposes no device GUID,
// so `id` IS the cpal device name string (`name` is the display label — identical
// today, may be decorated later).

/** Typed STT failure vocabulary (mirrors the Rust `SttErrorCode`). */
export type SttErrorCode =
  | 'noDevice'
  | 'permissionDenied'
  | 'modelMissing'
  | 'modelCorrupt'
  | 'engineStartFailed'
  | 'alreadyListening'
  | 'disabled'
  | 'internal'
  // #2897 ST-6 (REQ-7) — the model-audio degradation codes.
  | 'modelAudioUnsupported'
  | 'modelAudioUnavailable';

/** One enumerated cpal input device (`stt_list_devices`). */
export interface SttDeviceInfo {
  /** Stable selector — the cpal device name (cpal exposes no device GUID). */
  id: string;
  /** Display label (identical to `id` today; may be decorated later). */
  name: string;
  isDefault: boolean;
}

/** `stt_list_devices` result (camelCase, IPC). */
export interface SttDevicesResult {
  devices: SttDeviceInfo[];
  /** Persisted selection reported by the backend; null = system default. */
  selectedId: string | null;
  /** Typed failure (e.g. `permissionDenied`), or null on success. */
  code: SttErrorCode | null;
}

/**
 * Presentation state for the device probe. `checking` exists only while a probe
 * is in flight; `unavailable` is the FAIL-CLOSED state for a missing/unknown
 * backend — it never claims "no device" (that would fabricate a fact).
 */
export type SttDeviceProbeState =
  | 'checking'
  | 'devices'
  | 'no-device'
  | 'vanished'
  | 'permissionDenied'
  | 'unavailable';

/** Derived device-probe snapshot consumed by the settings UI. */
export interface SttDeviceProbe {
  state: SttDeviceProbeState;
  devices: SttDeviceInfo[];
  /** Normalized persisted selection: a device id, or null for system default. */
  selectedId: string | null;
  code: SttErrorCode | null;
}

/** Normalize a persisted device id: blank/whitespace/non-string ⇒ null (default). */
export function normalizeDeviceId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSttDeviceInfo(value: unknown): value is SttDeviceInfo {
  if (!value || typeof value !== 'object') return false;
  const device = value as Record<string, unknown>;
  return typeof device.id === 'string' && device.id.trim().length > 0;
}

const EMPTY_DEVICE_PROBE: Omit<SttDeviceProbe, 'state'> = {
  devices: [],
  selectedId: null,
  code: null,
};

/**
 * Derive the device-probe presentation state. Pure — unit-testable without a
 * Tauri host. Fail-closed: a null/malformed result is `unavailable`, never
 * `no-device`; a persisted selection absent from the enumeration is `vanished`
 * (the system never silently falls back to the default device — AC4).
 */
export function deriveSttDeviceProbe(input: {
  /** A `stt_list_devices` probe is in flight. */
  checking: boolean;
  /** The latest result, or null when the command is unavailable/failed. */
  result: SttDevicesResult | null;
}): SttDeviceProbe {
  if (input.checking) return { state: 'checking', ...EMPTY_DEVICE_PROBE };
  const result = input.result;
  if (!result || !Array.isArray(result.devices)) {
    return { state: 'unavailable', ...EMPTY_DEVICE_PROBE };
  }
  const devices = result.devices.filter(isSttDeviceInfo);
  const selectedId = normalizeDeviceId(result.selectedId);
  const code = result.code ?? null;
  // Access denial is about permission, not absence — it wins over `no-device`.
  if (code === 'permissionDenied') {
    return { state: 'permissionDenied', devices, selectedId, code };
  }
  if (devices.length === 0) return { state: 'no-device', devices, selectedId, code };
  if (selectedId && !devices.some((device) => device.id === selectedId)) {
    return { state: 'vanished', devices, selectedId, code };
  }
  return { state: 'devices', devices, selectedId, code };
}

// ── Model-audio capability + fallback (#2897 ST-6 / REQ-7) ───────────────────
//
// `stt_audio_capability` is BACKEND-OWNED: the UI never infers capability from a
// model name. The readiness row (C0r) and the reactive fallback alert both derive
// their copy from THIS one module, so the two degradation moments can never
// disagree.

/** Rust `SttAudioCapabilityState` (camelCase wire). */
export type SttAudioCapabilityState =
  | 'checking'
  | 'ready'
  | 'unsupported'
  | 'serverUnavailable'
  | 'unknown';

/** `stt_audio_capability` result (camelCase, IPC). */
export interface SttAudioCapability {
  state: SttAudioCapabilityState;
  /** Model name reported by the managed server (`null` when unavailable). */
  model: string | null;
  /** ST-0's MEASURED per-input ceiling; `null` until F-110 records it. */
  limitMs: number | null;
  code: SttErrorCode | null;
  detail: string | null;
}

/**
 * The reactive fallback vocabulary. `modelAudioUnsupported` /
 * `modelAudioUnavailable` are the shipped typed wire codes (ST-2);
 * `modelAudioFailed` is the client-side generic failure (a null clip or a
 * dispatch error — no distinct wire code is needed for it).
 */
export type ModelAudioFailureCode =
  | 'modelAudioUnsupported'
  | 'modelAudioUnavailable'
  | 'modelAudioFailed';

/**
 * The curated fallback sentences (UI/UX §7). NEVER the raw IPC string; each names
 * the cause and the next step. Spec #2914 ST-3 (R-3): the local fallback is gone
 * (there is exactly ONE voice path), so every sentence names a REACHABLE
 * remediation — install an audio-capable model / start the companion server /
 * try again — and none offers or names the removed local transcription.
 */
export const MODEL_AUDIO_FAILURE_COPY: Record<ModelAudioFailureCode, string> = {
  modelAudioUnsupported:
    "The companion model can't interpret audio — your recording wasn't sent. Install a model with audio support from Companion setup, or choose Change model.",
  modelAudioUnavailable:
    "The local model server isn't running, so Fredo couldn't interpret that. Start the companion server, then try again.",
  modelAudioFailed:
    "Fredo couldn't interpret that recording. Try again.",
};

/** The distinct cause of the fallback's generic copy (a null clip / dispatch error). */
export const MODEL_AUDIO_GENERIC_FAILURE: ModelAudioFailureCode = 'modelAudioFailed';

/** Is this string one of the model-audio fallback causes? */
export function isModelAudioFailureCode(
  code: string | null | undefined,
): code is ModelAudioFailureCode {
  return (
    code === 'modelAudioUnsupported' ||
    code === 'modelAudioUnavailable' ||
    code === 'modelAudioFailed'
  );
}

/** Curated fallback copy for a model-audio failure cause, or null. */
export function modelAudioFailureCopy(
  code: ModelAudioFailureCode | null | undefined,
): string | null {
  return code ? MODEL_AUDIO_FAILURE_COPY[code] : null;
}

/** The readiness row's frozen `data-state` vocabulary (kebab for unavailable). */
export type ModelAudioReadinessState =
  | 'checking'
  | 'ready'
  | 'unsupported'
  | 'server-unavailable'
  | 'unknown';

/** The derived row: state + sentence + which actions it offers. */
export interface ModelAudioReadinessRow {
  state: ModelAudioReadinessState;
  sentence: string;
  /** Offer `Change model` (unsupported only — install an audio-capable model). */
  offerChangeModel: boolean;
  /** Offer `Try again` (re-probe). */
  offerRetry: boolean;
}

/**
 * Derive the model-audio `Model audio status` row from the backend capability.
 * Pure and fail-closed: a missing capability (no probe / rejected invoke) is
 * `unknown` ("can't check"), never a fabricated `ready`. `checking` is the
 * UI-side probe-in-flight value. Spec #2914 ST-3 (R-3): the row NEVER offers a
 * local-transcription fallback — every offered action is a reachable remediation.
 */
export function deriveModelAudioReadinessRow(
  capability: SttAudioCapability | null,
  checking: boolean,
): ModelAudioReadinessRow {
  if (checking) {
    return {
      state: 'checking',
      sentence: "Checking the companion model's audio support…",
      offerChangeModel: false,
      offerRetry: false,
    };
  }
  switch (capability?.state) {
    case 'ready': {
      const subject =
        typeof capability.model === 'string' && capability.model.trim().length > 0
          ? capability.model.trim()
          : 'The installed companion model';
      return {
        state: 'ready',
        sentence: `${subject} can interpret audio. Recordings stay on this machine.`,
        offerChangeModel: false,
        offerRetry: false,
      };
    }
    case 'unsupported':
      return {
        state: 'unsupported',
        sentence:
          "The installed companion model can't interpret audio. Recordings won't be sent.",
        offerChangeModel: true,
        offerRetry: false,
      };
    case 'serverUnavailable':
      return {
        state: 'server-unavailable',
        sentence:
          "The local model server isn't running, so Fredo can't interpret audio.",
        offerChangeModel: false,
        offerRetry: true,
      };
    default:
      return {
        state: 'unknown',
        sentence: "Can't check audio support right now.",
        offerChangeModel: false,
        offerRetry: true,
      };
  }
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

// ── Companion reply failure copy (#2871 ST-1r) ───────────────────────────────
//
// The companion's `llm-error` channel (and a non-`still loading` `llm_chat`
// invoke rejection) carries a RAW backend/IPC string — e.g. the verbatim
// `failed to start …: spawn …` detail. That string must NEVER be the primary
// sentence the user reads in the reply bubble; this maps it to one of two
// curated sentences. Pure + unit-pinned (`companionReplyErrorCopy.test.ts`).

/** The model is still loading / not ready — actionable next step. */
export const COMPANION_REPLY_NOT_READY_COPY =
  "Fredo's model isn't ready yet — open Companion setup to finish loading it.";

/** Any other generation failure — safe, transient, retryable. */
export const COMPANION_REPLY_GENERIC_COPY =
  "Fredo couldn't reply just now. Try again in a moment.";

/**
 * Not-ready / still-loading signatures (the `⏳ Loading model...` retry path and
 * the managed server's startup states). First match wins; no match → generic.
 */
const COMPANION_NOT_READY_RE =
  /still loading|not ready|isn'?t ready|loading the model|model .*(not|isn'?t).*(ready|loaded)/i;

/**
 * Map a raw `llm-error` / invoke-rejection string to the readable companion
 * reply sentence. The raw backend/IPC string is never returned.
 */
export function companionReplyErrorCopy(raw: string): string {
  return COMPANION_NOT_READY_RE.test(raw)
    ? COMPANION_REPLY_NOT_READY_COPY
    : COMPANION_REPLY_GENERIC_COPY;
}
