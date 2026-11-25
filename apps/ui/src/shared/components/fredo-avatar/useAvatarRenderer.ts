/**
 * #3210 ST-3 — the avatar renderer lifecycle hook (the React edge of the seam).
 *
 * The hook owns exactly five things:
 *   1. CREATE the renderer once per (canvas, asset) and DISPOSE it on unmount /
 *      whenever either identity changes — so a remount never leaks a WebGL context
 *      and a re-tint never recreates one.
 *   2. Push the resolved inputs (`state`, `streaming`, the derived `motion`, the
 *      live palette) into the renderer imperatively.
 *   3. Mirror what the renderer ACTUALLY applied back to the shell
 *      (`render` / `clip` / `bodyColor`), so the component's data attributes report
 *      the mixer's truth rather than the requested value.
 *   4. Keep the accent live: a module-scoped {@link MutationObserver} on the
 *      document element turns the theming application's variable writes into a
 *      STRING snapshot consumed through `useSyncExternalStore`.
 *   5. Bridge the Doom performance store onto the renderer (Spec #3223): the
 *      consumer's `doomEngaged` boolean plus the derived reduced-motion/teleport
 *      suspension are IMPERATIVE store writes, and the store's pushes reach
 *      `setDoomPerformance` with no React re-render per clip.
 *
 * ## Why a string snapshot
 * `useSyncExternalStore` compares snapshots by identity. Exposing a fresh palette
 * object (or an array whose `.length` changes) would re-render on every read and
 * walk straight into the #523 re-render-loop class. The snapshot is therefore a
 * primitive string key, parsed into a palette only when it actually changes.
 *
 * ## Inputs are pushed, not fetched
 * The hook deliberately does NOT fetch the GLB: the asset is the module-cached
 * buffer the caller already holds (`loadAvatarAsset`), passed in as `asset`. That
 * keeps the render path independent of the packaging/caching module and lets the
 * caller decide when the canvas may mount at all.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useReducedMotion } from '../../hooks/useReducedMotion';
import {
  resolveAvatarMotion,
  type AvatarMotion,
} from './avatarClips';
import {
  isDoomSuppressingClip,
  type AvatarRenderedClip,
} from './doomClips';
import {
  bindDoomPerformanceRenderer,
  completeDoomOneShot,
  setDoomPerformanceEngaged,
  setDoomPerformanceReducedMotion,
  setDoomPerformanceSuspended,
} from './doomPerformance';
import type { FredoAvatarState } from './fredoAvatarStates';
import { readAvatarPalette, type AvatarPalette } from './three/avatarPalette';
import {
  resolveAvatarRendererFactory,
  type AvatarRenderer,
} from './three/avatarRenderer';

/** Which layer the shell must show for this mount. */
export type AvatarRenderMode = 'poster' | 'live';

/** What the shell mirrors onto the avatar root's data attributes. */
export interface AvatarRendererStatus {
  /** `live` once the first frame of the asset has been painted. */
  readonly render: AvatarRenderMode;
  /** The mixer's applied clip (null while the poster is the only layer). */
  readonly clip: AvatarRenderedClip | null;
  /** The motion the renderer was told to run (`play` loops, `still` draws one frame). */
  readonly motion: AvatarMotion;
  /** The applied body material colour, or null before the first palette lands. */
  readonly bodyColor: string | null;
}

export interface UseAvatarRendererOptions {
  /** The live canvas element, or null while only the poster is mounted. */
  readonly canvas: HTMLCanvasElement | null;
  /** The already-fetched GLB. MUST be a stable reference (the module-cached buffer). */
  readonly asset: ArrayBuffer | null;
  /** The resolved avatar state — the clip to play. */
  readonly state: FredoAvatarState;
  /** Gates `talk` to a held frame while the assistant is not streaming. */
  readonly streaming?: boolean;
  /** False keeps the poster path (the caller's capability/asset decision). Default true. */
  readonly enabled?: boolean;
  /**
   * Whether the Doom armour performance is engaged. A plain boolean: the CONSUMER
   * owns the engagement store read, so this hook imports nothing from it.
   */
  readonly doomEngaged?: boolean;
}

/** Separator between the two hex values in the palette snapshot key. */
const SNAPSHOT_SEPARATOR = '|';

/**
 * Per-webview palette bridge state. Deliberately MODULE scope: it must survive a
 * component close/reopen cycle and never live in a `useRef` (ENGINEERING_RULES).
 */
let snapshotKey: string | null = null;
let paletteObserver: MutationObserver | null = null;
let paletteRefreshHandle = 0;
const paletteListeners = new Set<() => void>();

/** Read the live palette and encode it as the snapshot key. */
function readSnapshotKey(): string {
  const palette = readAvatarPalette();
  return palette ? `${palette.body}${SNAPSHOT_SEPARATOR}${palette.detail}` : '';
}

/** Re-read the palette; notify only when the key actually moved. */
function refreshPaletteSnapshot(): void {
  const next = readSnapshotKey();
  const previous = snapshotKey ?? '';
  snapshotKey = next;
  if (next === previous) return;
  for (const listener of paletteListeners) listener();
}

/** rAF-throttle a burst of style writes into one palette read (no per-write render). */
function schedulePaletteRefresh(): void {
  if (paletteRefreshHandle !== 0) return;
  if (typeof requestAnimationFrame !== 'function') {
    refreshPaletteSnapshot();
    return;
  }
  paletteRefreshHandle = requestAnimationFrame(() => {
    paletteRefreshHandle = 0;
    refreshPaletteSnapshot();
  });
}

