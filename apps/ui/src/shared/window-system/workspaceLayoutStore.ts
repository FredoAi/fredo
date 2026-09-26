/**
 * WorkspaceLayoutStore — the single module-scoped source of truth for the tiled
 * workspace arrangement (Spec #2949 ST-1).
 *
 * Every consumer (the tiling renderer, the toolbar, the settings surface) reads
 * through `useWorkspaceLayout()` / `getLayoutSnapshot()` and mutates through the
 * exported actions, so the arrangement is ONE authoritative registry (never a
 * second copy in `windowStore`/`WindowEntry` — those stay geometry-free). The
 * module scope is deliberate: the arrangement must survive a
 * `WindowManager`/Home remount and close-all-reopen (mirrors
 * `dockPositionStore.ts` + `windowStore.ts:19-47`).
 *
 * Persistence (R8/R14): the arrangement is stored as versioned JSON under the
 * SINGLE key `Fredo_workspace_layout` via `settingsService`
 * (Tauri `save_setting`/`get_setting` → AppStore SQLite KV + a localStorage
 * mirror). Only ids + px rects are persisted — never a `WindowEntry` (its
 * `icon`/`component` are `ReactNode`, non-serializable). Writes are debounced
 * and SUPPRESSED during a gesture (`dragging`), so a live resize never spams the
 * store and persists exactly once on release. Hydration is once-only and
 * dirty-guarded, so an in-flight read can never clobber a user write.
 */

import { useSyncExternalStore } from 'react';

import { settingsService, serializeValue } from '../../features/settings';

import {
  absorbRemovedSlot,
  applyDividerDelta,
  parseDividerId,
  reflowSlots,
  resolveRegionRect,
  PANE_REGIONS,
  type PaneRegion,
  type PaneSlot,
  type SavedLayout,
  type WorkspaceLayoutSnapshot,
} from './paneLayout';
import type { Geometry, WorkspaceSize } from './windowGeometry';
import { focusWindow, getWindowSnapshot } from './windowStore';

/** AppSettings key (backend AppStore SQLite KV + localStorage mirror). */
export const WORKSPACE_LAYOUT_KEY = 'Fredo_workspace_layout';
/** Name used when a save is requested with an empty/whitespace-only name. */
export const DEFAULT_LAYOUT_NAME = 'Default';

/** Persisted schema version (one key, versioned JSON). */
const LAYOUT_VERSION = 1;
/** Coalescing window for persistence — rapid changes write once. */
const PERSIST_DEBOUNCE_MS = 150;
/** Longest accepted saved-layout name. */
const MAX_LAYOUT_NAME_LENGTH = 40;

/** The exact JSON shape under `WORKSPACE_LAYOUT_KEY`. */
interface PersistedWorkspaceLayout {
  version: number;
  activeLayoutId: string | null;
  activeSlots: PaneSlot[];
  savedLayouts: SavedLayout[];
}

/** Measured workspace reported by the renderer (`null` before first layout). */
let workspace: WorkspaceSize | null = null;
/** The stable snapshot handed to `useSyncExternalStore` — new ref only on mutation. */
let snapshot: WorkspaceLayoutSnapshot = {
  activeSlots: [],
  savedLayouts: [],
  activeLayoutId: null,
  dragging: false,
};
const listeners = new Set<() => void>();
/** True once a user mutation happened — a late hydration must never clobber it. */
let dirty = false;
let hydrationStarted = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Sync module read of the current snapshot (stable ref until a mutation). */
export function getLayoutSnapshot(): WorkspaceLayoutSnapshot {
  return snapshot;
}

/** Subscribe to arrangement changes (useSyncExternalStore listener contract). */
export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding — re-renders consumers on every real arrangement mutation. */
export function useWorkspaceLayout(): WorkspaceLayoutSnapshot {
  return useSyncExternalStore(subscribeLayout, getLayoutSnapshot, getLayoutSnapshot);
}

/**
 * Report the measured workspace (the renderer's container size). Region
 * placements (`addPane`/`movePane`) resolve against this; `null`/degenerate
 * uses `FALLBACK_WORKSPACE`. Not part of the snapshot — no re-render.
 */
export function setLayoutWorkspace(size: WorkspaceSize | null): void {
  workspace = size && size.width > 0 && size.height > 0 ? size : null;
}

/** Sync read of the last reported workspace (tests / renderers). */
export function getLayoutWorkspace(): WorkspaceSize | null {
  return workspace;
}

// ── Mutation plumbing ─────────────────────────────────────────────────────────

function commit(patch: Partial<WorkspaceLayoutSnapshot>): void {
  dirty = true;
  snapshot = { ...snapshot, ...patch };
  notify();
  schedulePersist();
}

