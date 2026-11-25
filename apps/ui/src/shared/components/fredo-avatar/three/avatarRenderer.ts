/**
 * #3210 ST-3 — the imperative three.js renderer core, behind an injectable seam.
 *
 * This module is the ONE live render path. It owns the 12-state clip contract, the
 * Doom overlay performance channel, the one-shot/resting timing, the accent tint
 * and the frame budget — and nothing else. There is no React here (no reconciler,
 * so a tint change mutates materials instead of remounting a scene) and no
 * post-processing.
 *
 * ## Contract points this file implements
 *  - The resolved avatar state IS the clip name (`AvatarClipName` = `FredoAvatarState`,
 *    12 members). A clip missing from the GLB never crashes a mount; it is a no-op.
 *  - The Doom armour is a PARALLEL channel (`DOOM_CLIPS` + `setDoomPerformance`), not a
 *    thirteenth state: one mixer, one render path, two request channels. While a Doom
 *    performance is applied a 12-state request is only recorded — except a teleport,
 *    which always wins (the overlay is suspended and handed back).
 *  - One-shots (`AVATAR_ONE_SHOT_CLIPS`) run `LoopOnce` + `clampWhenFinished`, with
 *    `timeScale` from `AVATAR_CLIP_TIME_SCALE` so the authored 1.333 s action
 *    completes inside the shipped 400 ms state window.
 *  - On the mixer's `finished` event the renderer resumes the clip of the LATEST
 *    `setState` (`resolveFinishedClip`). If the finished one-shot is itself still
 *    the latest state it stays on its final authored frame — for `teleport-out`
 *    that frame IS the empty seat, and re-playing it would loop a dissolve.
 *  - `resolveAvatarMotion` is computed by the caller and pushed through
 *    `setMotion`: `still` draws exactly ONE frame of the resolved clip at t = 0 and
 *    starts no loop.
 *  - The loop is event/test-driven by RAF, capped at 30 fps, paused while the
 *    document is hidden. No wall-clock state decides a clip switch, so a hidden or
 *    paused window cannot strand a one-shot.
 *  - `webglcontextlost` reports `onUnavailable('lost')`: the caller renders the
 *    poster for the remainder of the mount (a lost context is never a blank seat).
 *
 * ## The seam (U-1)
 * jsdom has no GPU, so renderer internals are not unit-tested by instantiating the
 * real renderer. `setAvatarRendererFactoryForTests` swaps the FACTORY at module
 * level — never a component prop, never a component mock — so the production
 * poster path stays the one the component suites exercise.
 */

import {
  AnimationMixer,
  Box3,
  DirectionalLight,
  HemisphereLight,
  LoopOnce,
  OrthographicCamera,
  Scene,
  WebGLRenderer,
  type AnimationAction,
  type Material,
  type Mesh,
  type Object3D,
  type SkinnedMesh,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  AVATAR_CLIPS,
  AVATAR_CLIP_TIME_SCALE,
  AVATAR_ONE_SHOT_CLIPS,
  type AvatarClipName,
  type AvatarMotion,
} from '../avatarClips';
import {
  DOOM_ONE_SHOT_CLIPS,
  isDoomClipName,
  isDoomSuppressingClip,
  type AvatarRenderedClip,
  type DoomClipName,
  type DoomPerformance,
} from '../doomClips';
import type { FredoAvatarState } from '../fredoAvatarStates';
import { computeOrthoFraming, framingCenterX } from './avatarFraming';
import { applyAvatarTint, type AvatarPalette } from './avatarPalette';

/** The shipped crossfade between any two clips. */
const CROSSFADE_SECONDS = 0.15;

/** Frame budget: 30 fps, so `mixer.update` never runs faster than the eye needs. */
const FRAME_INTERVAL_MS = 1000 / 30;
/** Tolerance so a 60 Hz host draws every second tick instead of skipping to 20 fps. */
const FRAME_INTERVAL_SLOP_MS = 2;

/** A resumed tab must not fast-forward the mixer by the whole hidden interval. */
const MAX_FRAME_DELTA_SECONDS = 0.1;

/** `setPixelRatio(min(dpr, 2))` keeps the device-pixel budget bounded (U-2). */
const MAX_PIXEL_RATIO = 2;

/** The orthographic eye distance — irrelevant for the projection, inside near/far. */
const CAMERA_DISTANCE = 5;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;

/** Poses sampled per clip when measuring the body for the framing fit. */
const FRAMING_SAMPLES_PER_CLIP = 4;

