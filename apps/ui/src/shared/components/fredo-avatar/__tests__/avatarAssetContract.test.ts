import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AVATAR_ASSET_BASE,
  AVATAR_ASSET_URL,
  AVATAR_POSTER_BODY_URL,
  AVATAR_POSTER_DETAIL_URL,
  loadAvatarAsset,
  resetAvatarAssetCacheForTests,
} from '../avatarAsset';
import {
  AVATAR_CLIPS,
  AVATAR_CLIP_TIME_SCALE,
  AVATAR_ONE_SHOT_CLIPS,
  resolveAvatarMotion,
} from '../avatarClips';
import { FREDO_AVATAR_STATES, type FredoAvatarState } from '../fredoAvatarStates';

/**
 * Spec 3210 ST-1/ST-2 — the ONE asset-contract pin.
 *
 * Two copies of the character now exist in the tree: the authoring copy under
 * `.opencode/wireframes/blender/` and the copy the webview actually serves from
 * `apps/ui/public/avatar/`. This suite is what makes art drift impossible to ship
 * silently. It parses the shipped GLB's own container (12-byte header + JSON
 * chunk, no glTF library involved) and asserts:
 *
 *  - the shipped copy is BYTE-IDENTICAL to the authoring GLB (digest + length);
 *  - the GLB carries its full authored clip table — all 32 clips — and that set
 *    EQUALS the authoring manifest's clip list, so a re-export that drops or
 *    renames a clip fails here rather than in a later slice that names one;
 *  - every clip this BASE plays (`AVATAR_CLIPS`, the 12 state clips) exists, is
 *    1.333 s in both the GLB and the manifest, and agrees with the manifest's
 *    loop flag — only the two teleport clips are one-shots;
 *  - the two poster passes are 420x525 RGBA rasters (0.800, the aspect of every
 *    shipped avatar box) so `mask-size: 100% 100%` cannot distort them;
 *  - the model is delivered as a REAL FILE, never inlined: the asset module
 *    derives its URLs from `import.meta.env.BASE_URL` and never mentions a data
 *    URI, a base64 payload or an asset import;
 *  - the packaged CSP still permits the same-origin fetch the loader performs.
 *
 * Files are read with `readFileSync(resolve(process.cwd(), ...))` — vitest runs
 * with cwd = `apps/ui`, the established convention in this workspace.
 *
 * The 32-clip assertion is deliberately BLIND to names beyond the 12: the extra
 * clips belong to slices this one must not name (they are asserted as a SET
 * against the authoring manifest, which is data, not base code).
 */

const repoPath = (...segments: string[]): string => resolve(process.cwd(), ...segments);

const SHIPPED_GLB = repoPath('public/avatar/fredo-character.glb');
const AUTHORING_GLB = repoPath('../../.opencode/wireframes/blender/fredo-character.glb');
const AUTHORING_MANIFEST = repoPath('../../.opencode/wireframes/blender/fredo-character.manifest.json');

const POSTER_BODY = repoPath('public/avatar/poster-body.png');
const POSTER_DETAIL = repoPath('public/avatar/poster-detail.png');

const AVATAR_DIR = 'src/shared/components/fredo-avatar';

interface ManifestClip {
  name: string;
  duration: number;
  loop: boolean;
}

interface Manifest {
  bytes: number;
  clips: ManifestClip[];
}

interface GlbClip {
  name: string;
  duration: number;
}

/** The GLB's own clip table, read straight out of its JSON chunk. */
function readGlbClips(glb: Buffer): GlbClip[] {
  expect(glb.readUInt32LE(0), 'GLB magic').toBe(0x46546c67);
  expect(glb.readUInt32LE(4), 'GLB container version').toBe(2);
  expect(glb.readUInt32LE(8), 'declared container length').toBe(glb.byteLength);

  let offset = 12;
  let json: Record<string, unknown> | null = null;
  while (offset < glb.byteLength) {
    const chunkLength = glb.readUInt32LE(offset);
    const chunkType = glb.readUInt32LE(offset + 4);
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(glb.subarray(offset + 8, offset + 8 + chunkLength).toString('utf8')) as Record<string, unknown>;
    }
    offset += 8 + chunkLength;
  }
  expect(json, 'GLB must carry a JSON chunk').not.toBeNull();

  const accessors = (json as { accessors?: { max?: number[] }[] }).accessors ?? [];
  const animations = (json as { animations?: { name?: string; samplers: { input: number }[] }[] }).animations ?? [];

  return animations.map((animation) => {
    let duration = 0;
    for (const sampler of animation.samplers) {
      const accessor = accessors[sampler.input];
      if (accessor?.max?.length) duration = Math.max(duration, accessor.max[0]);
    }
    return { name: animation.name ?? '', duration };
  });
}

/** PNG IHDR — the header every decoder reads first. */
function readPngHeader(png: Buffer): {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlaced: number;
} {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...png.subarray(0, 8)], 'PNG signature').toEqual(signature);
  expect(png.subarray(12, 16).toString('ascii'), 'first chunk must be IHDR').toBe('IHDR');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colourType: png[25],
    interlaced: png[28],
  };
}

