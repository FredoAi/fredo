/**
 * performanceGate — the module-scoped companion voice/audio suppression gate
 * (Spec #2970, ST-5; UI/UX §2).
 *
 * While Doom Mode is active the companion's voice/audio pipeline is suppressed.
 * `LauncherShell` consumes this through the shipped external-store pattern
 * (`useSyncExternalStore(subscribePerformanceGate, isPerformanceGateActive,
 * isPerformanceGateActive)`), so the suppression is visible to the launcher
 * without a React context and without a `useRef`.
 *
 * Module-scoped BY DESIGN: React refs reset across mount/unmount, and the gate
 * must survive companion/window mount cycles (ENGINEERING_RULES — never a
 * `useRef` for cross-mount state). `useDoomMode()` is the single driver: it
 * re-sets the same boolean on its mount seed and on every `doom-mode-changed`,
 * so multiple mounts are idempotent.
 */

type Listener = () => void;

let active = false;
const listeners = new Set<Listener>();

/** Set the gate. Idempotent; notifies subscribers only on an actual change. */
export function setPerformanceGateActive(next: boolean): void {
  if (active === next) return;
  active = next;
  listeners.forEach((listener) => {
    listener();
  });
}

/** Read the gate. `false` unless Doom Mode is active. */
export function isPerformanceGateActive(): boolean {
  return active;
}

/** Subscribe to gate changes. Returns the unsubscribe function. */
export function subscribePerformanceGate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
