/**
 * The Doom PERFORMANCE state machine (Spec #3223 ST-2) — module scope, no React.
 *
 * The engagement signal the app exposes is a single boolean
 * (`isDoomVisualEngaged()` — `entering`, `active` and `exiting` all read `true`),
 * so it has exactly two edges and NO transition lifecycle. The whole
 * `doom-in → weapon idle (+flourish) → doom-out` sequence therefore lives here,
 * sequenced from those two edges and from the mixer's one-shot completions.
 *
 * ```
 * idle ⇄ entering ⇄ holding ⇄ flourishing
 *          ↕            ↓            ↓
 *          └──────→ exiting ←────────┘
 * ```
 *
 * ## One mirror, one settle (binding rule — no pending booleans)
 *
 * There is NO `pendingExit` / `pendingEntry` slot and NO queue. The store keeps
 * exactly one authoritative field, `desiredEngaged`, rewritten by every observed
 * edge; every one-shot completion runs ONE `settle()` that re-reads it. A
 * `false→true→false→true` flick inside one `doom-in` therefore converges on the
 * mode's ACTUAL state (`holding`), never on edge order — the figure is never left
 * un-armoured with the mode ON, nor armoured with it OFF.
 *
 * Invariant, asserted after EVERY completion:
 *   `desiredEngaged === (phase === 'holding' || phase === 'flourishing')`
 *
 * ## Who ends what
 *
 * `doom-in` / `doom-out` are ONE-SHOTS ended by the mixer's `finished` (pushed
 * back here through `completeDoomOneShot`) — never a wall-clock timer, so a hidden
 * window cannot strand the armour. `doom-shoot` is a LOOP clip and emits no
 * `finished`, so the flourish is ended by the deterministic `DOOM_FLOURISH_MS`
 * timer. There is no RNG: every host sees the same beat.
 *
 * Everything here is module-scoped BY DESIGN — the phase and the weapon cursor
 * must survive component mount/unmount (the seat mascot and the away overlay are
 * different mounts of the same performance). React refs reset on every mount.
 */

import {
  DOOM_WEAPON_CLIP,
  advanceDoomWeapon,
  getDoomWeapon,
  resetDoomWeaponForTests,
  type DoomClipName,
  type DoomPerformance,
  type DoomWeapon,
} from './doomClips';

/**
 * The flourish cadence: 9 s of CONTINUOUS holding after the intro settles, then
 * one authored 1.333 s loop. First tick ≈ 10.3 s after engagement, duty cycle
 * ≈ 13 %, silence:action ≈ 6.8:1 — what makes it read as an idle tic rather than
 * a loop. Deterministic, no RNG: the same beat lands on every host.
 */
export const DOOM_FLOURISH_INTERVAL_MS = 9000;

/** One authored flourish loop (the `doom-shoot` clip's length). */
export const DOOM_FLOURISH_MS = 1333;

export type DoomPerformancePhase = 'idle' | 'entering' | 'holding' | 'flourishing' | 'exiting';

/** The one shape every consumer reads (a stable object between publications). */
export interface DoomPerformanceSnapshot {
  readonly phase: DoomPerformancePhase;
  /** The CURRENT engagement's weapon (the cursor's value). */
  readonly weapon: DoomWeapon;
  /** The phase's clip (`null` only in `idle`). */
  readonly clip: DoomClipName | null;
  /**
   * The ONE authoritative engagement mirror — the observed
   * `isDoomVisualEngaged()` value, rewritten by every edge. `settle()` re-reads it
   * on every one-shot completion; it is never a queued request.
   */
  readonly desiredEngaged: boolean;
  /** True while a teleport outranks the overlay (the renderer is pushed `null`). */
  readonly suspended: boolean;
  /** True while the host prefers reduced motion (no intro/outro, no flourish). */
  readonly reducedMotion: boolean;
}

/** The renderer surface this store drives. */
export interface DoomPerformanceTarget {
  setDoomPerformance(performance: DoomPerformance | null): void;
}

type Listener = () => void;

let phase: DoomPerformancePhase = 'idle';
let weapon: DoomWeapon = getDoomWeapon();
let desiredEngaged = false;
let suspended = false;
let reducedMotion = false;

