/**
 * ZoneLayoutStore — the single module-scoped source of truth for the zone model
 * (Spec #2980 ST-1).
 *
 * Every consumer (the Layout settings section, the layout editor, the zone
 * overlay, the zoned renderer, the chord-drag gesture) reads through
 * `useZoneLayout()` / `getZoneLayoutSnapshot()` and mutates through the exported
 * actions, so the zone configuration is ONE authoritative registry — never a
 * second copy in `windowStore`/`WindowEntry` (those stay geometry-free). The
 * module scope is deliberate: the configuration must survive a
 * `WindowManager`/Home remount and close-all-reopen (mirrors
 * `workspaceLayoutStore.ts` + `appPresentationStore.ts`).
 *
 * Persistence: the document is stored as versioned JSON under the SINGLE key
 * `Fredo_layout_zones` via `settingsService` (Tauri `save_setting`/`get_setting`
 * → AppStore SQLite KV + a localStorage dev mirror). Only ids + fractions +
 * numbers are persisted — never a `WindowEntry` (its `icon`/`component` are
 * `ReactNode`, non-serializable). The legacy `Fredo_workspace_layout` key is
 * best-effort PURGED on first hydrate; it is never migrated. Writes are debounced
 * and suppressed during a drag gesture, so a gesture persists exactly once on
 * release. Hydration is once-only and dirty-guarded, so an in-flight read can
 * never clobber a user write.
 *
 * Rendering contract: the snapshot ref is STABLE until a real mutation. Transient
 * drag fields (`dragActive`/`dragWindowId`/`hoveredZoneId`) change the snapshot
 * only while a gesture is live; a pointer move that does not change the hovered
 * zone does not notify. No array `.length` / freshly-created object refs in
 * effect deps (AGENTS.md #523).
 */

import { useSyncExternalStore } from 'react';

import { settingsService, serializeValue } from '../../features/settings';

import {
  clampZoneGap,
  DEFAULT_ZONE_CHORD,
  DEFAULT_ZONE_GAP,
  LEGACY_WORKSPACE_LAYOUT_KEY,
  ZONE_ACTIVATION_CHORDS,
  ZONE_LAYOUT_KEY,
  ZONE_LAYOUT_VERSION,
  zoneAtPoint,
  type PersistedZoneLayout,
  type WorkspaceRect,
  type Zone,
  type ZoneActivationChord,
  type ZoneAssignment,
  type ZoneLayout,
  type ZoneTemplateId,
} from './zoneLayout';
import { getWindowSnapshot } from './windowStore';

/** Coalescing window for persistence — rapid changes write once. */
const PERSIST_DEBOUNCE_MS = 150;

/** The render-time snapshot the store exposes (stable ref until a mutation). */
export interface ZoneLayoutSnapshot {
  enabled: boolean;
  activeLayoutId: string | null;
  layouts: ZoneLayout[];
  gap: number;
  chord: ZoneActivationChord;
  assignments: ZoneAssignment[];
  /** True only during a chord-drag gesture (transient; never persisted). */
  dragActive: boolean;
  /** The window being dragged (transient; never persisted). */
  dragWindowId: string | null;
  /** The zone under the pointer during a drag (transient; never persisted). */
  hoveredZoneId: string | null;
}

/** Measured workspace reported by the renderer (`null` before first layout). */
let workspace: WorkspaceRect | null = null;
/** Latest pointer position during a drag (transient, not in the snapshot). */
let dragPointer: { x: number; y: number } | null = null;
/** The stable snapshot handed to `useSyncExternalStore` — new ref only on mutation. */
let snapshot: ZoneLayoutSnapshot = {
  enabled: false,
  activeLayoutId: null,
  layouts: [],
  gap: DEFAULT_ZONE_GAP,
  chord: DEFAULT_ZONE_CHORD,
  assignments: [],
  dragActive: false,
  dragWindowId: null,
  hoveredZoneId: null,
};
const listeners = new Set<() => void>();
/** True once a user mutation happened — a late hydration must never clobber it. */
let dirty = false;
let hydrationStarted = false;
let hydrationPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Sync module read of the current snapshot (stable ref until a mutation). */
export function getZoneLayoutSnapshot(): ZoneLayoutSnapshot {
  return snapshot;
}

/** Subscribe to zone-configuration changes (useSyncExternalStore contract). */
export function subscribeZoneLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding — re-renders consumers on every real zone mutation. */
export function useZoneLayout(): ZoneLayoutSnapshot {
  return useSyncExternalStore(subscribeZoneLayout, getZoneLayoutSnapshot, getZoneLayoutSnapshot);
}

