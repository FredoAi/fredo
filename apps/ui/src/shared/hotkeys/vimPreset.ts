/**
 * Spec #2946 ST-6 — the opt-in Vim preset: enable / disable + collision
 * surfacing (plan contract block 10; R-4.7, R-4.8).
 *
 * Enabling applies the shipped `VIM_PRESET` (leader = Space, `h j k l` focus
 * movement, `@leader ?` cheat sheet) through the SAME conflict classifier every
 * rebind uses — `classifyBinding` stays the ONE authority, so no preset path can
 * silently clobber a user binding. Every collision is returned in the preview
 * BEFORE anything is applied (R-4.8); a same-tier collision blocks the apply.
 *
 * Disabling restores the PRE-PRESET defaults (R-4.7): the bindings + leader that
 * were in effect when the preset was enabled are captured into a small
 * `settingsService` snapshot under `VIM_PRESET_SNAPSHOT_KEY` (a SIBLING key — the
 * keymap document schema in `types.ts` is ST-2-owned and is deliberately NOT
 * changed). When no snapshot exists (preset enabled by an older build, or the
 * snapshot was cleared) disabling falls back to the shipped defaults.
 *
 * This module owns only the preset mechanics; the Settings pane renders the
 * preview and calls `applyVimPreset`.
 */

import { settingsService } from '../../features/settings';
import { classifyBinding } from './conflicts';
import { VIM_PRESET } from './defaults';
import { getDefaultBinding } from './persistence';
import { listHotkeyActions } from './registry';
import { applyKeymap, getKeymap } from './store';
import type {
  ConflictReport,
  HotkeyActionId,
  HotkeyTier,
  PersistedKeymap,
  RegisteredHotkeyAction,
} from './types';

/** Sibling KV key holding the pre-preset snapshot (NOT part of the keymap schema). */
export const VIM_PRESET_SNAPSHOT_KEY = 'fredo.hotkeys.vimPreset.snapshot';

/** The action ids the preset touches (its declared binding keys). */
export const VIM_PRESET_ACTION_IDS: readonly HotkeyActionId[] = Object.freeze(
  Object.keys(VIM_PRESET.bindings),
);

/** One binding the preset changes. */
export interface VimPresetChange {
  readonly actionId: HotkeyActionId;
  readonly previous: readonly string[];
  readonly next: readonly string[];
}

/** One collision a preset binding would cause, classified by the ONE classifier. */
export interface VimPresetCollision {
  readonly actionId: HotkeyActionId;
  readonly sequence: string;
  readonly report: ConflictReport;
}

/** The pre-preset bindings + leader captured at enable time. */
export interface VimPresetSnapshot {
  readonly leader: string | null;
  readonly bindings: Record<string, string[]>;
}

/** A fully-resolved preset decision the pane renders + confirms. */
export interface VimPresetPreview {
  readonly enable: boolean;
  readonly changes: readonly VimPresetChange[];
  readonly collisions: readonly VimPresetCollision[];
  /** `true` when a same-tier collision blocks the apply (R-4.8). */
  readonly blocking: boolean;
  /** The candidate keymap if the preview is applied. */
  readonly keymap: PersistedKeymap;
  /** The pre-preset snapshot to persist on enable (`null` when disabling). */
  readonly snapshot: VimPresetSnapshot | null;
}

function captureSnapshot(keymap: PersistedKeymap): VimPresetSnapshot {
  const bindings: Record<string, string[]> = {};
  for (const actionId of VIM_PRESET_ACTION_IDS) {
    bindings[actionId] = [...(keymap.bindings[actionId] ?? [])];
  }
  return { leader: keymap.leader, bindings };
}

function tierFor(actionId: HotkeyActionId, actions: readonly RegisteredHotkeyAction[]): HotkeyTier {
  const action = actions.find((entry) => entry.actionId === actionId);
  if (action) return action.tier;
  return actionId.startsWith('fredo.') ? 'fredo' : 'feature';
}

function collectCollisions(
  changes: readonly VimPresetChange[],
  candidate: PersistedKeymap,
  actions: readonly RegisteredHotkeyAction[],
): VimPresetCollision[] {
  const collisions: VimPresetCollision[] = [];
  for (const change of changes) {
    const targetTier = tierFor(change.actionId, actions);
    for (const sequence of change.next) {
      const report = classifyBinding({
        candidate: sequence,
        targetActionId: change.actionId,
        targetTier,
        keymap: candidate,
        actions,
      });
      if (report.kind !== 'none') {
        collisions.push({ actionId: change.actionId, sequence, report });
      }
    }
  }
  return collisions;
}

