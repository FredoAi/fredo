/**
 * #3223 ST-4 — the COMPONENT seam: the Doom performance reaches the DOM only as
 * `data-avatar-clip` (no `data-avatar-doom-phase`, no extra attribute).
 *
 * jsdom has no GPU, so this suite stubs the capability probe's global and installs
 * the module-level renderer factory (the shipped test seam) to get a REAL canvas
 * mount. Everything else is the production component: the consumer passes a plain
 * boolean, the shell renders the poster/live shell, and the mixer's APPLIED clip is
 * mirrored onto the root's `data-avatar-clip`.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAvatarAssetCacheForTests } from '../avatarAsset';
import {
  DOOM_WEAPON_CLIP,
  type AvatarRenderedClip,
  type DoomClipName,
  type DoomPerformance,
} from '../doomClips';
import {
  resetDoomPerformanceForTests,
  setDoomPerformanceEngaged,
} from '../doomPerformance';
import { FredoAvatar } from '../FredoAvatar';
import {
  setAvatarRendererFactoryForTests,
  type AvatarRenderer,
  type AvatarRendererOptions,
} from '../three/avatarRenderer';

const ASSET_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]); // "glTF"

interface FakeRig {
  readonly applied: { clip: string };
  readonly finishDoom: (clip: DoomClipName) => void;
}

/** Install the shipped factory seam with a renderer that mimics the applied clip. */
function installFakeRenderer(): FakeRig {
  const applied = { clip: 'idle', requested: 'idle' };
  const options: { current: AvatarRendererOptions | null } = { current: null };

  const renderer: AvatarRenderer = {
    setState: vi.fn((state: string) => {
      applied.requested = state;
      applied.clip = state;
      options.current?.onClipChange(state as AvatarRenderedClip);
    }),
    setStreaming: vi.fn(),
    setMotion: vi.fn(),
    setPalette: vi.fn(),
    setDoomPerformance: vi.fn((performance: DoomPerformance | null) => {
      const next = performance?.clip ?? null;
      // `null` hands the mixer back to the LATEST requested 12-state clip.
      const appliedNext = next ?? applied.requested;
      if (appliedNext === applied.clip) return;
      applied.clip = appliedNext;
      options.current?.onClipChange(appliedNext);
    }),
    getAppliedClip: vi.fn(() => applied.clip as AvatarRenderedClip),
    getAppliedBodyColor: vi.fn(() => ''),
    dispose: vi.fn(),
  };

  const factory = vi.fn(
    async (
      _canvas: HTMLCanvasElement,
      _asset: ArrayBuffer,
      next: AvatarRendererOptions,
    ): Promise<AvatarRenderer> => {
      options.current = next;
      next.onReady();
      return renderer;
    },
  );

  setAvatarRendererFactoryForTests(factory as never);
  return {
    applied,
    finishDoom: (clip: DoomClipName) => options.current?.onDoomClipFinished?.(clip),
  };
}

const shell = (container: HTMLElement): HTMLElement => {
  const node = container.querySelector<HTMLElement>('[data-avatar-render]');
  expect(node, 'the avatar must render the stable shell root').not.toBeNull();
  return node!;
};

beforeEach(() => {
  // The probe short-circuits on a missing WebGL2 global, so a stub is what makes the
  // component mount its canvas at all (never a `getContext` call).
  vi.stubGlobal('WebGL2RenderingContext', class WebGL2RenderingContextStub {});
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(ASSET_BYTES, { status: 200 })));
  resetAvatarAssetCacheForTests();
  resetDoomPerformanceForTests({ resetWeaponCursor: true });
});

afterEach(() => {
  cleanup();
  setAvatarRendererFactoryForTests(null);
  resetDoomPerformanceForTests({ resetWeaponCursor: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#3223 FredoAvatar — the Doom phase is read from `data-avatar-clip`', () => {
  it('mirrors the intro, the weapon idle, the retract and the restored state', async () => {
    const rig = installFakeRenderer();

    const { container, rerender } = render(
      <FredoAvatar size="sm" state="thinking" doomEngaged />,
    );

    await waitFor(() => expect(shell(container).getAttribute('data-avatar-render')).toBe('live'));
    await waitFor(() => expect(shell(container).getAttribute('data-avatar-clip')).toBe('doom-in'));

    rig.finishDoom('doom-in');
    await waitFor(() =>
      expect(shell(container).getAttribute('data-avatar-clip')).toBe(DOOM_WEAPON_CLIP.shotgun),
    );

    // Release: the retract plays, then the consumer's live state is restored.
    rerender(<FredoAvatar size="sm" state="thinking" doomEngaged={false} />);
    await waitFor(() => expect(shell(container).getAttribute('data-avatar-clip')).toBe('doom-out'));

    rig.finishDoom('doom-out');
    await waitFor(() => expect(shell(container).getAttribute('data-avatar-clip')).toBe('thinking'));
  });

  it('adds no Doom-specific DOM hook (the clip name is the one observable)', async () => {
    installFakeRenderer();
    const { container } = render(<FredoAvatar size="sm" state="thinking" doomEngaged />);

    await waitFor(() => expect(shell(container).getAttribute('data-avatar-clip')).toBe('doom-in'));

    const root = shell(container);
    expect(root.hasAttribute('data-avatar-doom-phase')).toBe(false);
    for (const attribute of Array.from(root.attributes)) {
      expect(attribute.name).not.toMatch(/doom/i);
    }
  });

  it('shows a 12-state clip and no Doom clip while the mode stays off', async () => {
    installFakeRenderer();
    const { container } = render(<FredoAvatar size="sm" state="happy" />);

    await waitFor(() => expect(shell(container).getAttribute('data-avatar-render')).toBe('live'));
    await waitFor(() => expect(shell(container).getAttribute('data-avatar-clip')).toBe('happy'));
    expect(shell(container).getAttribute('data-avatar-clip')).not.toMatch(/^doom-/);
  });

  it('arms from the SAME store the consumers read (mount freshness)', async () => {
    const rig = installFakeRenderer();
    setDoomPerformanceEngaged(true);

    // The phase is already `entering` in the module store: a freshly mounted surface
    // reports it immediately rather than waiting for another edge.
    const { container } = render(<FredoAvatar size="sm" state="idle" doomEngaged />);
    await waitFor(() => expect(shell(container).getAttribute('data-avatar-clip')).toBe('doom-in'));

    rig.finishDoom('doom-in');
    await waitFor(() =>
      expect(shell(container).getAttribute('data-avatar-clip')).toBe(DOOM_WEAPON_CLIP.shotgun),
    );
  });
});
