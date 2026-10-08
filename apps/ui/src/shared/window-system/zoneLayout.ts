/**
 * Zone layout — pure, DOM-free types + zone math (Spec #2980 ST-1).
 *
 * This is the single shared-state PRODUCER for the zone model that replaces the
 * retired #2949 nine-region arrangement: it owns the zone types
 * (`Zone`/`ZoneLayout`/`ZoneAssignment`/`ZoneLayoutSnapshot`) and every pure rule
 * the store, the editor, the overlay and the renderers share. It mirrors
 * `paneLayout.ts` / `windowGeometry.ts` — no DOM, no React, no Tauri, no store
 * state — so the math is unit-testable in isolation and has exactly ONE
 * implementation.
 *
 * Geometry model: a zone rect is a FRACTION of the measured workspace
 * (`0..1`), so a layout defined on a large display scales to a small one. The
 * rendered pane rect is derived at paint time by `resolveZoneRect`, which applies
 * the px `gap` as a half-gap inset per edge and clamps the pane to
 * `MIN_WIDTH × MIN_HEIGHT`. Nothing here produces or persists px geometry — the
 * persisted payload holds ids + fractions + numbers only (never a `WindowEntry`).
 *
 * The activation chord is MODIFIER-ONLY (pure modifier keydowns are rejected by
 * the hotkey engine's `normalizeKeyStroke`), so `matchesZoneChord` reads the
 * pointer event's modifier flags and reuses the engine's
 * `resolvePrimaryModifier` for the platform-neutral `primary` token. This module
 * adds no keydown listener and does not touch the keymap engine.
 */

import { resolvePrimaryModifier } from '../hotkeys/keys';
import type { Platform } from '../hotkeys/types';
import { MIN_HEIGHT, MIN_WIDTH } from './windowGeometry';

// ── Template + chord vocabulary ───────────────────────────────────────────────

/** The zone-layout templates a user can start from. `custom` starts empty. */
export type ZoneTemplateId = 'columns' | 'rows' | 'grid' | 'main-side' | 'custom';

/** The modifier chords that activate zone-drag (never a printable key). */
export type ZoneActivationChord =
  | 'alt'
  | 'primary'
  | 'primary+alt'
  | 'primary+shift'
  | 'alt+shift';

/** The canonical ordered chord list (settings select / test iteration). */
export const ZONE_ACTIVATION_CHORDS: readonly ZoneActivationChord[] = [
  'alt',
  'primary',
  'primary+alt',
  'primary+shift',
  'alt+shift',
];

// ── Geometry + layout types ───────────────────────────────────────────────────

/** A zone rect as a fraction of the workspace (`0..1`). */
export interface FractionalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One zone in a layout. `id` is unique WITHIN its layout. */
export interface Zone {
  id: string;
  rect: FractionalRect;
}

/** A named zone layout (template + its zones). */
export interface ZoneLayout {
  id: string;
  name: string;
  template: ZoneTemplateId;
  zones: Zone[];
}

/** A window placed into one zone of one layout. */
export interface ZoneAssignment {
  windowId: string;
  layoutId: string;
  zoneId: string;
}

/** Optional template parameters (counts for columns/rows/grid, main split). */
export interface TemplateParams {
  columns?: number;
  rows?: number;
  mainFraction?: number;
}

/** A measured workspace rect in viewport coordinates (px). */
export interface WorkspaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The measured workspace (viewport-relative). */
export interface WorkspaceSize {
  width: number;
  height: number;
}

/** A resolved pane rect in workspace-local px. */
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Persistence constants ─────────────────────────────────────────────────────

/** The single settings key that owns the zone document. */
export const ZONE_LAYOUT_KEY = 'Fredo_layout_zones';
/** The LEGACY #2949 key — read never; best-effort purged (NOT migrated). */
export const LEGACY_WORKSPACE_LAYOUT_KEY = 'Fredo_workspace_layout';
/** The current zone document schema version (the migration field). */
export const ZONE_LAYOUT_VERSION = 1;
/** Default px gap between zones. */
export const DEFAULT_ZONE_GAP = 8;
/** Minimum px gap (0 = flush zones). */
export const MIN_ZONE_GAP = 0;
/** Maximum px gap. */
export const MAX_ZONE_GAP = 32;
/** Default activation chord. */
export const DEFAULT_ZONE_CHORD: ZoneActivationChord = 'alt';

