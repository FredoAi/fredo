/**
 * useAppCommandSkill — Home's generic companion dispatcher (Spec #3099, ST-6).
 *
 * Replaces the Wireframe-only `useWireframeSkill`. ONE listener on the one
 * `llm-skill-call` channel; every NON-reserved skill is resolved against the
 * PUBLISHED surface registry (`app_command_surfaces`, D12 — never a local
 * `buildCompanionManifest` rebuild), validated host-side, and only then opened +
 * relayed to the owning application.
 *
 * BINDING host pre-flight order (one step at a time; every rejection changes
 * nothing and opens no window):
 *
 *   (0) non-reserved `skill` name only (`open_app` / `close_app` / `doom_mode`
 *       stay owned by their own hooks) -> ONE `app_command_surfaces` read per
 *       incoming call,
 *   (1) the skill is not a published `skillName` -> ignore,
 *   (2) blank / non-string `action` -> nothing-changed,
 *   (3) `listActions` -> the list reply (no window, no relay),
 *   (4) the id is not a published command -> unknown-action reply (no window,
 *       no relay),
 *   (5) a present non-object `arguments` -> nothing-changed (no window, no
 *       relay),
 *   (6) the declared argument contract fails -> nothing-changed (no window, no
 *       relay),
 *   (7) the application cannot be resolved -> nothing-changed,
 *   (8) open the application if it is closed, invoke `app_command_intent`, and
 *       wait <= 10 s for the matching `app-command-intent-result`.
 *
 * Exactly ONE reply per turn, pushed through the shipped `skillBridge`, bounded
 * below the companion's 15 s watchdog. No JSON parsing of model output: the
 * tool-call arguments arrive already parsed and typed.
 */

import { useCallback, useEffect, useRef } from 'react';

import type { AppOpenReply } from '../../../shared/components/companion/appOpenReply';
import { pushAppOpenReply } from '../../../shared/components/companion/skillBridge';
import {
  COMPANION_LIST_ACTIONS_ID,
  type CompanionCommandManifest,
  type CompanionManifest,
  type CompanionSurfaceManifest,
} from '../../../shared/companion/manifest';
import {
  appCommandListReply,
  appCommandNothingChangedReply,
  appCommandPerformedReply,
  appCommandUnknownActionReply,
} from '../../../shared/companion/reply';
import type { AppCommandIntentResultPayload } from '../../../shared/companion/useAppCommandIntent';
import {
  validateDeclaredArguments,
  type VerbArg,
} from '../../../shared/navigation';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { getWindowSnapshot } from '../../../shared/window-system/windowStore';
import type { FredoApplicationClass } from '../../../shared/classes/FredoApplicationClass';
import { resolveAppIdentity } from '../lib/appIdentity';

/** Host relay command (ST-5 binding). */
export const APP_COMMAND_INTENT_COMMAND = 'app_command_intent';
/** The READ-ONLY published-surface view (ST-4/D12 binding). */
export const APP_COMMAND_SURFACES_COMMAND = 'app_command_surfaces';
/** The result event the owning application reports on (ST-5 binding). */
export const APP_COMMAND_INTENT_RESULT_EVENT = 'app-command-intent-result';
/**
 * Bounded wait for the application's result. Below the companion's 15 s
 * watchdog, so a lost intent always settles the bubble with the failure reply.
 */
export const APP_COMMAND_INTENT_TIMEOUT_MS = 10_000;

/**
 * The reserved static skill names. Their own hooks own them on the same
 * `llm-skill-call` channel — this dispatcher never reads the registry for them.
 */
export const RESERVED_SKILL_NAMES: readonly string[] = ['open_app', 'close_app', 'doom_mode'];

/** Wire contract — the additive skill-selection event payload. */
export interface AppCommandSkillCallPayload {
  /** The validated skill name (the surface's `skillName`). */
  skill: string;
  /**
   * The whole parsed tool-call arguments object: `{ action, arguments? }`.
   * `arguments` is the command's flat string map.
   */
  arguments?: unknown;
}

export interface UseAppCommandSkillOptions {
  /** The full-lifecycle presentation-aware opener Home registers (`openApp`). */
  openFeatureWindow: (id: string, feature: FredoApplicationClass) => void;
  /** The addressable feature list (Home passes `SHOWABLE_FEATURES`). */
  features: readonly FredoApplicationClass[];
}

type PendingResolver = (result: AppCommandIntentResultPayload | null) => void;