/** Subscribe to theme-variable writes on the document element. */
function subscribeToPalette(listener: () => void): () => void {
  paletteListeners.add(listener);

  if (!paletteObserver && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    paletteObserver = new MutationObserver(schedulePaletteRefresh);
    paletteObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }

  // The theme may have been applied before this subscription existed.
  refreshPaletteSnapshot();

  return () => {
    paletteListeners.delete(listener);
    if (paletteListeners.size > 0) return;

    paletteObserver?.disconnect();
    paletteObserver = null;
    if (paletteRefreshHandle !== 0 && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(paletteRefreshHandle);
    }
    paletteRefreshHandle = 0;
  };
}

/** Lazy initial read: the first render already sees the live theme. */
function getPaletteSnapshot(): string {
  if (snapshotKey === null) snapshotKey = readSnapshotKey();
  return snapshotKey;
}

/** Server snapshot — no theme to read outside the DOM. */
function getPaletteServerSnapshot(): string {
  return '';
}

/** Decode the snapshot key into a palette (identity changes only when the key does). */
function parsePaletteKey(key: string): AvatarPalette | null {
  if (!key) return null;
  const [body, detail] = key.split(SNAPSHOT_SEPARATOR);
  if (!body || !detail) return null;
  return { body, detail };
}

/**
 * Drive the imperative renderer for one mounted avatar.
 *
 * The returned status is what the component mirrors onto `data-avatar-render`,
 * `data-avatar-clip`, `data-avatar-motion` and `data-avatar-body-color`.
 */
export function useAvatarRenderer({
  canvas,
  asset,
  state,
  streaming = false,
  enabled = true,
  doomEngaged = false,
}: UseAvatarRendererOptions): AvatarRendererStatus {
  const reducedMotion = useReducedMotion();
  const motion = resolveAvatarMotion(state, streaming, reducedMotion);
  // A teleport outranks the armour: the overlay is suspended for its whole pair.
  const doomSuspended = isDoomSuppressingClip(state);

  const paletteKey = useSyncExternalStore(
    subscribeToPalette,
    getPaletteSnapshot,
    getPaletteServerSnapshot,
  );
  const palette = useMemo<AvatarPalette | null>(
    () => parsePaletteKey(paletteKey),
    [paletteKey],
  );

  const rendererRef = useRef<AvatarRenderer | null>(null);
  const [render, setRender] = useState<AvatarRenderMode>('poster');
  const [clip, setClip] = useState<AvatarRenderedClip | null>(null);
  const [bodyColor, setBodyColor] = useState<string | null>(null);

  // The freshest inputs, readable by the async create callback without making it a
  // dependency (it must not re-run on every state change).
  const latest = useRef({ state, streaming, motion, palette });
  useEffect(() => {
    latest.current = { state, streaming, motion, palette };
  });

  useEffect(() => {
    if (!enabled || !canvas || !asset) return undefined;

    let cancelled = false;
    let unbindDoom: (() => void) | null = null;
    const factory = resolveAvatarRendererFactory();

    const applyCurrentInputs = (renderer: AvatarRenderer): void => {
      const current = latest.current;
      if (current.palette) renderer.setPalette(current.palette);
      renderer.setState(current.state);
      renderer.setStreaming(current.streaming);
      renderer.setMotion(current.motion);
      setBodyColor(renderer.getAppliedBodyColor() || null);
    };

    factory(canvas, asset, {
      onReady: () => {
        if (!cancelled) setRender('live');
      },
      onUnavailable: () => {
        if (!cancelled) setRender('poster');
      },
      onClipChange: (next) => {
        if (!cancelled) setClip(next);
      },
      // The store owns the armour phase; the renderer only reports completions.
      onDoomClipFinished: (finished) => {
        if (!cancelled) completeDoomOneShot(finished);
      },
    })
      .then((renderer) => {
        if (cancelled) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;
        applyCurrentInputs(renderer);
        // ONE push path: the bridge pushes the current performance now and every
        // change after, so a freshly mounted surface reports the SAME clip with no
        // second intro (the phase is store-owned).
        unbindDoom = bindDoomPerformanceRenderer(renderer);
      })
      .catch(() => {
        // A constructor failure (driver refusal) degrades to the poster; the
        // renderer itself already reported `onUnavailable` when it could.
        if (!cancelled) setRender('poster');
      });

    return () => {
      cancelled = true;
      unbindDoom?.();
      unbindDoom = null;
      rendererRef.current?.dispose();
      rendererRef.current = null;
      setRender('poster');
      setClip(null);
      setBodyColor(null);
    };
  }, [enabled, canvas, asset]);

  // Doom inputs are IMPERATIVE store writes (no React re-render per clip). They run
  // before the async renderer exists unless it is already bound; the bind then pushes
  // the resulting phase, so either ordering converges on the same performance.
  // Reduced motion is written FIRST so a mount lands on the reduced-motion phase
  // table directly (no transient intro), then the suspension, then the edge.
  useEffect(() => {
    setDoomPerformanceReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    setDoomPerformanceSuspended(doomSuspended);
  }, [doomSuspended]);

  useEffect(() => {
    setDoomPerformanceEngaged(doomEngaged);
  }, [doomEngaged]);

  useEffect(() => {
    rendererRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    rendererRef.current?.setStreaming(streaming);
  }, [streaming]);

  useEffect(() => {
    rendererRef.current?.setMotion(motion);
  }, [motion]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !palette) return;
    renderer.setPalette(palette);
    setBodyColor(renderer.getAppliedBodyColor() || null);
  }, [palette]);

  return useMemo<AvatarRendererStatus>(
    () => ({ render, clip, motion, bodyColor }),
    [render, clip, motion, bodyColor],
  );
}
