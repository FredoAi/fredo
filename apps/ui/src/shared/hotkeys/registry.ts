/**
 * Spec #2946 ST-2 — the action registry + declared-action contribution API
 * (contract block 3, R-2.1/R-2.2/R-2.3).
 *
 * A feature declares hotkey actions ONCE (`FredoFeatureClass.hotkeys`); the
 * platform discovers every registered feature (`featureRegistry.getFeatures()`),
 * merges its declarations with explicitly-registered feature actions and the
 * Fredo-tier actions, and exposes ONE listing. No feature supplies listing code.
 *
 * Registration is deliberately PERMISSIVE, validation is at LIST time: a
 * malformed, duplicate or foreign-prefixed `actionId` still appears in the
 * listing (with an explicit `invalid` diagnostic) but is NEVER resolvable for
 * dispatch (`getHotkeyAction` returns `null`, `runHotkeyAction` is a no-op).
 *
 * The listing is cached and returns a STABLE reference until a registry mutation
 * or a newly-registered feature occurs, so React consumers do not re-render on
 * an unchanged listing.
 */

import { getFeatures } from '../../features/featureRegistry';
import { parseSequence } from './keys';
import {
  isValidHotkeyActionId,
  tierForActionId,
  type FeatureHotkeyAction,
  type HotkeyActionId,
  type HotkeyInvocationContext,
  type HotkeyTier,
  type KeySequence,
  type RegisteredHotkeyAction,
} from './types';

/** The structural shape the registry discovers on a registered feature. */
export interface HotkeyContributor {
  readonly id: string;
  readonly hotkeys?: readonly FeatureHotkeyAction[];
}

type HotkeyRun = (ctx: HotkeyInvocationContext) => void | Promise<void>;

interface Declaration {
  readonly action: FeatureHotkeyAction;
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
export function registerFredoAction(action: FeatureHotkeyAction): void {
  fredoDeclarations.push({ action });
  invalidate();
}

/**
 * Register actions for a feature that does not declare them through
 * `FredoFeatureClass.hotkeys` (e.g. a non-class contributor). Declarations for a
 * feature already discovered via `registerFeature()` are ignored, so the same
 * feature can never be listed twice.
 */
export function registerFeatureHotkeys(
  featureId: string,
  actions: readonly FeatureHotkeyAction[],
): void {
  if (typeof featureId !== 'string' || featureId.length === 0) return;
  const existing = featureDeclarations.get(featureId) ?? [];
  for (const action of actions) existing.push({ action, featureId });
  featureDeclarations.set(featureId, existing);
  invalidate();
}

/**
 * Attach (or clear, with `null`) the executable handler for an action id. Used
 * for React-bound Fredo actions (launcher toggle, window cycling) whose `run`
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
function validateDeclaration(action: FeatureHotkeyAction, featureId?: string): string | undefined {
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
  let features: readonly HotkeyContributor[] = [];
  try {
    features = getFeatures();
  } catch {
    features = [];
  }

  const discovered = new Set<string>();
  for (const feature of features) {
    if (!feature || typeof feature.id !== 'string') continue;
    discovered.add(feature.id);
    const declared = feature.hotkeys;
    if (!Array.isArray(declared)) continue;
    for (const action of declared) out.push({ action, featureId: feature.id });
  }

  // Explicit registrations only for features the discovery pass did not cover.
  for (const [featureId, declarations] of featureDeclarations) {
    if (discovered.has(featureId)) continue;
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

/** The single merged listing (R-2.1). Stable reference until the registry changes. */
export function listHotkeyActions(): readonly RegisteredHotkeyAction[] {
  let featureCount = 0;
  try {
    featureCount = getFeatures().length;
  } catch {
    featureCount = 0;
  }
  const key = `${registryRevision}:${featureCount}`;
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
 * Run a registered action exactly once. Never throws and never awaits — the
 * keydown path must not block on an async handler. Disabled or invalid actions
 * are silently skipped, matching the engine's availability contract.
 */
export function runHotkeyAction(
  id: HotkeyActionId,
  source: HotkeyInvocationContext['source'],
  sequence: KeySequence = [],
  focusedFeatureId: string | null = null,
): void {
  const action = getHotkeyAction(id);
  if (!action) return;
  if (action.enabled && !action.enabled()) return;

  const ctx: HotkeyInvocationContext = {
    actionId: id,
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
        console.error(`[hotkeys] action "${id}" failed`, error);
      });
    }
  } catch (error) {
    console.error(`[hotkeys] action "${id}" failed`, error);
  }
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
