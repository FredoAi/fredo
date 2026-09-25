/**
 * Spec #2946 ST-1 — the ONE conflict classifier (plan contract block 11).
 *
 * `same-tier` BLOCKS a save; `cross-tier` is LABELLED but never blocks;
 * `reserved` and `invalid` always carry a human-readable reason. The candidate
 * keymap passed in is the IN-MEMORY document (including the pending change), so
 * the classifier sees exactly what would take effect.
 *
 * PURE: no DOM/Tauri/React/clock.
 */

import { parseSequence, sequenceEquals } from './keys';
import { reservedReason } from './reserved';
import {
  tierForActionId,
  type ConflictReport,
  type HotkeyActionId,
  type HotkeyTier,
  type PersistedKeymap,
  type Platform,
  type RegisteredHotkeyAction,
} from './types';

export interface ClassifyBindingInput {
  /** The serialized sequence being captured. */
  readonly candidate: string;
  readonly targetActionId: HotkeyActionId;
  readonly targetTier: HotkeyTier;
  /** The in-memory candidate keymap (includes the pending change). */
  readonly keymap: PersistedKeymap;
  readonly actions: readonly RegisteredHotkeyAction[];
  readonly platform?: Platform;
}

/**
 * Classify a candidate binding against the keymap + registry.
 *
 * Order: invalid (unparseable) → reserved (R-5.3) → same-tier / cross-tier.
 * An empty candidate is the "unbound" sentinel and classifies as `none`.
 */
export function classifyBinding(input: ClassifyBindingInput): ConflictReport {
  const { candidate, targetActionId, targetTier, keymap, actions, platform } = input;
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (trimmed.length === 0) return { kind: 'none', colliding: [] };

  const parsed = parseSequence(trimmed);
  if (parsed.length === 0) {
    return {
      kind: 'invalid',
      colliding: [],
      reason: `Unrecognized key sequence "${candidate}"`,
    };
  }

  const reserved = reservedReason(parsed, platform);
  if (reserved !== null) {
    return { kind: 'reserved', colliding: [], reason: reserved };
  }

  const tierByAction = new Map<HotkeyActionId, HotkeyTier>();
  for (const action of actions) tierByAction.set(action.actionId, action.tier);

  const colliding: { actionId: HotkeyActionId; tier: HotkeyTier; sequence: string }[] = [];
  for (const [actionId, sequences] of Object.entries(keymap.bindings)) {
    if (actionId === targetActionId) continue;
    const tier = tierByAction.get(actionId) ?? tierForActionId(actionId);
    for (const sequence of sequences) {
      const other = parseSequence(sequence);
      if (other.length === 0) continue;
      if (sequenceEquals(parsed, other, platform)) {
        colliding.push({ actionId, tier, sequence });
        break;
      }
    }
  }

  if (colliding.length === 0) return { kind: 'none', colliding: [] };

  const sameTier = colliding.some((entry) => entry.tier === targetTier);
  return { kind: sameTier ? 'same-tier' : 'cross-tier', colliding };
}