/**
 * Build the preview for enabling or disabling the Vim preset. PURE with respect
 * to storage writes (only reads the snapshot when disabling) — nothing is
 * applied until `applyVimPreset` is called.
 */
export async function buildVimPresetPreview(enable: boolean): Promise<VimPresetPreview> {
  const keymap = getKeymap();
  const actions = listHotkeyActions();
  const bindings: Record<string, string[]> = { ...keymap.bindings };
  const changes: VimPresetChange[] = [];

  if (enable) {
    const snapshot = captureSnapshot(keymap);
    for (const actionId of VIM_PRESET_ACTION_IDS) {
      const previous = [...(keymap.bindings[actionId] ?? [])];
      const next: string[] = [...VIM_PRESET.bindings[actionId]];
      bindings[actionId] = next;
      changes.push({ actionId, previous, next });
    }
    const candidate: PersistedKeymap = {
      ...keymap,
      vimPresetEnabled: true,
      leader: VIM_PRESET.leader,
      bindings,
    };
    const collisions = collectCollisions(changes, candidate, actions);
    return {
      enable: true,
      changes,
      collisions,
      blocking: collisions.some((collision) => collision.report.kind === 'same-tier'),
      keymap: candidate,
      snapshot,
    };
  }

  const snapshot = await readVimPresetSnapshot();
  for (const actionId of VIM_PRESET_ACTION_IDS) {
    const previous = [...(keymap.bindings[actionId] ?? [])];
    const next: string[] = snapshot
      ? [...(snapshot.bindings[actionId] ?? [])]
      : [...getDefaultBinding(actionId)];
    bindings[actionId] = next;
    changes.push({ actionId, previous, next });
  }
  const candidate: PersistedKeymap = {
    ...keymap,
    vimPresetEnabled: false,
    leader: snapshot ? snapshot.leader : null,
    bindings,
  };
  return {
    enable: false,
    changes,
    collisions: [],
    blocking: false,
    keymap: candidate,
    snapshot: null,
  };
}

/**
 * Apply a previewed preset change (optimistic write-through via the keymap
 * store). On enable the pre-preset snapshot is persisted AFTER the keymap write
 * succeeds; on disable the snapshot is cleared.
 */
export async function applyVimPreset(preview: VimPresetPreview): Promise<void> {
  await applyKeymap(preview.keymap);
  if (preview.enable) await writeVimPresetSnapshot(preview.snapshot);
  else await clearVimPresetSnapshot();
}

// ── Snapshot persistence (sibling KV key; total read) ─────────────────────────

function normalizeSnapshot(raw: unknown): VimPresetSnapshot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  const leader =
    typeof doc.leader === 'string' && doc.leader.length > 0 ? doc.leader : null;
  const bindings: Record<string, string[]> = {};
  if (typeof doc.bindings === 'object' && doc.bindings !== null && !Array.isArray(doc.bindings)) {
    for (const [actionId, value] of Object.entries(doc.bindings as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      bindings[actionId] = value.filter((seq): seq is string => typeof seq === 'string');
    }
  }
  return { leader, bindings };
}

/** Read the pre-preset snapshot; `null` when absent or unreadable. */
export async function readVimPresetSnapshot(): Promise<VimPresetSnapshot | null> {
  try {
    const stored = await settingsService.get<unknown>(VIM_PRESET_SNAPSHOT_KEY, null);
    return normalizeSnapshot(stored);
  } catch {
    return null;
  }
}

async function writeVimPresetSnapshot(snapshot: VimPresetSnapshot | null): Promise<void> {
  if (!snapshot) return;
  try {
    await settingsService.set(VIM_PRESET_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Best-effort: a failed snapshot write degrades disable to shipped defaults.
  }
}

/**
 * Remove the pre-preset snapshot (the sibling KV key). Exported for the
 * "reset all" path (Spec #2946 ST-17): reset-all clears the preset flag and
 * leader, so the now-stale snapshot must not survive to be restored on a later
 * disable. Best-effort — a failure never throws.
 */
export async function clearVimPresetSnapshot(): Promise<void> {
  try {
    await settingsService.remove(VIM_PRESET_SNAPSHOT_KEY);
  } catch {
    // Best-effort.
  }
}