/** Debounced, gesture-suppressed best-effort write. */
function schedulePersist(): void {
  if (snapshot.dragging) {
    // A gesture persists only on end. Cancel any timer scheduled just BEFORE
    // the gesture began, so a structural change made moments earlier can never
    // fire a write MID-gesture (R5/R14: never persist during a gesture). The
    // gesture-end `commit` re-schedules the single write with the final state.
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    return;
  }
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (snapshot.dragging) return; // defensive: never write mid-gesture
    writePersisted();
  }, PERSIST_DEBOUNCE_MS);
}

/** Schedule the debounced persistence write (exported for callers that opt in). */
export function persistWorkspaceLayout(): void {
  schedulePersist();
}

function writePersisted(): void {
  const payload: PersistedWorkspaceLayout = {
    version: LAYOUT_VERSION,
    activeLayoutId: snapshot.activeLayoutId,
    activeSlots: snapshot.activeSlots,
    savedLayouts: snapshot.savedLayouts,
  };
  try {
    // Best-effort: settingsService already swallows its own transport failures,
    // but a synchronous throw or rejected promise must never reach the caller.
    void settingsService.set(WORKSPACE_LAYOUT_KEY, serializeValue(payload)).catch(() => {});
  } catch {
    // Persistence is best-effort — the in-memory arrangement is authoritative.
  }
}

// ── Layout actions ────────────────────────────────────────────────────────────

/**
 * Place an open window in the workspace (R2). One pane per `windowId` — a
 * repeat call is a no-op. If the resolved region rect would overlap an existing
 * pane (e.g. a second `center` pane), all panes are reflowed into a clean grid.
 */
export function addPane(windowId: string, region: PaneRegion = 'center'): void {
  if (snapshot.activeSlots.some((slot) => slot.windowId === windowId)) return;
  const existing = snapshot.activeSlots;
  const rect = resolveRegionRect(workspace, region, existing);
  let next: PaneSlot[] = [...existing, { windowId, region, rect }];
  if (overlapsAny(rect, existing)) {
    next = reflowSlots(workspace, next);
  }
  commit({ activeSlots: next, activeLayoutId: null });
}

/**
 * Drop a window's pane (R10). The freed space REFLOWS into the adjacent sibling
 * (`absorbRemovedSlot`) so the remaining panes stay a valid tiled arrangement —
 * no overlap, no orphan divider. Removing the last pane clears the arrangement
 * (the workspace returns to the plain desktop).
 */
export function removePane(windowId: string): void {
  const removed = snapshot.activeSlots.find((slot) => slot.windowId === windowId);
  if (!removed) return;
  const remaining = snapshot.activeSlots.filter((slot) => slot.windowId !== windowId);
  commit({
    activeSlots: absorbRemovedSlot(workspace, removed, remaining),
    activeLayoutId: null,
  });
}

/**
 * Re-place a pane in `region` (R3). The REQUESTED region is AUTHORITATIVE for
 * the moved pane: it receives the full requested band (`resolveRegionRect`),
 * never a `nearestRegion` rewrite or an index repartition — the round-1 defect
 * was that any overlap (always true at ≥2 panes) discarded the request.
 *
 * Siblings are re-homed around it in ORIGINAL slot order, each keeping its own
 * region string; when a sibling's own band is fully claimed by the moved pane
 * it is re-homed into the largest free area instead. `reflowSlots` is only the
 * DEGENERATE fallback (a fully-claimed workspace), and the moved pane's region
 * is re-stamped to the requested value rather than a computed `nearestRegion`.
 * The commit preserves the ORIGINAL `activeSlots` order (mapped by `windowId`).
 */
export function movePane(windowId: string, region: PaneRegion): void {
  const existing = snapshot.activeSlots;
  const index = existing.findIndex((slot) => slot.windowId === windowId);
  if (index < 0) return;
  const others = existing.filter((_, i) => i !== index);

  // `center` IS the whole workspace (`paneLayout.ts`): narrow it against the
  // siblings so they stay placeable. Every other region is the moved pane's
  // requested home regardless of what it currently overlaps.
  const movedRect = resolveRegionRect(workspace, region, region === 'center' ? others : []);
  const placed: PaneSlot[] = [{ windowId, region, rect: movedRect }];

  for (const sibling of others) {
    let rect = resolveRegionRect(workspace, sibling.region, placed);
    if (overlapsAny(rect, placed)) {
      // The sibling's own band is claimed by the moved pane (e.g. both request
      // `right`) → re-home it into the largest free area, preserving its region.
      rect = resolveRegionRect(workspace, 'center', placed);
    }
    if (overlapsAny(rect, placed)) {
      // Fully-claimed workspace → degenerate fallback: repartition cleanly and
      // re-stamp the moved pane's region to the REQUESTED value.
      const repartitioned = reflowSlots(workspace, existing).map((slot) =>
        slot.windowId === windowId ? { ...slot, region } : slot,
      );
      commit({ activeSlots: repartitioned, activeLayoutId: null });
      return;
    }
    placed.push({ windowId: sibling.windowId, region: sibling.region, rect });
  }

  const byId = new Map(placed.map((slot) => [slot.windowId, slot] as const));
  commit({
    activeSlots: existing.map((slot) => byId.get(slot.windowId) ?? slot),
    activeLayoutId: null,
  });
}