/**
 * Report the measured workspace rect (the renderer's container position/size).
 * Used to convert viewport pointer coords into workspace-local coords for
 * `zoneAtPoint`. Not part of the snapshot — no re-render.
 */
export function setZoneLayoutWorkspace(rect: WorkspaceRect | null): void {
  workspace = rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

/** Sync read of the last reported workspace rect (tests / renderers). */
export function getZoneLayoutWorkspace(): WorkspaceRect | null {
  return workspace;
}

// ── Mutation plumbing ─────────────────────────────────────────────────────────

/** A PERSISTENT mutation: marks dirty, notifies, and schedules the write. */
function commitPersistent(patch: Partial<ZoneLayoutSnapshot>): void {
  dirty = true;
  snapshot = { ...snapshot, ...patch };
  notify();
  schedulePersist();
}

/** A TRANSIENT mutation (drag state): notifies, never marks dirty or persists. */
function commitTransient(patch: Partial<ZoneLayoutSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  notify();
}

/** Debounced, gesture-suppressed best-effort write. */
function schedulePersist(): void {
  if (!dirty) return;
  if (snapshot.dragActive) {
    // A gesture persists only on end. Cancel any timer scheduled just BEFORE the
    // gesture began, so a config change made moments earlier can never fire a
    // write MID-gesture; `endZoneDrag`/`cancelZoneDrag` re-arm the single write.
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    return;
  }
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (snapshot.dragActive) return; // defensive: never write mid-gesture
    writePersisted();
  }, PERSIST_DEBOUNCE_MS);
}

function writePersisted(): void {
  const payload: PersistedZoneLayout = {
    version: ZONE_LAYOUT_VERSION,
    enabled: snapshot.enabled,
    activeLayoutId: snapshot.activeLayoutId,
    layouts: snapshot.layouts,
    gap: snapshot.gap,
    chord: snapshot.chord,
    assignments: snapshot.assignments,
  };
  try {
    // Best-effort: settingsService already swallows its own transport failures,
    // but a synchronous throw or rejected promise must never reach the caller.
    void settingsService.set(ZONE_LAYOUT_KEY, serializeValue(payload)).catch(() => {});
  } catch {
    // Persistence is best-effort — the in-memory configuration is authoritative.
  }
}

// ── Configuration actions ─────────────────────────────────────────────────────

/** Enable/disable layout management (AC1/R-1.2). */
export function setZoneLayoutEnabled(enabled: boolean): void {
  if (snapshot.enabled === enabled) return;
  commitPersistent({ enabled });
}

/**
 * Assign the active layout (R-2.3). A `null` target clears the active layout.
 * Assigning a layout with ZERO zones is a NO-OP (R-2.4) — `activeLayoutId` never
 * points at a zero-zone layout — as is an unknown id.
 */
export function setActiveZoneLayout(layoutId: string | null): void {
  if (layoutId === null) {
    if (snapshot.activeLayoutId === null) return;
    commitPersistent({ activeLayoutId: null });
    return;
  }
  if (snapshot.activeLayoutId === layoutId) return;
  const layout = snapshot.layouts.find((entry) => entry.id === layoutId);
  if (!layout || layout.zones.length === 0) return;
  commitPersistent({ activeLayoutId: layoutId });
}

/**
 * Upsert a layout by id (R-2.2). The returned layout is the STORED one — its name
 * is de-duplicated against the other layouts so names stay unique. Saving a
 * zero-zone version of the ACTIVE layout clears the active pointer (R-2.4).
 */
export function saveZoneLayout(layout: ZoneLayout): ZoneLayout {
  const others = snapshot.layouts.filter((entry) => entry.id !== layout.id);
  const stored: ZoneLayout = {
    id: layout.id,
    name: uniqueLayoutName(layout.name, others),
    template: layout.template,
    zones: layout.zones.map(cloneZone),
  };
  const exists = snapshot.layouts.some((entry) => entry.id === stored.id);
  const layouts = exists
    ? snapshot.layouts.map((entry) => (entry.id === stored.id ? stored : entry))
    : [...snapshot.layouts, stored];
  const activeLayoutId =
    stored.zones.length === 0 && snapshot.activeLayoutId === stored.id
      ? null
      : snapshot.activeLayoutId;
  commitPersistent({ layouts, activeLayoutId });
  return stored;
}

