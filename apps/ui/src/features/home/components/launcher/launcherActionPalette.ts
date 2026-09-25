/**
 * Spec #2946 ST-9 — command-palette integration in the EXISTING launcher command
 * bar (plan contract block 8; UI/UX §4, PO#10 item 3).
 *
 * The launcher command bar IS the palette: when the query's first non-whitespace
 * character is `>` (`ACTION_PALETTE_PREFIX`, e.g. `>open settings`) the below-bar
 * results list switches from app tiles to the declared hotkey actions. The action
 * rows carry the action label, the CURRENT binding(s) rendered by ST-3's `Keycap`
 * (one renderer) and the tier tag; selecting a row runs the action with
 * `source: 'palette'`.
 *
 * A query WITHOUT the prefix is left completely untouched — the shipped
 * `resolveEnterAction` precedence (`launcherEnterAction.ts:176-199`) still owns
 * Enter, including its `listening`/`sending` branches. This module is PURE:
 * parsing + matcher + projection only (no React/DOM/registry/engine imports), so
 * both the switch and the matcher are pinned headlessly. Its only runtime
 * dependency is ST-3's `describeSequence` (itself pure) for the displayed-key
 * search term and the `bindingDisplay` projection.
 */

import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import { describeSequence } from '../../../../shared/hotkeys/describe';
import {
  ACTION_PALETTE_PREFIX,
  type HotkeyActionId,
  type HotkeyTier,
} from '../../../../shared/hotkeys/types';

// Re-exported so every palette consumer/test reads the ONE prefix constant.
export { ACTION_PALETTE_PREFIX };

/**
 * The Fredo-tier action whose RUN opens the command bar pre-filled with the
 * action prefix. Declared in `shared/hotkeys/engine.ts` (`DEFAULT_FREDO_ACTION_DEFS`)
 * with the shipped default `primary+P` (`defaults.ts`); the launcher shell
 * contributes the run through `registerHotkeyHandler`.
 */
export const ACTION_PALETTE_OPEN_ACTION_ID: HotkeyActionId = 'fredo.palette.openActions';

/** One row of the launcher action palette. */
export interface LauncherActionResult {
  readonly kind: 'action';
  readonly actionId: HotkeyActionId;
  readonly title: string;
  readonly tier: HotkeyTier;
  readonly featureId?: string;
  readonly description?: string;
  /** Effective serialized sequences (configured, else shipped default); `[]` = unbound. */
  readonly bindings: readonly string[];
  /** The first binding's layout-resolved human string; `null` when unbound. */
  readonly bindingDisplay: string | null;
}

/**
 * The additive result union (contract block 8). The `app` arm is the shipped
 * tile result; the `action` arm is what the `>` prefix surfaces. Defined here so
 * the palette's shape has ONE declaration site next to its projection.
 */
export type LauncherResult =
  | { readonly kind: 'app'; readonly feature: FredoFeatureClass }
  | LauncherActionResult;

/** The parsed command-bar query: whether the action prefix is present, and the term. */
export interface PaletteQuery {
  readonly active: boolean;
  readonly term: string;
}

/**
 * Parse a command-bar query into palette mode. Active when the first
 * NON-WHITESPACE character is `>`; the term is the remainder (trimmed). A query
 * that does not start with the prefix is inactive with an empty term — it drives
 * the shipped app-tile path unchanged.
 */
export function parsePaletteQuery(query: string): PaletteQuery {
  const leading = typeof query === 'string' ? query.replace(/^\s+/, '') : '';
  if (!leading.startsWith(ACTION_PALETTE_PREFIX)) return { active: false, term: '' };
  return { active: true, term: leading.slice(ACTION_PALETTE_PREFIX.length).trim() };
}

/** Convenience predicate for callers that only need the switch. */
export function isPaletteQuery(query: string): boolean {
  return parsePaletteQuery(query).active;
}

/** The DOM id of the Nth palette row (the roving `aria-activedescendant` target). */
export function launcherActionEntryId(index: number): string {
  return `fredo-launcher-action-${index}`;
}

/** The registry shape the projection consumes (a subset of `RegisteredHotkeyAction`). */
export interface PaletteActionSource {
  readonly actionId: HotkeyActionId;
  readonly tier: HotkeyTier;
  readonly featureId?: string;
  readonly title: string;
  readonly description?: string;
  /** The action's declared/shipped default sequence (serialized), or `null` when unbound. */
  readonly defaultSequence: string | null;
  /** Registration-time diagnostic; an invalid action is never dispatchable and shown nowhere here. */
  readonly invalid?: string;
  /** Availability probe; a definitively-unavailable action is not offered. */
  readonly enabled?: () => boolean;
}

export interface BuildPaletteInput {
  readonly actions: readonly PaletteActionSource[];
  /** The search term AFTER the prefix (empty = list every action). */
  readonly term: string;
  /**
   * The CONFIGURED bindings for one action, or `undefined` when the user has not
   * overridden it. Mirrors the engine's `effectiveSequences` exactly: a configured
   * array (including `[]` = explicitly unbound) wins; otherwise the action's
   * declared `defaultSequence` applies.
   */
  readonly configuredBindingsFor: (actionId: HotkeyActionId) => readonly string[] | undefined;
}

interface MatchableEntry {
  readonly title: string;
  readonly description?: string;
  readonly featureId?: string;
  readonly bindings: readonly string[];
}

/**
 * The settings-search matcher semantics (R-4.2), reused so the palette is
 * consistent with the Hotkeys pane and the cheat sheet: match on the action
 * title, its description, the owning feature id, the DISPLAYED key text and the
 * STORED serialized token (so both a keycap reader and a token typist find it).
 * Case-insensitive; filtering never reorders.
 */
export function matchesPaletteQuery(entry: MatchableEntry, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (q.length === 0) return true;
  const haystack = [
    entry.title,
    entry.description ?? '',
    entry.featureId ?? '',
    ...entry.bindings.map((binding) => describeSequence(binding).display),
    ...entry.bindings,
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(q);
}

function isDefinitelyDisabled(source: PaletteActionSource): boolean {
  if (typeof source.enabled !== 'function') return false;
  try {
    return source.enabled() === false;
  } catch {
    return false;
  }
}

/**
 * Project the registry listing into the palette rows: invalid/non-dispatchable
 * actions are dropped (a run surface must never offer a dead row — R-2.3 keeps
 * those visible in Settings instead), the rest keep registry order (never
 * re-sorted) and are filtered by the shared matcher.
 */
export function buildLauncherActionEntries(
  input: BuildPaletteInput,
): readonly LauncherActionResult[] {
  const out: LauncherActionResult[] = [];
  for (const action of input.actions) {
    if (action.invalid) continue;
    if (isDefinitelyDisabled(action)) continue;
    // Effective bindings = configured (a present key wins, even `[]`) else the
    // declared default — byte-identical to the engine's `effectiveSequences`.
    const configured = input.configuredBindingsFor(action.actionId);
    const bindings =
      configured !== undefined
        ? [...configured]
        : action.defaultSequence
          ? [action.defaultSequence]
          : [];
    const entry: LauncherActionResult = {
      kind: 'action',
      actionId: action.actionId,
      title: action.title,
      tier: action.tier,
      featureId: action.featureId,
      description: action.description,
      bindings,
      bindingDisplay: bindings[0] ? describeSequence(bindings[0]).display : null,
    };
    if (matchesPaletteQuery(entry, input.term)) out.push(entry);
  }
  return out;
}
