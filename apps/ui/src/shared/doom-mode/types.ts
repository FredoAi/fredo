/**
 * Doom Mode secret-activation wire mirror (Spec #2970, ST-5).
 *
 * Mirrors the Rust contract in `applications/doom/mode.rs` (serde camelCase over
 * IPC) verbatim — the binding names adopted by the plan. No I/O happens here:
 * the types describe what the ST-2 commands/event deliver, and the constants
 * are the ONE frontend source of the trigger/skill/event vocabulary.
 */

import type { DoomProvisionPhase } from './provision';

/** The global broadcast carrying a `DoomModeStatus` to every window. */
export const DOOM_MODE_EVENT = 'doom-mode-changed';

/** The companion skill name the model selects to enter/leave Doom Mode. */
export const DOOM_MODE_SKILL = 'doom_mode';

/** The secret typed sequence that enters Doom Mode (five keys, no modifier). */
export const DOOM_SECRET_CODE = 'iddqd';

/**
 * The Doom Mode lifecycle phase (binding enum, camelCase over IPC).
 *
 * Spec #3012 ST-3 added `provisioning`: the mode is entering, but the engine is
 * being built on first use — the launch completes once provisioning reaches
 * `ready`.
 */
export type DoomModePhase = 'inactive' | 'entering' | 'provisioning' | 'active' | 'exiting';

/** How Doom Mode was entered (binding enum, camelCase over IPC). */
export type DoomModeOrigin = 'code' | 'voice' | 'window';

/**
 * `get_doom_mode_status` / `doom-mode-changed` payload.
 *
 * `needsProvisioning` / `provision` are additive (#3012 ST-3): the live
 * provisioning sub-phase while the mode is `provisioning`. They are optional so
 * a pre-#3012 status payload (and the resting constant below) stays valid.
 */
export interface DoomModeStatus {
  phase: DoomModePhase;
  active: boolean;
  voiceSuppressed: boolean;
  origin: DoomModeOrigin | null;
  enteredAt: string | null;
  lastError: string | null;
  code: string | null;
  needsProvisioning?: boolean;
  provision?: DoomProvisionPhase | null;
}

/** `enter_doom_mode` / `exit_doom_mode` result — always returned, never a hang. */
export interface DoomModeResult {
  success: boolean;
  phase: DoomModePhase;
  active: boolean;
  voiceSuppressed: boolean;
  origin: DoomModeOrigin | null;
  error: string | null;
  code: string | null;
  /** Spec #3012 ST-3 — `code: provisionRequired` asks the owner to choose a dir. */
  needsInstallDir?: boolean;
}

/**
 * The resting state before the mount seed resolves (and the safe default for any
 * window that has not yet received a `doom-mode-changed` broadcast). Mirrors the
 * backend's fresh-boot `inactive` status.
 */
export const DOOM_MODE_INACTIVE_STATUS: DoomModeStatus = {
  phase: 'inactive',
  active: false,
  voiceSuppressed: false,
  origin: null,
  enteredAt: null,
  lastError: null,
  code: null,
};

/** Whether the phase means the mode is engaged or coming up (not resting). */
export function isDoomModeEngaged(phase: DoomModePhase): boolean {
  return phase !== 'inactive';
}
