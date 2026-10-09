/**
 * Doom engine provisioning wire mirror (Spec #3012, ST-4).
 *
 * Mirrors the Rust contract in `applications/doom/provision.rs` (serde camelCase
 * over IPC) verbatim — the binding names adopted by the plan. There is exactly
 * ONE event shape: `doom-provision-progress` is a global broadcast whose payload
 * is `DoomProvisionStatus` (the nested `progress` carries the per-tick detail).
 * `get_doom_provision_status` is the seed/poll fallback — never a second shape,
 * never a `??` fallback chain (Contract-Trust Cleanup).
 *
 * No I/O happens here: the types describe what the ST-2 commands/event deliver,
 * and the pure helpers format them for the `DoomProvisionDialog` surface.
 */

/** The ONLY provisioning progress event: a global broadcast carrying `DoomProvisionStatus`. */
export const DOOM_PROVISION_EVENT = 'doom-provision-progress';

/** The install-dir setting key the provisioning plane persists (existing key). */
export const DOOM_PROVISION_INSTALL_DIR_KEY = 'doom_install_dir';

/** 150 ms `ready` success flash before the host enters Doom Mode (UI/UX spec). */
export const DOOM_PROVISION_READY_FLASH_MS = 150;

/** The provisioning phase (binding enum; camelCase over IPC). */
export type DoomProvisionPhase =
  | 'idle'
  | 'awaitingInstallDir'
  | 'downloadingToolchain'
  | 'building'
  | 'ready'
  | 'failed'
  | 'cancelled';

/** The typed provisioning failure vocabulary (binding enum; camelCase over IPC). */
export type DoomProvisionErrorCode =
  | 'installDirInvalid'
  | 'toolchainUnavailable'
  | 'toolchainDownloadFailed'
  | 'toolchainExtractFailed'
  | 'sourceMissing'
  | 'buildFailed'
  | 'timeout'
  | 'cancelled';

/**
 * The build-script `STEP` markers, in order (binding ids). The progress bar is
 * scaled to this list when a byte `percent` is not available (the `make` phase),
 * so it is never frozen at 0.
 */
export const DOOM_PROVISION_STEPS = [
  'toolchain',
  'deps',
  'source',
  'patch',
  'autogen',
  'configure',
  'make',
  'stage',
] as const;

/** One build step id. */
export type DoomProvisionStep = (typeof DOOM_PROVISION_STEPS)[number];

/** Per-tick provisioning detail carried on `DoomProvisionStatus`. */
export interface DoomProvisionProgress {
  phase: DoomProvisionPhase;
  step: string;
  message: string;
  downloaded: number;
  total: number;
  percent: number;
  elapsedMs: number;
}

/** `get_doom_provision_status` / `doom-provision-progress` payload (ONE shape). */
export interface DoomProvisionStatus {
  phase: DoomProvisionPhase;
  running: boolean;
  needsInstallDir: boolean;
  installDir: string | null;
  installDirDefault: string;
  enginePath: string | null;
  progress: DoomProvisionProgress | null;
  lastError: string | null;
  code: DoomProvisionErrorCode | null;
}

/** `provision_doom_engine` result — returned immediately (the event is truth). */
export interface DoomProvisionResult {
  success: boolean;
  phase: DoomProvisionPhase;
  needsInstallDir: boolean;
  enginePath: string | null;
  error: string | null;
  code: DoomProvisionErrorCode | null;
}

/** The resting status before the mount seed resolves (mirrors the backend fresh boot). */
export const DOOM_PROVISION_IDLE_STATUS: DoomProvisionStatus = {
  phase: 'idle',
  running: false,
  needsInstallDir: false,
  installDir: null,
  installDirDefault: '',
  enginePath: null,
  progress: null,
  lastError: null,
  code: null,
};

/** Whether the phase is a live provisioning run (download or build). */
export function isDoomProvisionRunning(phase: DoomProvisionPhase): boolean {
  return phase === 'downloadingToolchain' || phase === 'building';
}

/**
 * The install dir to show/prefill: the stored dir, else the product default.
 * Mirrors the backend `resolve_chosen_install_dir` precedence — ONE source, no
 * multi-path lookup.
 */
export function doomProvisionDir(status: DoomProvisionStatus): string {
  return status.installDir ?? status.installDirDefault;
}

/** The 0-based index of a step id, or -1 when unknown. */
export function doomProvisionStepIndex(step: string | null | undefined): number {
  if (!step) return -1;
  return (DOOM_PROVISION_STEPS as readonly string[]).indexOf(step);
}

/** The 1-based position of a step id (`make` → 7), defaulting to 1 when unknown. */
export function doomProvisionStepNumber(step: string | null | undefined): number {
  const index = doomProvisionStepIndex(step);
  return index >= 0 ? index + 1 : 1;
}

/** The single-line phase label (UI/UX state table). */
export function doomProvisionPhaseLabel(phase: DoomProvisionPhase): string {
  switch (phase) {
    case 'awaitingInstallDir':
      return 'Set up the engine';
    case 'downloadingToolchain':
      return 'Downloading toolchain';
    case 'building':
      return 'Building';
    case 'ready':
      return 'Engine ready';
    case 'failed':
      return 'Setup failed';
    case 'cancelled':
      return 'Setup cancelled';
    case 'idle':
    default:
      return 'Idle';
  }
}

/**
 * The polite-live-region step text. `downloadingToolchain` reads
 * "Downloading toolchain (n of 8)"; `building` reads "Building · make (7 of 8)"
 * (UI/UX spec, throttled to phase/step changes).
 */
export function doomProvisionStepText(status: DoomProvisionStatus): string {
  const progress = status.progress;
  const total = DOOM_PROVISION_STEPS.length;
  const position = doomProvisionStepNumber(progress?.step);
  const phase = progress?.phase ?? status.phase;
  if (phase === 'downloadingToolchain') {
    return `Downloading toolchain (${String(position)} of ${String(total)})`;
  }
  if (phase === 'building') {
    const step = progress?.step && progress.step.length > 0 ? progress.step : 'toolchain';
    return `Building · ${step} (${String(position)} of ${String(total)})`;
  }
  return doomProvisionPhaseLabel(phase);
}

/**
 * The progress-bar value: the byte percent while downloading, else the
 * step-derived fraction (so the bar advances through `make`), else 0.
 */
export function doomProvisionProgressValue(status: DoomProvisionStatus): number {
  const progress = status.progress;
  if (!progress) return 0;
  if (progress.percent > 0) return Math.min(100, Math.max(0, progress.percent));
  const index = doomProvisionStepIndex(progress.step);
  if (index < 0) return 0;
  return Math.min(100, ((index + 1) / DOOM_PROVISION_STEPS.length) * 100);
}

/** A compact human byte count (e.g. `41.2 MB`). */
export function formatDoomProvisionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}

/** A compact elapsed duration (`0:42`, `3:07`, or `12s` under a minute). */
export function formatDoomProvisionDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}:${String(seconds).padStart(2, '0')}` : `${String(seconds)}s`;
}

/**
 * The byte readout while downloading toolchain bytes, or `null` when no total is
 * known (the build phase).
 */
export function doomProvisionByteText(status: DoomProvisionStatus): string | null {
  const progress = status.progress;
  if (!progress || progress.total <= 0) return null;
  if (progress.phase !== 'downloadingToolchain') return null;
  return `${formatDoomProvisionBytes(progress.downloaded)} / ${formatDoomProvisionBytes(progress.total)}`;
}
