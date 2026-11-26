/**
 * Companion setup readiness — wire types for the backend
 * `check_companion_readiness` command (Spec #2855; in-process since #3141).
 *
 * The backend owns the prerequisite SET; these ids are the stable join key
 * between the backend reports and the ordered `COMPANION_SETUP_STEPS` registry.
 * #2857 appended `'serverLaunch'` (a frontend-composed lifecycle row). #3141
 * ST-6 removed `'llamaServer'` with the out-of-process runtime — the model files
 * are the backend's ONLY prerequisite.
 */

export type PrerequisiteId = 'modelFiles' | 'serverLaunch';

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
 * remediation. Spec #3141 ST-6 re-pointed the two former "model server" strings
 * onto the IN-PROCESS companion engine (the out-of-process runtime is retired) —
 * there is no server to start, and no string may tell a user to.
 */
export const MODEL_AUDIO_FAILURE_COPY: Record<ModelAudioFailureCode, string> = {
  modelAudioUnsupported:
    "The companion model can't interpret audio — your recording wasn't sent. Install a model with audio support from Companion setup, or choose Change model.",
  modelAudioUnavailable:
    "The companion engine isn't running, so Fredo couldn't interpret that. Start the companion engine in Companion setup, then try again.",
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
          "The companion engine isn't running, so Fredo can't interpret audio.",
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

// ── Companion engine launch (#2857; in-process since #3141) ──────────────────
//
// `check_companion_readiness` reports the model files as the backend's ONLY
// prerequisite (Spec #3141 — the runtime ships inside Fredo). The `serverLaunch`
// lifecycle row is COMPOSED in the frontend from `get_llama_server_status`, and
// the overall gate is the backend readiness AND a healthy engine.

// ── In-process engine status surface (Spec #3141, ST-1) ──────────────────────
//
// The backend moves companion inference in-process (`llama-cpp-4`). The status
// command keeps its IPC name and its EXISTING fields (wire stability) and gains
// the ADDITIVE fields below. Every optional additive field is an ABSENT KEY when
// unset — the Rust side uses `skip_serializing_if` — so a consumer must treat
// `undefined` (not `null`) as "not loaded".

/**
 * The backend class ggml reports for a loaded device (camelCase, 1:1 with the
 * Rust `CompanionBackendKind`).
 */
export type CompanionBackendKind =
  | 'cpu'
  | 'gpu'
  | 'integratedGpu'
  | 'accel'
  | 'meta';

/** The persisted backend selection (`llama_server_backend`). */
export type CompanionBackendMode = 'auto' | 'gpu' | 'cpu';

/**
 * The ONE settings key the backend-mode control writes (Spec #3141 AC-24).
 * Declared here so no string literal is duplicated in the panel; the backend
 * owns the closed-enum validation (`auto` | `gpu` | `cpu`).
 */
export const COMPANION_BACKEND_SETTING_KEY = 'llama_server_backend';

/**
 * Coerce a persisted raw value onto the closed mode set. Mirrors the backend's
 * `CompanionBackendMode::from_persisted` so an invalid persisted value can never
 * render as a selection: anything outside `gpu`/`cpu` (case-insensitive,
 * trimmed) is `auto`.
 */
export function coerceCompanionBackendMode(
  raw: string | null | undefined,
): CompanionBackendMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'gpu' ? 'gpu' : value === 'cpu' ? 'cpu' : 'auto';
}

/**
 * One backend device the loaded model's tensors are spread across (camelCase,
 * 1:1 with the Rust `CompanionDeviceInfo`; sourced from ggml's typed
 * enumeration, never a log line).
 */
export interface CompanionDeviceInfo {
  /** ggml device name, e.g. `CUDA0`, `Vulkan0`, `CPU`. */
  name: string;
  /** ggml device description (usually the hardware name). */
  description: string;
  deviceType: CompanionBackendKind;
  memoryFreeBytes: number;
  memoryTotalBytes: number;
}

/** The typed engine failure vocabulary (camelCase, 1:1 with the Rust enum). */
export type CompanionEngineErrorCode =
  | 'gpuUnavailable'
  | 'backendInitFailed'
  | 'modelMissing'
  | 'modelLoadFailed'
  | 'mtpInitFailed'
  | 'mmprojInitFailed'
  | 'contextCreateFailed'
  | 'busy'
  | 'startTimeout';

