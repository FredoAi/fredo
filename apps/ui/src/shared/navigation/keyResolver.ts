/**
 * Spec #3117 (P3) — §4.1 key resolution: four tiers, one intent.
 *
 * `resolveStroke` is the ONE decision point that turns a stroke into at most one intent
 * (or a named rejection / a quiet hint / a passthrough / a timeout). It is synchronous,
 * deterministic, and reads NO clock: `nowMs` is an argument, so the 250 ms prefix rule is
 * exercised in tests without a timer (REQ-01.3, REQ-02.7).
 *
 * The post-dispatch cursor (transient pop, Escape) is applied by `dispatch` in ST-2 —
 * this module returns the intent + the tier that produced it and nothing else.
 *
 * PURE: no imports outside `./types`, `./registry` and `./resolver`.
 */

import {
  PENDING_TIMEOUT_MS,
  PLACE_EXIT_VERB_ID,
  type Actor,
  type Channel,
  type HintModel,
  type Intent,
  type KeyboardOwner,
  type KeyBinding,
  type Surface,
} from './types';
import { createRegistry, type SurfaceRegistry } from './registry';
import {
  continuationStrokes,
  normalizeStroke,
  serializeStrokes,
  splitStrokes,
} from './resolver';

/** §4.1 — an armed which-key prefix. `armedAtMs` is the caller's clock reading. */
export interface PendingPrefix {
  readonly sequence: string;
  readonly armedAtMs: number;
}

/** §4.1 — everything resolution is allowed to read. */
export interface ResolverInput {
  readonly surface: Surface;
  readonly placePath: readonly string[];
  readonly pending: PendingPrefix | null;
  readonly stroke: string;
  /** TIME IS AN ARGUMENT — never `Date.now()`. */
  readonly nowMs: number;
  /** Default `'engine'`; any other owner passes every stroke through (REQ-02.8). */
  readonly keyboardOwner?: KeyboardOwner;
  /** Default `'human'`. */
  readonly actor?: Actor;
  /** Default `'keyboard'`. */
  readonly channel?: Channel;
}

/** §4.1 — the complete resolution outcome. */
export type KeyResolution =
  | { readonly status: 'dispatch'; readonly intent: Intent; readonly tier: 1 | 2 | 3 }
  | { readonly status: 'armed'; readonly prefix: PendingPrefix }
  | { readonly status: 'pending'; readonly prefix: PendingPrefix }
  | { readonly status: 'passthrough' }
  | { readonly status: 'hint'; readonly hint: HintModel }
  | { readonly status: 'rejected'; readonly code: 'ambiguous-key' }
  | { readonly status: 'timeout' };

type TierLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'bound'; readonly verbId: string };

function makeIntent(verbId: string, input: ResolverInput): Intent {
  return {
    verbId,
    args: {},
    channel: input.channel ?? 'keyboard',
    actor: input.actor ?? 'human',
  };
}

/** §4.1 — distinct target ids at one tier; ≥ 2 distinct targets ⇒ ambiguity (§4.1). */
function lookup(bindings: readonly KeyBinding[] | undefined): TierLookup {
  const targets: string[] = [];
  for (const binding of bindings ?? []) {
    const target = binding.kind === 'verb' ? binding.verbId : binding.placeId;
    if (!targets.includes(target)) targets.push(target);
  }
  if (targets.length > 1) return { kind: 'ambiguous' };
  if (targets.length === 1) return { kind: 'bound', verbId: targets[0] };
  return { kind: 'none' };
}

/** §4.1 tier 1 — an exact binding on the current place's `keys`. */
function lookupPlace(reg: SurfaceRegistry, placeId: string, stroke: string): TierLookup {
  return lookup(reg.bindingsByPlace.get(placeId)?.get(stroke));
}

/** §4.1 tier 2 — an application-level direct alias. */
function lookupAlias(reg: SurfaceRegistry, stroke: string): TierLookup {
  return lookup(reg.aliasByStroke.get(stroke));
}

/** §4.1 tier 4 — a quiet hint: no intent, no rows, no delay. */
function quietHint(): KeyResolution {
  return { status: 'hint', hint: { kind: 'next', rows: [], readyAfterMs: 0 } };
}

