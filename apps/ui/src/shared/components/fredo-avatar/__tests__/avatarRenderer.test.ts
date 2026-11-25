/**
 * #3210 ST-3 — the renderer seam, the capability probe and the clip contract the
 * renderer consumes.
 *
 * jsdom has no GPU, so this suite never instantiates the real WebGL renderer: it
 * pins (a) the capability probe's ORDER — false on jsdom without a single
 * `getContext` call, so every existing avatar suite keeps a clean console (U-1);
 * (b) the module-level factory override the hook swaps in tests; (c) the 12-state
 * clip contract and the 400 ms one-shot window the renderer normalises into; and
 * (d) the one-shot completion rule.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AVATAR_CLIPS,
  AVATAR_CLIP_TIME_SCALE,
  AVATAR_ONE_SHOT_CLIPS,
  resolveAvatarMotion,
  type AvatarClipName,
} from '../avatarClips';
import { FREDO_AVATAR_STATES, type FredoAvatarState } from '../fredoAvatarStates';
import { probeAvatar3d } from '../three/avatarCapability';
import {
  createAvatarRenderer,
  isAvatarClipName,
  resolveAvatarRendererFactory,
  resolveFinishedClip,
  setAvatarRendererFactoryForTests,
} from '../three/avatarRenderer';

/** `ANIM_DURATION['teleport-out' | 'teleport-in']` — the shipped state window. */
const SHIPPED_TELEPORT_WINDOW_SECONDS = 0.4;

const ALL_STATES: readonly FredoAvatarState[] = FREDO_AVATAR_STATES;
const ALL_CLIPS = Object.keys(AVATAR_CLIPS) as AvatarClipName[];

afterEach(() => {
  setAvatarRendererFactoryForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probeAvatar3d (U-1: the probe short-circuits BEFORE getContext)', () => {
  it('reports false on a host without WebGL2 and never asks for a context', () => {
    // The precondition this suite relies on: jsdom has no WebGL2 global.
    expect(typeof WebGL2RenderingContext).toBe('undefined');

    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const consoleError = vi.spyOn(console, 'error');
    const consoleWarn = vi.spyOn(console, 'warn');

    expect(probeAvatar3d()).toBe(false);

    expect(getContext).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('reports true when the host exposes WebGL2, still without a context call', () => {
    vi.stubGlobal('WebGL2RenderingContext', class WebGL2RenderingContextStub {});
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');

    expect(probeAvatar3d()).toBe(true);
    expect(getContext).not.toHaveBeenCalled();
  });
});

describe('the 12-state clip contract as the renderer consumes it', () => {
  it('maps every state to exactly one same-named clip', () => {
    expect(ALL_CLIPS.slice().sort()).toEqual(ALL_STATES.slice().sort());
    for (const state of ALL_STATES) {
      expect(isAvatarClipName(state)).toBe(true);
      expect(AVATAR_CLIPS[state]).toBeDefined();
    }
  });

  it('rejects a non-vocabulary clip name', () => {
    expect(isAvatarClipName('dance')).toBe(false);
    expect(isAvatarClipName('')).toBe(false);
    expect(isAvatarClipName('IDLE')).toBe(false);
  });

  it('declares exactly the two teleport clips as one-shots', () => {
    expect(AVATAR_ONE_SHOT_CLIPS.slice().sort()).toEqual(['teleport-in', 'teleport-out']);
    for (const state of ALL_STATES) {
      if (state === 'teleport-out' || state === 'teleport-in') continue;
      expect(AVATAR_ONE_SHOT_CLIPS).not.toContain(state);
    }
  });

  it('normalises each one-shot into the shipped 400 ms window', () => {
    for (const clip of AVATAR_ONE_SHOT_CLIPS) {
      expect(AVATAR_CLIP_TIME_SCALE[clip] * SHIPPED_TELEPORT_WINDOW_SECONDS).toBeCloseTo(
        AVATAR_CLIPS[clip].durationSeconds,
        3,
      );
      expect(AVATAR_CLIP_TIME_SCALE[clip]).toBeCloseTo(
        AVATAR_CLIPS[clip].durationSeconds / SHIPPED_TELEPORT_WINDOW_SECONDS,
        3,
      );
    }
  });

  it('runs every state as `play` except a non-streaming talk, and `still` under reduced motion', () => {
    for (const state of ALL_STATES) {
      const expected: 'play' | 'still' = state === 'talk' ? 'still' : 'play';
      expect(resolveAvatarMotion(state, false, false)).toBe(expected);
      expect(resolveAvatarMotion(state, true, false)).toBe('play');
      expect(resolveAvatarMotion(state, true, true)).toBe('still');
      expect(resolveAvatarMotion(state, false, true)).toBe('still');
    }
  });
});

describe('resolveFinishedClip (one-shot completion, S-1/R-4)', () => {
  it('resumes the LATEST requested clip when the state machine moved on', () => {
    for (const clip of ALL_CLIPS) {
      const requested = clip === 'idle' ? ('happy' as AvatarClipName) : 'idle';
      expect(resolveFinishedClip(clip, requested)).toBe(requested);
    }
  });

  it('stays on the clamped final frame when the one-shot IS still the latest state', () => {
    for (const clip of ALL_CLIPS) {
      expect(resolveFinishedClip(clip, clip)).toBeNull();
    }
  });

  it('leaves teleport-out on its final frame (the empty seat) unless told otherwise', () => {
    expect(resolveFinishedClip('teleport-out', 'teleport-out')).toBeNull();
    expect(resolveFinishedClip('teleport-out', 'teleport-in')).toBe('teleport-in');
  });
});

describe('setAvatarRendererFactoryForTests (the injectable seam)', () => {
  it('swaps the factory in tests and restores the real one on null', () => {
    const fake = vi.fn() as unknown as typeof createAvatarRenderer;

    setAvatarRendererFactoryForTests(fake);
    expect(resolveAvatarRendererFactory()).toBe(fake);

    setAvatarRendererFactoryForTests(null);
    expect(resolveAvatarRendererFactory()).toBe(createAvatarRenderer);
  });
});