/** Descendant names with this prefix are props/FX and never size the framing (U-5). */
const PROP_NAME_PREFIX = 'prop';

/** Public surface of a mounted renderer (the shell reads the two applied hooks). */
export interface AvatarRenderer {
  setState(state: FredoAvatarState): void;
  setStreaming(streaming: boolean): void;
  setMotion(motion: AvatarMotion): void;
  setPalette(palette: AvatarPalette): void;
  /**
   * The Doom OVERLAY request channel (`null` hands the mixer back to the consumer's
   * resolved 12-state clip). Deliberately parallel to `setState`: Doom is a
   * performance layered over the vocabulary, never a thirteenth state.
   */
  setDoomPerformance(performance: DoomPerformance | null): void;
  /** The clip the mixer is ACTUALLY playing (crossfade target). */
  getAppliedClip(): AvatarRenderedClip;
  /** The body material's current colour, as a normalised hex string. */
  getAppliedBodyColor(): string;
  dispose(): void;
}

export interface AvatarRendererOptions {
  /** Fired once, after the first frame of the asset has actually been painted. */
  onReady(): void;
  /** Live 3D is unavailable for the remaining mount: render the poster. */
  onUnavailable(reason: 'load' | 'lost' | 'unsupported'): void;
  /** Fired whenever the applied clip changes (mirrors `data-avatar-clip`). */
  onClipChange(clip: AvatarRenderedClip): void;
  /** Fired when a Doom ONE-SHOT completes (`doom-in`/`doom-out`). */
  onDoomClipFinished?(clip: DoomClipName): void;
}

type AvatarRendererFactory = (
  canvas: HTMLCanvasElement,
  asset: ArrayBuffer,
  opts: AvatarRendererOptions,
) => Promise<AvatarRenderer>;

/**
 * Test-only factory override (module level, never a prop). `null` restores the real
 * renderer — the hook's cleanup never touches it, only the test does.
 */
let factoryOverride: AvatarRendererFactory | null = null;

/** Swap the renderer factory for tests (a fake renderer needs no GPU). */
export function setAvatarRendererFactoryForTests(
  factory: AvatarRendererFactory | null,
): void {
  factoryOverride = factory;
}

/** The factory the hook must call — the test override when installed. */
export function resolveAvatarRendererFactory(): AvatarRendererFactory {
  return factoryOverride ?? createAvatarRenderer;
}

/** True for the 12 clip names this base renders (and only those). */
export function isAvatarClipName(name: string): name is AvatarClipName {
  return Object.prototype.hasOwnProperty.call(AVATAR_CLIPS, name);
}

/** True for a one-shot clip (the members of `AVATAR_ONE_SHOT_CLIPS`). */
function isOneShotClip(name: AvatarClipName): name is keyof typeof AVATAR_CLIP_TIME_SCALE {
  return (AVATAR_ONE_SHOT_CLIPS as readonly AvatarClipName[]).includes(name);
}

/** True for a Doom clip this renderer owns in its parallel action map. */
function isDoomClipForRender(name: AvatarRenderedClip): name is DoomClipName {
  return isDoomClipName(name);
}

/**
 * Whether a 12-state request is APPLIED immediately while a Doom performance owns
 * the mixer.
 *
 * A teleport always wins over the overlay (REQ-9: leave/arrive play in place, the
 * overlay is suspended and handed back). Every other state is only RECORDED, so
 * releasing the overlay hands straight back to the consumer's LATEST resolved
 * state — never a stale pre-engagement snapshot (REQ-7).
 */
export function shouldApplyRequestedClip(state: AvatarClipName, doomActive: boolean): boolean {
  if (!doomActive) return true;
  return isDoomSuppressingClip(state);
}

/**
 * Which clip a completed one-shot hands over to.
 *
 * `null` means "stay on the one-shot's clamped final frame": the state machine has
 * not moved on, so replaying the action (or snapping to a bind pose) would be the
 * stranded/invisible-pose defect this rule exists to prevent.
 */
export function resolveFinishedClip(
  finished: AvatarClipName,
  requested: AvatarClipName,
): AvatarClipName | null {
  return requested === finished ? null : requested;
}

/** Wrap `GLTFLoader.parse` (the asset is already an ArrayBuffer — one fetch, one parse). */
function parseGltf(asset: ArrayBuffer): Promise<GLTF> {
  return new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().parse(asset, '', resolve, reject);
  });
}

/** Find a clip's action by identity (the mixer reports actions, not names). */
function clipNameOfAction<N extends string>(
  action: AnimationAction,
  actions: Map<N, AnimationAction>,
): N | null {
  for (const [name, candidate] of actions) {
    if (candidate === action) return name;
  }
  return null;
}

