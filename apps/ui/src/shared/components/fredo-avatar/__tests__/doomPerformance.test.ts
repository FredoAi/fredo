/**
 * #3223 ST-2 — the Doom performance state machine (the transition table + the
 * settled invariant + the deterministic flourish).
 *
 * The store is driven here exactly as the hook drives it: a fake renderer is bound
 * through `bindDoomPerformanceRenderer` (records every `setDoomPerformance` push)
 * and reports one-shot completions through `completeDoomOneShot`. That is the ONE
 * push path, so a fake records precisely what a live renderer receives.
 *
 * Binding mechanism note: there is NO `pendingExit`/`pendingEntry` slot. Every edge
 * rewrites ONE `desiredEngaged` mirror and every completion runs one `settle()`.
 * These pins assert the BEHAVIOUR and the snapshot — never a boolean name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOOM_WEAPON_CLIP,
  getDoomWeapon,
  type DoomClipName,
  type DoomPerformance,
} from '../doomClips';
import {
  DOOM_FLOURISH_INTERVAL_MS,
  DOOM_FLOURISH_MS,
  bindDoomPerformanceRenderer,
  completeDoomOneShot,
  getDoomPerformancePush,
  getDoomPerformanceSnapshot,
  resetDoomPerformanceForTests,
  resolveDoomClip,
  setDoomPerformanceEngaged,
  setDoomPerformanceReducedMotion,
  setDoomPerformanceSuspended,
  subscribeDoomPerformance,
} from '../doomPerformance';

type Push = DoomClipName | null;

interface Rig {
  /** Every performance the store pushed, oldest first (`null` = hand back). */
  readonly pushes: Push[];
  /** The most recent push. */
  readonly last: () => Push;
}

const unbinds: Array<() => void> = [];

/** Bind a fake renderer (the hook's own path) and record its pushes. */
function connect(): Rig {
  const pushes: Push[] = [];
  const target = {
    setDoomPerformance: (performance: DoomPerformance | null): void => {
      pushes.push(performance?.clip ?? null);
    },
  };
  unbinds.push(bindDoomPerformanceRenderer(target));
  // The bridge seeds the CURRENT performance on connect; these pins care about the
  // pushes a transition causes, so the seed is dropped.
  pushes.length = 0;
  return { pushes, last: () => pushes[pushes.length - 1] ?? null };
}

/**
 * What the APPLIED clip actually did: consecutive duplicates collapsed. A
 * mirror-only edge may re-publish the same clip (a renderer no-ops on it), so the
 * behavioural assertion is the sequence, not the raw push count.
 */
function sequence(rig: Rig): Push[] {
  return rig.pushes.filter((push, index) => index === 0 || push !== rig.pushes[index - 1]);
}

/** Drive one full engagement to the armour idle (callers use the weapon they set). */
function engageAndSettle(rig: Rig): DoomClipName {
  setDoomPerformanceEngaged(true);
  completeDoomOneShot('doom-in');
  const clip = getDoomPerformanceSnapshot().clip;
  expect(clip).not.toBeNull();
  expect(rig.last()).toBe(clip);
  return clip as DoomClipName;
}

/** Drive one full engagement to a clean idle (the 12-state hand-back). */
function releaseAndSettle(rig: Rig): void {
  setDoomPerformanceEngaged(false);
  completeDoomOneShot('doom-out');
  expect(getDoomPerformanceSnapshot().phase).toBe('idle');
  expect(rig.last()).toBeNull();
}

/**
 * The invariant asserted after EVERY completion.
 *
 * The mode's engagement flag and the phase must agree: engaged ⇔ the performance is
 * not idle/retracting. Once the completion comes to rest (i.e. it did not hand over
 * to another in-flight one-shot) this is the plan's literal settled form
 * `desiredEngaged === (phase === 'holding' || phase === 'flourishing')`.
 */
function expectSettled(): void {
  const snapshot = getDoomPerformanceSnapshot();
  expect(snapshot.desiredEngaged).toBe(
    snapshot.phase !== 'idle' && snapshot.phase !== 'exiting',
  );
  if (snapshot.phase !== 'entering') {
    expect(snapshot.desiredEngaged).toBe(
      snapshot.phase === 'holding' || snapshot.phase === 'flourishing',
    );
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDoomPerformanceForTests({ resetWeaponCursor: true });
});

