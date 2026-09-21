import { isFredoAvatarState } from './fredoAvatarStates';
import type { FredoAvatarState } from './fredoAvatarStates';

/**
 * #2917 ST-4 — the ONE mapping seam from product signals to the shared
 * `FredoAvatar` status vocabulary.
 *
 * Before this module the companion hand-rolled the derivation inline
 * (`CompanionEntity.tsx:376-377`) and the launcher hand-rolled its own priority
 * (`LauncherShell.tsx:577-578`). Both now route through
 * {@link resolveCompanionAvatarState} so the conflict order has exactly one home
 * — and #2918 can select a status from structured model output by adding the ONE
 * optional `modelStatus` input, never by adding states or touching JSX.
 *
 * Pure + synchronous + unit-testable: no React, no timers, no DOM.
 */
export interface AvatarSignals {
  /**
   * The flow-owned expression the consumer is currently driving (the companion's
   * `currentAnim`, the launcher's surface-local moment). This is the BASE
   * candidate — a higher-priority signal below may override it.
   */
  flow: FredoAvatarState;
  /**
   * The resting-cadence phase (`useFredoRestingCadence`). `'playful'` tints an
   * otherwise-`idle` flow with the bounded resting beat.
   */
  resting: 'idle' | 'playful';
  /**
   * A teleport is in flight (`isTeleportingRef`) — a teleport ALWAYS wins: the
   * flow (the teleport base state) is passed straight through, untouched by any
   * other signal, so a status beat can never clobber the leaving/arriving motion.
   */
  teleporting?: boolean;
  /**
   * A generation/reply is streaming. Suppresses the ambient `greeting` beat (a
   * welcome must never mask a live generation), and matches UI/UX's
   * "no generation in flight".
   */
  streaming?: boolean;
  /**
   * A skill/tool call is pending (the settle is deferred) — renders `working`.
   * Superseded by the settle paths (`happy` / `error`) and the watchdog, which
   * each replace the flow-owned state (and clear this flag).
   */
  skillPending?: boolean;
  /**
   * The typed error channel fired — renders `error`. It must outrank `happy`
   * (a completion beat must never mask a failure).
   */
  errored?: boolean;
  /**
   * A context (ambient welcome) message is present. With NO generation in flight
   * the expression is `greeting`, while the context `animState` stays `talk` (the
   * #2853 busy/presence marker is untouched).
   */
  ambientMessage?: boolean;
  /**
   * Voice capture is live (`useVoiceDictation().listening`) — renders the
   * `listening` meter on the right cheek.
   */
  captureActive?: boolean;
  /**
   * #2918 model-driven status. Any value NOT in the frozen `FREDO_AVATAR_STATES`
   * vocabulary is DROPPED (boundary validation) so malformed model output can
   * never reach the DOM as a stray `data-state`.
   */
  modelStatus?: string;
}

/**
 * #2917 ST-4 — the ordered status-conflict resolution (UI/UX §1), the single
 * source of the priority comparison. A teleport is handled separately: it always
 * wins outright (see {@link resolveCompanionAvatarState}).
 *
 * `working > error > happy (holds) > joking > listening > greeting > thinking >
 * resting playful > idle`
 *
 * `talk` and the teleport base states are deliberately NOT members: they are
 * base states (never conflict candidates) — `talk` is overridden by every status
 * above it, and the teleport states are passed through before this order is
 * consulted.
 */
export const FREDO_AVATAR_STATE_PRIORITY = [
  'working',
  'error',
  'happy',
  'joking',
  'listening',
  'greeting',
  'thinking',
  'playful',
  'idle',
] as const satisfies readonly FredoAvatarState[];

/** The base teleport states — passed through untouched (a teleport always wins). */
const TELEPORT_STATES: readonly FredoAvatarState[] = ['teleport-out', 'teleport-in'];

/** Lower rank = higher priority; a base state outside the order is unranked. */
const PRIORITY_RANK = new Map<FredoAvatarState, number>(
  FREDO_AVATAR_STATE_PRIORITY.map((state, index) => [state, index]),
);

const rankOf = (state: FredoAvatarState): number =>
  PRIORITY_RANK.get(state) ?? Number.POSITIVE_INFINITY;

/**
 * Resolve the single expression state from the product signals.
 *
 * A teleport (or a teleport base state as the flow) wins outright. Otherwise the
 * highest-priority candidate among the flow and the derived signals is returned;
 * when NO status candidate exists the flow is passed through unchanged (so a bare
 * `talk` — which is not a conflict candidate — still renders).
 */
export function resolveCompanionAvatarState(signals: AvatarSignals): FredoAvatarState {
  const { flow } = signals;

  // A teleport always wins — pass the in-flight base state straight through.
  if (signals.teleporting || TELEPORT_STATES.includes(flow)) return flow;

  const candidates: FredoAvatarState[] = [];
  // The flow itself is a candidate only when it is a ranked status state; a base
  // state (talk) is handled by the pass-through fallback at the end.
  if (rankOf(flow) !== Number.POSITIVE_INFINITY) candidates.push(flow);
  if (signals.skillPending) candidates.push('working');
  if (signals.errored) candidates.push('error');
  if (signals.captureActive) candidates.push('listening');
  if (signals.ambientMessage && !signals.streaming && !signals.skillPending) {
    candidates.push('greeting');
  }
  if (signals.resting === 'playful') candidates.push('playful');
  if (signals.modelStatus !== undefined && isFredoAvatarState(signals.modelStatus)) {
    candidates.push(signals.modelStatus);
  }

  let best: FredoAvatarState | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const rank = rankOf(candidate);
    if (rank < bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }

  // No ranked candidate: the flow is a base state (talk) or already idle.
  return best ?? flow;
}