/** True when the object (or an ancestor) is a prop/FX node excluded from the fit. */
function isPropObject(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (current.name.toLowerCase().startsWith(PROP_NAME_PREFIX)) return true;
    current = current.parent;
  }
  return false;
}

/** The mesh-local bounding box of one object at the mixer's CURRENT pose. */
function posedLocalBox(object: Object3D): Box3 | null {
  const skinned = object as SkinnedMesh;
  if (skinned.isSkinnedMesh) {
    skinned.computeBoundingBox();
    return skinned.boundingBox ?? null;
  }

  const mesh = object as Mesh;
  const geometry = mesh.geometry;
  if (!geometry) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox;
}

/**
 * Measure the BODY's silhouette over the authored clips (U-5).
 *
 * The fit must follow the body, never props: prop/FX nodes are skipped, and every
 * other mesh is sampled across each clip so an extended pose (a raised arm, a
 * landed crouch) is inside the frame rather than clipped at 80 px.
 */
function measureBodyBox(
  model: Object3D,
  mixer: AnimationMixer,
  actions: Map<AvatarClipName, AnimationAction>,
): Box3 {
  const measured = new Box3();
  const bodies: Object3D[] = [];

  model.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh && !isPropObject(mesh)) bodies.push(mesh);
  });

  if (bodies.length > 0 && actions.size > 0) {
    try {
      for (const action of actions.values()) {
        const clip = action.getClip();
        action.reset();
        action.enabled = true;
        action.setEffectiveWeight(1);
        action.play();

        for (let sample = 0; sample <= FRAMING_SAMPLES_PER_CLIP; sample += 1) {
          const time =
            clip.duration > 0 ? (clip.duration * sample) / FRAMING_SAMPLES_PER_CLIP : 0;
          mixer.setTime(time);
          model.updateMatrixWorld(true);

          for (const body of bodies) {
            const local = posedLocalBox(body);
            if (local) measured.union(local.clone().applyMatrix4(body.matrixWorld));
          }
        }

        action.stop();
      }
    } catch {
      // A measurement failure must never stop the avatar from rendering: the
      // whole-model fallback below still yields a usable frame.
    } finally {
      mixer.stopAllAction();
    }
  }

  if (measured.isEmpty()) measured.setFromObject(model);
  return measured;
}

/** Dispose every geometry/material the model brought in, then empty the scene. */
function disposeScene(scene: Scene): void {
  const materials = new Set<Material>();

  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const list = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of list) materials.add(material);
  });

  for (const material of materials) material.dispose();
  scene.clear();
}

/**
 * Create the live renderer on `canvas` from an already-fetched GLB.
 *
 * Resolves once the scene is mounted, framed and playing; the first painted frame
 * fires `onReady`. Rejects (after reporting `onUnavailable('load')`) when the asset
 * cannot be parsed, so the caller degrades to the poster.
 */