afterEach(() => {
  while (unbinds.length > 0) unbinds.pop()?.();
  resetDoomPerformanceForTests({ resetWeaponCursor: true });
  vi.useRealTimers();
});

describe('#3223 resolveDoomClip — the one phase table', () => {
  it('maps each phase to its authored clip and `idle` to nothing', () => {
    expect(resolveDoomClip('idle', 'shotgun')).toBeNull();
    expect(resolveDoomClip('entering', 'shotgun')).toBe('doom-in');
    expect(resolveDoomClip('holding', 'shotgun')).toBe('doom-idle');
    expect(resolveDoomClip('holding', 'machine-gun')).toBe('doom-mg');
    expect(resolveDoomClip('holding', 'energy-sword')).toBe('doom-sword');
    expect(resolveDoomClip('flourishing', 'energy-sword')).toBe('doom-shoot');
    expect(resolveDoomClip('exiting', 'energy-sword')).toBe('doom-out');
  });
});

describe('#3223 the transition table', () => {
  it('plays the intro, settles into the weapon idle, retracts, and resumes', () => {
    const rig = connect();

    setDoomPerformanceEngaged(true);
    let snapshot = getDoomPerformanceSnapshot();
    expect(snapshot.phase).toBe('entering');
    expect(snapshot.weapon).toBe('shotgun');
    expect(snapshot.clip).toBe('doom-in');
    expect(sequence(rig)).toEqual(['doom-in']);

    completeDoomOneShot('doom-in');
    expectSettled();
    snapshot = getDoomPerformanceSnapshot();
    expect(snapshot.phase).toBe('holding');
    expect(snapshot.clip).toBe(DOOM_WEAPON_CLIP.shotgun);
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP.shotgun);

    setDoomPerformanceEngaged(false);
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    expect(rig.last()).toBe('doom-out');

    completeDoomOneShot('doom-out');
    expectSettled();
    snapshot = getDoomPerformanceSnapshot();
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.clip).toBeNull();
    expect(rig.last()).toBeNull();
  });

  it('ignores a redundant engagement edge (a second activation is a no-op)', () => {
    const rig = connect();
    setDoomPerformanceEngaged(true);
    const pushesAfterFirst = rig.pushes.length;

    setDoomPerformanceEngaged(true);
    expect(rig.pushes.length).toBe(pushesAfterFirst);
    expect(getDoomPerformanceSnapshot().phase).toBe('entering');

    completeDoomOneShot('doom-in');
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
    completeDoomOneShot('doom-in');
    // A duplicate completion from a second mounted surface is idempotent.
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP.shotgun);
  });
});

describe('#3223 release mid-`entering` — the intro always completes', () => {
  it('holds the release intent in the mirror and retracts only after `finished`', () => {
    const rig = connect();

    setDoomPerformanceEngaged(true);
    expect(sequence(rig)).toEqual(['doom-in']);

    // Release while the intro is in flight: the clip must NOT change and the intro
    // must NOT be cut (`doom-in → <state>` is the half-armoured state AC5 bans).
    setDoomPerformanceEngaged(false);
    expect(getDoomPerformanceSnapshot().phase).toBe('entering');
    expect(sequence(rig)).toEqual(['doom-in']);

    completeDoomOneShot('doom-in');
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    expect(sequence(rig)).toEqual(['doom-in', 'doom-out']);
    // NOT settled yet — the invariant is asserted on completion only.
    completeDoomOneShot('doom-out');
    expectSettled();
    expect(getDoomPerformanceSnapshot().phase).toBe('idle');
  });
});

