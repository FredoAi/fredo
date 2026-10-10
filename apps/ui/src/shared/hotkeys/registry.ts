/**
 * Spec #3009 — the ONE action registry.
 *
 * After #3009 the registry is the single action table for dispatch AND the
 * launcher action palette. Contributions come from:
 *   - `registerFredoAction` — the kept platform globals (declared by the engine),
 *   - `registerFeatureHotkeys` — explicit programmatic registrations,
 *   - element hotkeys, which are synthesized per resolution by the engine (they
 *     are NOT registry declarations — the registry stays a fixed table).
 *
 * Registration is PERMISSIVE, validation is at LIST time: a malformed, duplicate
 * or foreign-prefixed `actionId` still appears in the listing (with an explicit
 * `invalid` diagnostic) but is NEVER resolvable for dispatch.
 *
 * The retired feature-instance discovery (`FredoApplicationClass.hotkeys`) and
 * every interaction-context field are gone — the class carries no hotkey surface.
 *
 * The listing is cached and returns a STABLE reference until a registry mutation,
 * so React consumers do not re-render on an unchanged listing.
 */

import { parseSequence } from './keys';
import {
  isValidHotkeyActionId,
  tierForActionId,
  type ApplicationHotkeyAction,
  type HotkeyActionId,
  type HotkeyInvocationContext,
  type HotkeyTier,
  type KeySequence,
  type RegisteredHotkeyAction,
} from './types';

type HotkeyRun = (ctx: HotkeyInvocationContext) => void | Promise<void>;

interface Declaration {
  readonly action: ApplicationHotkeyAction;
  readonly featureId?: string;
}

const fredoDeclarations: Declaration[] = [];
const featureDeclarations = new Map<string, Declaration[]>();
const handlers = new Map<HotkeyActionId, HotkeyRun>();

let registryRevision = 0;
let cachedList: readonly RegisteredHotkeyAction[] | null = null;
let cachedKey: string | null = null;

function invalidate(): void {
  registryRevision += 1;
  cachedList = null;
  cachedKey = null;
}

/**
 * Register a Fredo-tier action (tier `fredo`, `fredo.` prefix expected — the
 * prefix is validated at list time and surfaced as `invalid` when wrong).
 */
export function registerFredoAction(action: ApplicationHotkeyAction): void {
  fredoDeclarations.push({ action });
  invalidate();
}

/**
 * Register actions for a feature that does not declare them through a class.
 * Declarations are kept per feature id in registration order.
 */
export function registerFeatureHotkeys(
  featureId: string,
  actions: readonly ApplicationHotkeyAction[],
): void {
  if (typeof featureId !== 'string' || featureId.length === 0) return;
  const existing = featureDeclarations.get(featureId) ?? [];
  for (const action of actions) existing.push({ action, featureId });
  featureDeclarations.set(featureId, existing);
  invalidate();
}

/**
 * Attach (or clear, with `null`) the executable handler for an action id. Used
 * for React-bound Fredo actions (launcher toggle, palette open) whose `run`
 * lives in a component; it overrides any declared `run` at resolution time.
 */
export function registerHotkeyHandler(
  actionId: HotkeyActionId,
  handler: HotkeyRun | null,
): void {
  if (handler === null) handlers.delete(actionId);
  else handlers.set(actionId, handler);
  invalidate();
}

/** Validate ONE declaration; returns a human-readable diagnostic or `undefined`. */
function validateDeclaration(action: ApplicationHotkeyAction, featureId?: string): string | undefined {
  if (!action || typeof action.actionId !== 'string') return 'Missing action id';
  const actionId = action.actionId;
  if (!isValidHotkeyActionId(actionId)) return `Malformed action id "${actionId}"`;

  const tier = tierForActionId(actionId);
  if (tier === 'fredo') {
    if (featureId !== undefined) {
      return `Feature "${featureId}" may not declare the Fredo-tier action "${actionId}"`;
    }
  } else {
    if (featureId === undefined) {
      return `Feature-tier action "${actionId}" has no owning feature`;
    }
    if (!actionId.startsWith(`${featureId}.`)) {
      return `Action id "${actionId}" is outside feature "${featureId}"`;
    }
  }

  if (typeof action.title !== 'string' || action.title.length === 0) {
    return `Action "${actionId}" is missing a title`;
  }
  if (typeof action.run !== 'function' && !handlers.has(actionId)) {
    return `Action "${actionId}" is missing a run handler`;
  }
  if (action.defaultSequence !== null && action.defaultSequence !== undefined) {
    if (
      typeof action.defaultSequence !== 'string' ||
      parseSequence(action.defaultSequence).length === 0
    ) {
      return `Unknown default sequence "${String(action.defaultSequence)}"`;
    }
  }
  return undefined;
}