export async function createAvatarRenderer(
  canvas: HTMLCanvasElement,
  asset: ArrayBuffer,
  opts: AvatarRendererOptions,
): Promise<AvatarRenderer> {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR);

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true });
  } catch (error) {
    // A host that exposes WebGL2 but refuses a context degrades to the poster.
    opts.onUnavailable('unsupported');
    throw error;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  // Transparent clear: an opaque clear paints a rectangle over the seat and over
  // whatever the floating companion hovers above.
  renderer.setClearAlpha(0);
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  renderer.setSize(width, height, false);

  // Lighting is deliberately colourless (the constructors' neutral defaults): the
  // avatar's colour comes from the accent palette and the authored materials, never
  // from a light table.
  const ambient = new HemisphereLight();
  const keyLight = new DirectionalLight();
  keyLight.position.set(-2, 3.4, 2.6);
  const rimLight = new DirectionalLight();
  rimLight.position.set(2.6, 1.6, -2.4);
  rimLight.intensity = 0.7;
  scene.add(ambient, keyLight, rimLight);

  let gltf: GLTF;
  try {
    gltf = await parseGltf(asset);
  } catch (error) {
    disposeScene(scene);
    renderer.dispose();
    opts.onUnavailable('load');
    throw error;
  }

  const model = gltf.scene;
  model.traverse((object) => {
    const mesh = object as Mesh;
    // A prop swinging past the bind-pose bounds must never pop out of frame.
    if (mesh.isMesh) mesh.frustumCulled = false;
  });
  scene.add(model);

  const mixer = new AnimationMixer(model);
  const actions = new Map<AvatarClipName, AnimationAction>();

  for (const clip of gltf.animations) {
    if (!isAvatarClipName(clip.name)) continue;
    const action = mixer.clipAction(clip);
    if (isOneShotClip(clip.name)) {
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      // Normalise the authored 1.333 s action into the shipped 400 ms window.
      action.setEffectiveTimeScale(AVATAR_CLIP_TIME_SCALE[clip.name]);
    }
    actions.set(clip.name, action);
  }

  // One camera fit per mount, from the body silhouette over the authored clips.
  const bodyBox = measureBodyBox(model, mixer, actions);
  const framing = computeOrthoFraming(bodyBox, width / height);
  const centerX = framingCenterX(bodyBox);
  camera.left = framing.left;
  camera.right = framing.right;
  camera.top = framing.top;
  camera.bottom = framing.bottom;
  camera.position.set(centerX, framing.centerY, CAMERA_DISTANCE);
  camera.lookAt(centerX, framing.centerY, 0);

  // The PARALLEL Doom action map (ST-3). Built after the framing measurement so
  // the fit stays exactly the 12-state body silhouette (the Doom poses/props never
  // size the camera). Doom one-shots clamp; every other Doom clip loops.
  const doomActions = new Map<DoomClipName, AnimationAction>();
  for (const clip of gltf.animations) {
    if (!isDoomClipName(clip.name)) continue;
    const action = mixer.clipAction(clip);
    if ((DOOM_ONE_SHOT_CLIPS as readonly string[]).includes(clip.name)) {
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    doomActions.set(clip.name, action);
  }

  let applied: AvatarRenderedClip | null = null;
  let requested: AvatarClipName | null = null;
  /** The Doom clip the overlay is holding (null when the overlay is not applied). */
  let doomClip: DoomClipName | null = null;
  let motion: AvatarMotion = 'play';
  let streaming = false;
  let bodyColour: string | null = null;
  let rafId = 0;
  let running = false;
  let lastDrawAt = 0;
  let lastStillPoseKey: string | null = null;
  let ready = false;
  let disposed = false;

  const documentHidden = (): boolean =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden';

  const poseKey = (): string => `${applied ?? ''}|${bodyColour ?? ''}`;

  const markReady = (): void => {
    if (ready) return;
    ready = true;
    opts.onReady();
  };

  const draw = (): void => {
    renderer.render(scene, camera);
    markReady();
  };

  /** The action for ANY renderable clip, across both parallel maps. */
  const actionFor = (clip: AvatarRenderedClip): AnimationAction | undefined =>
    isDoomClipForRender(clip) ? doomActions.get(clip) : actions.get(clip);

  /** Exactly one frame of the resolved clip at t = 0 — reduced motion, never a loop. */
  const drawStillFrame = (): void => {
    if (lastStillPoseKey === poseKey()) return;

    const action = applied ? actionFor(applied) : undefined;
    if (action) {
      action.reset();
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.play();
    }
    mixer.setTime(0);
    renderer.render(scene, camera);
    lastStillPoseKey = poseKey();
    markReady();
  };

  const frame = (now: number): void => {
    if (disposed) return;
    rafId = requestAnimationFrame(frame);
    if (now - lastDrawAt < FRAME_INTERVAL_MS - FRAME_INTERVAL_SLOP_MS) return;

    const delta =
      lastDrawAt === 0
        ? 0
        : Math.min((now - lastDrawAt) / 1000, MAX_FRAME_DELTA_SECONDS);
    lastDrawAt = now;
    mixer.update(delta);
    draw();
  };

  const start = (): void => {
    if (disposed || running || motion !== 'play' || documentHidden()) return;
    // A playing frame is not a still: invalidate the still key so returning to
    // reduced motion re-draws frame 0 of whatever is resolved.
    lastStillPoseKey = null;
    running = true;
    rafId = requestAnimationFrame(frame);
  };

  const stop = (): void => {
    if (rafId !== 0) cancelAnimationFrame(rafId);
    rafId = 0;
    running = false;
    lastDrawAt = 0;
  };

  const applyClip = (next: AvatarClipName): void => {
    const action = actions.get(next);
    if (!action) return;
    if (next === applied) return;

    const previous = applied ? actionFor(applied) : undefined;
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(
      isOneShotClip(next) ? AVATAR_CLIP_TIME_SCALE[next] : 1,
    );
    action.play();
    if (previous && previous !== action) {
      action.crossFadeFrom(previous, CROSSFADE_SECONDS, false);
    }

    applied = next;
    opts.onClipChange(next);
    if (motion === 'still') drawStillFrame();
  };

  /**
   * Apply a Doom performance clip. Same one-mixer path and the same shipped 0.15 s
   * crossfade — only the source map and the (unscaled) timing differ: the armour
   * clips are authored at 1.333 s and are never normalised into the teleport window.
   */
  const applyDoomClip = (next: DoomClipName): void => {
    const action = doomActions.get(next);
    if (!action) return;
    if (next === applied) return;

    const previous = applied ? actionFor(applied) : undefined;
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.play();
    if (previous && previous !== action) {
      action.crossFadeFrom(previous, CROSSFADE_SECONDS, false);
    }

    applied = next;
    opts.onClipChange(next);
    if (motion === 'still') drawStillFrame();
  };

  /**
   * The Doom overlay request channel. `null` hands the mixer back to the LATEST
   * requested 12-state clip (the release path, and every suspension); a clip plays
   * the armour performance over it. Idempotent on the applied Doom clip, so the
   * store can publish freely.
   */
  function setDoomPerformance(performance: DoomPerformance | null): void {
    const next = performance?.clip ?? null;
    if (next === doomClip) return;
    doomClip = next;
    // A clip switch is never a still: invalidate the still key so reduced motion
    // re-draws frame 0 of the newly resolved clip.
    lastStillPoseKey = null;
    if (next) {
      applyDoomClip(next);
      return;
    }
    applyClip(requested ?? 'idle');
  }

  const onFinished = (event: { action: AnimationAction }): void => {
    // Doom one-shots are resolved by the performance store, never by the 12-state
    // rule: `doom-in`/`doom-out` hand over to a phase, not to a requested state.
    const finishedDoom = clipNameOfAction(event.action, doomActions);
    if (finishedDoom) {
      opts.onDoomClipFinished?.(finishedDoom);
      return;
    }

    const finished = clipNameOfAction(event.action, actions);
    if (!finished) return;
    const next = resolveFinishedClip(finished, requested ?? finished);
    if (next) applyClip(next);
  };

  const onVisibilityChange = (): void => {
    if (documentHidden()) {
      stop();
      return;
    }
    if (motion === 'still') drawStillFrame();
    else start();
  };

  const onContextLost = (event: Event): void => {
    event.preventDefault();
    stop();
    opts.onUnavailable('lost');
  };

  mixer.addEventListener('finished', onFinished);
  document.addEventListener('visibilitychange', onVisibilityChange);
  canvas.addEventListener('webglcontextlost', onContextLost);

  function setState(state: FredoAvatarState): void {
    if (requested === state) return;
    requested = state;
    // Before the asset is parsed there is nothing to switch; the initial apply below
    // picks the remembered state up.
    if (actions.size === 0) return;
    // While the Doom overlay owns the mixer, a request is only RECORDED (a teleport
    // is the one thing that outranks the armour), so the release hands back to the
    // latest resolved state instead of a stale pre-engagement snapshot.
    if (!shouldApplyRequestedClip(state, doomClip !== null)) return;
    applyClip(state);
  }

  function setStreaming(next: boolean): void {
    // Recorded input: the caller derives the motion through `resolveAvatarMotion`
    // (which needs the streaming flag) and pushes it via `setMotion`.
    streaming = next;
  }

  function setMotion(next: AvatarMotion): void {
    if (next === motion) {
      if (next === 'still') drawStillFrame();
      return;
    }
    motion = next;
    if (next === 'still') {
      stop();
      drawStillFrame();
    } else {
      start();
    }
  }

  function setPalette(palette: AvatarPalette): void {
    applyAvatarTint(model, palette);
    bodyColour = palette.body;
    if (motion === 'still') drawStillFrame();
  }

  function getAppliedClip(): AvatarRenderedClip {
    return applied ?? requested ?? 'idle';
  }

  function getAppliedBodyColor(): string {
    return bodyColour ?? '';
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    mixer.removeEventListener('finished', onFinished);
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
    disposeScene(scene);
    renderer.dispose();
    renderer.forceContextLoss();
  }

  // The renderer starts in `play`; a caller that needs a still frame (reduced
  // motion) pushes it through `setMotion('still')` immediately after creation.
  applyClip(requested ?? 'idle');
  start();

  return {
    setState,
    setStreaming,
    setMotion,
    setPalette,
    setDoomPerformance,
    getAppliedClip,
    getAppliedBodyColor,
    dispose,
  };
}