const shippedGlb = readFileSync(SHIPPED_GLB);
const authoringGlb = readFileSync(AUTHORING_GLB);
const manifest = JSON.parse(readFileSync(AUTHORING_MANIFEST, 'utf8')) as Manifest;
const glbClips = readGlbClips(shippedGlb);

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('avatar asset contract — the shipped GLB (spec 3210 ST-1)', () => {
  it('ships the authored GLB byte-for-byte (digest and length)', () => {
    expect(shippedGlb.byteLength).toBe(3554176);
    expect(shippedGlb.byteLength).toBe(manifest.bytes);
    expect(authoringGlb.byteLength).toBe(shippedGlb.byteLength);
    expect(digest(shippedGlb)).toBe(digest(authoringGlb));
  });

  it('carries the full authored clip table — all 32 clips', () => {
    expect(glbClips).toHaveLength(32);
    expect(manifest.clips).toHaveLength(32);
  });

  it('matches the authoring manifest clip list exactly (no drift either way)', () => {
    const shipped = glbClips.map((clip) => clip.name).sort();
    const authored = manifest.clips.map((clip) => clip.name).sort();
    expect(shipped).toEqual(authored);
  });
});

describe('avatar asset contract — the 12 clips this base plays', () => {
  it('plays exactly one clip per frozen state, and nothing else', () => {
    const played = Object.keys(AVATAR_CLIPS).sort();
    expect(played).toHaveLength(12);
    expect(played).toEqual([...FREDO_AVATAR_STATES].sort());
  });

  it('resolves every played clip against the shipped GLB at the authored duration', () => {
    for (const state of FREDO_AVATAR_STATES) {
      const spec = AVATAR_CLIPS[state];
      const clip = glbClips.find((candidate) => candidate.name === state);
      expect(clip, `GLB must carry the "${state}" clip`).toBeDefined();
      expect(Math.abs(clip!.duration - spec.durationSeconds), `"${state}" duration`).toBeLessThan(0.01);
    }
  });

  it('agrees with the authoring manifest on duration and loop flag', () => {
    for (const state of FREDO_AVATAR_STATES) {
      const spec = AVATAR_CLIPS[state];
      const authored = manifest.clips.find((clip) => clip.name === state);
      expect(authored, `manifest must carry the "${state}" clip`).toBeDefined();
      expect(authored!.duration).toBeCloseTo(spec.durationSeconds, 3);
      expect(authored!.loop, `"${state}" loop flag`).toBe(spec.loop);
    }
  });

  it('marks exactly the two teleport clips as one-shots', () => {
    const oneShots = FREDO_AVATAR_STATES.filter((state) => !AVATAR_CLIPS[state].loop);
    expect(oneShots).toEqual(['teleport-out', 'teleport-in']);
    expect([...AVATAR_ONE_SHOT_CLIPS]).toEqual(['teleport-out', 'teleport-in']);
    expect(AVATAR_CLIPS.idle.loop).toBe(true);
  });

  it('normalises each one-shot into the shipped 400 ms teleport window', () => {
    for (const clip of AVATAR_ONE_SHOT_CLIPS) {
      const scale = AVATAR_CLIP_TIME_SCALE[clip];
      expect(scale).toBeCloseTo(AVATAR_CLIPS[clip].durationSeconds / 0.4, 6);
      expect(scale).toBeGreaterThan(3);
      expect(AVATAR_CLIPS[clip].durationSeconds / scale).toBeCloseTo(0.4, 6);
    }
  });
});

describe('avatar motion — one rule for still frames', () => {
  it('holds the resolved clip still under reduced motion', () => {
    for (const state of FREDO_AVATAR_STATES) {
      expect(resolveAvatarMotion(state, false, true)).toBe('still');
      expect(resolveAvatarMotion(state, true, true)).toBe('still');
    }
  });

  it('holds `talk` still while nothing is streaming, and plays it while streaming', () => {
    expect(resolveAvatarMotion('talk', false, false)).toBe('still');
    expect(resolveAvatarMotion('talk', true, false)).toBe('play');
  });

  it('plays every other state', () => {
    for (const state of FREDO_AVATAR_STATES) {
      if (state === 'talk') continue;
      expect(resolveAvatarMotion(state, false, false)).toBe('play');
    }
  });

  it('returns a motion for every vocabulary member (exhaustive, no fallback)', () => {
    const motions = FREDO_AVATAR_STATES.map((state: FredoAvatarState) => resolveAvatarMotion(state, true, false));
    expect(motions.every((motion) => motion === 'play' || motion === 'still')).toBe(true);
  });
});