describe('#3223 re-engage mid-`exiting` — a fresh intro, the NEXT weapon', () => {
  it('completes the retract and advances the weapon exactly once', () => {
    const rig = connect();

    expect(engageAndSettle(rig)).toBe(DOOM_WEAPON_CLIP.shotgun);

    setDoomPerformanceEngaged(false);
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');

    // The entry edge only rewrites the mirror while `doom-out` plays.
    setDoomPerformanceEngaged(true);
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    expect(rig.last()).toBe('doom-out');

    completeDoomOneShot('doom-out');
    expectSettled();
    const snapshot = getDoomPerformanceSnapshot();
    expect(snapshot.phase).toBe('entering');
    expect(snapshot.weapon).toBe('machine-gun');
    expect(rig.last()).toBe('doom-in');

    completeDoomOneShot('doom-in');
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
    expect(getDoomPerformanceSnapshot().clip).toBe(DOOM_WEAPON_CLIP['machine-gun']);
    expect(getDoomWeapon()).toBe('machine-gun');
  });
});

describe('#3223 repeated edges (coalesce-to-latest, F-AV-25 leg C / F-AV-29)', () => {
  it('converges on the mode ACTUAL state after a double flick inside one intro', () => {
    const rig = connect();

    // false→true→false→true inside one `doom-in`.
    setDoomPerformanceEngaged(true);
    setDoomPerformanceEngaged(false);
    setDoomPerformanceEngaged(true);
    expect(getDoomPerformanceSnapshot().phase).toBe('entering');
    expect(sequence(rig)).toEqual(['doom-in']);

    completeDoomOneShot('doom-in');
    expectSettled();
    // Armed, never un-armoured with the mode ON.
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
    expect(getDoomPerformanceSnapshot().desiredEngaged).toBe(true);
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP.shotgun);
    // One engagement: the weapon advanced exactly once.
    expect(getDoomPerformanceSnapshot().weapon).toBe('shotgun');
  });

  it('converges on OFF after a double flick inside one retract', () => {
    const rig = connect();
    engageAndSettle(rig);

    // true→false→true→false inside one `doom-out`.
    setDoomPerformanceEngaged(false);
    setDoomPerformanceEngaged(true);
    setDoomPerformanceEngaged(false);
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    expect(rig.last()).toBe('doom-out');

    completeDoomOneShot('doom-out');
    expectSettled();
    // Un-armoured, never armoured with the mode OFF.
    expect(getDoomPerformanceSnapshot().phase).toBe('idle');
    expect(getDoomPerformanceSnapshot().desiredEngaged).toBe(false);
    expect(rig.last()).toBeNull();
  });

  it('settles correctly with three edges inside one one-shot', () => {
    const rig = connect();
    setDoomPerformanceEngaged(true);
    setDoomPerformanceEngaged(false);
    setDoomPerformanceEngaged(true);
    setDoomPerformanceEngaged(false);
    completeDoomOneShot('doom-in');
    expectSettled();
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    completeDoomOneShot('doom-out');
    expectSettled();
    expect(getDoomPerformanceSnapshot().phase).toBe('idle');
  });
});

describe('#3223 the weapon cycle (REQ-2)', () => {
  it('cycles shotgun → machine-gun → energy-sword and wraps on the fourth engagement', () => {
    const rig = connect();
    const seen: Push[] = [];

    for (let engagement = 1; engagement <= 4; engagement += 1) {
      seen.push(engageAndSettle(rig));
      releaseAndSettle(rig);
    }

    expect(seen).toEqual([
      DOOM_WEAPON_CLIP.shotgun,
      DOOM_WEAPON_CLIP['machine-gun'],
      DOOM_WEAPON_CLIP['energy-sword'],
      DOOM_WEAPON_CLIP.shotgun,
    ]);
  });

  it('keeps the cursor across a surface remount (module scope, not a ref)', () => {
    const first = connect();
    engageAndSettle(first);
    releaseAndSettle(first);
    unbinds.pop()?.();

    // A brand-new surface (the away overlay) binds onto the SAME module store.
    const second = connect();
    expect(engageAndSettle(second)).toBe(DOOM_WEAPON_CLIP['machine-gun']);
  });
});

