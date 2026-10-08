/**
 * Doom Mode shared wire contract + pure UI helpers (Spec #2968 CU-4: ST-6/ST-7).
 *
 * These mirror the Rust contract in
 * `apps/tauri/src-tauri/src/applications/doom/{state,client}.rs` (serde camelCase)
 * verbatim — the binding names adopted by the plan. No I/O happens here: the
 * types describe what the Tauri commands/events deliver, and the helpers format
 * them for the `DoomWindow` surface.
 */

/** The runtime lifecycle phase (binding enum, camelCase over IPC). */
export type DoomRuntimePhase = 'idle' | 'starting' | 'ready' | 'stopping' | 'error';

/** The typed failure vocabulary (binding enum, camelCase over IPC). */
export type DoomErrorCode =
  | 'notConfigured'
  | 'acquireFailed'
  | 'spawnFailed'
  | 'readyTimeout'
  | 'stopTimeout'
  | 'requestFailed'
  | 'frameNotReady';

/** Bounded readiness wait: the `starting` Progress bar is scaled to this. */
export const DOOM_READY_TIMEOUT_S = 30;
/** Frame polling cadence (~15 fps). */
export const DOOM_FRAME_POLL_MS = 66;

/** `doom-status-changed` payload (emitted to the `doom` window only). */
export interface DoomStatusEvent {
  phase: DoomRuntimePhase;
  running?: boolean;
  port?: number | null;
  pid?: number | null;
  enginePath?: string | null;
  lastError?: string | null;
  code?: DoomErrorCode | null;
}

/** `launch_doom_runtime` result — always returned, never a hang. */
export interface DoomLaunchResult {
  success: boolean;
  phase: DoomRuntimePhase;
  port?: number | null;
  pid?: number | null;
  enginePath?: string | null;
  error?: string | null;
  code?: DoomErrorCode | null;
}

/** `doom_read_state` result — the engine observation, verbatim. */
export interface DoomStateView {
  raw: unknown;
}

/** `doom_step` result — the post-step observation, verbatim. */
export interface DoomStepResult {
  state: unknown;
}

/** `doom_frame` result — a renderable base64 PNG (no data-URI prefix). */
export interface DoomFrame {
  pngBase64: string;
}

/** The human-facing error copy per `DoomErrorCode` (UI/UX error table). */
export const DOOM_ERROR_MESSAGES: Record<DoomErrorCode, { title: string; message: string }> = {
  notConfigured: {
    title: "Doom isn't set up",
    message: 'Choose a Doom engine and game data (WAD) in Settings, then retry.',
  },
  acquireFailed: {
    title: 'Download failed',
    message: "Couldn't download the Doom engine or game data. Check your connection and retry.",
  },
  spawnFailed: {
    title: "Engine didn't start",
    message: 'The Doom engine failed to launch. Check the engine path in Settings and retry.',
  },
  readyTimeout: {
    title: "Engine didn't respond",
    message:
      "The engine didn't become ready within 30 seconds and was stopped. Retry to try again.",
  },
  stopTimeout: {
    title: "Engine didn't stop",
    message: "The engine didn't stop cleanly and was force-closed. Retry to restart.",
  },
  requestFailed: {
    title: 'Lost connection',
    message: 'Lost contact with the Doom engine — it may have stopped. Retry to restart it.',
  },
  // Transient and never rendered in the error phase (the frame loop degrades to
  // the reconnecting note instead). Present only so the Record stays exhaustive.
  frameNotReady: {
    title: 'Graphics warming up',
    message: 'The Doom engine is still preparing its display. The view resumes automatically.',
  },
};

/** Resolve the human copy for a code, defaulting to a generic typed failure. */
export function doomErrorMessage(code: DoomErrorCode | null | undefined): {
  title: string;
  message: string;
} {
  if (code && code in DOOM_ERROR_MESSAGES) {
    return DOOM_ERROR_MESSAGES[code];
  }
  return { title: 'Doom error', message: 'The Doom runtime hit an unexpected error. Retry to try again.' };
}

/** The phase label shown in `doom-status`. */
export function doomPhaseLabel(phase: DoomRuntimePhase, port?: number | null): string {
  switch (phase) {
    case 'starting':
      return 'Starting…';
    case 'ready':
      return port ? `Ready · :${port}` : 'Ready';
    case 'stopping':
      return 'Stopping…';
    case 'error':
      return 'Error';
    case 'idle':
    default:
      return 'Not started';
  }
}

const ADVANCED_FIELDS = ['tick', 'gametic', 'time', 'tic'] as const;
const MAX_READOUT_PAIRS = 6;
const MAX_SCALAR_LENGTH = 80;

function truncate(value: string): string {
  return value.length > MAX_SCALAR_LENGTH ? `${value.slice(0, MAX_SCALAR_LENGTH - 1)}…` : value;
}

