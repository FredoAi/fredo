/**
 * useDoomModeSkill — the companion `doom_mode` dispatcher (Spec #2970, ST-5).
 *
 * On `llm-skill-call {skill:"doom_mode"}` it validates `arguments.action` in
 * {`enter`,`exit`}, invokes the shared `useDoomMode` client, and ALWAYS pushes
 * exactly ONE deterministic reply through the shipped `skillBridge` — so the
 * companion's 15 s `SAFETY_TIMEOUT_MS` watchdog can never fire. It NEVER opens a
 * window directly (the ST-2 command owns the window lifecycle).
 *
 * It filters only `DOOM_MODE_SKILL`, so it coexists with `useAppOpenRequests`
 * (which ignores every other skill) on the same `llm-skill-call` channel.
 */
import { useCallback, useEffect, useRef } from 'react';

import { adapterBridge } from '../utils/adapterBridge';
import { pushAppOpenReply } from '../components/companion/skillBridge';
import type { AppOpenReply } from '../components/companion/appOpenReply';
import { useDoomMode } from './useDoomMode';
import { DOOM_MODE_SKILL, isDoomModeEngaged, type DoomModeStatus } from './types';

/** The `doom_mode` argument carrying the requested action (binding). */
export const DOOM_MODE_ACTION_ARG = 'action';
/** The enter action value (binding). */
export const DOOM_MODE_ENTER_ACTION = 'enter';
/** The exit action value (binding). */
export const DOOM_MODE_EXIT_ACTION = 'exit';

// Binding reply copy (UI/UX §4) — the WHOLE bubble text, no prefix/suffix.
/** enter accepted & mode active. */
export const DOOM_MODE_ENGAGED_REPLY = 'Doom Mode engaged.';
/** exit accepted & mode inactive. */
export const DOOM_MODE_DISENGAGED_REPLY = 'Doom Mode disengaged.';
/** enter failed (R-1.b / `FREDO_DOOM_MODE_FAIL_ENTER`). */
export const DOOM_MODE_ENTER_FAILED_REPLY = "I couldn't start Doom Mode. Nothing changed.";
/** exit while already inactive (R-3.c no-op). */
export const DOOM_MODE_NOT_ACTIVE_REPLY = "Doom Mode isn't active.";
/** malformed / unknown `action`. */
export const DOOM_MODE_MALFORMED_REPLY = "I didn't catch that Doom Mode command.";

/** Wire contract — the additive skill-selection event payload. */
export interface LlmSkillCallPayload {
  skill: string;
  arguments?: { action?: unknown } | null;
}

export function useDoomModeSkill(): void {
  const { status, enter, exit } = useDoomMode();

  // The handler is registered once and reads the latest status through a ref
  // (the shipped #523 loop guard: never re-subscribe on an unstable identity).
  const statusRef = useRef<DoomModeStatus>(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const handleSkillCall = useCallback(
    async (payload: LlmSkillCallPayload) => {
      if (!payload || payload.skill !== DOOM_MODE_SKILL) return;

      const rawAction =
        payload.arguments && typeof payload.arguments === 'object'
          ? payload.arguments.action
          : undefined;
      const action = typeof rawAction === 'string' ? rawAction : undefined;

      let reply: AppOpenReply;
      if (action !== DOOM_MODE_ENTER_ACTION && action !== DOOM_MODE_EXIT_ACTION) {
        reply = { kind: 'failed', text: DOOM_MODE_MALFORMED_REPLY };
      } else if (action === DOOM_MODE_ENTER_ACTION) {
        const result = await enter('voice').catch(() => undefined);
        reply =
          result?.success && result.active
            ? { kind: 'success', text: DOOM_MODE_ENGAGED_REPLY }
            : { kind: 'failed', text: DOOM_MODE_ENTER_FAILED_REPLY };
      } else {
        // "exit while already inactive" (R-3.c no-op) is told the truth: the
        // decision is made from the mode BEFORE the exit attempt.
        const wasEngaged = isDoomModeEngaged(statusRef.current.phase);
        const result = await exit('voice').catch(() => undefined);
        if (!wasEngaged) {
          reply = { kind: 'unknown', text: DOOM_MODE_NOT_ACTIVE_REPLY };
        } else if (result?.success && !result.active) {
          reply = { kind: 'success', text: DOOM_MODE_DISENGAGED_REPLY };
        } else {
          reply = { kind: 'unknown', text: DOOM_MODE_NOT_ACTIVE_REPLY };
        }
      }

      // ALWAYS push exactly one reply — the 15 s watchdog can never fire.
      pushAppOpenReply(reply);
    },
    [enter, exit],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const off = await adapterBridge.listen<LlmSkillCallPayload>('llm-skill-call', (payload) => {
        void handleSkillCall(payload);
      });
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
  }, [handleSkillCall]);
}
