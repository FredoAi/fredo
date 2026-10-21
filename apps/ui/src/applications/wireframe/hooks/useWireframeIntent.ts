/**
 * Wireframe intent listener (Spec #3070, ST-7, C5 / G-124).
 *
 * Mounted by the editor shell. Two entry points, one executor:
 *
 *  - a `wireframe-intent` event (the editor was already mounted when the host
 *    broadcast it), and
 *  - a `wireframe_intent_take()` drain on mount (the editor mounted LATER — the
 *    app had to be opened first — or lives in another webview).
 *
 * Both paths funnel through the queue so an intent is executed EXACTLY once:
 * the event is a wake-up that drains the authoritative host queue, and a
 * bounded module-scoped handled-id set guards the (unlikely) case where the
 * same request is both drained and delivered.
 *
 * Every intent is answered with `wireframe_intent_result` — including the
 * `performed: []` no-op — so the Home hook never waits forever.
 */

import { useEffect } from 'react';

import { adapterBridge } from '../../../shared/utils/adapterBridge';
import {
  executeWireframeIntent,
  type WireframeIntentPayload,
} from '../actions/wireframeCompanion';

/** The host event carrying one intent (C5 binding). */
export const WIREFRAME_INTENT_EVENT = 'wireframe-intent';
/** Drain the bounded host queue on mount (C5 binding). */
export const WIREFRAME_INTENT_TAKE_COMMAND = 'wireframe_intent_take';
/** Report the performed subset (C5 binding). */
export const WIREFRAME_INTENT_RESULT_COMMAND = 'wireframe_intent_result';

/** Handled-id cap. Far above a session's intent count; bounded by design. */
const HANDLED_REQUEST_LIMIT = 200;

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
export function resetWireframeIntentHandledForTests(): void {
  handledRequestIds = [];
}

/**
 * Execute one intent (idempotent per `requestId`) and always report the
 * outcome. Exported so the drain and the event path share one implementation.
 */
export async function handleWireframeIntent(
  intent: WireframeIntentPayload | null | undefined,
): Promise<void> {
  if (
    !intent ||
    typeof intent.requestId !== 'string' ||
    intent.requestId.trim() === '' ||
    typeof intent.action !== 'string'
  ) {
    return;
  }
  if (wasHandled(intent.requestId)) return;
  markHandled(intent.requestId);

  const outcome = executeWireframeIntent(intent);

  try {
    await adapterBridge.invoke(WIREFRAME_INTENT_RESULT_COMMAND, {
      requestId: intent.requestId,
      performed: outcome.performed,
      detail: outcome.detail ?? null,
    });
  } catch (error) {
    // The Home hook's bounded timeout is the failure surface; never throw out
    // of a listener.
    console.warn('[useWireframeIntent] wireframe_intent_result failed', error);
  }
}

/**
 * Drain the host queue and execute each intent in order. Exported for the
 * mount path and its unit pin.
 */
export async function drainWireframeIntents(): Promise<void> {
  let queued: WireframeIntentPayload[] | undefined;
  try {
    queued = await adapterBridge.invoke<WireframeIntentPayload[]>(
      WIREFRAME_INTENT_TAKE_COMMAND,
    );
  } catch (error) {
    console.warn('[useWireframeIntent] wireframe_intent_take failed', error);
    return;
  }
  for (const intent of queued ?? []) {
    await handleWireframeIntent(intent);
  }
}

/**
 * Mount the intent listener + the take-on-mount drain. Register the listener
 * FIRST, then drain: an event that fires before registration is still in the
 * queue for the drain, and an event that fires after registration triggers its
 * own drain. No intent can fall between the two.
 */
export function useWireframeIntent(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const off = await adapterBridge.listen<WireframeIntentPayload>(
        WIREFRAME_INTENT_EVENT,
        () => {
          void drainWireframeIntents();
        },
      );
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
      await drainWireframeIntents();
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
