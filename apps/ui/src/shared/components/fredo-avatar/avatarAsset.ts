/**
 * The avatar asset's ONE address surface and its loader (spec 3210 ST-1).
 *
 * The character GLB and the two poster passes are REAL FILES copied verbatim from
 * `apps/ui/public/avatar/` into the served bundle by Vite's `public` directory —
 * never imported, never inlined as a URI payload. That is
 * structural: `public/` bytes are copied, not bundled, so the initial JS chunk is
 * unchanged and the 3.4 MB model cannot block first paint. The poster paints
 * first; the model is fetched afterwards, and only while the avatar is mounted.
 *
 * URLs are built from `import.meta.env.BASE_URL` so the same committed copy is
 * served by every surface (the browser-only dev server, the Tauri webview dev
 * server and the packaged app) with no second copy and no build step.
 */

/** The folder the shipped avatar files are served from (trailing slash included). */
export const AVATAR_ASSET_BASE = `${import.meta.env.BASE_URL}avatar/`;

/** The character model — a glTF binary container. */
export const AVATAR_ASSET_URL = `${AVATAR_ASSET_BASE}fredo-character.glb`;

/** Poster pass 1: the body-family silhouette, used as an ALPHA MASK only. */
export const AVATAR_POSTER_BODY_URL = `${AVATAR_ASSET_BASE}poster-body.png`;

/** Poster pass 2: the authored detail (wardrobe, trim, expression), full colour. */
export const AVATAR_POSTER_DETAIL_URL = `${AVATAR_ASSET_BASE}poster-detail.png`;

/**
 * The decoded model bytes, ready for the glTF loader's `parse` call. It IS an
 * `ArrayBuffer` rather than a wrapper object: the renderer takes the bytes, and a
 * wrapper would only add an indirection for every consumer to unpack.
 */
export type AvatarAsset = ArrayBuffer;

/**
 * One in-flight/settled load per webview. Module scope (not a React ref) so a
 * remount — and the companion's teleport re-key, which remounts the avatar —
 * reuses the same bytes instead of re-downloading them.
 */
let cachedAsset: Promise<AvatarAsset> | null = null;

/**
 * Load the character model once per webview.
 *
 * A FAILED load clears the cache and rejects: the caller renders the poster for
 * that mount, and a later mount may try again. A failure is therefore never
 * permanent for the window's lifetime, and never retried in a loop.
 */
export function loadAvatarAsset(): Promise<AvatarAsset> {
  if (cachedAsset) return cachedAsset;

  const pending = fetch(AVATAR_ASSET_URL, { cache: 'force-cache' })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`avatar asset request failed with status ${response.status}`);
      }
      return response.arrayBuffer();
    })
    .then((bytes) => {
      if (bytes.byteLength === 0) throw new Error('avatar asset response was empty');
      return bytes;
    })
    .catch((error: unknown) => {
      cachedAsset = null;
      throw error;
    });

  cachedAsset = pending;
  return pending;
}

/** Test seam: forget the cached load so a suite can re-drive it. */
export function resetAvatarAssetCacheForTests(): void {
  cachedAsset = null;
}
