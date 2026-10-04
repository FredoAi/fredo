/**
 * Spec #2959 ST-2 — the PURE keyboard-bar availability model (EARS R-2.1,
 * R-5.1, R-5.2, R-5.5, R-5.6; supports R-3.2).
 *
 * This module projects the ACTIVE context's already-resolved bindings
 * (`resolveActiveBindings`, `engine.ts`) into the read-only bar rows the
 * persistent key bar renders, together with each row's availability and the
 * human copy explaining why it is unavailable.
 *
 * HONESTY CONTRACT (R-5.5). Availability is NOT re-derived here: for every
 * binding the model asks the engine's OWN pure decision, `decideDispatch`
 * (`sequence.ts`), "would pressing this binding's keys run this action right
 * now?" — a single-stroke binding is asked once; a multi-stroke binding is
 * simulated step-by-step exactly as the keydown path does (fresh arm, then
 * `pending` continuation). A row is `available` ONLY when the decision returns
 * `match` for that action id; otherwise the decision's `reason` is mapped to
 * human copy via `unavailableReasonFor`. The bar and the engine therefore share
 * ONE decision and can never disagree.
 *
 * PURE (mirrors `keys.ts`/`sequence.ts`): no DOM, no React, no store, no
 * registry mutation. The only imports are the pure matcher/decision module, the
 * pure key formatter, and TYPES (`FocusSnapshot` is a type-only import from
 * `engine.ts`, erased at compile time — no runtime dependency on the engine).
 *
 * Defined rules (R-5.6): an action with no effective sequence (an empty
 * `sequence`) is HIDDEN from the rows; `empty` is `rows.length === 0` (R-5.4).
 */

import { displaySequence, parseSequence } from './keys';
import { decideDispatch } from './sequence';
import { ROOT_CONTEXT_ID } from './types';
import type { FocusSnapshot } from './engine';
import type {
  DispatchDecision,
  HotkeyActionId,
  HotkeyContextId,
  HotkeyTier,
  KeySequence,
  Platform,
  ResolvedBinding,
} from './types';

/** The two availability states a bar row can be in. */
export type BarAvailability = 'available' | 'unavailable';

/** One action chip in the bar — availability + (when unavailable) the reason copy. */
export interface KeyboardBarRow {
  readonly actionId: HotkeyActionId;
  readonly title: string;
  readonly tier: HotkeyTier;
  readonly contextId: HotkeyContextId;
  /** Serialized effective sequence, e.g. `'ctrl+shift+f8'` (space-joined steps). */
  readonly sequence: string;
  readonly availability: BarAvailability;
  /** Present iff `availability === 'unavailable'`. */
  readonly unavailableReason?: string;
  /**
   * Spec #2959 round 2 (F-1) — whether this row is scoped to the active context
   * (a feature-tier action, a Fredo-tier action scoped `contextId`-wise to a
   * non-ROOT context, or a Fredo-tier descent action whose `opensContextId` is a
   * non-ROOT context) rather than an always-on ROOT binding. Context-scoped rows
   * are ordered FIRST, so an overflow rule can never drop the actions specific to
   * where the user is.
   */
  readonly contextScoped: boolean;
}

/** The bar's read-only projection of the active context's actions. */
export interface KeyboardBarModel {
  readonly contextId: HotkeyContextId;
  readonly contextTitle: string;
  /** Path length; base context = 1 (see DEPTH semantics in `contexts.ts`). */
  readonly depth: number;
  /**
   * The FULL ordered list: context-scoped rows first (F-1), then always-on.
   * `rows.length` is the total resolved-action count (the body hook + announcement
   * count semantics are unchanged by the ordering).
   */
  readonly rows: readonly KeyboardBarRow[];
  /** How many of `rows` are context-scoped (the leading segment of `rows`). */
  readonly scopedCount: number;
  /** `rows.length === 0` — the defined empty state (R-5.4). */
  readonly empty: boolean;
}

/** The model's input — the SAME listing the engine dispatches from (one listing). */
export interface KeyboardBarModelInput {
  /** `resolveActiveBindings(...)` (`engine.ts`) — the ONE listing. */
  readonly bindings: readonly ResolvedBinding[];
  /** `getHotkeyContextSnapshot().contextId`. */
  readonly contextId: HotkeyContextId;
  /** `getHotkeyContext(contextId)?.title ?? contextId`. */
  readonly contextTitle: string;
  readonly depth: number;
  /** ST-1's live focus snapshot (`engine.ts`) — the ONE focus source. */
  readonly focus: FocusSnapshot;
  /** `isMacroRecording()` (`store.ts`). */
  readonly macroRecording: boolean;
  readonly platform?: Platform;
}

// ── Human copy (the ONE reason mapper) ───────────────────────────────────────

/**
 * Map a `decideDispatch` reason to human copy. Six decision reasons collapse
 * onto five named explanations; everything else (unbound, sequence-*,
 * context-back, match:<id>, …) shares the generic default.
 */