/** A bounded, display-safe rendering of one state field (null = not scalar). */
function formatScalar(value: unknown): string | null {
  if (value === null) return 'null';
  if (value === undefined) return null;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects/arrays are progressive-disclosure only (the raw Collapsible).
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return null;
  }
}

/** Safe stringify for the "Raw state" disclosure; never throws. */
export function stringifyDoomState(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    return String(raw);
  }
}

export interface FormattedDoomState {
  /** The promoted advanced field (`tick`/`gametic`/`time`/`tic`), if present. */
  advancedKey: string | null;
  advancedValue: string | null;
  /** Up to 6 bounded `key=value` scalars (advanced field excluded). */
  pairs: Array<{ key: string; value: string }>;
  /** The verbatim engine JSON, for the progressive-disclosure panel. */
  rawJson: string;
}

/**
 * Format an engine observation for the footer readout: promote the advanced
 * field, then at most 6 scalar `key=value` pairs, and carry the full JSON for
 * the "Raw state" disclosure. Never dumps the whole object inline.
 */
export function formatDoomState(raw: unknown): FormattedDoomState {
  const rawJson = stringifyDoomState(raw);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const scalar = formatScalar(raw);
    return {
      advancedKey: null,
      advancedValue: scalar,
      pairs: [],
      rawJson,
    };
  }

  const record = raw as Record<string, unknown>;
  const advancedKey = ADVANCED_FIELDS.find((key) => key in record) ?? null;
  const advancedValue = advancedKey ? formatScalar(record[advancedKey]) : null;

  const pairs: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === advancedKey) continue;
    if (pairs.length >= MAX_READOUT_PAIRS) break;
    const formatted = formatScalar(value);
    if (formatted === null) continue;
    pairs.push({ key, value: formatted });
  }

  return { advancedKey, advancedValue, pairs, rawJson };
}

// ── Autoplay contract (Spec #2969, ST-7) ─────────────────────────────────────
//
// Mirrors the Rust contract in `applications/doom/autoplay.rs` (serde camelCase over
// IPC) verbatim — the binding names adopted by the plan. No I/O happens here:
// the types describe what the ST-5 commands/event deliver, and the helpers
// format them for the `DoomAutoplayControls` cluster.

/** The autoplay lifecycle phase (binding enum, camelCase over IPC). */
export type DoomAutoplayPhase = 'idle' | 'running' | 'stopping' | 'completed' | 'failed';

/** The typed autoplay failure vocabulary (binding enum, camelCase over IPC). */
export type DoomAutoplayErrorCode =
  | 'notReady'
  | 'decisionFailed'
  | 'engineRequestFailed'
  | 'budgetExhausted'
  // Spec #2972 ST-6 — additive: the campaign's final level was exited.
  | 'campaignComplete';

/** The `doom-autoplay-changed` event name (ST-5 emits it to the `doom` window). */
export const DOOM_AUTOPLAY_EVENT = 'doom-autoplay-changed';

/** Maximum advance steps a single autoplay run may issue (backend default). */
export const DOOM_AUTOPLAY_MAX_STEPS = 600;
/** Maximum consecutive decision failures before the run stops (backend default). */
export const DOOM_AUTOPLAY_MAX_FAILURES = 3;
/** Longest `lastError` detail rendered in the failure box (AC-UI-2). */
export const DOOM_AUTOPLAY_ERROR_MAX_CHARS = 120;

/** `doom-autoplay-changed` payload + `get_doom_autoplay_status` return. */
export interface DoomAutoplayStatus {
  phase: DoomAutoplayPhase;
  running: boolean;
  steps: number;
  decisions: number;
  failures: number;
  consecutiveFailures: number;
  lastTic: number | null;
  outcome: string | null;
  startedAt: string | null;
  lastError: string | null;
  code: DoomAutoplayErrorCode | null;
  // Spec #2972 ST-6 — additive campaign position (the live running source).
  episode: number | null;
  map: number | null;
  completed: boolean;
}

/** `start_doom_autoplay` result — always returned, never a hang. */
export interface DoomAutoplayResult {
  success: boolean;
  phase: DoomAutoplayPhase;
  steps: number;
  code: DoomAutoplayErrorCode | null;
  error: string | null;
}

/** The initial idle status (mirrors the backend's `idle_status()`). */
export const DOOM_AUTOPLAY_IDLE_STATUS: DoomAutoplayStatus = {
  phase: 'idle',
  running: false,
  steps: 0,
  decisions: 0,
  failures: 0,
  consecutiveFailures: 0,
  lastTic: null,
  outcome: null,
  startedAt: null,
  lastError: null,
  code: null,
  episode: null,
  map: null,
  completed: false,
};

/** The human-facing failure copy per `DoomAutoplayErrorCode` (UI/UX error table). */
export const DOOM_AUTOPLAY_ERROR_MESSAGES: Record<
  DoomAutoplayErrorCode,
  { title: string; message: string }