/** Collect every declaration in deterministic order: Fredo first, then features. */
function collectDeclarations(): Declaration[] {
  const out: Declaration[] = [...fredoDeclarations];
  for (const declarations of featureDeclarations.values()) {
    for (const declaration of declarations) out.push(declaration);
  }
  return out;
}

function buildList(): readonly RegisteredHotkeyAction[] {
  const list: RegisteredHotkeyAction[] = [];
  const seen = new Set<HotkeyActionId>();

  for (const { action, featureId } of collectDeclarations()) {
    const tier: HotkeyTier = tierForActionId(action.actionId);
    const ownDiagnostic = validateDeclaration(action, featureId);
    let invalid = ownDiagnostic;

    if (!invalid && seen.has(action.actionId)) {
      invalid = `Duplicate action id "${action.actionId}"`;
    }
    seen.add(action.actionId);

    list.push({
      actionId: action.actionId,
      tier,
      featureId,
      title: action.title,
      description: action.description,
      defaultSequence: action.defaultSequence,
      run: handlers.get(action.actionId) ?? action.run,
      enabled: action.enabled,
      invalid,
    });
  }
  return list;
}

/** The single merged listing. Stable reference until the registry changes. */
export function listHotkeyActions(): readonly RegisteredHotkeyAction[] {
  const key = String(registryRevision);
  if (cachedList !== null && cachedKey === key) return cachedList;
  cachedList = buildList();
  cachedKey = key;
  return cachedList;
}

/** Resolve one action for dispatch/listing. `null` for unknown or invalid. */
export function getHotkeyAction(id: HotkeyActionId): RegisteredHotkeyAction | null {
  for (const entry of listHotkeyActions()) {
    if (entry.actionId === id && !entry.invalid) return entry;
  }
  return null;
}

/**
 * Run a resolved action exactly once. Never throws and never awaits — the
 * keydown path must not block on an async handler. Disabled actions are
 * silently skipped.
 */
export function runResolvedAction(
  action: RegisteredHotkeyAction,
  source: HotkeyInvocationContext['source'],
  sequence: KeySequence = [],
  focusedFeatureId: string | null = null,
): void {
  if (action.enabled && !action.enabled()) return;

  const ctx: HotkeyInvocationContext = {
    actionId: action.actionId,
    tier: action.tier,
    sequence,
    source,
    focusedFeatureId,
    at: Date.now(),
  };

  try {
    const result = action.run(ctx);
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).catch((error) => {
        console.error(`[hotkeys] action "${action.actionId}" failed`, error);
      });
    }
  } catch (error) {
    console.error(`[hotkeys] action "${action.actionId}" failed`, error);
  }
}

/** Run a registered action by id exactly once (palette + registry consumers). */
export function runHotkeyAction(
  id: HotkeyActionId,
  source: HotkeyInvocationContext['source'],
  sequence: KeySequence = [],
  focusedFeatureId: string | null = null,
): void {
  const action = getHotkeyAction(id);
  if (!action) return;
  runResolvedAction(action, source, sequence, focusedFeatureId);
}

/** Test-only: clear every registration so tests start from a clean registry. */
export function resetRegistryForTests(): void {
  fredoDeclarations.length = 0;
  featureDeclarations.clear();
  handlers.clear();
  cachedList = null;
  cachedKey = null;
  registryRevision = 0;
}
