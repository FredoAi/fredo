/**
 * Spec #3120 (P6), ST-1 — the launcher-open bridge.
 *
 * The `/ Ask` rail affordance and the `app.ask` verb both open the shipped launcher without a
 * cross-application import: they publish a `LauncherOpenRequest` here and the Home launcher shell
 * — always mounted — subscribes. A request carries WHY it opened (so the shell can decide focus)
 * and an optional prefill. There is no queue and no state: a request that arrives with no
 * subscriber is dropped (the launcher is not mounted, so there is nothing to open).
 *
 * Module-scoped and synchronous; no persistence, no clock, no I/O.
 */

/** Why the launcher was asked to open. */
export interface LauncherOpenRequest {
  readonly source: 'ask-verb' | 'rail-ask' | 'keyboard';
  readonly prefill?: string;
  readonly focus: true;
}

type Listener = (request: LauncherOpenRequest) => void;

const listeners = new Set<Listener>();

/** Publish an open request to the mounted launcher (no-op when none is subscribed). */
export function requestLauncherOpen(request: LauncherOpenRequest): void {
  for (const listener of [...listeners]) listener(request);
}

/** Subscribe the launcher shell; the returned disposer is idempotent. */
export function subscribeLauncherOpenRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