/** `get_llama_server_status` snapshot (camelCase, IPC). */
export interface LlamaServerStatus {
  running: boolean;
  healthy: boolean;
  /** Always `null` post-migration (in-process: there is no port). */
  port: number | null;
  /** Always `null` post-migration (in-process: no child process). */
  pid: number | null;
  configPath: string;
  logPath: string;
  lastError: string | null;
  // ── additive (Spec #3141 ST-1) — ABSENT KEY when unset, never null ──
  /** Typed failure of the most recent engine start; absent when none. */
  lastErrorCode?: CompanionEngineErrorCode;
  /** The backend ggml reports; absent until an engine is loaded. */
  backend?: CompanionBackendKind;
  /** The persisted backend selection, echoed back. */
  backendMode: CompanionBackendMode;
  /** The device set ggml reports (empty before a load). */
  devices: CompanionDeviceInfo[];
  /** The canonical model id (manifest `model` file stem); absent until loaded. */
  modelId?: string;
}

/**
 * `launch_llama_server` result (camelCase, IPC) — 1:1 with the Rust
 * `CompanionEngineStartResult`. Always returned (never a hang); `code` is the
 * typed failure when `success` is false.
 */
export interface CompanionEngineStartResult {
  success: boolean;
  code: CompanionEngineErrorCode | null;
  /** Curated, actionable detail — never a raw library/IPC string. */
  detail: string;
  /** The backend ggml reports for the loaded device set. */
  backend: CompanionBackendKind | null;
  devices: CompanionDeviceInfo[];
}

/**
 * Payload of the engine status push channel (`llama-server-status`). The
 * in-process engine emits no process-exit event, so the channel is retained as
 * a re-probe hook; the shape stays the two engine flags plus the typed code.
 */
export interface LlamaServerStatusEvent {
  running: boolean;
  healthy: boolean;
  code: CompanionEngineErrorCode | null;
}

/**
 * The frontend-composed `serverLaunch` step snapshot (UI/UX §4.4). Derived from
 * `get_llama_server_status` by `useCompanionReadiness` (no cross-feature import).
 */
export interface CompanionServerLaunchInfo {
  state: ServerLaunchState;
  /** The reported backend; `null` until an engine is loaded (never invented). */
  backend: CompanionBackendKind | null;
  /** The device set ggml reports (empty before a load). */
  devices: CompanionDeviceInfo[];
  /** The canonical model id — the healthy card's detail. */
  modelId: string | null;
  /** The typed engine failure. */
  code: CompanionEngineErrorCode | null;
  /** Curated engine detail (fallback for the card's copy). */
  detail: string | null;
}

/**
 * Engine-start presentation state for the `serverLaunch` step. Distinct from
 * `PrerequisiteState` (which has no notion of a running-but-loading engine).
 */
export type ServerLaunchState =
  | 'notRunning'
  | 'starting'
  | 'healthy'
  | 'exited'
  | 'failed';

/**
 * Derive the `serverLaunch` step state from the engine status + local action
 * outcome. Pure — unit-testable without a Tauri host. `status.lastError` is the
 * backend-persisted failure marker, so a failed start is never silently retried
 * as `notRunning`.
 */
export function deriveServerLaunchState(input: {
  /** A `launch_llama_server` run is in flight. */
  launching: boolean;
  /** The last launch attempt failed (invoke rejection or `success:false`). */
  error: boolean;
  status: LlamaServerStatus | null;
  /** A previously-healthy engine was observed to have stopped. */
  exited: boolean;
}): ServerLaunchState {
  if (input.launching) return 'starting';
  if (input.status?.healthy) return 'healthy';
  if (input.status?.running) return 'starting';
  if (input.error || input.status?.lastError) return 'failed';
  if (input.exited) return 'exited';
  return 'notRunning';
}

/** The curated engine-failure copy: a distinct title + an actionable sentence. */
export interface EngineFailureCopy {
  /** A distinct title per typed code (never a bare shared "Failed to start"). */
  title: string;
  /** Cause AND next step; never a raw library/IPC string. */
  sentence: string;
}

/**
 * `engineFailureCopy` — the UI/UX §3.2 typed-copy table (Spec #3141 AC-25).
 *
 * One distinct TITLE per `CompanionEngineErrorCode`, so the failure is
 * recognisable at a glance, plus a sentence naming the cause and the next step.
 * No sentence names `llama-server`, a port, an endpoint, a `.bat`, or anything to
 * install (AC-17/AC-28), and no sentence is a raw library/IPC string (NFR-5).
 * The `gpuUnavailable` sentence names the mode control by its visible label —
 * which is why that control must be on the same screen (UI/UX §2.5).
 */