/** Fallback workspace for pre-layout / unmeasured callers (jsdom, first paint). */
export const FALLBACK_WORKSPACE: WorkspaceSize = { width: 1280, height: 800 };

/** The persisted zone document (JSON under `ZONE_LAYOUT_KEY`). */
export interface PersistedZoneLayout {
  version: typeof ZONE_LAYOUT_VERSION;
  enabled: boolean;
  activeLayoutId: string | null;
  layouts: ZoneLayout[];
  gap: number;
  chord: ZoneActivationChord;
  assignments: ZoneAssignment[];
}

/** Default template counts (settings/editor clamp their own UI ranges). */
const DEFAULT_COLUMNS = 2;
const DEFAULT_ROWS = 2;
/** Main fraction bounds for the `main-side` template. */
const DEFAULT_MAIN_FRACTION = 0.6;
const MIN_MAIN_FRACTION = 0.1;
const MAX_MAIN_FRACTION = 0.9;
/** Split fractions are clamped to keep both children non-degenerate. */
const MIN_SPLIT_FRACTION = 0.05;
const MAX_SPLIT_FRACTION = 0.95;

// ── Gap ───────────────────────────────────────────────────────────────────────

/**
 * Clamp a gap to the accepted px range. A non-finite value falls back to
 * `DEFAULT_ZONE_GAP`; the result is always within `[MIN_ZONE_GAP, MAX_ZONE_GAP]`.
 */
export function clampZoneGap(gap: number): number {
  if (typeof gap !== 'number' || !Number.isFinite(gap)) return DEFAULT_ZONE_GAP;
  return Math.min(MAX_ZONE_GAP, Math.max(MIN_ZONE_GAP, gap));
}

// ── Template builders ─────────────────────────────────────────────────────────

/** A finite, positive integer count, clamped to at least 1. */
function count(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** A finite main fraction within the supported bounds. */
function mainFraction(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAIN_FRACTION;
  return Math.min(MAX_MAIN_FRACTION, Math.max(MIN_MAIN_FRACTION, value));
}

/**
 * Build the zones for a template. Zone ids are deterministic
 * (`zone-0`, `zone-1`, …) so the editor preview and tests are stable.
 * `custom` has no preset shape and starts EMPTY — the user adds zones by
 * splitting (`splitZone`).
 */
export function buildTemplateZones(t: ZoneTemplateId, p: TemplateParams = {}): Zone[] {
  switch (t) {
    case 'columns': {
      const columns = count(p.columns, DEFAULT_COLUMNS);
      const width = 1 / columns;
      return Array.from({ length: columns }, (_, i) => ({
        id: `zone-${i}`,
        rect: { x: i * width, y: 0, width, height: 1 },
      }));
    }
    case 'rows': {
      const rows = count(p.rows, DEFAULT_ROWS);
      const height = 1 / rows;
      return Array.from({ length: rows }, (_, i) => ({
        id: `zone-${i}`,
        rect: { x: 0, y: i * height, width: 1, height },
      }));
    }
    case 'grid': {
      const columns = count(p.columns, DEFAULT_COLUMNS);
      const rows = count(p.rows, DEFAULT_ROWS);
      const width = 1 / columns;
      const height = 1 / rows;
      const zones: Zone[] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          zones.push({
            id: `zone-${row * columns + col}`,
            rect: { x: col * width, y: row * height, width, height },
          });
        }
      }
      return zones;
    }
    case 'main-side': {
      const fraction = mainFraction(p.mainFraction);
      return [
        { id: 'zone-0', rect: { x: 0, y: 0, width: fraction, height: 1 } },
        { id: 'zone-1', rect: { x: fraction, y: 0, width: 1 - fraction, height: 1 } },
      ];
    }
    case 'custom':
    default:
      return [];
  }
}

/**
 * Split `zoneId` in two along `axis` at `fraction` (the fraction belonging to the
 * FIRST child). `horizontal` produces two side-by-side children (left/right);
 * `vertical` produces two stacked children (top/bottom). The split zone is
 * replaced IN PLACE (order preserved), so every other zone is untouched.
 *
 * New child ids are derived deterministically from the parent id
 * (`<id>-a` / `<id>-b`), so repeated splits never collide. An unknown `zoneId`
 * returns the SAME array reference (callers can treat reference equality as a
 * no-op). The fraction is clamped to keep both children non-degenerate.
 */