/** The pending 9 s "hold long enough" beat. */
let flourishDueTimer: ReturnType<typeof setTimeout> | null = null;
/** The pending 1.333 s flourish end. */
let flourishEndTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<Listener>();

let snapshot: DoomPerformanceSnapshot = buildSnapshot();

function buildSnapshot(): DoomPerformanceSnapshot {
  return {
    phase,
    weapon,
    clip: resolveDoomClip(phase, weapon),
    desiredEngaged,
    suspended,
    reducedMotion,
  };
}

/**
 * The clip a phase requests, or `null` in `idle`. Pure — the phase table is the
 * ONE place a Doom clip is chosen.
 */
export function resolveDoomClip(
  next: DoomPerformancePhase,
  held: DoomWeapon,
): DoomClipName | null {
  switch (next) {
    case 'idle':
      return null;
    case 'entering':
      return 'doom-in';
    case 'holding':
      return DOOM_WEAPON_CLIP[held];
    case 'flourishing':
      return 'doom-shoot';
    case 'exiting':
      return 'doom-out';
  }
}

/** Publish the new snapshot and notify every subscriber (one object per change). */
function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

function clearFlourishTimers(): void {
  if (flourishDueTimer !== null) {
    clearTimeout(flourishDueTimer);
    flourishDueTimer = null;
  }
  if (flourishEndTimer !== null) {
    clearTimeout(flourishEndTimer);
    flourishEndTimer = null;
  }
}

/**
 * Arm the ONE 9 s "continuous holding" beat. It restarts on every entry into
 * `holding` (including the end of a flourish), so two flourishes are never
 * adjacent and rapid re-engagement cannot stoke it.
 */
function armFlourishInterval(): void {
  clearFlourishTimers();
  if (reducedMotion || suspended || phase !== 'holding') return;
  flourishDueTimer = setTimeout(startFlourish, DOOM_FLOURISH_INTERVAL_MS);
}

/** The flourish tick — only ever from `holding` (never from `entering`/`exiting`). */
function startFlourish(): void {
  flourishDueTimer = null;
  if (phase !== 'holding' || suspended || reducedMotion) return;
  phase = 'flourishing';
  flourishEndTimer = setTimeout(endFlourish, DOOM_FLOURISH_MS);
  publish();
}

/** End the flourish on the TIMER (`doom-shoot` loops and never emits `finished`). */
function endFlourish(): void {
  flourishEndTimer = null;
  if (phase !== 'flourishing') return;
  phase = 'holding';
  armFlourishInterval();
  publish();
}

/** A new engagement: advance the weapon exactly once and play the intro. */
function enter(): void {
  weapon = advanceDoomWeapon();
  phase = 'entering';
  clearFlourishTimers();
}

/** Settle into the armour idle (the flourish cadence restarts from here). */
function hold(): void {
  phase = 'holding';
  armFlourishInterval();
}

/** Begin the retract. A pending/flourishing beat never delays or survives it. */
function exit(): void {
  phase = 'exiting';
  clearFlourishTimers();
}

/**
 * The engagement edge. Writes the mirror and applies the phase table; a repeated
 * edge while a one-shot is in flight changes ONLY the mirror.
 */
export function setDoomPerformanceEngaged(engaged: boolean): void {
  // A repeated edge is inert: the mirror already holds the observed value, so
  // there is nothing to rewrite and nothing to restart (a second `iddqd` while
  // engaged is a no-op — it never advances the weapon or replays the intro).
  if (engaged === desiredEngaged) return;
  desiredEngaged = engaged;

  if (reducedMotion) {
    // Instant costume swap: no intro, no retract, no flourish.
    if (engaged) {
      if (phase === 'idle') {
        weapon = advanceDoomWeapon();
        phase = 'holding';
      }
    } else if (phase !== 'idle') {
      phase = 'idle';
    }
    clearFlourishTimers();
    publish();
    return;
  }

  if (engaged) {
    if (phase === 'idle') enter();
    // entering / exiting / holding / flourishing: the mirror is the whole change.
  } else if (phase === 'holding' || phase === 'flourishing') {
    exit();
  }
  // entering / exiting keep playing: the in-flight one-shot always completes.

  publish();
}

