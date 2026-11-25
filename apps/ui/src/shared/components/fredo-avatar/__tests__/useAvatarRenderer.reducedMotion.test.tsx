/**
 * #3210 ST-3 — `useAvatarRenderer` lifecycle through the injectable seam.
 *
 * The production poster path is what jsdom exercises through the component; this
 * suite drives the HOOK with a fake renderer installed by
 * `setAvatarRendererFactoryForTests`, which is how the scene's behaviour (loop
 * gating, clip mirroring, tint without a remount) is proven on a host with no GPU.
 *
 * R-4c specifically: reduced motion must resolve to `still` for every state, push
 * exactly one `setMotion('still')` into the renderer, and start NO frame loop.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAvatarMotion } from '../avatarClips';
import { DOOM_WEAPON_CLIP, type DoomClipName, type DoomPerformance } from '../doomClips';
import {
  getDoomPerformanceSnapshot,
  resetDoomPerformanceForTests,
} from '../doomPerformance';
import { FREDO_AVATAR_STATES, type FredoAvatarState } from '../fredoAvatarStates';
import {
  setAvatarRendererFactoryForTests,
  type AvatarRenderer,
  type AvatarRendererOptions,
} from '../three/avatarRenderer';
import { useAvatarRenderer, type UseAvatarRendererOptions } from '../useAvatarRenderer';

/** Build a 6-digit hex string without writing a literal colour in this suite. */
function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

const ACCENT = hexOf(85, 221, 234);
const ACCENT_NEXT = hexOf(12, 200, 90);
const TEXT_PRIMARY = hexOf(255, 255, 255);

const CANVAS = document.createElement('canvas');
const ASSET = new ArrayBuffer(16);

/** A `matchMedia` stub whose reduced-motion answer the test controls. */
function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

type Factory = (
  canvas: HTMLCanvasElement,
  asset: ArrayBuffer,
  options: AvatarRendererOptions,
) => Promise<AvatarRenderer>;

interface FakeRig {
  readonly renderer: AvatarRenderer;
  /** What the fake mixer is actually showing (mirrors `data-avatar-clip`). */
  readonly applied: { clip: string; body: string; requested: string; doom: DoomClipName | null };
  /** The options the hook handed the factory (the seam's outbound channel). */
  readonly options: { current: AvatarRendererOptions | null };
  readonly factory: ReturnType<typeof vi.fn>;
  /** Report a Doom ONE-SHOT completion back through the seam. */
  readonly finishDoom: (clip: DoomClipName) => void;
}

/**
 * Install a fake factory + renderer; the renderer reports ready on creation.
 *
 * The fake honours the PARALLEL channel the real renderer owns: a Doom performance
 * applied becomes the visible clip and a requested 12-state clip is only recorded
 * while the overlay holds it (a teleport still wins by suspension, which pushes
 * `null` through the same channel).
 */
function installFakeRenderer(): FakeRig {
  const applied = { clip: 'idle', body: '', requested: 'idle', doom: null as DoomClipName | null };
  const options: { current: AvatarRendererOptions | null } = { current: null };

  const renderer: AvatarRenderer = {
    setState: vi.fn((state: FredoAvatarState) => {
      applied.requested = state;
      // A teleport always wins over the armour; anything else is only recorded.
      const outranksOverlay = state === 'teleport-out' || state === 'teleport-in';
      if (applied.doom && !outranksOverlay) return;
      applied.clip = state;
      options.current?.onClipChange(state);
    }),
    setStreaming: vi.fn(),
    setMotion: vi.fn(),
    setPalette: vi.fn((palette) => {
      applied.body = palette.body;
    }),
    setDoomPerformance: vi.fn((performance: DoomPerformance | null) => {
      const next = performance?.clip ?? null;
      if (next === applied.doom) return;
      applied.doom = next;
      applied.clip = next ?? applied.requested;
      options.current?.onClipChange(applied.clip);
    }),
    getAppliedClip: vi.fn(() => applied.clip),
    getAppliedBodyColor: vi.fn(() => applied.body),
    dispose: vi.fn(),
  };

  const factory = vi.fn(
    async (
      _canvas: HTMLCanvasElement,
      _asset: ArrayBuffer,
      next: AvatarRendererOptions,
    ): Promise<AvatarRenderer> => {
      options.current = next;
      next.onClipChange(applied.clip);
      next.onReady();
      return renderer;
    },
  );

  setAvatarRendererFactoryForTests(factory as unknown as Factory);
  return {
    applied,
    renderer,
    options,
    factory,
    finishDoom: (clip: DoomClipName) => {
      options.current?.onDoomClipFinished?.(clip);
    },
  };
}

