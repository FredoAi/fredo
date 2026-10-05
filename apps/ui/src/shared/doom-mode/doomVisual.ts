/**
 * doomVisual — the module-scoped Doom Mode visual-engagement store
 * (Spec #2971, ST-2; architect API contract).
 *
 * While Doom Mode is engaged the whole app is restyled to the Doom palette
 * (ST-4, inside `ThemeProvider`) and the Fredo avatar wears a Doom-armor
 * overlay (ST-5). Both consumers read THIS one boolean through the shipped
 * external-store pattern (`useSyncExternalStore(subscribeDoomVisual,
 * isDoomVisualEngaged, isDoomVisualEngaged)`), so the theme layer and the
 * armor overlay can never diverge from the phase.
 *
 * Module-scoped BY DESIGN: React refs reset across mount/unmount, and the
 * engaged flag must survive component/window mount cycles (ENGINEERING_RULES —
 * never a `useRef` for cross-mount state). `useDoomMode()` is the single driver
 * (ST-3): it re-sets the same boolean on its mount seed and on every
 * `doom-mode-changed`, so multiple mounts are idempotent. The flag starts
 * `false` and is never persisted — it mirrors the backend's never-persisted
 * mode and resets to `false` on reload.
 */

type Listener = () => void;

let engaged = false;
const listeners = new Set<Listener>();

/** Set the visual-engaged flag. Idempotent; notifies subscribers only on an actual change. */
export function setDoomVisualEngaged(next: boolean): void {
  if (engaged === next) return;
  engaged = next;
  listeners.forEach((listener) => {
    listener();
  });
}

/** Read the flag. `false` unless Doom Mode is engaged. */
export function isDoomVisualEngaged(): boolean {
  return engaged;
}

/** Subscribe to flag changes. Returns the unsubscribe function. */
export function subscribeDoomVisual(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