describe('avatar poster passes (spec 3210 ST-2)', () => {
  it('commits both passes at the 0.800 poster raster, 8-bit RGBA', () => {
    for (const [label, path] of [
      ['body', POSTER_BODY],
      ['detail', POSTER_DETAIL],
    ] as const) {
      expect(existsSync(path), `${label} poster must exist at ${path}`).toBe(true);
      const header = readPngHeader(readFileSync(path));
      expect(header.width, `${label} width`).toBe(420);
      expect(header.height, `${label} height`).toBe(525);
      expect(header.width / header.height, `${label} aspect`).toBeCloseTo(0.8, 3);
      expect(header.bitDepth, `${label} bit depth`).toBe(8);
      expect(header.colourType, `${label} must be RGBA (colour type 6)`).toBe(6);
      expect(header.interlaced, `${label} must not be interlaced`).toBe(0);
    }
  });

  it('does not bake the poster into a background-coloured raster', () => {
    // A fully opaque poster would paint a rectangle over the seat; the passes are
    // masks/overlays, so their file size stays far below an opaque 420x525 RGBA
    // raster of the same art (220,500 px * 4 B, compression aside).
    for (const path of [POSTER_BODY, POSTER_DETAIL]) {
      expect(readFileSync(path).byteLength).toBeLessThan(200_000);
    }
  });
});

describe('avatar asset delivery — a real file, never inlined', () => {
  const assetSource = readFileSync(resolve(repoPath(AVATAR_DIR), 'avatarAsset.ts'), 'utf8');
  it('derives every URL from the bundler base URL', () => {
    expect(assetSource).toContain('import.meta.env.BASE_URL');
    expect(AVATAR_ASSET_BASE.endsWith('/')).toBe(true);
    expect(AVATAR_ASSET_URL.startsWith(AVATAR_ASSET_BASE)).toBe(true);
    expect(AVATAR_POSTER_BODY_URL.startsWith(AVATAR_ASSET_BASE)).toBe(true);
    expect(AVATAR_POSTER_DETAIL_URL.startsWith(AVATAR_ASSET_BASE)).toBe(true);
    expect(AVATAR_ASSET_URL.endsWith('.glb')).toBe(true);
  });

  it('never inlines the asset (no data URI, no base64, no asset import)', () => {
    expect(assetSource).not.toMatch(/data:/);
    expect(assetSource).not.toMatch(/base64/i);
    expect(assetSource).not.toMatch(/\?inline|\?url/);
    expect(assetSource).not.toMatch(/from\s+['"][^'"]*\.(glb|png)['"]/);
  });

  it('serves the files from the committed public folder', () => {
    for (const name of ['fredo-character.glb', 'poster-body.png', 'poster-detail.png']) {
      expect(existsSync(repoPath('public/avatar', name)), `${name} must be committed`).toBe(true);
    }
  });
});

describe('packaged CSP still permits the same-origin asset fetch', () => {
  const tauriConfig = JSON.parse(
    readFileSync(repoPath('../tauri/src-tauri/tauri.conf.json'), 'utf8'),
  ) as { app: { security: { csp: string; devCsp: string } } };

  it('keeps `connect-src self` in the release CSP', () => {
    const connectSrc = tauriConfig.app.security.csp.split(';').find((directive) => directive.trim().startsWith('connect-src'));
    expect(connectSrc, 'release CSP must declare connect-src').toBeDefined();
    expect(connectSrc).toContain("'self'");
  });

  it('keeps `img-src` able to load the poster PNGs from the app origin', () => {
    const imgSrc = tauriConfig.app.security.csp.split(';').find((directive) => directive.trim().startsWith('img-src'));
    expect(imgSrc, 'release CSP must declare img-src').toBeDefined();
    expect(imgSrc).toContain("'self'");
  });
});

describe('avatar asset loader — one lazy fetch per webview', () => {
  afterEach(() => {
    resetAvatarAssetCacheForTests();
    vi.unstubAllGlobals();
  });

  /** A fetch stub that records the requested URLs and counts calls. */
  const stubFetch = (respond: () => Response) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (input: string) => {
      calls.push(input);
      return Promise.resolve(respond());
    });
    return calls;
  };

  const payload = new Uint8Array([0x67, 0x6c, 0x54, 0x46]); // "glTF"

  it('fetches the shipped GLB url once, and reuses the result across mounts', async () => {
    const calls = stubFetch(() => new Response(payload, { status: 200 }));
    const first = await loadAvatarAsset();
    const second = await loadAvatarAsset();
    expect(first).toBe(second);
    expect(first.byteLength).toBe(payload.byteLength);
    expect(calls).toEqual([AVATAR_ASSET_URL]);
  });

  it('rejects a non-OK response and forgets the failure (a later mount may retry)', async () => {
    const calls = stubFetch(() => new Response(null, { status: 404 }));
    await expect(loadAvatarAsset()).rejects.toThrow(/404/);
    // The cache was cleared, so the next attempt really goes to the network again.
    await expect(loadAvatarAsset()).rejects.toThrow(/404/);
    expect(calls).toHaveLength(2);
  });

  it('treats an empty body as a failure (never hands an empty model to the renderer)', async () => {
    stubFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    await expect(loadAvatarAsset()).rejects.toThrow(/empty/);
  });
});