/**
 * Enter / extend tiling (R2) — the SINGLE implementation behind BOTH entry
 * points: the workspace toolbar's `workspace-arrange` control and the dock's
 * `dock-arrange` well (AC1). Places EVERY open non-minimized window as a pane,
 * clearing full-bleed so the arrangement is actually visible, and returns the
 * number of panes added. `addPane` is idempotent per window id and reflows
 * overlapping placements, so a repeat call adds nothing.
 */
export function arrangeOpenWindows(): number {
  const before = snapshot.activeSlots.length;
  for (const win of getWindowSnapshot()) {
    if (win.isMinimized) continue;
    if (win.isMaximized) focusWindow(win.id, { maximize: false });
    addPane(win.id);
  }
  return snapshot.activeSlots.length - before;
}

/** Live drag frame (R5) — updates the rect without a structural change. */
export function setPaneRect(windowId: string, rect: Geometry): void {
  const index = snapshot.activeSlots.findIndex((slot) => slot.windowId === windowId);
  if (index < 0) return;
  const next = snapshot.activeSlots.slice();
  next[index] = { ...next[index], rect };
  commit({ activeSlots: next });
}

/** Enter a move/resize gesture (R5): suppresses persistence until `end`. */
export function beginLayoutGesture(): void {
  if (snapshot.dragging) return;
  commit({ dragging: true });
}

/** End a gesture (R5/R14): clears `dragging` and schedules the single write. */
export function endLayoutGesture(): void {
  if (!snapshot.dragging) return;
  commit({ dragging: false });
}

/** Resize the two panes around a divider (R4/R12); combined extent constant. */
export function resizeViaDivider(dividerId: string, deltaPx: number): void {
  const divider = parseDividerId(dividerId);
  if (!divider) return;
  const next = applyDividerDelta(snapshot.activeSlots, divider, deltaPx);
  if (next === snapshot.activeSlots) return;
  commit({ activeSlots: next });
}

// ── Named layouts (v1: save / restore / delete) ───────────────────────────────

/** Snapshot the current arrangement under `name` and return the new layout (R6). */
export function saveLayout(name: string): SavedLayout {
  const trimmed = name.trim().slice(0, MAX_LAYOUT_NAME_LENGTH);
  const layout: SavedLayout = {
    id: makeLayoutId(),
    name: trimmed.length > 0 ? trimmed : DEFAULT_LAYOUT_NAME,
    slots: cloneSlots(snapshot.activeSlots),
  };
  commit({
    savedLayouts: [...snapshot.savedLayouts, layout],
    activeLayoutId: layout.id,
  });
  return layout;
}

/** Replace the active arrangement with a saved one (R7); unknown id = no-op. */
export function restoreLayout(layoutId: string): void {
  const layout = snapshot.savedLayouts.find((entry) => entry.id === layoutId);
  if (!layout) return;
  commit({ activeSlots: cloneSlots(layout.slots), activeLayoutId: layoutId });
}

/** Remove a saved layout; clears `activeLayoutId` when it pointed at it. */
export function deleteLayout(layoutId: string): void {
  const next = snapshot.savedLayouts.filter((entry) => entry.id !== layoutId);
  if (next.length === snapshot.savedLayouts.length) return;
  commit({
    savedLayouts: next,
    activeLayoutId: snapshot.activeLayoutId === layoutId ? null : snapshot.activeLayoutId,
  });
}

// ── Hydration ─────────────────────────────────────────────────────────────────

/**
 * Hydrate the arrangement from the persisted key. Idempotent + runs ONCE (module
 * scope, not per-consumer-mount) and never overwrites an in-flight user write.
 */
export async function hydrateWorkspaceLayout(): Promise<void> {
  if (hydrationStarted) return;
  hydrationStarted = true;
  try {
    const stored = await settingsService.get<PersistedWorkspaceLayout | null>(
      WORKSPACE_LAYOUT_KEY,
      null,
      parsePersistedLayout,
    );
    if (dirty || !stored) return;
    snapshot = {
      activeSlots: cloneSlots(stored.activeSlots),
      savedLayouts: stored.savedLayouts.map(cloneLayout),
      activeLayoutId: stored.activeLayoutId,
      dragging: false,
    };
    notify();
  } catch {
    // Tauri absent / read failure → stay on the empty default (no crash).
  }
}

