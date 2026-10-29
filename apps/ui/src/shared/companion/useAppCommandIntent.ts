/**
 * The generic application-side intent hook (Spec #3099, ST-6).
 *
 * Replaces the Wireframe-only `useWireframeIntent`. Mounted by an application's
 * shell; it consumes the ONE generic host relay:
 *
 *  - the `app-command-intent` event (this application was already mounted when
 *    the host broadcast it), and
 *  - an `app_command_intent_take` drain on mount (the application mounted LATER
 *    — it had to be opened first — or lives in another webview).
 *
 * Both paths funnel through {@link handleAppCommandIntent}, which executes the
 * named command through the ONE executor (`executeCommand`, so the declared
 * argument contract re-runs before `run` — R-3d defence in depth) and ALWAYS
 * reports a result (`app_command_intent_result`) — including a thrown error, so
 * the Home dispatcher never waits for something that will not come.
 *
 * Exactly-once is guarded by a MODULE-SCOPED handled-request ledger, never a
 * React ref: refs reset on every mount, and a remount must not re-execute an
 * intent that is still in the host queue.
 *
 * Intents addressed to another `appId` are ignored — no cross-app drain.
 */

import { useEffect } from 'react';

import { executeCommand } from '../hotkeys/commandSurfaceStore';
import type { ApplicationCommandArgs } from '../hotkeys/commandSurface';
import { adapterBridge } from '../utils/adapterBridge';

/** Host event carrying one intent (ST-5 binding). */
export const APP_COMMAND_INTENT_EVENT = 'app-command-intent';
/** Drain the bounded host queue for one application on mount (ST-5 binding). */
export const APP_COMMAND_INTENT_TAKE_COMMAND = 'app_command_intent_take';
/** Report the outcome for one intent (ST-5 binding). */
export const APP_COMMAND_INTENT_RESULT_COMMAND = 'app_command_intent_result';

/**
 * The reported outcome (mirrors the Rust `AppCommandOutcome`, PascalCase over
 * IPC). `Performed` is the only one that claims work.
 */
export type AppCommandOutcomeName = 'Performed' | 'Noop' | 'Invalid' | 'Failed';

/** One relayed intent (`app-command-intent` payload, camelCase). */
export interface AppCommandIntentPayload {
  readonly requestId: string;
  readonly appId: string;
  readonly action: string;
  /** The command's flat string map (`arguments` of the tool call). */
  readonly arguments?: unknown;
}

/** The result the dispatcher matches by `requestId`. */
export interface AppCommandIntentResultPayload {
  readonly requestId: string;
  readonly appId: string;
  readonly outcome: AppCommandOutcomeName;
  readonly performed: readonly string[];
  readonly detail?: string | null;
}

/** Handled-id cap. Far above a session's intent count; bounded by design. */
const HANDLED_REQUEST_LIMIT = 200;

/** Module-scoped ledger — survives mount/unmount (never a React ref). */
let handledRequestIds: string[] = [];

function markHandled(requestId: string): void {
  handledRequestIds.push(requestId);
  if (handledRequestIds.length > HANDLED_REQUEST_LIMIT) {
    handledRequestIds = handledRequestIds.slice(-HANDLED_REQUEST_LIMIT);
  }
}

function wasHandled(requestId: string): boolean {
  return handledRequestIds.includes(requestId);
}

/** Test-only: forget the handled-id ledger (module-scoped by design). */
export function resetAppCommandIntentLedgerForTests(): void {
  handledRequestIds = [];
}

/** Whether `intent` carries the identifiers the relay always sends. */
function isValidIntent(
  intent: AppCommandIntentPayload | null | undefined,
): intent is AppCommandIntentPayload {
  return (
    !!intent &&
    typeof intent.requestId === 'string' &&
    intent.requestId.trim() !== '' &&
    typeof intent.appId === 'string' &&
    intent.appId.trim() !== '' &&
    typeof intent.action === 'string' &&
    intent.action.trim() !== ''
  );
}

