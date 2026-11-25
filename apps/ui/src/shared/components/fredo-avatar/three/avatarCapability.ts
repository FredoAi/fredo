/**
 * #3210 ST-3 — the live-3D capability probe (R-4: "whenever live 3D rendering is
 * unavailable, a static image of the same character fills the exact footprint").
 *
 * ORDER IS THE CONTRACT (`### Resolved Unknowns` U-1), and it is deliberate:
 *
 *   1. no `window`                   -> false (SSR / a non-DOM host)
 *   2. no `WebGL2RenderingContext`   -> false (jsdom, and any WebGL2-less host)
 *   3. no `HTMLCanvasElement`        -> false (defensive: no canvas, no renderer)
 *   -> true
 *
 * The probe NEVER calls `canvas.getContext`. Under jsdom a `getContext` call emits
 * a "Not implemented" virtual-console error into every avatar-rendering suite (and
 * a canvas-level console gate would then fail a suite for a capability the host
 * simply does not have). Short-circuiting on the GLOBAL keeps the 12 jsdom suites
 * quiet without mocking anything: they exercise the production poster path.
 *
 * A host can still fail to create a context for driver reasons even when the
 * global exists; that surfaces from the renderer constructor and is mapped to
 * `onUnavailable('unsupported')` by the hook — never guessed here.
 */

/** True when this host can host a live WebGL2 avatar renderer. */
export function probeAvatar3d(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof WebGL2RenderingContext === 'undefined') return false;
  if (typeof HTMLCanvasElement === 'undefined') return false;
  return true;
}