/**
 * Delete a layout (R-2.5/AC2). Clears the active pointer and every dependent
 * assignment atomically. An unknown id is a no-op.
 */
export function deleteZoneLayout(layoutId: string): void {
  if (!snapshot.layouts.some((entry) => entry.id === layoutId)) return;
  commitPersistent({
    layouts: snapshot.layouts.filter((entry) => entry.id !== layoutId),
    activeLayoutId: snapshot.activeLayoutId === layoutId ? null : snapshot.activeLayoutId,
    assignments: snapshot.assignments.filter((entry) => entry.layoutId !== layoutId),
  });
}

/**
 * Place a window in `zoneId` of the ACTIVE layout (R-3.2). One zone per window:
 * a repeat call replaces the window's assignment. No-op when there is no active
 * layout or the zone does not belong to it.
 */
export function assignWindowToZone(windowId: string, zoneId: string): void {
  if (!windowId || !zoneId) return;
  const layoutId = snapshot.activeLayoutId;
  if (layoutId === null) return;
  const layout = snapshot.layouts.find((entry) => entry.id === layoutId);
  if (!layout || !layout.zones.some((zone) => zone.id === zoneId)) return;

  const index = snapshot.assignments.findIndex((entry) => entry.windowId === windowId);
  let assignments: ZoneAssignment[];
  if (index >= 0) {
    assignments = snapshot.assignments.slice();
    assignments[index] = { windowId, layoutId, zoneId };
  } else {
    assignments = [...snapshot.assignments, { windowId, layoutId, zoneId }];
  }
  commitPersistent({ assignments });
}

/** Drop a window's zone assignment. No-op when it has none. */
export function clearWindowZone(windowId: string): void {
  const next = snapshot.assignments.filter((entry) => entry.windowId !== windowId);
  if (next.length === snapshot.assignments.length) return;
  commitPersistent({ assignments: next });
}

/** Set the px gap, clamped to `[MIN_ZONE_GAP, MAX_ZONE_GAP]` (AC1). */
export function setZoneGap(gap: number): void {
  const next = clampZoneGap(gap);
  if (next === snapshot.gap) return;
  commitPersistent({ gap: next });
}

/** Set the activation chord; an unrecognized value is ignored (AC1). */
export function setZoneChord(chord: ZoneActivationChord): void {
  if (!ZONE_ACTIVATION_CHORDS.includes(chord)) return;
  if (snapshot.chord === chord) return;
  commitPersistent({ chord });
}

// ── Drag gesture (transient) ──────────────────────────────────────────────────

/** Enter a zone-drag gesture for `windowId` (R-3.1). Transient — never persisted. */
export function beginZoneDrag(windowId: string): void {
  if (snapshot.dragActive && snapshot.dragWindowId === windowId) return;
  dragPointer = null;
  commitTransient({ dragActive: true, dragWindowId: windowId, hoveredZoneId: null });
}

/**
 * Update the pointer position during a drag and recompute the hovered zone
 * (R-3.1). The pointer is in viewport (client) coords; it is converted against
 * the reported workspace rect. Notifies only when the hovered zone changes.
 */
export function updateZoneDragPointer(clientX: number, clientY: number): void {
  if (!snapshot.dragActive) return;
  dragPointer = { x: clientX, y: clientY };
  const next = hoveredZoneAt(clientX, clientY);
  if (next === snapshot.hoveredZoneId) return;
  commitTransient({ hoveredZoneId: next });
}

/**
 * End a drag (R-3.2/R-3.4). When `commit` is true and the pointer is over a zone,
 * the window is assigned to that zone and persisted; otherwise the window is left
 * unchanged. Always clears the transient drag state and flushes any pending
 * config write suppressed by the gesture.
 */
export function endZoneDrag(commit: boolean): void {
  if (!snapshot.dragActive) return;
  const windowId = snapshot.dragWindowId;
  const zoneId = snapshot.hoveredZoneId;
  dragPointer = null;
  snapshot = {
    ...snapshot,
    dragActive: false,
    dragWindowId: null,
    hoveredZoneId: null,
  };
  notify();
  if (commit && windowId !== null && zoneId !== null) {
    assignWindowToZone(windowId, zoneId);
  }
  if (dirty) schedulePersist();
}

/** Cancel a drag (Escape / no-zone release, R-3.4) — geometry left unchanged. */
export function cancelZoneDrag(): void {
  if (!snapshot.dragActive) return;
  dragPointer = null;
  snapshot = {
    ...snapshot,
    dragActive: false,
    dragWindowId: null,
    hoveredZoneId: null,
  };
  notify();
  if (dirty) schedulePersist();
}

