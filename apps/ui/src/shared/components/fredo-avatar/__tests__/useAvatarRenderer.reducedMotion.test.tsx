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

import { resolveAvatarMotion, type AvatarClipName } from '../avatarClips';
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
  readonly applied: { clip: AvatarClipName; body: string };
  /** The options the hook handed the factory (the seam's outbound channel). */
  readonly options: { current: AvatarRendererOptions | null };
  readonly factory: ReturnType<typeof vi.fn>;
}

/** Install a fake factory + renderer; the renderer reports ready on creation. */
function installFakeRenderer(): FakeRig {
  const applied: { clip: AvatarClipName; body: string } = { clip: 'idle', body: '' };

  const renderer: AvatarRenderer = {
    setState: vi.fn((state: FredoAvatarState) => {
      applied.clip = state;
    }),
    setStreaming: vi.fn(),
    setMotion: vi.fn(),
    setPalette: vi.fn((palette) => {
      applied.body = palette.body;
    }),
    getAppliedClip: vi.fn(() => applied.clip),
    getAppliedBodyColor: vi.fn(() => applied.body),
    dispose: vi.fn(),
  };

  const options: { current: AvatarRendererOptions | null } = { current: null };

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
  return { applied, renderer, options, factory };
}

beforeEach(() => {
  document.documentElement.style.setProperty('--accent-primary', ACCENT);
  document.documentElement.style.setProperty('--text-primary', TEXT_PRIMARY);
});

afterEach(() => {
  cleanup();
  setAvatarRendererFactoryForTests(null);
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
