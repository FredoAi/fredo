/**
 * Spec #3120 (rework) ST-2 — the pure companion target resolution.
 *
 * The instruction box grounds every turn on the app it is aimed at. This module
 * is the ONE decision (no React, no DOM, no Tauri), so the default target, the
 * named override and the "ground on describeContext" contract are unit-pinned
 * without a harness:
 *
 *   default target  : requestedAppId → topmost frame containing the landing
 *                     point → the standalone window's app → the focused window
 *                     → null (order is BINDING — Architect's names block).
 *   named override  : whole-word, case-insensitive, longest match over an app's
 *                     `name` and `id`; `null` on 0 matches or on 2+ DISTINCT
 *                     apps tying at the longest match (ambiguous).
 *
 * `ContextEnvelope` is a TYPE-ONLY import (the envelope is built by the caller
 * through `describeContext`), so this file stays pure and free of the navigation
 * host runtime.
 */

import type { ContextEnvelope } from '../navigation/types';
import type { ReplyRect } from '../components/companion/replySurfaceLayout';

/** The app metadata target resolution needs (never the application instance). */
export interface FredoAppRef {
  readonly id: string;
  readonly name: string;
  readonly showable: boolean;
}

/** One in-window app frame, in viewport px. Frames are supplied low z → high z. */
export interface CompanionTargetFrame {
  readonly appId: string;
  readonly rect: ReplyRect;
}

export interface CompanionTargetInput {
  /** A bridge request (command-bar Ask) names the app explicitly. */
  readonly requestedAppId?: string | null;
  /** A standalone app window's own `data-fredo-app-id`. */
  readonly windowAppId?: string | null;
  /** In-window app frames, LOW z → HIGH z (the last one is topmost). */
  readonly frames?: readonly CompanionTargetFrame[];
  /** Fredo's landing centre (viewport px). */
  readonly point?: { readonly x: number; readonly y: number } | null;
  /** The focused, non-minimized application window. */
  readonly focusedAppId?: string | null;
}

/** The resolved grounding target of one composer turn. */
export interface CompanionTurnTarget {
  readonly appId: string | null;
  readonly appName: string | null;
  /** `describeContext(appId)`; `null` when the app is unregistered / no app. */
  readonly envelope: ContextEnvelope | null;
  /** True when a named app overrode the default target. */
  readonly explicit: boolean;
}

function normalizeAppId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Half-open rectangle containment: bottom/right edges belong to the outside. */
function rectContains(rect: ReplyRect, point: { x: number; y: number }): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= rect.left &&
    point.x < rect.right &&
    point.y >= rect.top &&
    point.y < rect.bottom
  );
}

/**
 * BINDING resolution order:
 * `requestedAppId` → topmost frame containing the point → `windowAppId` →
 * `focusedAppId` → `null`.
 */
export function resolveCompanionTargetApp(input: CompanionTargetInput): string | null {
  const requested = normalizeAppId(input.requestedAppId);
  if (requested !== null) return requested;

  const point = input.point ?? null;
  if (point !== null && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    const frames = input.frames ?? [];
    // Frames arrive low z → high z; the TOPMOST containing frame wins.
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index];
      if (frame !== undefined && rectContains(frame.rect, point)) return frame.appId;
    }
  }

  const windowAppId = normalizeAppId(input.windowAppId);
  if (windowAppId !== null) return windowAppId;

  return normalizeAppId(input.focusedAppId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive containment. A "word" character is
 * ASCII-alphanumeric; every other character (space, dash, dot) is a boundary, so
 * `Mission Monitor` matches in "open mission monitor now" and an id such as
 * `mission-monitor` matches too.
 */
function containsWholeWord(text: string, term: string): boolean {
  const trimmed = term.trim();
  if (trimmed === '') return false;
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(trimmed)}([^A-Za-z0-9]|$)`, 'i');
  return pattern.test(text);
}

/**
 * Resolve a typed app mention. Only `showable` apps are candidates (an
 * unregistered/non-showable app must never become a grounding target).
 *
 * Returns the app id when exactly ONE distinct app owns the longest whole-word
 * match over its `name` or `id`; `null` for 0 matches, for 2+ distinct apps tying
 * at that longest match, and for a partial (non-whole-word) mention.
 */
export function resolveNamedAppMention(
  text: string,
  apps: readonly FredoAppRef[],
): string | null {
  const query = text.trim();
  if (query === '') return null;

  const longestByApp = new Map<string, number>();
  for (const app of apps) {
    if (!app.showable) continue;
    for (const term of [app.name, app.id]) {
      if (!containsWholeWord(query, term)) continue;
      const length = term.trim().length;
      const previous = longestByApp.get(app.id) ?? -1;
      if (length > previous) longestByApp.set(app.id, length);
    }
  }

  if (longestByApp.size === 0) return null;
  let longest = -1;
  for (const length of longestByApp.values()) {
    if (length > longest) longest = length;
  }
  const winners: string[] = [];
  for (const [appId, length] of longestByApp) {
    if (length === longest) winners.push(appId);
  }
  return winners.length === 1 ? (winners[0] ?? null) : null;
}
