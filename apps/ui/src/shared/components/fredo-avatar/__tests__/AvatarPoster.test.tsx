import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import {
  AVATAR_POSTER_HANDOFF_MS,
  AvatarPoster,
  isAvatarPosterPainted,
  type AvatarPosterPhase,
} from '../AvatarPoster';
import { AVATAR_POSTER_BODY_URL, AVATAR_POSTER_DETAIL_URL } from '../avatarAsset';
import { AVATAR_MD, AVATAR_SM } from '../fredoAvatarSizes';

/**
 * Spec 3210 ST-2 — the poster's rendered contract.
 *
 * WHAT THIS SUITE CAN PROVE, AND WHAT IT CANNOT (stated so a green run is not
 * mistaken for more than it is). jsdom has NO LAYOUT ENGINE: every
 * `getBoundingClientRect()` is zero, so no unit test can measure "80x100" — the
 * live pixel receipt is the tester's capture row. What is asserted here is the
 * mechanism that makes the footprint exact by construction: the poster layer is
 * out of flow (`position: absolute`) with `inset: 0`, so it adopts the reserved
 * box of whatever it is mounted in (80x100 CSS px on both shipped surfaces — the
 * component is size-agnostic and reserves nothing itself), and every layer inside
 * it fills that box at `100%`. Anything that could shift the seat (an intrinsic
 * size, a margin, a transform, a focusable node, a pointer target) is absent, and
 * that absence is what is pinned.
 *
 * The rest of the suite pins the four render boundaries and the mask-decode gate
 * that keeps an undecoded mask from painting a solid accent rectangle.
 */

const stubReducedMotion = (matches: boolean): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
};

interface PosterParts {
  layer: HTMLElement;
  body: HTMLElement;
  detail: HTMLElement;
  loader: HTMLElement;
}

/** Render the poster inside a reserved box of the given size and read its parts. */
function renderPoster(
  box: { width: number; height: number } = AVATAR_SM,
  phase?: AvatarPosterPhase,
): PosterParts {
  const { container } = render(
    <div style={{ position: 'relative', width: `${box.width}px`, height: `${box.height}px` }}>
      <AvatarPoster phase={phase} />
    </div>,
  );
  const host = container.firstElementChild as HTMLElement;
  const layer = host.querySelector('[data-avatar-poster-layer]') as HTMLElement;
  const body = host.querySelector('[data-avatar-poster-body]') as HTMLElement;
  const detail = host.querySelector('[data-avatar-poster-detail]') as HTMLElement;
  const loader = host.querySelector('[data-avatar-poster-mask-loader]') as HTMLElement;
  expect(layer, 'poster layer must render').toBeTruthy();
  expect(body, 'body layer must render').toBeTruthy();
  expect(detail, 'detail layer must render').toBeTruthy();
  expect(loader, 'mask loader must render').toBeTruthy();
  return { layer, body, detail, loader };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AvatarPoster — the reserved footprint (spec 3210 ST-2)', () => {
  it.each([
    ['sm (both shipped surfaces)', AVATAR_SM],
    ['md (component leg only)', AVATAR_MD],
  ])('fills the %s box from the reserved footprint, reserving nothing itself', (_label, box) => {
    const { layer, body, detail, loader } = renderPoster(box);

    // Out of flow on all four edges: the poster contributes no height to the flow
    // and cannot push the seat, whatever the box it is mounted in.
    // (jsdom stores the `inset` shorthand without expanding it, so accept either
    // representation — the serialized declaration is the same either way.)
    const expectInsetZero = (part: HTMLElement) => {
      expect(part.style.position).toBe('absolute');
      const declared = part.getAttribute('style') ?? '';
      const shorthandZero = /(^|;)\s*inset\s*:\s*0(px)?\s*(;|$)/.test(declared);
      const longhandsZero = ['top', 'right', 'bottom', 'left'].every((edge) => {
        const value = part.style.getPropertyValue(edge);
        return value === '0' || value === '0px';
      });
      expect(shorthandZero || longhandsZero, `inset of ${declared}`).toBe(true);
    };
    expectInsetZero(layer);
    // Every layer fills the poster's box exactly.
    expectInsetZero(body);
    expectInsetZero(detail);
    expect(detail.style.width).toBe('100%');
    expect(detail.style.height).toBe('100%');

    // Nothing here owns a size or a margin, so no size change is expressible.
    for (const part of [layer, body, detail, loader]) {
      expect(part.style.width === '' || part.style.width === '0px' || part.style.width === '100%').toBe(true);
      expect(part.style.height === '' || part.style.height === '0px' || part.style.height === '100%').toBe(true);
      expect(part.style.margin).toBe('');
      expect(part.style.transform).toBe('');
    }
  });

  it('fills rather than letterboxes the poster raster (never `contain`)', () => {
    const { body, detail } = renderPoster();
    expect(body.style.maskSize).toBe('100% 100%');
    expect(body.style.maskRepeat).toBe('no-repeat');
    // Crisp-edge scaling is the deleted flat avatar's idiom; the poster is
    // anti-aliased art and must never be pixelated.
    expect(detail.style.objectFit).toBe('fill');
    expect(detail.style.imageRendering).toBe('auto');
  });

  it('is decorative and inert: no focusable node, no pointer target, nothing announced', () => {
    const { layer, detail, loader } = renderPoster();
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.style.pointerEvents).toBe('none');
    expect(detail.style.pointerEvents).toBe('none');
    expect(loader.style.pointerEvents).toBe('none');
    expect(detail.getAttribute('alt')).toBe('');
    expect(loader.getAttribute('alt')).toBe('');
    expect(layer.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
    expect(detail.getAttribute('tabindex')).toBeNull();
  });

  it('reads its art from the two committed poster passes', () => {
    const { body, detail, loader } = renderPoster();
    expect(body.style.maskImage).toContain(AVATAR_POSTER_BODY_URL);
    expect(loader.getAttribute('src')).toBe(AVATAR_POSTER_BODY_URL);
    expect(detail.getAttribute('src')).toBe(AVATAR_POSTER_DETAIL_URL);
    // The body is the ONE accent-tinted surface: no literal colour anywhere.
    expect(body.style.backgroundColor).toBe('var(--accent-primary)');
  });
});