/** `crypto.randomUUID()` per the engineering rules (with a non-crypto fallback). */
function createRequestId(): string {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `app-command-intent-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** A plain object (never `null`, never an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReservedSkill(skill: string): boolean {
  return RESERVED_SKILL_NAMES.includes(skill);
}

/**
 * Run the manifest's serializable argument contract through the ONE shared rule
 * (`validateDeclaredArguments`, the same matcher the navigation dispatch funnel uses).
 * The published manifest carries `{ name, required, description? }` only; the host
 * pre-flight maps that onto `VerbArg[]` with `type: 'string'` (values arrive as strings
 * and the rule rejects non-strings at runtime).
 */
function manifestArgsAreValid(
  command: CompanionCommandManifest,
  args: Record<string, unknown>,
): boolean {
  const declared: readonly VerbArg[] = command.args.map((arg) => ({
    name: arg.name,
    type: 'string',
    required: arg.required,
  }));
  return validateDeclaredArguments(declared, args as Readonly<Record<string, string>>);
}

export function useAppCommandSkill({
  openFeatureWindow,
  features,
}: UseAppCommandSkillOptions): void {
  // Refs keep the listener registered exactly once while always seeing the
  // latest opener/list (the #523 loop guard: never re-subscribe on an unstable
  // identity).
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
      appId: string,
      action: string,
      args: Record<string, unknown>,
    ): Promise<AppCommandIntentResultPayload | null> => {
      const requestId = createRequestId();
      return new Promise((resolve) => {
        const settle = (result: AppCommandIntentResultPayload | null): void => {
          if (!pendingRef.current.has(requestId)) return;
          pendingRef.current.delete(requestId);
          const timer = timersRef.current.get(requestId);
          if (timer !== undefined) {
            clearTimeout(timer);
            timersRef.current.delete(requestId);
          }
          resolve(result);
        };

        const timer = setTimeout(() => settle(null), APP_COMMAND_INTENT_TIMEOUT_MS);
        timersRef.current.set(requestId, timer);
        pendingRef.current.set(requestId, (result) => settle(result));

        void adapterBridge
          .invoke(APP_COMMAND_INTENT_COMMAND, {
            requestId,
            appId,
            action,
            arguments: args,
          })
          .catch((error) => {
            console.warn('[useAppCommandSkill] app_command_intent failed', error);
            settle(null);
          });
      });
    },
    [],
  );

  const handleSkillCall = useCallback(
    async (payload: AppCommandSkillCallPayload) => {
      if (!payload || typeof payload.skill !== 'string') return;
      const skill = payload.skill.trim();

      // (0) Reserved skills belong to their own hooks — and never pay for a
      // registry read.
      if (skill === '' || isReservedSkill(skill)) return;

      // (0) ONE registry read per incoming call; the surface is resolved from
      // THAT read (D12: the published truth, never a local rebuild).
      let manifest: CompanionManifest | undefined;
      try {
        manifest = await adapterBridge.invoke<CompanionManifest>(APP_COMMAND_SURFACES_COMMAND);
      } catch (error) {
        console.warn('[useAppCommandSkill] app_command_surfaces failed', error);
        return;
      }
      const surface: CompanionSurfaceManifest | undefined = manifest?.surfaces?.find(
        (candidate) => candidate.skillName === skill,
      );
      // (1) Not a published skill -> not ours (another hook or nothing).
      if (surface === undefined) return;

      const reply = (kind: AppOpenReply['kind'], text: string): void => {
        pushAppOpenReply({ kind, text });
      };

      const toolArgs = isPlainObject(payload.arguments) ? payload.arguments : undefined;
      const rawAction = toolArgs?.action;
      const action = typeof rawAction === 'string' ? rawAction.trim() : '';

      // (2) Blank / non-string action.
      if (action === '') {
        reply('failed', appCommandNothingChangedReply(surface));
        return;
      }

      // (3) The reserved listing action: composed from the published manifest,
      // no window and no relay.
      if (action === COMPANION_LIST_ACTIONS_ID) {
        reply('success', appCommandListReply(surface));
        return;
      }

      // (4) Not a published command id -> no window, no relay.
      const command = surface.commands.find((candidate) => candidate.id === action);
      if (command === undefined) {
        reply('unknown', appCommandUnknownActionReply(surface, action));
        return;
      }

      // (5) `arguments` is the command's flat string map. Absent => the "no
      // arguments supplied" shape `{}` (the schema never requires it); a
      // PRESENT non-object is a malformed call.
      const supplied = toolArgs?.arguments;
      if (supplied !== undefined && supplied !== null && !isPlainObject(supplied)) {
        reply('failed', appCommandNothingChangedReply(surface));
        return;
      }
      const commandArgs: Record<string, unknown> = isPlainObject(supplied) ? supplied : {};

      // (6) The declared argument contract — before any window or relay.
      if (!manifestArgsAreValid(command, commandArgs)) {
        reply('failed', appCommandNothingChangedReply(surface));
        return;
      }

      // (7) The owning application must be addressable in THIS window.
      const resolution = resolveAppIdentity(surface.appId, featuresRef.current);
      if (resolution.kind !== 'resolved') {
        reply('failed', appCommandNothingChangedReply(surface));
        return;
      }
      const { feature } = resolution;

      // (8) Only now: open if closed, then relay.
      const isOpen = getWindowSnapshot().some((entry) => entry.id === feature.id);
      if (!isOpen) {
        openFeatureWindowRef.current(feature.id, feature);
      }

      const result = await requestIntent(surface.appId, action, commandArgs);
      if (result !== null && result.outcome === 'Performed') {
        reply('success', appCommandPerformedReply(surface, result.performed));
        return;
      }
      // Noop / Invalid / Failed / timeout all report nothing changed.
      reply('failed', appCommandNothingChangedReply(surface));
    },
    [requestIntent],
  );

  // The result listener is registered once; the handler resolves the pending
  // request by `requestId` (never by arrival order).
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const off = await adapterBridge.listen<AppCommandIntentResultPayload>(
        APP_COMMAND_INTENT_RESULT_EVENT,
        (payload) => {
          if (!payload || typeof payload.requestId !== 'string') return;
          const resolve = pendingRef.current.get(payload.requestId);
          if (!resolve) return;
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

  // The skill listener mirrors `useDoomModeSkill`: one channel, one listener.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const off = await adapterBridge.listen<AppCommandSkillCallPayload>(
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