/** Arm a prefix at `sequence`; the caller's `nowMs` becomes `armedAtMs`. */
function armed(sequence: string, nowMs: number): KeyResolution {
  return { status: 'armed', prefix: { sequence, armedAtMs: nowMs } };
}

/** §4.1 — create an armed prefix from a normalized sequence. */
export function createPendingPrefix(sequence: string, armedAtMs: number): PendingPrefix {
  return { sequence: normalizeStroke(sequence) ?? sequence, armedAtMs };
}

/**
 * §4.1 — resolve one stroke.
 *
 * Order: passthrough → pending timeout → engine Escape → tier 3 (only while armed) →
 * tier 1 → arm → tier 2 → tier 4. Tiers 1 and 2 are never consulted for the stroke that
 * follows an armed prefix unless the prefix has no continuation, in which case the prefix
 * is cancelled and the SAME stroke is re-resolved from tier 1 (REQ-02.3).
 */
export function resolveStroke(input: ResolverInput): KeyResolution {
  // §4.1 pass-through: a consumer-owned keyboard is absolute — no key, no alias, no arm.
  const owner = input.keyboardOwner ?? 'engine';
  if (owner !== 'engine') return { status: 'passthrough' };

  // §4.1 timeout: `>=` the constant, no fallback to the prefix's own binding.
  if (input.pending !== null && input.nowMs - input.pending.armedAtMs >= PENDING_TIMEOUT_MS) {
    return { status: 'timeout' };
  }

  const reg = createRegistry(input.surface);
  const currentPlaceId =
    input.placePath.length > 0
      ? input.placePath[input.placePath.length - 1]
      : reg.rootId;
  const normalized = normalizeStroke(input.stroke);

  // §2.2 Escape: one press pops exactly one level; at the root it dispatches nothing
  // (the host reports `overlayClose` through ST-2's dispatch). It also cancels an
  // armed prefix as part of the same press.
  if (normalized === 'Escape') {
    if (input.placePath.length > 1) {
      return {
        status: 'dispatch',
        intent: makeIntent(PLACE_EXIT_VERB_ID, input),
        tier: 1,
      };
    }
    return quietHint();
  }

  // §4.4 a non-bindable token is a tier-4 no-match, never a throw (Reading #6).
  if (normalized === null) return quietHint();

  // §4.1 tier 3 — while armed, the continuation set is consulted FIRST and alone.
  if (input.pending !== null) {
    const sequence = serializeStrokes([...splitStrokes(input.pending.sequence), normalized]);
    const continuation = lookupPlace(reg, currentPlaceId, sequence);
    if (continuation.kind === 'ambiguous') {
      return { status: 'rejected', code: 'ambiguous-key' };
    }
    if (continuation.kind === 'bound') {
      return { status: 'dispatch', intent: makeIntent(continuation.verbId, input), tier: 3 };
    }
    if (continuationStrokes(reg, currentPlaceId, sequence).length > 0) {
      return armed(sequence, input.nowMs);
    }
    // No continuation: the prefix is cancelled and this stroke falls through to tier 1
    // IN THE SAME CALL (REQ-02.3) — `pending` is simply dropped below.
  }

  // §4.1 tier 1 — an exact binding on the current place's keys.
  const place = lookupPlace(reg, currentPlaceId, normalized);
  if (place.kind === 'ambiguous') return { status: 'rejected', code: 'ambiguous-key' };
  if (place.kind === 'bound') {
    return { status: 'dispatch', intent: makeIntent(place.verbId, input), tier: 1 };
  }

  // §4.1 — arm only a NON-EMPTY continuation set; an empty one falls through to tier 2.
  if (continuationStrokes(reg, currentPlaceId, normalized).length > 0) {
    return armed(normalized, input.nowMs);
  }

  // §4.1 tier 2 — an application-level direct alias.
  const alias = lookupAlias(reg, normalized);
  if (alias.kind === 'ambiguous') return { status: 'rejected', code: 'ambiguous-key' };
  if (alias.kind === 'bound') {
    return { status: 'dispatch', intent: makeIntent(alias.verbId, input), tier: 2 };
  }

  // §4.1 tier 4 — nothing matched: surface a quiet hint, dispatch nothing.
  return quietHint();
}
