/**
 * #2835 round-2 (ST-4-R2a + ST-8a) — replay recency window + warm-reopen
 * watermark.
 *
 * Two orthogonal bounds narrow the Mission Monitor replay snapshot:
 *
 * 1. **Recency cutoff (ST-4-R2a).** `MM_REPLAY_WINDOW_NS` is a WINDOW WIDTH
 *    (7 days). The panel computes a MOUNT-STABLE absolute cutoff
 *    (`Date.now() * 1e6 - MM_REPLAY_WINDOW_NS`) and passes it as
 *    `startedAtNs >= <cutoff>` on both the Chat and ToolUse subscriptions.
 *    The magnitude rule: real row `startedAtNs` values are absolute epoch
 *    nanoseconds ≈ 1.7–1.8e18 (`Date.now()` ms × 1e6), NOT 1970-relative
 *    deltas — a window width used as the literal compare value (the round-1
 *    defect, `MissionMonitorPanel.tsx`) matches every real row and the
 *    snapshot never narrows.
 *
 * 2. **Warm-reopen watermark (ST-8a).** The RTDB row store is module-scoped
 *    and survives Mission Monitor mount/unmount, yet every remount re-opens
 *    `replay: true` and the backend re-drains the whole table. This module
 *    keeps a feature-local, MODULE-scoped last-seen `updatedAt` watermark per
 *    event type (the pipeline writes one canonical RFC3339 form with a fixed
 *    `+00:00` offset, so lexicographic order == chronological order for the
 *    values it stores). On a warm reopen the panel adds
 *    `updatedAt > <watermark>` to the replay args, so the drain returns only
 *    the rows the store does NOT yet hold (≈ live delta) and the
 *    `replayCompleteQueryId` settle marker arrives in tens of ms.
 *
 * Invariants (frozen by the round-2 fix plan):
 * - The watermark is advanced incrementally on row-store epoch changes only
 *   (scan only when the epoch advances); it must never skip a row the shared
 *   store does NOT hold — it only skips rows the store provably holds (the
 *   same store that survives the reopen).
 * - The watermark state is MODULE-scoped per the AGENTS.md persistence rule
 *   (never a `useRef`); it resets on app restart (module reload), so a cold
 *   boot performs the full windowed replay exactly as before.
 * - The args the panel passes to `useEventRows` MUST be render-stable —
 *   `useEventRows` resubscribes whenever `stableArgsKey(args)` changes, so an
 *   inline `Date.now()` in the render body would resubscribe + re-replay on
 *   every render. All consumers capture the cutoff/watermark mount-stably.
 */

import type { RowEventType } from '../../../shared/classes/EventSubscription';
import type { RowArgs } from '../../../shared/hooks/useEventRows';

/** Replay window width in ns — 7 days, matching the backend retention window
 *  (`RTDB_DEFAULT_RETENTION_DAYS`, `store.rs:58`). A WINDOW WIDTH, never a
 *  compare value (see the module doc magnitude rule). */
export const MM_REPLAY_WINDOW_NS = 7 * 24 * 60 * 60 * 1e9;

/** Any row type the MM subscriptions hold — both expose the canonical
 *  `updatedAt` RFC3339 string (EventSubscription.ts). */
export interface WatermarkRow {
  updatedAt: string;
}

// Module-scoped last-seen watermark per event type (survives feature
// mount/unmount; cleared on app restart via module reload).
const watermarks = new Map<RowEventType, string>();

/** The stored watermark for one event type, or `undefined` when this app
 *  session has never seen a row of that type (cold boot → no delta arg). */
export function getReplayWatermark(eventType: RowEventType): string | undefined {
  return watermarks.get(eventType);
}

/** Raise the module watermark for `eventType` to the maximum `updatedAt`
 *  RFC3339 string currently held in the store. Lexicographic max ==
 *  chronological max for the pipeline's normalized stamps. Monotonic (never
 *  lowers) and idempotent — safe to call on every epoch change and from test
 *  resets. Returns the (possibly unchanged) watermark. */
export function advanceReplayWatermark(
  eventType: RowEventType,
  rows: ReadonlyMap<string, WatermarkRow>,
): string | undefined {
  let max = watermarks.get(eventType);
  for (const row of rows.values()) {
    const ts = row.updatedAt;
    if (ts !== undefined && ts !== null && ts !== '' && (max === undefined || ts > max)) {
      max = ts;
    }
  }
  if (max !== undefined) {
    watermarks.set(eventType, max);
  }
  return max;
}

/** Test-only reset — clears the module-scoped watermark state. */
export function resetReplayWatermarksForTests(): void {
  watermarks.clear();
}

/**
 * Build the replay args for one event type at mount.
 *
 * - Always bounds the snapshot to a recent window (`startedAtNs >= cutoffNs`).
 * - On a warm reopen (non-empty watermark) additionally bounds it to rows the
 *   store does NOT yet hold (`updatedAt > watermark`) — the delta-only drain.
 *
 * The returned object is meant to be captured mount-stably (a `useMemo([])`)
 * so `stableArgsKey` never changes across renders.
 *
 * NULL-`startedAtNs` policy (ST-4-R2c): rows with no span start are the
 * mock/edge-only class (real rows always carry `telemetry_spans.start_time_ns`
 * via the classifier). A time-bounded read has no place for timeless rows — the
 * `>=` bound excludes them (SQL NULL semantics + the registry's
 * null-never-matches rule), which is the intended behavior; the drawer's
 * start-time fallback for a NULL-start row exists in useSessionHistory
 * (falls back to `updatedAt`).
 */
export function buildReplayArgs(eventType: RowEventType, cutoffNs: number): RowArgs {
  const args: RowArgs = { startedAtNs: { op: '>=', value: cutoffNs } };
  const watermark = getReplayWatermark(eventType);
  if (watermark !== undefined) {
    args.updatedAt = { op: '>', value: watermark };
  }
  return args;
}