export function unavailableReasonFor(decisionReason: string): string {
  switch (decisionReason) {
    case 'text-entry-passthrough':
    case 'text-entry-chord-unbound':
      return 'Unavailable while typing';
    case 'modal-suspend':
    case 'modal-chord-unbound':
      return 'Unavailable while a dialog is open';
    case 'native-consumes':
      return 'The focused control captures this key';
    case 'macro-recording':
      return 'Unavailable during macro recording';
    case 'terminal-passthrough':
      return 'The terminal owns the keyboard';
    default:
      return 'Not available right now';
  }
}

// ── Platform precedence / observable shadowing (Spec #2962, R-2.1/R-4.1/R-4.2) ─

/**
 * The reason copy prefix for a binding SHADOWED by a deeper level's binding for
 * the SAME sequence. The full copy is
 * `` `${SHADOWED_UNAVAILABLE_PREFIX} ${winner.action.title}` `` — naming the
 * winning action so the losing (parent) binding is observable to the user.
 */
export const SHADOWED_UNAVAILABLE_PREFIX = 'Shadowed by';

/**
 * The earlier (deeper) binding that shares `binding`'s `serialized` sequence, or
 * `null` when `binding` is the winner (the first same-sequence entry) or no
 * earlier entry shares the sequence.
 *
 * `resolveContextBindings` orders feature-tier bindings by context depth DESC
 * (deepest first) and `matchSequence` returns the FIRST exact binding — so the
 * earlier same-sequence entry is the one the engine actually runs when a key is
 * reused across levels (Spec #2962, R-2.1/R-4.1/R-4.2).
 */
export function shadowingBinding(
  binding: ResolvedBinding,
  bindings: readonly ResolvedBinding[],
): ResolvedBinding | null {
  const winner = bindings.find((candidate) => candidate.serialized === binding.serialized);
  if (!winner) return null;
  if (winner === binding) return null;
  if (winner.actionId === binding.actionId && winner.tier === binding.tier) return null;
  return winner;
}

// ── Availability projection (asks the engine's OWN decision) ──────────────────

/**
 * Ask `decideDispatch` whether `binding`'s keys would run its action right now.
 *
 * A single-stroke binding is asked once (the engine's own fresh-key path). A
 * multi-stroke binding is walked step-by-step: the first stroke must arm (the
 * decision returns `arm-sequence`) and each later stroke must continue the
 * pending prefix (`pending`), with the final stroke resolving to a `match` —
 * mirroring the engine's keydown path (`sequence.ts`).
 *
 * The configured leader's own stroke is intentionally `null` here: the model's
 * contract carries no leader, and the engine's leader-arming and the plain
 * prefix-arming branches both report an `arm-sequence` outcome, so a binding's
 * availability is identical either way. The decision's OUTCOME is consulted for
 * the final step's `match` action id, which is what R-5.5 requires.
 */
function simulateDecision(
  binding: ResolvedBinding,
  focus: FocusSnapshot,
  macroRecording: boolean,
  bindings: readonly ResolvedBinding[],
  platform: Platform | undefined,
): DispatchDecision {
  const steps = binding.sequence;
  let pending: KeySequence | null = null;
  let decision: DispatchDecision = { outcome: 'passthrough', consumed: false, reason: 'unbound' };

  for (let i = 0; i < steps.length; i += 1) {
    decision = decideDispatch({
      stroke: steps[i],
      context: focus.context,
      pending,
      bindings,
      leader: null,
      macroRecording,
      nativeConsumes: focus.nativeConsumes,
      platform,
    });

    if (decision.outcome === 'match') return decision;
    if (decision.outcome === 'arm-sequence') {
      pending = [steps[i]];
      continue;
    }
    if (decision.outcome === 'pending') {
      pending = [...(pending ?? []), steps[i]];
      continue;
    }
    // suppress / passthrough / context-back — this action cannot be reached.
    return decision;
  }
  return decision;
}

interface ProjectedAvailability {
  readonly availability: BarAvailability;
  readonly unavailableReason?: string;
}

function availabilityFor(
  binding: ResolvedBinding,
  focus: FocusSnapshot,
  macroRecording: boolean,
  bindings: readonly ResolvedBinding[],
  platform: Platform | undefined,
): ProjectedAvailability {
  const action = binding.action;

  // Independent, declared gate: `enabled() === false` ⇒ unavailable, using the
  // action's OWN reason when it declares one (S4's real action sets).
  if (typeof action.enabled === 'function' && action.enabled() === false) {
    return {
      availability: 'unavailable',
      unavailableReason: action.unavailableReason ?? 'Not available right now',
    };
  }

  const decision = simulateDecision(binding, focus, macroRecording, bindings, platform);
  if (decision.outcome === 'match' && decision.action?.actionId === binding.actionId) {
    return { availability: 'available' };
  }
  // Spec #2962 (R-4.1/R-4.2): the decision matched a DIFFERENT action — the
  // earlier, deeper binding for the SAME sequence. This row's binding is
  // shadowed; name the winning action so the losing level is observable. Only
  // taken when the matched action IS the earlier same-sequence binding.
  if (decision.outcome === 'match' && decision.action !== undefined) {
    const shadowing = shadowingBinding(binding, bindings);
    if (shadowing !== null && shadowing.actionId === decision.action.actionId) {
      return {
        availability: 'unavailable',
        unavailableReason: `${SHADOWED_UNAVAILABLE_PREFIX} ${shadowing.action.title}`,
      };
    }
  }
  return { availability: 'unavailable', unavailableReason: unavailableReasonFor(decision.reason) };
}