describe('AvatarPoster — the four render boundaries', () => {
  it('paints the poster by default (poster phase), instantly', () => {
    const { layer } = renderPoster();
    expect(isAvatarPosterPainted('poster')).toBe(true);
    expect(window.getComputedStyle(layer).visibility).toBe('visible');
    expect(layer.style.opacity).toBe('1');
    expect(layer.style.transition).toBe('none');
  });

  it('is visibility:hidden while the canvas is live — never a backdrop behind a dissolve', () => {
    const { layer } = renderPoster(AVATAR_SM, 'live');
    expect(isAvatarPosterPainted('live')).toBe(false);
    expect(window.getComputedStyle(layer).visibility).toBe('hidden');
    expect(layer.style.opacity).toBe('0');
    // Hidden, not unmounted: the reserved rect and the probe must survive.
    expect(layer.isConnected).toBe(true);
  });

  it('crossfades opacity only for the 150 ms handoff (poster still painted)', () => {
    const { layer } = renderPoster(AVATAR_SM, 'handoff');
    expect(isAvatarPosterPainted('handoff')).toBe(true);
    expect(window.getComputedStyle(layer).visibility).toBe('visible');
    expect(layer.style.opacity).toBe('0');
    expect(layer.style.transition).toContain(`opacity ${AVATAR_POSTER_HANDOFF_MS}ms`);
    expect(layer.style.transform).toBe('');
  });

  it('falls back from live to poster instantly (no fade, no motion)', () => {
    const live = renderPoster(AVATAR_SM, 'live');
    expect(live.layer.style.transition).toBe('none');
    cleanup();
    const poster = renderPoster(AVATAR_SM, 'poster');
    expect(poster.layer.style.transition).toBe('none');
    expect(poster.layer.style.opacity).toBe('1');
  });

  it('drops the transition entirely under reduced motion (instant at every boundary)', () => {
    stubReducedMotion(true);
    const handoff = renderPoster(AVATAR_SM, 'handoff');
    expect(handoff.layer.style.transition).toBe('none');
    expect(window.getComputedStyle(handoff.layer).visibility).toBe('hidden');
    cleanup();
    const poster = renderPoster(AVATAR_SM, 'poster');
    expect(poster.layer.style.transition).toBe('none');
  });
});

describe('AvatarPoster — the body fill is never painted unmasked', () => {
  it('holds the body layer at opacity 0 until the mask bitmap is decoded', () => {
    const { body, loader } = renderPoster();
    expect(body.style.opacity).toBe('0');
    fireEvent.load(loader);
    expect(body.style.opacity).toBe('1');
  });

  it('never paints the accent fill when the mask fails to decode', () => {
    const { body, loader } = renderPoster();
    fireEvent.error(loader);
    expect(body.style.opacity).toBe('0');
  });

  it('keeps the fill instant when it appears (no fade-in from empty)', () => {
    const { body, loader } = renderPoster();
    fireEvent.load(loader);
    expect(body.style.transition).toBe('none');
    expect(body.style.opacity).toBe('1');
  });
});