describe('#3223 the flourish — deterministic, timer-ended, weapon-independent', () => {
  it('fires once at 9 s of holding, lasts 1.333 s, and returns to the SAME weapon idle', () => {
    const rig = connect();
    engageAndSettle(rig);
    const holdingClip = getDoomPerformanceSnapshot().clip;

    // Nothing before the interval elapses.
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS - 1);
    expect(rig.last()).toBe(holdingClip);

    vi.advanceTimersByTime(1);
    expect(getDoomPerformanceSnapshot().phase).toBe('flourishing');
    expect(rig.last()).toBe('doom-shoot');

    // `doom-shoot` is a LOOP: no `finished` is ever emitted for it. The timer ends it.
    vi.advanceTimersByTime(DOOM_FLOURISH_MS - 1);
    expect(getDoomPerformanceSnapshot().phase).toBe('flourishing');

    vi.advanceTimersByTime(1);
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
    expect(rig.last()).toBe(holdingClip);
    // Exactly ONE flourish in 9 s + 1.333 s of holding.
    expect(rig.pushes.filter((push) => push === 'doom-shoot')).toHaveLength(1);
  });

  it('never chains: the interval restarts on every entry into `holding`', () => {
    const rig = connect();
    engageAndSettle(rig);

    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS);
    vi.advanceTimersByTime(DOOM_FLOURISH_MS);
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');

    // The next flourish needs a FULL fresh interval.
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS - 1);
    expect(rig.pushes.filter((push) => push === 'doom-shoot')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(rig.pushes.filter((push) => push === 'doom-shoot')).toHaveLength(2);
  });

  it('never starts from `entering` or from `exiting`', () => {
    const rig = connect();

    setDoomPerformanceEngaged(true);
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS * 3);
    expect(getDoomPerformanceSnapshot().phase).toBe('entering');
    expect(rig.pushes).not.toContain('doom-shoot');

    completeDoomOneShot('doom-in');
    setDoomPerformanceEngaged(false);
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS * 3);
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    expect(rig.pushes).not.toContain('doom-shoot');
  });

  it('is weapon-independent — a machine-gun engagement still plays `doom-shoot`', () => {
    const rig = connect();
    engageAndSettle(rig);
    releaseAndSettle(rig);

    expect(engageAndSettle(rig)).toBe(DOOM_WEAPON_CLIP['machine-gun']);
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS);
    expect(rig.last()).toBe('doom-shoot');
    vi.advanceTimersByTime(DOOM_FLOURISH_MS);
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP['machine-gun']);
  });

  it('never survives a release: the retract starts immediately and clears the cadence', () => {
    const rig = connect();
    engageAndSettle(rig);

    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS);
    expect(getDoomPerformanceSnapshot().phase).toBe('flourishing');

    setDoomPerformanceEngaged(false);
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    expect(rig.last()).toBe('doom-out');

    // The cleared intervals cannot resurrect a flourish after the retract settles.
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS * 2);
    expect(getDoomPerformanceSnapshot().phase).toBe('exiting');
    completeDoomOneShot('doom-out');
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS * 2);
    expect(getDoomPerformanceSnapshot().phase).toBe('idle');
    expect(rig.pushes.filter((push) => push === 'doom-shoot')).toHaveLength(1);
  });

  it('ends on the timer even if the renderer never reports a completion', () => {
    const rig = connect();
    engageAndSettle(rig);
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS);
    expect(rig.last()).toBe('doom-shoot');
    // No `completeDoomOneShot('doom-shoot')` anywhere in this test.
    vi.advanceTimersByTime(DOOM_FLOURISH_MS);
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
  });
});