export function splitZone(
  zones: Zone[],
  zoneId: string,
  axis: 'horizontal' | 'vertical',
  fraction: number,
): Zone[] {
  const index = zones.findIndex((zone) => zone.id === zoneId);
  if (index < 0) return zones;
  const target = zones[index];
  const raw = typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : 0.5;
  const f = Math.min(MAX_SPLIT_FRACTION, Math.max(MIN_SPLIT_FRACTION, raw));
  const { x, y, width, height } = target.rect;

  const first: Zone = {
    id: `${zoneId}-a`,
    rect:
      axis === 'horizontal'
        ? { x, y, width: width * f, height }
        : { x, y, width, height: height * f },
  };
  const second: Zone = {
    id: `${zoneId}-b`,
    rect:
      axis === 'horizontal'
        ? { x: x + width * f, y, width: width * (1 - f), height }
        : { x, y: y + height * f, width, height: height * (1 - f) },
  };

  const next = zones.slice();
  next.splice(index, 1, first, second);
  return next;
}

// ── Rendering math ────────────────────────────────────────────────────────────

/** Resolve a measured (or fallback) workspace size. */
function measuredWorkspace(workspace: WorkspaceSize | null): WorkspaceSize {
  if (!workspace || workspace.width <= 0 || workspace.height <= 0) {
    return FALLBACK_WORKSPACE;
  }
  return workspace;
}

/**
 * Resolve a pane rect for `zone` against the measured workspace.
 *
 * `x = zx*W + gap/2`, `y = zy*H + gap/2`, `width = zw*W - gap`,
 * `height = zh*H - gap`, then clamped to at least `MIN_WIDTH × MIN_HEIGHT`
 * (320×200). `null`/degenerate measurements use `FALLBACK_WORKSPACE`.
 */
export function resolveZoneRect(
  ws: WorkspaceSize | null,
  zone: Zone,
  gap: number,
): Geometry {
  const workspace = measuredWorkspace(ws);
  const g = clampZoneGap(gap);
  const rect = zone.rect;
  const width = Math.max(MIN_WIDTH, rect.width * workspace.width - g);
  const height = Math.max(MIN_HEIGHT, rect.height * workspace.height - g);
  return {
    x: rect.x * workspace.width + g / 2,
    y: rect.y * workspace.height + g / 2,
    width,
    height,
  };
}

/**
 * The zone id containing the workspace-local point `(x, y)`, or `null` when the
 * point is in an inter-zone gap or outside every zone. The LAST matching zone
 * wins, so when zones overlap the topmost (later) one is reported. Zone rects
 * are compared as their resolved px rects (gap-inset), so a pointer in the
 * gutter between two zones resolves to `null` — the no-zone release path.
 */
export function zoneAtPoint(
  ws: WorkspaceSize | null,
  zones: Zone[],
  gap: number,
  x: number,
  y: number,
): string | null {
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    const zone = zones[i];
    const rect = resolveZoneRect(ws, zone, gap);
    if (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    ) {
      return zone.id;
    }
  }
  return null;
}

// ── Activation chord matching ─────────────────────────────────────────────────

/**
 * True when the pointer event's modifier flags exactly match `chord` on
 * `platform`. Matching is EXACT: a chord matches only when every modifier it
 * names is held AND no other modifier (the non-primary ctrl/meta, alt, shift) is
 * held, so `primary` does not match `primary+alt`.
 *
 * `primary` is the platform-neutral primary modifier (Ctrl on win32/linux, Meta
 * on darwin) resolved through the hotkey engine's `resolvePrimaryModifier`, so a
 * chord and the drag gesture agree on what "primary" means with no second rule.
 */
export function matchesZoneChord(
  chord: ZoneActivationChord,
  mods: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean },
  platform?: Platform,
): boolean {
  const primaryMod = resolvePrimaryModifier(platform);
  const primary = primaryMod === 'ctrl' ? mods.ctrl : mods.meta;
  const other = primaryMod === 'ctrl' ? mods.meta : mods.ctrl;

  switch (chord) {
    case 'alt':
      return mods.alt && !primary && !other && !mods.shift;
    case 'primary':
      return primary && !other && !mods.alt && !mods.shift;
    case 'primary+alt':
      return primary && !other && mods.alt && !mods.shift;
    case 'primary+shift':
      return primary && !other && !mods.alt && mods.shift;
    case 'alt+shift':
      return !primary && !other && mods.alt && mods.shift;
    default:
      return false;
  }
}