/**
 * The intent's `arguments` is already the command's flat string map. An absent
 * value is the "no arguments supplied" shape (`{}`), NEVER `undefined`: passing
 * `undefined` would let the executor open an inline prompt for a prompt-backed
 * command, and the companion path must present no human prompt.
 *
 * A present non-object value is passed THROUGH (not normalised away) so the
 * declared-argument rule rejects it (`not-an-object`) instead of silently
 * executing with no arguments.
 */
function toCommandArgs(value: unknown): ApplicationCommandArgs {
  if (value === undefined || value === null) return {};
  return value as ApplicationCommandArgs;
}

/** Map the executor's outcome onto the relay's outcome vocabulary. */
function mapOutcome(
  status: 'performed' | 'noop' | 'rejected' | 'failed',
): AppCommandOutcomeName {
  switch (status) {
    case 'performed':
      return 'Performed';
    case 'noop':
      return 'Noop';
    case 'rejected':
      return 'Invalid';
    default:
      return 'Failed';
  }
}

/**
 * Execute one intent (idempotent per `requestId`) and ALWAYS report the
 * outcome. Exported so the event path and the drain share one implementation.
 */
export async function handleAppCommandIntent(
  intent: AppCommandIntentPayload | null | undefined,
): Promise<void> {
  if (!isValidIntent(intent)) return;
  if (wasHandled(intent.requestId)) return;
  markHandled(intent.requestId);

  const action = intent.action.trim();
  let outcome: AppCommandOutcomeName = 'Failed';
  let performed: string[] = [];
  let detail: string | undefined;

  try {
    // The ONE executor — it re-runs `validateCommandArgs` before `run` (R-3d).
    const result = await executeCommand(intent.appId, action, toCommandArgs(intent.arguments));
    outcome = mapOutcome(result.status);
    if (result.status === 'performed') performed = [action];
    if (result.status === 'rejected') detail = result.reason;
  } catch (error) {
    // A throwing `run` is already mapped to `failed` by the executor; this
    // guard covers anything else. Never a silent drop.
    outcome = 'Failed';
    detail = error instanceof Error ? error.message : String(error);
  }

  try {
    await adapterBridge.invoke(APP_COMMAND_INTENT_RESULT_COMMAND, {
      requestId: intent.requestId,
      appId: intent.appId,
      outcome,
      performed,
      detail: detail ?? null,
    });
  } catch (error) {
    // The dispatcher's bounded timeout is the failure surface; never throw out
    // of a listener.
    console.warn('[useAppCommandIntent] app_command_intent_result failed', error);
  }
}

/**
 * Drain the host queue for `appId` and execute each intent in order. Intents
 * addressed to another application are skipped (they stay queued host-side).
 * Exported for the mount path and its unit pin.
 */
export async function drainAppCommandIntents(appId: string): Promise<void> {
  if (typeof appId !== 'string' || appId.trim() === '') return;

  let queued: AppCommandIntentPayload[] | undefined;
  try {
    queued = await adapterBridge.invoke<AppCommandIntentPayload[]>(
      APP_COMMAND_INTENT_TAKE_COMMAND,
      { appId },
    );
  } catch (error) {
    console.warn('[useAppCommandIntent] app_command_intent_take failed', error);
    return;
  }

  for (const intent of queued ?? []) {
    if (!intent || intent.appId !== appId) continue;
    await handleAppCommandIntent(intent);
  }
}

/**
 * Mount the intent listener + the take-on-mount drain for `appId`.
 *
 * The listener is registered FIRST, then the queue is drained: an intent that
 * fired before registration is still in the host queue for the drain, and an
 * intent that fires after registration is handled by the event (the ledger
 * makes a later drain of the same request a no-op).
 */
export function useAppCommandIntent(appId: string): void {
  useEffect(() => {
    if (typeof appId !== 'string' || appId.trim() === '') return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const off = await adapterBridge.listen<AppCommandIntentPayload>(
        APP_COMMAND_INTENT_EVENT,
        (payload) => {
          // No cross-app execution: only intents addressed to THIS app.
          if (!payload || payload.appId !== appId) return;
          void handleAppCommandIntent(payload);
        },
      );
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
      await drainAppCommandIntents(appId);
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appId]);
}
