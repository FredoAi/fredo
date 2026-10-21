/**
 * useWireframeSkill — Home's `wireframe` companion dispatcher (Spec #3070, ST-7,
 * C5 / R-6.1–R-6.5).
 *
 * A `llm-skill-call` arrives ONCE, in the main window. This hook:
 *
 *  1. ignores every skill except `wireframe` (the single-listener-per-skill rule
 *     shared with `useAppOpenRequests` / `useDoomModeSkill`);
 *  2. answers `wireframe.companion.listActions` DIRECTLY — the catalog is static,
 *     so listing works with the app closed and opens nothing (R-6.1);
 *  3. rejects an unknown action id locally: no intent is sent, no window opens,
 *     nothing changes, and the reply says so (R-6.4);
 *  4. resolves the Wireframe app with the shipped identity helper and opens it
 *     through the shipped presentation-aware `openApp` only when it is not
 *     already open;
 *  5. invokes `wireframe_intent` (host persists + broadcasts) and waits for the
 *     matching `wireframe-intent-result`, bounded by a timeout;
 *  6. composes the reply through `wireframeReply.ts` and pushes it through the
 *     shipped companion reply channel.
 *
 * The editor side lives in the Wireframe app (`useWireframeIntent` +
 * `wireframeCompanion.executeWireframeIntent`); this hook never touches the
 * document store, so it works while the editor is unmounted or in another
 * webview (G-124).
 */

import { useCallback, useEffect, useRef } from 'react';

import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { pushAppOpenReply } from '../../../shared/components/companion/skillBridge';
import { getWindowSnapshot } from '../../../shared/window-system/windowStore';
import { resolveAppIdentity } from '../lib/appIdentity';
import { findWireframeAction } from '../../wireframe/actions/wireframeActions';
import { WIREFRAME_LIST_ACTIONS_ID } from '../../wireframe/actions/wireframeCompanion';
import {
  wireframeListReply,
  wireframeNothingChangedReply,
  wireframePerformedReply,
  wireframeUnknownActionReply,
} from '../../wireframe/actions/wireframeReply';
import type { FredoApplicationClass } from '../../../shared/classes/FredoApplicationClass';

/** The skill name this hook owns (binding). */
export const WIREFRAME_SKILL_NAME = 'wireframe';
/** The identity resolved through the shipped `resolveAppIdentity` (name or id). */
export const WIREFRAME_APP_IDENTITY = 'Wireframe';
/** Host commands / event (C5 binding). */
export const WIREFRAME_INTENT_COMMAND = 'wireframe_intent';
export const WIREFRAME_INTENT_RESULT_EVENT = 'wireframe-intent-result';
/**
 * Bounded wait for the editor's result. Below the companion's 15 s watchdog,
 * so a lost intent always settles the bubble with the failure reply.
 */
export const WIREFRAME_INTENT_TIMEOUT_MS = 10_000;

/** Wire contract — the additive skill-selection event payload. */
export interface WireframeSkillCallPayload {
  skill: string;
  arguments?: {
    action?: unknown;
    app_name?: unknown;
    summary?: unknown;
  } | null;
}

/** Wire contract — the editor's result for one request (camelCase over IPC). */
export interface WireframeIntentResultPayload {
  requestId: string;
  performed: string[];
  detail?: string | null;
}

export interface UseWireframeSkillOptions {
  /** The full-lifecycle presentation-aware opener Home registers (`openApp`). */
  openFeatureWindow: (id: string, feature: FredoApplicationClass) => void;
  /** The addressable feature list (Home passes `SHOWABLE_FEATURES`). */
  features: readonly FredoApplicationClass[];
}

type PendingResolver = (result: WireframeIntentResultPayload) => void;