/**
 * A Doom one-shot completed (the renderer's `finished`). Runs the ONE `settle()`
 * that re-reads `desiredEngaged`. Guarded on the current phase, so two mounted
 * surfaces reporting the same completion are idempotent.
 */
export function completeDoomOneShot(clip: DoomClipName): void {
  if (reducedMotion) return;
  // A teleport swallowed the intro/outro: the completion must not settle a phase
  // the suspension froze (the intro restarts on resume — R-4).
  if (suspended) return;

  if (clip === 'doom-in') {
    if (phase !== 'entering') return;
    if (desiredEngaged) hold();
    else exit();
  } else if (clip === 'doom-out') {
    if (phase !== 'exiting') return;
    if (desiredEngaged) enter();
    else {
      phase = 'idle';
      clearFlourishTimers();
    }
  } else {
    return;
  }

  publish();
}

/**
 * Suspend the overlay while a teleport outranks it. The phase is FROZEN and the
 * flourish cadence is cleared; the renderer is pushed `null`, so the consumer's
 * teleport clips play untouched. On resume the phase's clip is re-pushed, and an
 * `entering` intro restarts (its `finished` was swallowed by the teleport).
 */
export function setDoomPerformanceSuspended(next: boolean): void {
  if (next === suspended) return;
  suspended = next;
  clearFlourishTimers();
  if (next) {
    publish();
    return;
  }
  // A flourish cannot survive the interruption: it drops to the weapon idle and
  // the 9 s cadence restarts (never a frozen `flourishing` with no timer).
  if (phase === 'flourishing') phase = 'holding';
  if (phase === 'holding') armFlourishInterval();
  publish();
}

/**
 * Reduced motion: one still frame of the resolved Doom clip, an instant costume
 * swap (`idle → holding` on engage, `→ idle` on release), and no flourish.
 */
export function setDoomPerformanceReducedMotion(reduced: boolean): void {
  if (reduced === reducedMotion) return;
  reducedMotion = reduced;
  if (reduced) {
    clearFlourishTimers();
    if (phase === 'entering' || phase === 'exiting' || phase === 'flourishing') {
      phase = desiredEngaged ? 'holding' : 'idle';
    }
  } else if (phase === 'holding') {
    armFlourishInterval();
  }
  publish();
}

/** The current snapshot (a stable object between publications). */
export function getDoomPerformanceSnapshot(): DoomPerformanceSnapshot {
  return snapshot;
}

/**
 * What the renderer should be holding right now: `null` while idle or suspended
 * (the renderer then resumes the consumer's resolved 12-state clip), otherwise the
 * phase's clip.
 */
export function getDoomPerformancePush(): DoomPerformance | null {
  if (suspended) return null;
  return snapshot.clip ? { clip: snapshot.clip } : null;
}

/** Subscribe to performance changes (the renderer bridge below is one such reader). */
export function subscribeDoomPerformance(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Bridge a renderer into the store: pushes the current performance on connect and
 * every change after. Returns the unbind function. This is the ONE push path —
 * the hook and the unit suites both drive the store through it, so a fake renderer
 * records exactly what a live one receives.
 */
export function bindDoomPerformanceRenderer(target: DoomPerformanceTarget): () => void {
  const push = (): void => {
    target.setDoomPerformance(getDoomPerformancePush());
  };
  push();
  listeners.add(push);
  return () => {
    listeners.delete(push);
  };
}

/**
 * Reset the module store without a page reload. TEST-ONLY. The weapon cursor
 * survives a reset unless explicitly requested — its cross-mount persistence is a
 * shipped behaviour (the engagement cycle), not test noise.
 */
export function resetDoomPerformanceForTests(options?: { resetWeaponCursor?: boolean }): void {
  phase = 'idle';
  desiredEngaged = false;
  suspended = false;
  reducedMotion = false;
  clearFlourishTimers();
  if (options?.resetWeaponCursor) {
    resetDoomWeaponForTests();
  }
  weapon = getDoomWeapon();
  snapshot = buildSnapshot();
}