/** The zone under a viewport point during a drag, or `null` (disabled/no layout). */
function hoveredZoneAt(clientX: number, clientY: number): string | null {
  if (!snapshot.enabled || snapshot.activeLayoutId === null || !workspace) return null;
  const layout = snapshot.layouts.find((entry) => entry.id === snapshot.activeLayoutId);
  if (!layout || layout.zones.length === 0) return null;
  return zoneAtPoint(
    { width: workspace.width, height: workspace.height },
    layout.zones,
    snapshot.gap,
    clientX - workspace.left,
    clientY - workspace.top,
  );
}

// ── Hydration ─────────────────────────────────────────────────────────────────

/**
 * Hydrate the configuration from the persisted key. Idempotent + runs ONCE
 * (module scope, not per-consumer-mount) and never overwrites an in-flight user
 * write. The legacy `Fredo_workspace_layout` key is best-effort purged (never
 * migrated) on this first pass.
 */
export function hydrateZoneLayout(): Promise<void> {
  if (hydrationStarted) return hydrationPromise ?? Promise.resolve();
  hydrationStarted = true;
  hydrationPromise = (async () => {
    // Best-effort purge of the retired #2949 key — never migrated (R-4.1/R-4.4).
    try {
      await settingsService.remove(LEGACY_WORKSPACE_LAYOUT_KEY);
    } catch {
      // Persistence is best-effort.
    }
    try {
      const stored = await settingsService.get<PersistedZoneLayout | null>(
        ZONE_LAYOUT_KEY,
        null,
        parsePersistedZoneLayout,
      );
      if (dirty || !stored) return;
      snapshot = {
        enabled: stored.enabled,
        activeLayoutId: normalizeActiveId(stored.activeLayoutId, stored.layouts),
        layouts: stored.layouts,
        gap: stored.gap,
        chord: stored.chord,
        assignments: stored.assignments,
        dragActive: false,
        dragWindowId: null,
        hoveredZoneId: null,
      };
      notify();
    } catch {
      // Tauri absent / read failure → stay on the empty default (no crash).
    }
  })();
  return hydrationPromise;
}

/** Options for `reopenZonedWindows` — injected so the boot path stays testable
 *  without importing the feature registry (`Home.tsx` supplies the production
 *  values: its raw in-window `openFeatureWindow` + the kernel `updateWindow`). */
export interface ReopenZonedWindowsOptions<F extends { id: string }> {
  /** Every registered feature — the reopen only touches REGISTERED ids (R-4.2). */
  features: readonly F[];
  /** Raw in-window opener (Home's `openFeatureWindow`). */
  open: (id: string, feature: F) => void;
  /** Kernel patch — un-maximizes the freshly-opened window so it lands in its zone. */
  update: (id: string, patch: { isMaximized?: boolean }) => void;
}

/**
 * BOOT-HYDRATION ONLY (R-4.2): reopen the windows placed in the ACTIVE layout's
 * zones so they land directly in their zones instead of rendering as degraded
 * placeholders. Every assignment whose window (a) belongs to the active layout,
 * (b) resolves to a REGISTERED feature, and (c) is not already open is opened
 * through the raw in-window `open` callback and immediately un-maximized.
 *
 * Assignments that resolve to no registered feature are SKIPPED — the existing
 * degraded-placeholder path renders them (R-4.4). Nothing happens while layout
 * management is disabled or no layout is active (the zones are not in effect).
 */
export function reopenZonedWindows<F extends { id: string }>(
  options: ReopenZonedWindowsOptions<F>,
): void {
  if (!snapshot.enabled || snapshot.activeLayoutId === null) return;
  const layoutId = snapshot.activeLayoutId;
  const openIds = new Set(getWindowSnapshot().map((win) => win.id));
  for (const assignment of snapshot.assignments) {
    if (assignment.layoutId !== layoutId) continue;
    if (openIds.has(assignment.windowId)) continue;
    const feature = options.features.find((entry) => entry.id === assignment.windowId);
    if (!feature) continue;
    options.open(feature.id, feature);
    openIds.add(feature.id);
    options.update(feature.id, { isMaximized: false });
  }
}

