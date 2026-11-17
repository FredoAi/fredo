/**
 * Wireframe canvas operator state (Spec #3151, ST-5).
 *
 * The canvas's create operator (`armed` shape kind), its two cursor constants
 * and their subscriber set were declared in the deleted engine-surface module.
 * They are pure presentation state, so they re-home here — nothing in this
 * module imports the navigation engine or the document store.
 *
 * Session-scoped and module-level (never a React ref) so the armed kind survives
 * a component remount while the user is mid-gesture; it is never persisted.
 */

import type { WireframeShapeDrawKind } from '../model/elements';

/** Cursor while the create operator is armed. */
export const WIREFRAME_DRAW_CURSOR = 'crosshair';
/** Cursor while the pan tool is latched. */
export const WIREFRAME_PAN_CURSOR = 'grab';

let armedShape: WireframeShapeDrawKind | null = null;
const armedListeners = new Set<() => void>();

function notifyArmed(): void {
  for (const listener of armedListeners) listener();
}

function setArmed(shape: WireframeShapeDrawKind | null): void {
  if (armedShape === shape) return;
  armedShape = shape;
  notifyArmed();
}

/** Arm the create operator for `shape`; the next pointer commit supplies the bounds. */
export function beginWireframeShapeCreate(shape: WireframeShapeDrawKind): void {
  setArmed(shape);
}

/** The currently armed create kind, or `null`. */
export function getArmedWireframeShape(): WireframeShapeDrawKind | null {
  return armedShape;
}

/** Disarm the create operator. */
export function clearArmedWireframeShape(): void {
  setArmed(null);
}

/** Subscribe to armed-kind changes (canvas selector). */
export function subscribeArmedWireframeShape(listener: () => void): () => void {
  armedListeners.add(listener);
  return () => {
    armedListeners.delete(listener);
  };
}

/** Test-only: reset the armed kind and drop every listener. */
export function resetWireframeCanvasOperatorForTests(): void {
  armedShape = null;
  armedListeners.clear();
}