beforeEach(() => {
  document.documentElement.style.setProperty('--accent-primary', ACCENT);
  document.documentElement.style.setProperty('--text-primary', TEXT_PRIMARY);
});

afterEach(() => {
  cleanup();
  setAvatarRendererFactoryForTests(null);
  resetDoomPerformanceForTests({ resetWeaponCursor: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--accent-primary');
  document.documentElement.style.removeProperty('--text-primary');
});

describe('useAvatarRenderer — reduced motion (R-4c)', () => {
  it('tells the renderer `still` and starts no frame loop', async () => {
    stubReducedMotion(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const rig = installFakeRenderer();

    const { result, unmount } = renderHook(() =>
      useAvatarRenderer({ canvas: CANVAS, asset: ASSET, state: 'idle' }),
    );

    expect(result.current.motion).toBe('still');
    await waitFor(() => expect(rig.renderer.setMotion).toHaveBeenCalledWith('still'));
    expect(rig.renderer.setMotion).not.toHaveBeenCalledWith('play');

    // The hook owns no frame loop; under reduced motion neither does the renderer.
    expect(raf).not.toHaveBeenCalled();

    act(() => unmount());
    expect(rig.renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it('resolves every one of the 12 states to `still` under reduced motion', () => {
    for (const state of FREDO_AVATAR_STATES) {
      expect(resolveAvatarMotion(state, false, true)).toBe('still');
      expect(resolveAvatarMotion(state, true, true)).toBe('still');
    }
  });
});

describe('useAvatarRenderer — inputs and mirroring', () => {
  it('pushes the current state and its resolved motion into the renderer', async () => {
    stubReducedMotion(false);
    const rig = installFakeRenderer();

    renderHook(() => useAvatarRenderer({ canvas: CANVAS, asset: ASSET, state: 'happy' }));

    await waitFor(() => expect(rig.renderer.setState).toHaveBeenCalledWith('happy'));
    expect(rig.renderer.setMotion).toHaveBeenCalledWith('play');
  });

  it('gates `talk` on the streaming flag (held frame when not streaming)', async () => {
    stubReducedMotion(false);
    const rig = installFakeRenderer();

    const { result, rerender } = renderHook(
      (props: UseAvatarRendererOptions) => useAvatarRenderer(props),
      {
        initialProps: {
          canvas: CANVAS,
          asset: ASSET,
          state: 'talk' as FredoAvatarState,
          streaming: false,
        },
      },
    );

    expect(result.current.motion).toBe('still');

    rerender({
      canvas: CANVAS,
      asset: ASSET,
      state: 'talk' as FredoAvatarState,
      streaming: true,
    });

    expect(result.current.motion).toBe('play');
    await waitFor(() =>
      expect(rig.renderer.setMotion).toHaveBeenLastCalledWith('play'),
    );
  });

  it('mirrors the clip the mixer APPLIED, not the requested state', async () => {
    stubReducedMotion(false);
    const rig = installFakeRenderer();

    const { result } = renderHook(() =>
      useAvatarRenderer({ canvas: CANVAS, asset: ASSET, state: 'idle' }),
    );

    await waitFor(() => expect(result.current.clip).toBe('idle'));
    expect(result.current.render).toBe('live');

    act(() => {
      rig.options.current?.onClipChange('teleport-out');
    });

    expect(result.current.clip).toBe('teleport-out');
  });

  it('stays on the poster and never creates a renderer while disabled or asset-less', () => {
    stubReducedMotion(false);
    const rig = installFakeRenderer();

    const disabled = renderHook(() =>
      useAvatarRenderer({ canvas: CANVAS, asset: ASSET, state: 'idle', enabled: false }),
    );
    expect(disabled.result.current.render).toBe('poster');

    const unloaded = renderHook(() =>
      useAvatarRenderer({ canvas: null, asset: null, state: 'idle' }),
    );
    expect(unloaded.result.current.render).toBe('poster');

    expect(rig.factory.mock.calls.length).toBe(0);
  });
});

describe('useAvatarRenderer — the live accent (R-3)', () => {
  it('re-tints through the palette bridge WITHOUT re-creating the renderer', async () => {
    stubReducedMotion(false);
    const rig = installFakeRenderer();

    renderHook(() => useAvatarRenderer({ canvas: CANVAS, asset: ASSET, state: 'idle' }));
    await waitFor(() => expect(rig.renderer.setPalette).toHaveBeenCalled());

    act(() => {
      document.documentElement.style.setProperty('--accent-primary', ACCENT_NEXT);
    });

    await waitFor(() =>
      expect(rig.renderer.setPalette).toHaveBeenLastCalledWith(
        expect.objectContaining({ body: ACCENT_NEXT }),
      ),
    );

    // One renderer for the whole mount: a re-tint mutates materials in place.
    expect(rig.factory.mock.calls.length).toBe(1);
    expect(rig.renderer.dispose).not.toHaveBeenCalled();
  });
});

describe('#3223 useAvatarRenderer — the Doom overlay channel', () => {
  it('plays the intro on engage and settles into the weapon idle on its `finished`', async () => {
    stubReducedMotion(false);
    const rig = installFakeRenderer();

    const { result, rerender } = renderHook(
      (props: UseAvatarRendererOptions) => useAvatarRenderer(props),
      {
        initialProps: {
          canvas: CANVAS,
          asset: ASSET,
          state: 'thinking' as FredoAvatarState,
          doomEngaged: false,
        },
      },
    );

    await waitFor(() => expect(result.current.clip).toBe('thinking'));

    rerender({
      canvas: CANVAS,
      asset: ASSET,
      state: 'thinking' as FredoAvatarState,
      doomEngaged: true,
    });

    await waitFor(() => expect(rig.renderer.setDoomPerformance).toHaveBeenLastCalledWith({ clip: 'doom-in' }));
    expect(result.current.clip).toBe('doom-in');
    // The consumer's live state is only RECORDED while the armour owns the mixer.
    expect(rig.applied.requested).toBe('thinking');

    act(() => {
      rig.finishDoom('doom-in');
    });

    await waitFor(() =>
      expect(rig.renderer.setDoomPerformance).toHaveBeenLastCalledWith({
        clip: DOOM_WEAPON_CLIP.shotgun,
      }),
    );
    expect(result.current.clip).toBe(DOOM_WEAPON_CLIP.shotgun);
  });

  it('retracts on release and hands back to the LATEST resolved state', async () => {
    stubReducedMotion(false);
    const rig = installFakeRenderer();

    const { result, rerender } = renderHook(
      (props: UseAvatarRendererOptions) => useAvatarRenderer(props),
      {
        initialProps: {
          canvas: CANVAS,
          asset: ASSET,
          state: 'thinking' as FredoAvatarState,
          doomEngaged: false,
        },
      },
    );

    await waitFor(() => expect(result.current.clip).toBe('thinking'));

    rerender({ canvas: CANVAS, asset: ASSET, state: 'thinking' as FredoAvatarState, doomEngaged: true });
    await waitFor(() => expect(result.current.clip).toBe('doom-in'));
    act(() => rig.finishDoom('doom-in'));

    // The consumer's state moved on WHILE the armour was held (the stale-snapshot control).
    rerender({ canvas: CANVAS, asset: ASSET, state: 'happy' as FredoAvatarState, doomEngaged: true });
    await waitFor(() => expect(rig.applied.requested).toBe('happy'));

    rerender({ canvas: CANVAS, asset: ASSET, state: 'happy' as FredoAvatarState, doomEngaged: false });
    await waitFor(() => expect(rig.renderer.setDoomPerformance).toHaveBeenLastCalledWith({ clip: 'doom-out' }));

    act(() => {
      rig.finishDoom('doom-out');
    });

    await waitFor(() => expect(rig.renderer.setDoomPerformance).toHaveBeenLastCalledWith(null));
    // Resumes the resolved state at the restore instant — never the pre-engagement one.
    expect(rig.applied.clip).toBe('happy');
    expect(result.current.clip).toBe('happy');
  });

  it('suspends the overlay for a teleport and hands it back on arrival', async () => {
    stubReducedMotion(false);
    const rig = installFakeRenderer();

    const { result, rerender } = renderHook(
      (props: UseAvatarRendererOptions) => useAvatarRenderer(props),
      {
        initialProps: {
          canvas: CANVAS,
          asset: ASSET,
          state: 'idle' as FredoAvatarState,
          doomEngaged: false,
        },
      },
    );

    await waitFor(() => expect(result.current.clip).toBe('idle'));

    rerender({ canvas: CANVAS, asset: ASSET, state: 'idle' as FredoAvatarState, doomEngaged: true });
    await waitFor(() => expect(result.current.clip).toBe('doom-in'));
    act(() => rig.finishDoom('doom-in'));
    await waitFor(() => expect(result.current.clip).toBe(DOOM_WEAPON_CLIP.shotgun));

    // A teleport outranks the overlay: it is pushed `null` and the teleport clip plays.
    rerender({
      canvas: CANVAS,
      asset: ASSET,
      state: 'teleport-out' as FredoAvatarState,
      doomEngaged: true,
    });
    await waitFor(() => expect(rig.renderer.setDoomPerformance).toHaveBeenLastCalledWith(null));
    expect(rig.applied.clip).toBe('teleport-out');

    rerender({
      canvas: CANVAS,
      asset: ASSET,
      state: 'teleport-in' as FredoAvatarState,
      doomEngaged: true,
    });
    await waitFor(() => expect(rig.applied.clip).toBe('teleport-in'));

    // Arrival hands the overlay back on the SAME weapon clip (never stuck mid-teleport).
    rerender({ canvas: CANVAS, asset: ASSET, state: 'idle' as FredoAvatarState, doomEngaged: true });
    await waitFor(() =>
      expect(rig.renderer.setDoomPerformance).toHaveBeenLastCalledWith({
        clip: DOOM_WEAPON_CLIP.shotgun,
      }),
    );
    expect(result.current.clip).toBe(DOOM_WEAPON_CLIP.shotgun);
    expect(getDoomPerformanceSnapshot().phase).toBe('holding');
  });

  it('keeps the mounted engagement across a consumer remount (no second intro)', async () => {
    stubReducedMotion(false);
    const first = installFakeRenderer();

    const mounted = renderHook(() => useAvatarRenderer({
      canvas: CANVAS,
      asset: ASSET,
      state: 'idle',
      doomEngaged: true,
    }));

    await waitFor(() => expect(first.renderer.setDoomPerformance).toHaveBeenLastCalledWith({ clip: 'doom-in' }));
    act(() => first.finishDoom('doom-in'));
    await waitFor(() =>
      expect(first.renderer.setDoomPerformance).toHaveBeenLastCalledWith({
        clip: DOOM_WEAPON_CLIP.shotgun,
      }),
    );
    act(() => mounted.unmount());

    // A fresh surface (the away overlay) mounts onto the SAME module-owned phase.
    const second = installFakeRenderer();
    const remounted = renderHook(() => useAvatarRenderer({
      canvas: CANVAS,
      asset: ASSET,
      state: 'idle',
      doomEngaged: true,
    }));

    await waitFor(() => expect(second.renderer.setDoomPerformance).toHaveBeenCalled());
    expect(second.renderer.setDoomPerformance).not.toHaveBeenCalledWith({ clip: 'doom-in' });
    expect(second.renderer.setDoomPerformance).toHaveBeenLastCalledWith({
      clip: DOOM_WEAPON_CLIP.shotgun,
    });
    act(() => remounted.unmount());
  });

  it('draws ONE still frame of the resolved Doom clip under reduced motion', async () => {
    stubReducedMotion(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const rig = installFakeRenderer();

    const { result } = renderHook(() =>
      useAvatarRenderer({ canvas: CANVAS, asset: ASSET, state: 'thinking', doomEngaged: true }),
    );

    // Instant costume swap: no intro at all, straight to the weapon idle still.
    await waitFor(() =>
      expect(rig.renderer.setDoomPerformance).toHaveBeenLastCalledWith({
        clip: DOOM_WEAPON_CLIP.shotgun,
      }),
    );
    expect(rig.renderer.setDoomPerformance).not.toHaveBeenCalledWith({ clip: 'doom-in' });
    expect(result.current.motion).toBe('still');
    expect(raf).not.toHaveBeenCalled();
  });
});
