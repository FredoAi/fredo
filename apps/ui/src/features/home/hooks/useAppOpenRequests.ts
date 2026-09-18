/**
 * Spec #2893 ST-6 — Home's app-open request/confirm loop.
 *
 * Two listeners, one resolver, one opener (the caller's full-lifecycle
 * `openFeatureWindow`) and one copy source (`appOpenReply`):
 *
 *  (a) `app-open-request` — emitted by the backend (ST-4) to the `main` window
 *      while a `fredo open-app <IDENTITY>` CLI invocation waits for the
 *      webview. Resolve the identity; when resolved, open through the
 *      registered `openFeatureWindow` (the SAME kernel opener the launcher grid
 *      uses — NEVER a raw `openWindow`) and confirm the structured outcome
 *      (`opened`/`unknown`/`ambiguous` + the UI/UX-composed message). Unknown /
 *      ambiguous open ZERO windows (R-2.3/R-2.4).
 *
 *  (b) `llm-skill-call` — emitted by the skill-aware inference path (ST-5) when
 *      the model selects `open_app`. Resolve; push the deterministic reply to
 *      the active companion FIRST (UI/UX ordering contract, §7), then for a
 *      resolved identity defer the CLI open by `APP_OPEN_REPLY_BEAT_MS = 800`
 *      and invoke `run_open_app_cli` (whose `fredo open-app` child round-trips
 *      back through (a), so the opener is still exactly one). A non-zero /
 *      non-`opened` CLI result pushes the failed reply. Unknown / ambiguous
 *      NEVER invoke the CLI (R-4.1/R-4.2). Non-`open_app` skills are ignored.
 *
 * Bounds are owned by the backend (ST-4): confirm wait <= 5 s, CLI child
 * <= 10 s. This hook never blocks or polls.
 */
import { useCallback, useEffect, useRef } from 'react';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { pushAppOpenReply } from '../../../shared/components/companion/skillBridge';
import {
  appOpenAmbiguousReply,
  appOpenFailedReply,
  appOpenSuccessReply,
  appOpenUnknownReply,
} from '../../../shared/components/companion/appOpenReply';
import { resolveAppIdentity } from '../lib/appIdentity';
import type { FredoFeatureClass } from '../../../shared/classes/FredoFeatureClass';

/** UI/UX §7 binding — reply committed first, open dispatched after this beat. */
export const APP_OPEN_REPLY_BEAT_MS = 800;

/** The one registered companion skill this hook executes (ST-3/ST-5). */
export const OPEN_APP_SKILL_NAME = 'open_app';

/** Wire contract §3 — backend -> `main` window on a CLI open request. */
export interface AppOpenRequestPayload {
  requestId: string;
  identity: string;
}

/** Wire contract §4 — the additive skill-selection event. */
export interface LlmSkillCallPayload {
  skill: string;
  arguments?: { app?: unknown } | null;
}

/** Wire contract §3 — `run_open_app_cli` result (camelCase over IPC). */
export interface OpenAppCliResult {
  exitCode: number;
  outcome: AppOpenOutcome;
  message?: string | null;
}

/** The frozen outcome vocabulary shared with the backend. */
export type AppOpenOutcome = 'opened' | 'unknown' | 'ambiguous' | 'unavailable';

export interface UseAppOpenRequestsOptions {
  /** The full-lifecycle kernel opener Home registers with the launcher. */
  openFeatureWindow: (id: string, feature: FredoFeatureClass) => void;
  /** The addressable feature list (Home passes `SHOWABLE_FEATURES`). */
  features: readonly FredoFeatureClass[];
}

/** Fire-and-forget confirmation; an expired id is a harmless backend error. */
async function confirmAppOpenRequest(
  requestId: string,
  outcome: AppOpenOutcome,
  message: string,
  extra?: { displayName?: string; spokenName?: string; candidates?: string[] },
): Promise<void> {
  try {
    await adapterBridge.invoke('confirm_app_open_request', {
      requestId,
      outcome,
      message,
      ...extra,
    });
  } catch (err) {
    console.warn('[useAppOpenRequests] confirm_app_open_request failed', err);
  }
}