/** Options for `reopenHydratedSlots` — injected so the boot path stays testable
 *  without importing the feature registry (`Home.tsx` supplies the production
 *  values: its full-lifecycle `openFeatureWindow` + the kernel `updateWindow`). */
export interface ReopenHydratedSlotsOptions<F extends { id: string }> {
  /** Every registered feature — the reopen only touches REGISTERED ids (R9). */
  features: readonly F[];
  /** Full-lifecycle open (Home's `openFeatureWindow`). */
  open: (id: string, feature: F) => void;
  /** Kernel patch — un-maximizes the freshly-opened window so it tiles. */
  update: (id: string, patch: { isMaximized?: boolean }) => void;
}

/**
 * BOOT-HYDRATION ONLY (R8 / AC5): reopen the windows the hydrated arrangement
 * names so they land directly as panes instead of rendering as degraded
 * "App not available" placeholders. Every slot id that (a) resolves to a
 * REGISTERED feature and (b) is not already open is opened through the
 * full-lifecycle `open` callback and immediately un-maximized, so it tiles into
 * its already-hydrated slot instead of covering the workspace full-bleed.
 *
 * Ids that resolve to no registered feature are SKIPPED — the existing
 * degraded-slot path renders them (R9). This MUST only be called from the boot
 * hydration caller: an explicit `restoreLayout` never reopens, so a closed app
 * keeps degrading gracefully (F-9 invariant).
 */
export function reopenHydratedSlots<F extends { id: string }>(
  options: ReopenHydratedSlotsOptions<F>,
): void {
  const openIds = new Set(getWindowSnapshot().map((win) => win.id));
  for (const slot of snapshot.activeSlots) {
    if (openIds.has(slot.windowId)) continue;
    const feature = options.features.find((entry) => entry.id === slot.windowId);
    if (!feature) continue;
    options.open(feature.id, feature);
    openIds.add(feature.id);
    options.update(feature.id, { isMaximized: false });
  }
}

/** Test-only: wipe the module-scoped store. Never call from app code. */
export function resetWorkspaceLayoutStoreForTests(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  workspace = null;
  snapshot = {
    activeSlots: [],
    savedLayouts: [],
    activeLayoutId: null,
    dragging: false,
  };
  dirty = false;
  hydrationStarted = false;
  listeners.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function overlapsAny(rect: Geometry, slots: PaneSlot[]): boolean {
  return slots.some((slot) => rectsOverlap(rect, slot.rect));
}

function rectsOverlap(a: Geometry, b: Geometry): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5
  );
}

function cloneSlots(slots: PaneSlot[]): PaneSlot[] {
  return slots.map((slot) => ({ ...slot, rect: { ...slot.rect } }));
}

function cloneLayout(layout: SavedLayout): SavedLayout {
  return { ...layout, slots: cloneSlots(layout.slots) };
}

function makeLayoutId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `layout-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRegion(value: unknown): value is PaneRegion {
  return (
    typeof value === 'string' && (PANE_REGIONS as readonly string[]).includes(value)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isGeometry(value: unknown): value is Geometry {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height)
  );
}

function isPaneSlot(value: unknown): value is PaneSlot {
  if (!value || typeof value !== 'object') return false;
  const slot = value as Record<string, unknown>;
  return (
    typeof slot.windowId === 'string' &&
    slot.windowId.length > 0 &&
    isRegion(slot.region) &&
    isGeometry(slot.rect)
  );
}

function isSavedLayout(value: unknown): value is SavedLayout {
  if (!value || typeof value !== 'object') return false;
  const layout = value as Record<string, unknown>;
  return (
    typeof layout.id === 'string' &&
    typeof layout.name === 'string' &&
    Array.isArray(layout.slots) &&
    layout.slots.every(isPaneSlot)
  );
}

/**
 * Tolerant deserializer: a corrupt or unknown `version` degrades to `null`
 * (clean workspace, no crash). Unknown/removed `windowId`s are KEPT in their
 * slots (R9) — the renderer decides whether to degrade them; siblings keep
 * their exact rects.
 */
function parsePersistedLayout(raw: string): PersistedWorkspaceLayout | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    // Unknown / corrupt schema version → clean workspace (never misread a
    // future shape). Only the documented v1 payload is accepted (R8).
    if (value.version !== LAYOUT_VERSION) return null;
    const activeSlots = Array.isArray(value.activeSlots)
      ? value.activeSlots.filter(isPaneSlot)
      : [];
    const savedLayouts = Array.isArray(value.savedLayouts)
      ? value.savedLayouts.filter(isSavedLayout)
      : [];
    const activeLayoutId =
      typeof value.activeLayoutId === 'string' ? value.activeLayoutId : null;
    return { version: LAYOUT_VERSION, activeLayoutId, activeSlots, savedLayouts };
  } catch {
    return null;
  }
}
