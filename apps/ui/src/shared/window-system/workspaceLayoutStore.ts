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

/** Drop a window's pane (R10) — the renderer reflows remaining siblings. */
export function removePane(windowId: string): void {
  const next = snapshot.activeSlots.filter((slot) => slot.windowId !== windowId);
  if (next.length === snapshot.activeSlots.length) return;
  commit({ activeSlots: next, activeLayoutId: null });
}

/** Re-place a pane in `region` (R3). Overlap is resolved by a clean reflow. */
export function movePane(windowId: string, region: PaneRegion): void {
  const existing = snapshot.activeSlots;
  const index = existing.findIndex((slot) => slot.windowId === windowId);
  if (index < 0) return;
  const others = existing.filter((_, i) => i !== index);
  const rect = resolveRegionRect(workspace, region, others);
  let next = existing.map((slot) =>
    slot.windowId === windowId ? { windowId, region, rect } : slot,
  );
  if (overlapsAny(rect, others)) {
    next = reflowSlots(workspace, next);
  }
  commit({ activeSlots: next, activeLayoutId: null });
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
