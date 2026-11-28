/**
 * Spec #3243 ST-1 — the placement lifecycle (AC-4: placing always begins a fresh
 * conversation; leaving discards it).
 *
 * # What a placement is
 *
 * A placement is RELATIONAL, not positional: the companion's instruction
 * composer is open with a RESOLVED app target (the target chip reads
 * `for <App>`). Teleport stays the only relocation mechanism — nothing here
 * moves Fredo.
 *
 * This module holds that placement's identity and nothing else:
 *
 *   - a NEW `placementId` is minted on every placement (so two placements can
 *     never share one — R-4a), and
 *   - `clearPlacement()` discards it on leave (so a later placement of the SAME
 *     app is a fresh conversation — R-4b).
 *
 * The identity is what the per-turn `companion.injection` receipt carries, which
 * turns AC-4 from "true by reading the source" into a run-derived observable.
 *
 * # Why module-scoped, and why nothing is persisted
 *
 * React refs reset on every mount/unmount cycle and the composer's `useState`
 * dies with the box, while the placement must survive a re-render and outlive
 * the box's own tree — so the live value lives at MODULE scope (the same shape
 * as `shared/companion/grounding.ts` and `shared/doom-mode/performanceGate.ts`).
 *
 * Deliberately TRANSIENT: nothing is written to `localStorage`, a settings key,
 * or the backend. Persisting a placement would resurrect a previous placement's
 * identity after a restart — exactly the "recalled across placements" defect
 * AC-4 forbids. This module therefore adds no transcript, no turn array and no
 * history of any kind: it stores ONE identity and no conversation.
 *
 * Pure of React, DOM and IPC by construction: it is a module-scoped value plus a
 * listener set, so it can be unit-tested without a renderer and read at turn
 * time with no render cycle.
 */

/** The identity of the placement Fredo is currently in. */
export interface Placement {
  /** A fresh identity per placement. Never reused, never persisted. */
  readonly placementId: string;
  /** The application the placement is scoped to. */
  readonly appId: string;
  /** The application's display name (the target chip's datum). */
  readonly appName: string;
  /**
   * The placement's mint sequence (1 for the first placement in this webview,
   * 2 for the next, …). A monotonic counter, never a clock: it makes "the
   * identity is new" observable without making the store time-dependent.
   */
  readonly startedAtSeq: number;
}

type Listener = () => void;

/** The live placement, or `null` when Fredo is not placed. */
let current: Placement | null = null;

/** The mint counter (monotonic; advances only on an actual placement). */
let mintSeq = 0;

/** The subscribers (one set for the module — no per-consumer channel). */
const listeners = new Set<Listener>();

function notify(): void {
  // Snapshot: a listener may unsubscribe (or subscribe) while being notified.
  for (const listener of [...listeners]) listener();
}

/**
 * A unique id for one placement. `crypto.randomUUID()` (AGENTS.md forbids the
 * `uuid` package); the fallback keeps a host without the Web Crypto randomUUID
 * method from silently minting an empty id — it composes the mint sequence with
 * a random suffix, which is unique within this webview.
 */
function mintPlacementId(seq: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `placement-${seq}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Mint a placement for `appId` — the transition to a RESOLVED app target.
 *
 * ALWAYS mints a NEW identity, including for the SAME app: two placements of
 * `Wireframe` are two placements (R-4a). The store keeps no reference to the
 * previous placement, so nothing about it can leak into the new one.
 *
 * FAILS CLOSED on a blank app id: no resolved target is not a placement (the
 * ungrounded composer session must read `placementId === ''`, not an identity
 * for an app nobody named). Returns the minted `Placement`, or `null` when the
 * id is blank and nothing was minted.
 */
export function placeFredo(appId: string, appName: string): Placement | null {
  const trimmedId = appId.trim();
  if (trimmedId === '') return null;

  mintSeq += 1;
  current = Object.freeze({
    placementId: mintPlacementId(mintSeq),
    appId: trimmedId,
    appName: appName.trim() === '' ? trimmedId : appName.trim(),
    startedAtSeq: mintSeq,
  });
  notify();
  return current;
}

/**
 * Discard the current placement — the transition away from a resolved target
 * (the placed instance closes / the order surface for that placement goes
 * away). Idempotent: clearing twice notifies once, so a duplicated leave (a
 * StrictMode double effect) cannot flap the state.
 */
export function clearPlacement(): void {
  if (current === null) return;
  current = null;
  notify();
}

/**
 * Re-SCOPE the live placement: point it at a DIFFERENT app while keeping the
 * SAME identity (ST-FP2, AC-3 / R-3b).
 *
 * # Why this exists, and what it fixes
 *
 * `placeFredo` conflates two different facts in one operation: the SCOPE (which
 * app the NEXT order targets) and the IDENTITY (which placement this is).
 *
 *   - The scope MUST follow a move: R-3b / F-17 require the next order's default
 *     target to be the NEW app, and the dispatcher reads the target from the
 *     placement.
 *   - The identity MUST NOT rotate on a move: `orderFlight.ts:20-43` states that
 *     a move does not end a placement, and keys an in-flight order's record on
 *     the placement identity. Minting a new identity mid-order orphaned the
 *     record — `readOrderFlight()` filtered it out, the settle early-returned
 *     `null` without notifying, and the ticker vanished.
 *
 * So a resolved-target change re-scopes IN PLACE. Nothing else about the
 * placement moves: `placementId` and `startedAtSeq` are RETAINED byte-for-byte,
 * which is what keeps the `companion.injection` receipt stable across a move (it
 * carries `placementId` with no sequence alongside it) and keeps "two
 * placements mint two distinct ids" true — a re-scope is NOT a mint.
 *
 * A no-op when nothing is placed (there is nothing to re-scope — a late first
 * resolution must MINT, and the caller decides that) or when the app is blank or
 * already the live one.
 */
export function rescopePlacement(appId: string, appName: string): Placement | null {
  if (current === null) return null;
  const trimmedId = appId.trim();
  if (trimmedId === '') return null;
  const trimmedName = appName.trim() === '' ? trimmedId : appName.trim();
  if (current.appId === trimmedId && current.appName === trimmedName) return current;

  current = Object.freeze({
    // RETAINED: the identity a flight (and a receipt) was begun under.
    placementId: current.placementId,
    startedAtSeq: current.startedAtSeq,
    // ADVANCED: the scope the NEXT order targets (R-3b / F-17).
    appId: trimmedId,
    appName: trimmedName,
  });
  notify();
  return current;
}

/** The live placement, or `null` when Fredo is not placed. */
export function readPlacement(): Placement | null {
  return current;
}

/**
 * Subscribe to placement changes (a mint or a clear). Returns the unsubscribe
 * function — the `useSyncExternalStore` listener contract.
 */
export function subscribePlacement(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drop the live placement and every subscriber. TEST ONLY — never call from
 * product code (a test-only reset must not become a leave path).
 */
export function resetPlacementForTests(): void {
  current = null;
  mintSeq = 0;
  listeners.clear();
}