/** `crypto.randomUUID()` per the engineering rules (with a non-crypto fallback). */
function createRequestId(): string {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `wireframe-intent-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function useWireframeSkill({
  openFeatureWindow,
  features,
}: UseWireframeSkillOptions): void {
  // Refs keep the listeners registered exactly once while always seeing the
  // latest opener/list (the shipped #523 loop guard: never re-subscribe on an
  // unstable identity).
  const openFeatureWindowRef = useRef(openFeatureWindow);
  const featuresRef = useRef(features);
  const pendingRef = useRef<Map<string, PendingResolver>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    openFeatureWindowRef.current = openFeatureWindow;
  }, [openFeatureWindow]);

  useEffect(() => {
    featuresRef.current = features;
  }, [features]);

  /** Send one intent and wait for its matching result (bounded). */
  const requestIntent = useCallback(
    (
      action: string,
      args: Record<string, unknown>,
    ): Promise<WireframeIntentResultPayload | null> => {
      const requestId = createRequestId();
      return new Promise((resolve) => {
        const settle = (result: WireframeIntentResultPayload | null) => {
          const timer = timersRef.current.get(requestId);
          if (timer !== undefined) {
            clearTimeout(timer);
            timersRef.current.delete(requestId);
          }
          pendingRef.current.delete(requestId);
          resolve(result);
        };

        const timer = setTimeout(() => {
          timersRef.current.delete(requestId);
          pendingRef.current.delete(requestId);
          resolve(null);
        }, WIREFRAME_INTENT_TIMEOUT_MS);
        timersRef.current.set(requestId, timer);
        pendingRef.current.set(requestId, (result) => settle(result));

        void adapterBridge
          .invoke(WIREFRAME_INTENT_COMMAND, {
            requestId,
            action,
            arguments: args,
          })
          .catch((error) => {
            console.warn('[useWireframeSkill] wireframe_intent failed', error);
            settle(null);
          });
      });
    },
    [],
  );

  const handleSkillCall = useCallback(
    async (payload: WireframeSkillCallPayload) => {
      if (!payload || payload.skill !== WIREFRAME_SKILL_NAME) return;

      const args =
        payload.arguments && typeof payload.arguments === 'object'
          ? (payload.arguments as Record<string, unknown>)
          : {};
      const rawAction = args.action;
      const action = typeof rawAction === 'string' ? rawAction.trim() : '';

      if (action === '') {
        pushAppOpenReply({ kind: 'failed', text: wireframeNothingChangedReply() });
        return;
      }

      // R-6.1 — list straight from the static catalog: works with the app
      // closed, opens nothing, and never needs the editor.
      if (action === WIREFRAME_LIST_ACTIONS_ID) {
        pushAppOpenReply({ kind: 'success', text: wireframeListReply() });
        return;
      }

      // R-6.4 — unknown id: no intent, no window, nothing changes.
      if (!findWireframeAction(action)) {
        pushAppOpenReply({
          kind: 'unknown',
          text: wireframeUnknownActionReply(action),
        });
        return;
      }

      const resolution = resolveAppIdentity(WIREFRAME_APP_IDENTITY, featuresRef.current);
      if (resolution.kind !== 'resolved') {
        pushAppOpenReply({ kind: 'failed', text: wireframeNothingChangedReply() });
        return;
      }

      const { feature, displayName } = resolution;
      const isOpen = getWindowSnapshot().some((entry) => entry.id === feature.id);
      if (!isOpen) {
        // The shipped presentation-aware opener (never a raw window open).
        openFeatureWindowRef.current(feature.id, feature);
      }

      const appName =
        typeof args.app_name === 'string' && args.app_name.trim() !== ''
          ? args.app_name.trim()
          : displayName;

      const result = await requestIntent(action, args);
      if (result === null || result.performed.length === 0) {
        pushAppOpenReply({ kind: 'failed', text: wireframeNothingChangedReply() });
        return;
      }

      pushAppOpenReply({
        kind: 'success',
        text: wireframePerformedReply(appName, result.performed),
      });
    },
    [requestIntent],
  );

  // The result listener is registered once; the handler resolves the pending
  // request by `requestId` (never by arrival order).
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const off = await adapterBridge.listen<WireframeIntentResultPayload>(
        WIREFRAME_INTENT_RESULT_EVENT,
        (payload) => {
          if (!payload || typeof payload.requestId !== 'string') return;
          const resolve = pendingRef.current.get(payload.requestId);
          if (!resolve) return;
          pendingRef.current.delete(payload.requestId);
          resolve(payload);
        },
      );
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // The skill listener mirrors `useDoomModeSkill`: one channel, one skill.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const off = await adapterBridge.listen<WireframeSkillCallPayload>(
        'llm-skill-call',
        (payload) => {
          void handleSkillCall(payload);
        },
      );
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
    })();

    return () => {
      disposed = true;
      unlisten?.();
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
      pendingRef.current.clear();
    };
  }, [handleSkillCall]);
}