describe('#3223 teleport suspension (REQ-9, R-4)', () => {
  it('pushes `null`, freezes the phase and clears the cadence', () => {
    const rig = connect();
    engageAndSettle(rig);

    setDoomPerformanceSuspended(true);
    expect(rig.last()).toBeNull();
    expect(getDoomPerformancePush()).toBeNull();
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');

    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS * 2);
    expect(rig.pushes).not.toContain('doom-shoot');
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');

    setDoomPerformanceSuspended(false);
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP.shotgun);
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS);
    expect(rig.last()).toBe('doom-shoot');
  });

  it('restarts an interrupted intro on resume (its `finished` was swallowed)', () => {
    const rig = connect();
    setDoomPerformanceEngaged(true);
    expect(rig.last()).toBe('doom-in');

    setDoomPerformanceSuspended(true);
    // The interrupted intro's completion must not settle a frozen phase.
    completeDoomOneShot('doom-in');
    expect(getDoomPerformanceSnapshot().phase).toBe('entering');

    setDoomPerformanceSuspended(false);
    expect(sequence(rig)).toEqual(['doom-in', null, 'doom-in']);

    completeDoomOneShot('doom-in');
    expectSettled();
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
  });

  it('drops a flourish interrupted by a teleport back to the weapon idle', () => {
    const rig = connect();
    engageAndSettle(rig);
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS);
    expect(getDoomPerformanceSnapshot().phase).toBe('flourishing');

    setDoomPerformanceSuspended(true);
    expect(rig.last()).toBeNull();

    setDoomPerformanceSuspended(false);
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP.shotgun);
    // The cadence restarts from the resume (never an immediate second flourish).
    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS - 1);
    expect(rig.pushes.filter((push) => push === 'doom-shoot')).toHaveLength(1);
  });
});

describe('#3223 reduced motion (REQ-11 / UX-14)', () => {
  it('swaps instantly to the weapon idle still and never plays the intro or flourish', () => {
    const rig = connect();
    setDoomPerformanceReducedMotion(true);

    setDoomPerformanceEngaged(true);
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP.shotgun);
    expect(rig.pushes).not.toContain('doom-in');

    vi.advanceTimersByTime(DOOM_FLOURISH_INTERVAL_MS * 3);
    expect(rig.pushes).not.toContain('doom-shoot');

    setDoomPerformanceEngaged(false);
    expect(getDoomPerformanceSnapshot().phase).toBe('idle');
    expect(rig.last()).toBeNull();
  });

  it('keeps the weapon cycle legible across engagements', () => {
    const rig = connect();
    setDoomPerformanceReducedMotion(true);

    const seen: Push[] = [];
    for (let engagement = 1; engagement <= 3; engagement += 1) {
      setDoomPerformanceEngaged(true);
      seen.push(rig.last());
      setDoomPerformanceEngaged(false);
    }

    expect(seen).toEqual([
      DOOM_WEAPON_CLIP.shotgun,
      DOOM_WEAPON_CLIP['machine-gun'],
      DOOM_WEAPON_CLIP['energy-sword'],
    ]);
  });

  it('resolves an in-flight intro to the still pose when the preference flips on', () => {
    const rig = connect();
    setDoomPerformanceEngaged(true);
    expect(getDoomPerformanceSnapshot().phase).toBe('entering');

    setDoomPerformanceReducedMotion(true);
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP.shotgun);
  });
});

describe('#3223 the store surface', () => {
  it('notifies subscribers on a change and returns a stable snapshot otherwise', () => {
    const rig = connect();
    const listener = vi.fn();
    const unsubscribe = subscribeDoomPerformance(listener);

    const before = getDoomPerformanceSnapshot();
    expect(getDoomPerformanceSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    setDoomPerformanceEngaged(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDoomPerformanceSnapshot()).not.toBe(before);
    expect(getDoomPerformanceSnapshot().phase).toBe('entering');

    unsubscribe();
    completeDoomOneShot('doom-in');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(rig.last()).toBe(DOOM_WEAPON_CLIP.shotgun);
  });

  it('resets to the pre-session state but keeps the weapon cursor unless asked', () => {
    const rig = connect();
    setDoomPerformanceEngaged(true);
    completeDoomOneShot('doom-in');
    expect(getDoomPerformanceSnapshot().weapon).toBe('shotgun');

    resetDoomPerformanceForTests();
    expect(getDoomPerformanceSnapshot()).toMatchObject({
      phase: 'idle',
      clip: null,
      desiredEngaged: false,
      suspended: false,
      reducedMotion: false,
    });

    // The cursor survives a plain reset (a shipped behaviour), so the NEXT
    // engagement advances rather than restarting at the shotgun.
    expect(engageAndSettle(rig)).toBe(DOOM_WEAPON_CLIP['machine-gun']);

    resetDoomPerformanceForTests({ resetWeaponCursor: true });
    expect(getDoomWeapon()).toBe('shotgun');
  });
});
