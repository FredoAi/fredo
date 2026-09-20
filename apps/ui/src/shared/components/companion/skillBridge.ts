/**
 * Spec #2893 ST-6 — the module-scoped app-open reply-push bridge.
 *
 * The Home hook (`useAppOpenRequests`) resolves an `llm-skill-call` to a
 * deterministic reply, but the bubble lives inside `CompanionEntity`, which the
 * hook cannot see (different React subtrees; the seat and the away overlay are
 * separate trees). This module mirrors the shipped `askActiveCompanion`
 * registry (#2870/#2871): exactly ONE companion entity registers a pusher per
 * window at a time, and the hook pushes through it.
 *
 * Contract for ST-7 (CompanionEntity consumer):
 *   - Call `registerAppOpenReplyPusher(push)` on mount, call the returned
 *     unregister function on unmount. The pusher applies the composed reply to
 *     the existing `streamingMessage` / live-region channel: `success` settles
 *     with the shipped `happy` beat, `unknown`/`ambiguous`/`failed` settle
 *     `idle` with the shipped error hold (no celebration).
 *   - `pushAppOpenReply` returns `true` iff a pusher was registered; it NEVER
 *     throws and silently no-ops when no companion is mounted (the reply is
 *     simply not shown — no window behavior depends on it).
 *
 * Module-scoped by design: React refs reset across mount/unmount, and the
 * reply must survive a component close/reopen cycle within a generation.
 */
import type { AppOpenReply } from './appOpenReply';

type AppOpenReplyPusher = (reply: AppOpenReply) => void;

let activePusher: AppOpenReplyPusher | null = null;

/**
 * Register the active companion entity's reply pusher. Returns the unregister
 * function (idempotent; a stale unregister never clears a newer pusher).
 */
export function registerAppOpenReplyPusher(pusher: AppOpenReplyPusher): () => void {
  activePusher = pusher;
  return () => {
    if (activePusher === pusher) activePusher = null;
  };
}

/**
 * Push a composed reply to the active companion. Returns `true` iff a pusher
 * was registered; a `false` return is a safe no-op (no companion mounted).
 *
 * R-1.4 (Spec #2893 ST-9) — the bridge NEVER throws. A pusher that throws (a
 * resolve during teardown, a state update on an unmounted tree) must not abort
 * the caller: the reply is simply not applied, and the companion's shipped
 * `SAFETY_TIMEOUT_MS` watchdog settles the still-pending generation. The
 * failure is diagnostic noise, never a stuck-state or a caller crash.
 */
export function pushAppOpenReply(reply: AppOpenReply): boolean {
  if (!activePusher) return false;
  try {
    activePusher(reply);
  } catch (error) {
    console.warn('[skillBridge] app-open reply pusher threw', error);
  }
  return true;
}