// ── Display ordering (F-1) ───────────────────────────────────────────────────

/**
 * Whether the binding is SCOPED to the active interaction context rather than an
 * always-on ROOT binding (F-1). True for:
 *  - a feature-tier action (only present for the focused feature / an on-path
 *    context);
 *  - a Fredo-tier action explicitly scoped (`contextId`) to a non-ROOT context;
 *  - a Fredo-tier action that DESCENDS (`opensContextId`) into a non-ROOT context
 *    — it is definitionally specific to where the user is (the way deeper), and
 *    the round-2 fix plan names it as the motivating example whose overflow the
 *    fix must eliminate. `fredo.context.descendReference` is registered with
 *    `opensContextId` (not `contextId`), so keying only off `contextId` would
 *    leave it as the last always-on row and off-screen — contradicting F-5.
 * False for a plain always-on ROOT Fredo binding.
 */
function isContextScoped(binding: ResolvedBinding): boolean {
  if (binding.tier === 'feature') return true;
  const { contextId, opensContextId } = binding.action;
  return (
    (contextId !== undefined && contextId !== ROOT_CONTEXT_ID) ||
    (opensContextId !== undefined && opensContextId !== ROOT_CONTEXT_ID)
  );
}

// ── The model builder ────────────────────────────────────────────────────────

/**
 * Build the bar model for the active context. PURE: no store reads, no listing
 * re-derivation (the input IS `resolveActiveBindings`), no mutation.
 *
 * Ordering (F-1): context-scoped rows first, preserving the resolver's existing
 * relative order, then the always-on group. `rows` remains the FULL list — the
 * count hook and the announcement digest keep their total-count semantics.
 */
export function buildKeyboardBarModel(input: KeyboardBarModelInput): KeyboardBarModel {
  const { bindings, contextId, contextTitle, depth, focus, macroRecording, platform } = input;

  const contextScopedRows: KeyboardBarRow[] = [];
  const alwaysOnRows: KeyboardBarRow[] = [];
  for (const binding of bindings) {
    // R-5.6 — an action with no effective sequence is HIDDEN (defined rule).
    if (binding.sequence.length === 0) continue;

    const projected = availabilityFor(binding, focus, macroRecording, bindings, platform);
    const row: KeyboardBarRow = {
      actionId: binding.actionId,
      title: binding.action.title,
      tier: binding.tier,
      contextId,
      sequence: binding.serialized,
      availability: projected.availability,
      ...(projected.availability === 'unavailable'
        ? { unavailableReason: projected.unavailableReason ?? 'Not available right now' }
        : {}),
      contextScoped: isContextScoped(binding),
    };
    if (row.contextScoped) {
      contextScopedRows.push(row);
    } else {
      alwaysOnRows.push(row);
    }
  }

  const rows = [...contextScopedRows, ...alwaysOnRows];

  return {
    contextId,
    contextTitle,
    depth,
    rows,
    scopedCount: contextScopedRows.length,
    empty: rows.length === 0,
  };
}

// ── Announcement copy (the ONE mode-aware digest) ────────────────────────────

/** The most action names a single announcement spells out. */
export const KEYBOARD_BAR_MAX_ANNOUNCED = 8;

/** The bounded digest: first 8 `"<display> (<title>)"`, then `and N more`. */
function digestFor(rows: readonly KeyboardBarRow[]): string {
  const announced = rows.slice(0, KEYBOARD_BAR_MAX_ANNOUNCED);
  const rest = rows.length - announced.length;
  const base = announced
    .map((row) => `${displaySequence(parseSequence(row.sequence))} (${row.title})`)
    .join(', ');
  return rest > 0 ? `${base}, and ${rest} more` : base;
}

/**
 * The canonical announcement for `enter` (mode turned on) or `context` (a
 * context change while mode stays on). Deterministic: identical model ⇒
 * identical string.
 */
export function keyboardBarAnnouncement(model: KeyboardBarModel, kind: 'enter' | 'context'): string {
  const prefix =
    kind === 'enter'
      ? `Keyboard mode on. ${model.contextTitle}.`
      : `${model.contextTitle}. Level ${model.depth}.`;
  if (model.rows.length === 0) return `${prefix} No actions in this context.`;
  return `${prefix} ${model.rows.length} actions: ${digestFor(model.rows)}`;
}
