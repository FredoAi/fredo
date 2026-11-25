/**
 * #3210 ST-4/ST-7 — the avatar SHELL contract (the state → clip vocabulary at the
 * component seam).
 *
 * This suite replaces the retired `fredoAvatarNewStates.test.tsx`, which read the
 * deleted SVG expression overlay (`#fredo-expression`) and the deleted
 * `fredo-avatar.css` as a FILE. Under jsdom the capability probe short-circuits on
 * the missing `WebGL2RenderingContext`, so every render here exercises the
 * PRODUCTION poster path — exactly what the shipped fallback is.
 *
 * What is pinned:
 *  - the stable shell hooks (`data-avatar-render`, `data-avatar-motion`, the
 *    poster layer, zero `<svg>`, zero canvas on a WebGL-less host) at BOTH sizes;
 *  - the 12-state vocabulary still maps 1:1 onto the same-named authored clip
 *    (`AVATAR_CLIPS`), and the motion rule (`resolveAvatarMotion`) — reduced
 *    motion always a still frame, `talk` held while not streaming;
 *  - the retired SVG path stays retired: no `fredo-avatar.css` import, no scene
 *    read of the Doom store, and the two deleted modules stay deleted.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AVATAR_CLIPS, resolveAvatarMotion } from '../avatarClips';
import { FredoAvatar } from '../FredoAvatar';
import { FREDO_AVATAR_STATES } from '../fredoAvatarStates';

/** vitest runs with cwd = apps/ui (the package root). */
const AVATAR_DIR = 'src/shared/components/fredo-avatar';

const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const root = (container: HTMLElement): HTMLElement => {
  const node = container.querySelector<HTMLElement>('[data-avatar-render]');
  expect(node, 'the avatar must render the stable shell root').not.toBeNull();
  return node!;
};

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('#3210 avatar shell — the production poster path (jsdom has no GPU)', () => {
  it('renders the poster shell at 80x100 with the state hooks and no SVG', () => {
    const { container } = render(<FredoAvatar size="sm" state="idle" />);
    const shell = root(container);

    expect(shell.getAttribute('data-avatar-render')).toBe('poster');
    expect(shell.getAttribute('data-avatar-motion')).toBe('play');
    expect(shell.getAttribute('aria-hidden')).toBe('true');
    expect(shell.style.width).toBe('80px');
    expect(shell.style.height).toBe('100px');

    // The poster is mounted as a layer; the live-only hooks are absent.
    expect(shell.querySelector('[data-avatar-poster-layer]')).not.toBeNull();
    expect(shell.hasAttribute('data-avatar-clip')).toBe(false);
    expect(shell.hasAttribute('data-avatar-body-color')).toBe(false);

    // ONE render path: no SVG markup and no canvas on a host without WebGL2.
    expect(shell.querySelector('svg')).toBeNull();
    expect(shell.querySelector('canvas')).toBeNull();
    expect(container.querySelector('#fredo-expression')).toBeNull();
  });

  it('renders the md footprint at 132x165 (component-only size, no shipped surface)', () => {
    const { container } = render(<FredoAvatar size="md" state="idle" />);
    const shell = root(container);

    expect(shell.style.width).toBe('132px');
    expect(shell.style.height).toBe('165px');
    const poster = shell.querySelector<HTMLElement>('[data-avatar-poster-layer]');
    expect(poster).not.toBeNull();
    // Absolutely positioned out of flow (jsdom keeps the `inset` shorthand as
    // serialized), so it fills the reserved box and can never overflow it.
    expect(poster!.style.position).toBe('absolute');
    const declared = poster!.getAttribute('style') ?? '';
    const shorthandZero = /(^|;)\s*inset\s*:\s*0(px)?\s*(;|$)/.test(declared);
    const longhandsZero = ['top', 'right', 'bottom', 'left'].every((edge) => {
      const value = poster!.style.getPropertyValue(edge);
      return value === '0' || value === '0px';
    });
    expect(shorthandZero || longhandsZero, declared).toBe(true);
  });

  it('renders the same shell for every one of the 12 resolved states', () => {
    for (const state of FREDO_AVATAR_STATES) {
      const { container, unmount } = render(<FredoAvatar size="sm" state={state} />);
      const shell = root(container);

      expect(shell.getAttribute('data-avatar-render'), state).toBe('poster');
      // The 12 states ARE the 12 clips — a missing clip would be a build error.
      expect(AVATAR_CLIPS[state], `${state} must have a same-named clip`).toBeDefined();
      // Non-`talk` states play; `talk` without a stream holds its first frame.
      expect(shell.getAttribute('data-avatar-motion'), state).toBe(
        resolveAvatarMotion(state, false, false),
      );

      unmount();
    }
  });

  it('gates `talk` on streaming: held still when idle, playing while streaming', () => {
    const held = render(<FredoAvatar size="sm" state="talk" streaming={false} />);
    expect(root(held.container).getAttribute('data-avatar-motion')).toBe('still');
    held.unmount();

    const playing = render(<FredoAvatar size="sm" state="talk" streaming />);
    expect(root(playing.container).getAttribute('data-avatar-motion')).toBe('play');
  });

  it('resolves every state to a still frame under reduced motion', () => {
    stubReducedMotion(true);

    for (const state of FREDO_AVATAR_STATES) {
      const { container, unmount } = render(<FredoAvatar size="sm" state={state} streaming />);
      expect(root(container).getAttribute('data-avatar-motion'), state).toBe('still');
      unmount();
    }
  });
});

describe('#3210 one render path — the SVG avatar code stays deleted', () => {
  const componentSource = readSource(`${AVATAR_DIR}/FredoAvatar.tsx`);

  it('keeps the wrapper-motion stylesheet import and drops the SVG overlay stylesheet', () => {
    // `fredoAvatarIdle.css` feeds the shipped bob/glow on the consumer wrappers.
    expect(componentSource).toContain("import './fredoAvatarIdle.css'");
    expect(componentSource).not.toContain('fredo-avatar.css');
    expect(existsSync(resolve(process.cwd(), `${AVATAR_DIR}/fredoAvatarIdle.css`))).toBe(true);
    expect(existsSync(resolve(process.cwd(), `${AVATAR_DIR}/fredo-avatar.css`))).toBe(false);
  });

  it('deletes the geometry module and never reads the Doom visual store', () => {
    expect(existsSync(resolve(process.cwd(), `${AVATAR_DIR}/fredoAvatarGeometry.ts`))).toBe(false);
    expect(componentSource).not.toContain('fredoAvatarGeometry');
    expect(componentSource).not.toContain('doom-mode');
    expect(componentSource).not.toContain('data-doom-armor');
    expect(componentSource).not.toContain('#fredo-armor');
  });

  it('names only the twelve frozen state ids — no emotion, no Doom vocabulary', () => {
    for (const moved of [
      'data-avatar-doom-phase',
      'poster-detail-doom',
      'uwu',
      'skeptical',
      'confused',
      'squint',
    ]) {
      expect(componentSource).not.toContain(moved);
    }
    expect(FREDO_AVATAR_STATES).toHaveLength(12);
    expect(Object.keys(AVATAR_CLIPS)).toHaveLength(12);
  });
});