/** Test-only: wipe the module-scoped store. Never call from app code. */
export function resetZoneLayoutStoreForTests(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  workspace = null;
  dragPointer = null;
  snapshot = {
    enabled: false,
    activeLayoutId: null,
    layouts: [],
    gap: DEFAULT_ZONE_GAP,
    chord: DEFAULT_ZONE_CHORD,
    assignments: [],
    dragActive: false,
    dragWindowId: null,
    hoveredZoneId: null,
  };
  dirty = false;
  hydrationStarted = false;
  hydrationPromise = null;
  listeners.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A name unique against `others` (case-insensitive), suffixing " (2)", … */
function uniqueLayoutName(name: string, others: ZoneLayout[]): string {
  const base = name.trim().length > 0 ? name.trim() : 'Layout';
  const taken = new Set(others.map((entry) => entry.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  let candidate = `${base} (${suffix})`;
  while (taken.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${base} (${suffix})`;
  }
  return candidate;
}

function cloneZone(zone: Zone): Zone {
  return { id: zone.id, rect: { ...zone.rect } };
}

/** `activeLayoutId` must resolve to a kept, non-empty layout, else `null`. */
function normalizeActiveId(activeLayoutId: string | null, layouts: ZoneLayout[]): string | null {
  if (activeLayoutId === null) return null;
  const layout = layouts.find((entry) => entry.id === activeLayoutId);
  return layout && layout.zones.length > 0 ? activeLayoutId : null;
}

// ── Tolerant parse ────────────────────────────────────────────────────────────

const TEMPLATE_IDS: readonly ZoneTemplateId[] = ['columns', 'rows', 'grid', 'main-side', 'custom'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isZone(value: unknown): value is Zone {
  if (!isRecord(value)) return false;
  const rect = value.rect;
  if (!isRecord(rect)) return false;
  return (
    isNonEmptyString(value.id) &&
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    rect.width > 0 &&
    isFiniteNumber(rect.height) &&
    rect.height > 0
  );
}

/** A layout is valid only with ≥1 well-formed zone (zero-zone layouts dropped). */
function isZoneLayout(value: unknown): value is ZoneLayout {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (typeof value.name !== 'string') return false;
  if (!TEMPLATE_IDS.includes(value.template as ZoneTemplateId)) return false;
  if (!Array.isArray(value.zones)) return false;
  const zones = value.zones.filter(isZone);
  return zones.length > 0;
}

function normalizeLayout(value: unknown): ZoneLayout | null {
  if (!isZoneLayout(value)) return null;
  // `isZoneLayout` validated the shape; re-filter so only well-formed zones survive.
  const zones = value.zones.filter(isZone).map(cloneZone);
  return {
    id: value.id,
    name: value.name,
    template: value.template,
    zones,
  };
}

function isAssignment(value: unknown): value is ZoneAssignment {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.windowId) &&
    isNonEmptyString(value.layoutId) &&
    isNonEmptyString(value.zoneId)
  );
}

function isChord(value: unknown): value is ZoneActivationChord {
  return typeof value === 'string' && (ZONE_ACTIVATION_CHORDS as readonly string[]).includes(value);
}

/**
 * Tolerant deserializer. A corrupt payload or an unknown `version` degrades to
 * `null` (the store stays on its clean default — never misreads a future shape).
 * A `version: 1` payload keeps every well-formed layout with ≥1 zone, KEEPS
 * unknown `windowId`s in assignments (degraded render — R-4.4), DROPS zero-zone
 * layouts, clamps the gap, and validates the chord. Unknown fields are ignored.
 */
function parsePersistedZoneLayout(raw: string): PersistedZoneLayout | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== ZONE_LAYOUT_VERSION) return null;
    const layouts = Array.isArray(parsed.layouts)
      ? parsed.layouts
          .map(normalizeLayout)
          .filter((layout): layout is ZoneLayout => layout !== null)
      : [];
    const assignments = Array.isArray(parsed.assignments)
      ? parsed.assignments.filter(isAssignment).map((entry) => ({ ...entry }))
      : [];
    return {
      version: ZONE_LAYOUT_VERSION,
      enabled: parsed.enabled === true,
      activeLayoutId: isNonEmptyString(parsed.activeLayoutId) ? parsed.activeLayoutId : null,
      layouts,
      gap: clampZoneGap(isFiniteNumber(parsed.gap) ? parsed.gap : DEFAULT_ZONE_GAP),
      chord: isChord(parsed.chord) ? parsed.chord : DEFAULT_ZONE_CHORD,
      assignments,
    };
  } catch {
    return null;
  }
}