> = {
  notReady: {
    title: 'Engine not ready',
    message:
      "The Doom engine wasn't ready to accept autoplay. Start the engine, then try again.",
  },
  decisionFailed: {
    title: 'Companion stalled',
    message: "The companion couldn't produce a usable decision within the failure budget.",
  },
  engineRequestFailed: {
    title: 'Lost contact',
    message: 'Lost contact with the Doom engine while playing. Restart and try again.',
  },
  budgetExhausted: {
    title: 'Run finished',
    message: 'Autoplay reached its step budget and stopped cleanly.',
  },
  campaignComplete: {
    title: 'Campaign complete',
    message: 'The companion finished the final level of the campaign. Start fresh to replay.',
  },
};

/** Resolve the human copy for a code, defaulting to a generic typed failure. */
export function doomAutoplayErrorMessage(code: DoomAutoplayErrorCode | null | undefined): {
  title: string;
  message: string;
} {
  if (code && code in DOOM_AUTOPLAY_ERROR_MESSAGES) {
    return DOOM_AUTOPLAY_ERROR_MESSAGES[code];
  }
  return {
    title: 'Autoplay error',
    message: 'Autoplay hit an unexpected error. Start it again to retry.',
  };
}

/** AC-UI-4: base-10 integer via `String(n)`; `lastTic === null` renders an em dash. */
export function formatAutoplayTic(lastTic: number | null): string {
  return lastTic === null ? '—' : String(lastTic);
}

/** The single-line status text per phase (the UI/UX state table). */
export function doomAutoplayStatusLine(status: DoomAutoplayStatus): string {
  switch (status.phase) {
    case 'running':
      return `Autoplay · step ${String(status.steps)} · tic ${formatAutoplayTic(
        status.lastTic,
      )} · ${status.outcome ?? 'alive'}`;
    case 'stopping':
      return 'Stopping autoplay…';
    case 'completed':
      return `Autoplay complete · ${String(status.steps)} steps${
        status.outcome ? ` · ${status.outcome}` : ''
      }`;
    case 'failed':
      return `Autoplay failed · ${String(status.steps)} steps`;
    case 'idle':
    default:
      return 'Autoplay off';
  }
}

/**
 * AC-UI-7: the `m:ss` elapsed ticker from an RFC3339 `startedAt`. An unparseable
 * (or absent) timestamp renders no ticker (`null`) — never throws.
 */
export function formatAutoplayElapsed(startedAt: string | null, nowMs: number): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const totalSeconds = Math.max(0, Math.floor((nowMs - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** AC-UI-2: truncate the failure detail to `<= 120` chars (title carries the full text). */
export function truncateAutoplayError(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= DOOM_AUTOPLAY_ERROR_MAX_CHARS) return value;
  return `${value.slice(0, DOOM_AUTOPLAY_ERROR_MAX_CHARS - 1)}…`;
}

// ── Save / resume contract (Spec #2972, ST-6) ────────────────────────────────
//
// Mirrors the additive Rust contract in `applications/doom/save.rs` (serde camelCase
// over IPC) verbatim — the binding names adopted by the plan. `get_doom_save`
// returns the durable resume point; the LIVE running position is carried by the
// extended `DoomAutoplayStatus.{episode,map,completed}`. No I/O happens here.

/** `get_doom_save` / `reset_doom_save` return (serde camelCase). */
export interface DoomSaveStatus {
  hasSave: boolean;
  episode: number | null;
  map: number | null;
  skill: number | null;
  seed: number | null;
  completed: boolean;
  updatedAt: string | null;
}

/**
 * G-187 display unit: `E{episode}M{map}` (e.g. `E1M2`). Storage stays integer
 * `episode`/`map`/`skill`/`seed`; this is the ONLY presentation conversion.
 * Returns `null` when either coordinate is absent.
 */
export function formatDoomLevel(episode: number | null, map: number | null): string | null {
  if (episode === null || map === null) return null;
  return `E${String(episode)}M${String(map)}`;
}

/** A one-line, non-visual description of the current frame/state. */
export function describeDoomFrame(phase: DoomRuntimePhase, raw: unknown): string {
  switch (phase) {
    case 'idle':
      return 'No frame yet — the Doom runtime is not started.';
    case 'starting':
      return 'No frame yet — the Doom runtime is starting.';
    case 'stopping':
      return 'The Doom runtime is stopping; the last rendered frame is shown.';
    case 'error':
      return 'No frame — the Doom engine is unavailable. See the error panel.';
    case 'ready':
    default: {
      if (raw === null || raw === undefined) {
        return 'Live Doom game view — waiting for the first frame.';
      }
      const { advancedKey, advancedValue, pairs } = formatDoomState(raw);
      const head =
        advancedKey && advancedValue ? `${advancedKey} ${advancedValue}` : 'engine state observed';
      const tail = pairs
        .slice(0, 3)
        .map((pair) => `${pair.key} ${pair.value}`)
        .join(' · ');
      return `Live Doom game view — ${head}${tail ? ` · ${tail}` : ''}.`;
    }
  }
}
