/**
 * log.ts — the ONE diagnostics channel for the Fredo OpenCode plugin (V2).
 *
 * Why this file exists (Spec #3197 NFR-3): the V1 plugin forwarded diagnostics
 * through `client.app.log`, which has no V2 equivalent — the V2 `Context`
 * exposes no OTel/log API behind it. Diagnostics therefore go to a single
 * `pluginLog` channel backed by `console.error`, gated at `warn` by default.
 *
 * Two hard rules:
 *   1. NEVER call `client.app.log` (or `app.log`) from anywhere in the plugin —
 *      the V2 surface has no such API. Route every diagnostic through here.
 *   2. The opt-out path is SILENT: `index.ts` returns before any diagnostic is
 *      emitted when capture is disabled (R-5). At most one startup line is
 *      emitted on the enabled path.
 */

import { LEVELS } from "./types";
import type { Level } from "./types";

/** Default level. `warn` keeps a healthy session silent (NFR-3). */
export const DEFAULT_LOG_LEVEL: Level = "warn";

let minLevel: Level = DEFAULT_LOG_LEVEL;

/** Raises/lowers the diagnostic floor. Only diagnostics are affected — never emission. */
export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** Returns the current diagnostic floor. */
export function getLogLevel(): Level {
  return minLevel;
}

/**
 * Emits one diagnostic line to the plugin host's stderr when `level` is at or
 * above the current floor. Synchronous and non-throwing: a failed diagnostic
 * must never break a session (NFR-1).
 */
export function pluginLog(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = `[fredo-opencode-plugin] ${message}`;
  try {
    if (extra && Object.keys(extra).length > 0) {
      console.error(`${line} ${JSON.stringify(extra)}`);
    } else {
      console.error(line);
    }
  } catch {
    // A diagnostics sink must never surface to the user (NFR-1).
  }
}