export function engineFailureCopy(
  code: CompanionEngineErrorCode | null | undefined,
): EngineFailureCopy {
  switch (code) {
    case 'gpuUnavailable':
      return {
        title: 'No usable GPU',
        sentence:
          'The companion is set to use the GPU, but this machine has no usable GPU. Switch the companion backend to Automatic or CPU, then choose Start companion engine.',
      };
    case 'backendInitFailed':
      return {
        title: "The engine couldn't start",
        sentence:
          "Fredo's built-in engine couldn't initialise on this machine. Choose Retry; if it keeps failing, restart Fredo.",
      };
    case 'modelMissing':
      return {
        title: 'Model files are missing',
        sentence:
          "One or more model files the engine needs aren't on disk. Download the model files in Companion setup, then start the engine again.",
      };
    case 'modelLoadFailed':
      return {
        title: "The model couldn't load",
        sentence:
          'The model file is present but couldn\'t be loaded. Close other apps to free memory, then choose Retry; if it still fails, download the model files again.',
      };
    case 'mtpInitFailed':
      return {
        title: 'Speculative decoding unavailable',
        sentence:
          "The engine couldn't set up speculative decoding with the draft model. Download the model files again, then choose Retry.",
      };
    case 'mmprojInitFailed':
      return {
        title: "The vision projector couldn't load",
        sentence:
          "The engine couldn't load the vision projector file. Download the model files again, then choose Retry.",
      };
    case 'contextCreateFailed':
      return {
        title: 'Not enough memory',
        sentence:
          "The engine couldn't allocate the memory it needs. Close other apps, then choose Retry.",
      };
    case 'busy':
      return {
        title: 'The companion is busy',
        sentence: 'Another reply is still running. Wait for it to finish, then choose Retry.',
      };
    case 'startTimeout':
      return {
        title: 'The engine is taking too long',
        sentence:
          "The engine didn't finish starting in time. It may still be loading the model — keep waiting, or choose Retry.",
      };
    default:
      return {
        title: "Couldn't start the engine",
        sentence:
          "Fredo's companion engine didn't start. Choose Retry; if it keeps failing, restart Fredo.",
      };
  }
}

/** Lifecycle copy shown when a previously-healthy engine has stopped (UI §3.3). */
export const SERVER_EXITED_COPY =
  'The companion engine stopped unexpectedly. Choose Start companion engine to reconnect Fredo.';

/** Wait affordance copy — shown after the client watchdog; NEVER a failure. */
export const SERVER_WATCHDOG_COPY =
  'The engine is taking longer than expected. You can keep waiting, or choose Retry.';

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
  modelFiles: 'the model download',
  serverLaunch: 'the engine start',
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
    // The typed engine code carries a distinct curated title + sentence; a raw
    // invoke rejection with no code falls through to the null-code row.
    message = engineFailureCopy(
      (code as CompanionEngineErrorCode | null | undefined) ?? null,
    ).sentence;
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
 * The turn produced no visible answer (#3233 AC-2, Adjudication #2). This is a
 * DISTINCT condition from a transport/generation failure: the model spent its
 * whole budget reasoning and never wrote a reply. It deliberately makes NO
 * retry promise (G-505) — re-sending is not guaranteed to help — so it must NOT
 * borrow `COMPANION_REPLY_GENERIC_COPY`'s "Try again in a moment.".
 */
export const COMPANION_REPLY_EMPTY_COPY = "Fredo didn't answer that one.";

/**
 * Not-ready / still-loading signatures (the `⏳ Loading model...` retry path and
 * the managed server's startup states). First match wins; no match → generic.
 */
const COMPANION_NOT_READY_RE =
  /still loading|not ready|isn'?t ready|loading the model|model .*(not|isn'?t).*(ready|loaded)/i;

/**
 * Empty-reply (starvation) signature (#3233 AC-2, Adjudication #3). The wire
 * carries no error code (`WireEvent::Error(String)`), so this branch can only
 * match a substring of the raw detail — mirroring `COMPANION_NOT_READY_RE`.
 * Anchored to the stable discriminator phrase ST-5 guarantees inside
 * `EMPTY_REPLY_DETAIL` (`apps/tauri/src-tauri/src/applications/llm_server/skills.rs`),
 * itself pinned by an engine-side unit test, so a later reword cannot silently
 * disable this branch.
 */
const EMPTY_REPLY_RE = /no visible reply/i;

/**
 * Map a raw `llm-error` / invoke-rejection string to the readable companion
 * reply sentence. The raw backend/IPC string is never returned.
 *
 * Order: not-ready first (the empty phrase cannot match its regex, so the order
 * is safe), then the empty-reply branch, then the generic fallback.
 */
export function companionReplyErrorCopy(raw: string): string {
  if (COMPANION_NOT_READY_RE.test(raw)) return COMPANION_REPLY_NOT_READY_COPY;
  if (EMPTY_REPLY_RE.test(raw)) return COMPANION_REPLY_EMPTY_COPY;
  return COMPANION_REPLY_GENERIC_COPY;
}