export function useAppOpenRequests({
  openFeatureWindow,
  features,
}: UseAppOpenRequestsOptions): void {
  // Refs keep the listeners registered exactly once while always seeing the
  // latest opener/list (the shipped #523 loop guard: never re-subscribe on an
  // unstable identity).
  const openFeatureWindowRef = useRef(openFeatureWindow);
  const featuresRef = useRef(features);
  const beatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    openFeatureWindowRef.current = openFeatureWindow;
  }, [openFeatureWindow]);

  useEffect(() => {
    featuresRef.current = features;
  }, [features]);

  const clearBeatTimer = useCallback(() => {
    if (beatTimerRef.current !== null) {
      clearTimeout(beatTimerRef.current);
      beatTimerRef.current = null;
    }
  }, []);

  /** (a) CLI round trip — resolve, open via the one kernel opener, confirm. */
  const handleAppOpenRequest = useCallback(async (payload: AppOpenRequestPayload) => {
    if (!payload || typeof payload.requestId !== 'string') return;
    const identity = typeof payload.identity === 'string' ? payload.identity : '';
    const resolution = resolveAppIdentity(identity, featuresRef.current);

    if (resolution.kind === 'resolved') {
      openFeatureWindowRef.current(resolution.feature.id, resolution.feature);
      await confirmAppOpenRequest(
        payload.requestId,
        'opened',
        appOpenSuccessReply(resolution.displayName),
        { displayName: resolution.displayName },
      );
      return;
    }

    if (resolution.kind === 'ambiguous') {
      const candidateNames = resolution.candidates.map((candidate) => candidate.name);
      await confirmAppOpenRequest(
        payload.requestId,
        'ambiguous',
        appOpenAmbiguousReply(resolution.spokenName, candidateNames),
        { spokenName: resolution.spokenName, candidates: candidateNames },
      );
      return;
    }

    await confirmAppOpenRequest(
      payload.requestId,
      'unknown',
      appOpenUnknownReply(resolution.spokenName),
      { spokenName: resolution.spokenName },
    );
  }, []);

  /** (b) skill selection — push the reply, then (resolved only) run the CLI. */
  const handleSkillCall = useCallback(
    (payload: LlmSkillCallPayload) => {
      if (!payload || payload.skill !== OPEN_APP_SKILL_NAME) return;

      const rawApp =
        payload.arguments && typeof payload.arguments === 'object'
          ? (payload.arguments as { app?: unknown }).app
          : undefined;
      const identity = typeof rawApp === 'string' ? rawApp : '';
      const resolution = resolveAppIdentity(identity, featuresRef.current);

      if (resolution.kind === 'unknown') {
        pushAppOpenReply({ kind: 'unknown', text: appOpenUnknownReply(resolution.spokenName) });
        return;
      }

      if (resolution.kind === 'ambiguous') {
        pushAppOpenReply({
          kind: 'ambiguous',
          text: appOpenAmbiguousReply(
            resolution.spokenName,
            resolution.candidates.map((candidate) => candidate.name),
          ),
        });
        return;
      }

      // Resolved — commit the success reply BEFORE the open (UI/UX §7), then
      // dispatch the CLI after the readable beat.
      const { feature, displayName } = resolution;
      pushAppOpenReply({ kind: 'success', text: appOpenSuccessReply(displayName) });
      clearBeatTimer();
      beatTimerRef.current = setTimeout(() => {
        beatTimerRef.current = null;
        void (async () => {
          let result: OpenAppCliResult | undefined;
          try {
            result = await adapterBridge.invoke<OpenAppCliResult>('run_open_app_cli', {
              identity: feature.id,
            });
          } catch (err) {
            console.warn('[useAppOpenRequests] run_open_app_cli failed', err);
            result = undefined;
          }
          if (!result || result.exitCode !== 0 || result.outcome !== 'opened') {
            pushAppOpenReply({ kind: 'failed', text: appOpenFailedReply(displayName) });
          }
        })();
      }, APP_OPEN_REPLY_BEAT_MS);
    },
    [clearBeatTimer],
  );

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const subscribe = async () => {
      const unRequest = await adapterBridge.listen<AppOpenRequestPayload>(
        'app-open-request',
        (payload) => {
          void handleAppOpenRequest(payload);
        },
      );
      if (disposed) {
        unRequest();
        return;
      }
      unlisteners.push(unRequest);

      const unSkill = await adapterBridge.listen<LlmSkillCallPayload>(
        'llm-skill-call',
        (payload) => {
          handleSkillCall(payload);
        },
      );
      if (disposed) {
        unSkill();
        return;
      }
      unlisteners.push(unSkill);
    };

    void subscribe();

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      clearBeatTimer();
    };
  }, [handleAppOpenRequest, handleSkillCall, clearBeatTimer]);
}
