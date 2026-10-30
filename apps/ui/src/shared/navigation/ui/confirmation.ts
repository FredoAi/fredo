/**
 * Spec #3120 (P6), ST-1 — the launcher confirmation store: the ONE await in the keystroke path.
 *
 * The host's risk policy asks this store for a destructive/external intent that originated from
 * the launcher, voice or agent channel. The store holds at most ONE pending confirmation (a new
 * request supersedes the old one as a cancel), notifies the mounted launcher, and resolves the
 * funnel's promise when the dialog answers.
 *
 * "No launcher surface is mounted" is the absence of a subscriber: the launcher shell subscribes
 * while it is open, so a request from a closed launcher resolves `false` immediately and nothing
 * applies (R-5.3). If the launcher unmounts while a confirmation is pending, the last unsubscribe
 * dismisses it as a cancel — a closed launcher must never leave a promise hanging.
 *
 * Module-scoped by design (it survives component remounts); no persistence, no clock, no I/O.
 */

import type { ConfirmationRequest, Intent } from '../types';

/** §9.1 — the request + the intent it gates (so the host can render verb + target). */
export interface PendingLauncherConfirmation {
  readonly request: ConfirmationRequest;
  readonly intent: Intent;
}

interface PendingState {
  readonly pending: PendingLauncherConfirmation;
  readonly resolve: (accepted: boolean) => void;
  settled: boolean;
}

type Listener = (pending: PendingLauncherConfirmation | null) => void;

let current: PendingState | null = null;
const listeners = new Set<Listener>();

function currentPending(): PendingLauncherConfirmation | null {
  return current === null ? null : current.pending;
}

function notify(): void {
  const pending = currentPending();
  for (const listener of [...listeners]) listener(pending);
}

/** Settle the pending promise exactly once (double resolve is guarded). */
function settle(accepted: boolean): void {
  const state = current;
  if (state === null || state.settled) return;
  state.settled = true;
  current = null;
  notify();
  state.resolve(accepted);
}

/**
 * Ask the mounted launcher to confirm `intent`. Resolves `false` immediately when no launcher
 * surface is subscribed (nothing applies); otherwise resolves when the dialog answers. A second
 * request while one is pending cancels the first (a fresh dialog, no stale promise).
 */
export function requestLauncherConfirmation(
  request: ConfirmationRequest,
  intent: Intent,
): Promise<boolean> {
  if (listeners.size === 0) return Promise.resolve(false);
  if (current !== null) settle(false);

  return new Promise<boolean>((resolve) => {
    current = { pending: { request, intent }, resolve, settled: false };
    notify();
  });
}

/** Answer the pending confirmation. A no-op when nothing is pending or it already settled. */
export function resolveLauncherConfirmation(accepted: boolean): void {
  settle(accepted);
}

/** The pending confirmation the launcher renders, or `null` when none is open. */
export function getPendingLauncherConfirmation(): PendingLauncherConfirmation | null {
  return currentPending();
}

/**
 * Subscribe the launcher to the pending confirmation (replays the current value on subscribe).
 * The returned disposer is idempotent; the last unsubscribe dismisses a still-pending request
 * as a cancel so a closed launcher never strands the funnel.
 */
export function subscribeLauncherConfirmation(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentPending());
  return () => {
    if (!listeners.delete(listener)) return;
    if (listeners.size === 0 && current !== null) settle(false);
  };
}
