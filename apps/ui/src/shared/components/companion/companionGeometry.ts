/**
 * #2886 ST-4 — the module-scoped companion geometry registry (the #2870 ST-2c
 * pattern).
 *
 * `LauncherShell` measures the reply placement region (safeTop / barrierTop,
 * with the command-bar box AND the app-tiles grid folded into `barrierTop`, plus
 * the launcher column's clip box) in ONE rAF pass. The AWAY overlay is rendered
 * by `main.tsx` at the app root — OUTSIDE `LauncherShell` — so the measured
 * region cannot reach it as a prop. This registry is that channel: module-scoped
 * (per webview by construction, exactly one launcher per window), idempotent
 * (publishing the same snapshot twice is a no-op for readers; `null` clears), and
 * it never participates in React state — the launcher publishes it from its
 * existing measurement effect, and the overlay reads it when it renders.
 */
import type { ReplyRegion } from './replySurfaceLayout';

export interface CompanionGeometrySnapshot {
  /** The launcher-measured band (viewport px), tiles folded into `barrierTop`. */
  region: ReplyRegion;
  /** The viewport the region was measured against. */
  viewport: { width: number; height: number };
}

let launcherRegion: CompanionGeometrySnapshot | null = null;

/** Publish (or clear, with `null`) the launcher-measured region for this webview. */
export function publishLauncherRegion(snapshot: CompanionGeometrySnapshot | null): void {
  launcherRegion = snapshot;
}

/** The last published launcher region, or `null` when no launcher measured one. */
export function getLauncherRegion(): CompanionGeometrySnapshot | null {
  return launcherRegion;
}
