/**
 * Spec #2958 ST-1 — the named-interaction-context registry + cumulative layered
 * resolution (plan binding block `contexts.ts`; EARS R-1.1/R-1.2/R-1.3,
 * R-2.2/R-2.3, R-5.1/R-5.2/R-5.3).
 *
 * PURE/registry by design: declarations + ONE deterministic resolution function
 * and helpers, with NO DOM, NO React and NO navigation-stack state — the
 * module-scoped stack lives in `contextStack.ts` (ST-2). The only ambient read
 * is the registered-feature list (`getFeatures()`), exactly like `registry.ts`.
 *
 * DEPTH semantics (binding): depth is the PATH LENGTH — base only = 1; each
 * explicit descent adds 1. `getHotkeyContextPath()` (ST-2) returns
 * `[base, ...explicit descents]`, so a context's depth along a path is its
 * zero-based index + 1; the DEEPEST context has the highest depth.
 *
 * RESOLUTION ORDER (binding): `resolveContextBindings` returns all Fredo-tier
 * bindings in their existing declaration order first, THEN the feature-tier
 * bindings of the focused feature ordered by context depth DESC (base-context
 * bindings last), preserving registry order within one context. At
 * `contextPath = [base]` this equals #2946's `resolveActiveBindings` output
 * exactly — the base-list byte-parity regression.
 *
 * KEYMAP CONTRACT (for the engine, ST-3): this module is keymap-free. Each
 * `RegisteredHotkeyAction` entry contributes ONE binding from its
 * `defaultSequence`; an entry with a null/empty `defaultSequence` contributes
 * nothing. The engine delegates by passing one entry per EFFECTIVE sequence
 * (the user keymap override, else the declared default) with `defaultSequence`
 * set to that serialized sequence — `listHotkeyActions().flatMap(action =>
 * effectiveSequences(action, getKeymap()).map(s => ({ ...action,
 * defaultSequence: s })))`. Entries with an `invalid` diagnostic are dropped.
 */

import { getFeatures } from '../../features/featureRegistry';
import { parseSequence } from './keys';
import {
  ROOT_CONTEXT_ID,
  isValidHotkeyActionId,
  type FeatureHotkeyContext,
  type HotkeyContextId,
  type RegisteredHotkeyAction,
  type ResolvedBinding,
} from './types';

/** A registered context as listed by the registry (declared + synthesized bases). */
export interface RegisteredHotkeyContext {
  readonly contextId: HotkeyContextId;
  readonly parentId: HotkeyContextId;
  readonly title: string;
  /** Absent for platform contexts; a synthesized base carries the feature id. */
  readonly featureId?: string;
  /** List-time diagnostic — an invalid context is never enterable. */
  readonly invalid?: string;
}

/** The structural shape the registry discovers on a registered feature. */
export interface HotkeyContextContributor {
  readonly id: string;
  readonly hotkeysContexts?: readonly FeatureHotkeyContext[];
}

interface ContextDeclaration {
  readonly context: FeatureHotkeyContext;
  readonly featureId?: string;
}

interface CollectedFeature {
  readonly featureId: string;
  readonly declared: readonly ContextDeclaration[];
}

/** ROOT is always registered with a self-parent sentinel (title `Fredo`). */
const ROOT_CONTEXT: RegisteredHotkeyContext = Object.freeze({
  contextId: ROOT_CONTEXT_ID,
  parentId: ROOT_CONTEXT_ID,
  title: 'Fredo',
});

/** Explicit platform (`fredo.*`) declarations, in registration order. */
const platformDeclarations: ContextDeclaration[] = [];
/** Explicit feature declarations only for features NOT discovered via `getFeatures()`. */
const explicitFeatureContexts = new Map<string, ContextDeclaration[]>();

let registryRevision = 0;
let cachedList: readonly RegisteredHotkeyContext[] | null = null;
let cachedKey: string | null = null;

function invalidate(): void {
  registryRevision += 1;
  cachedList = null;
  cachedKey = null;
}

/**
 * Register ONE context. A platform context (`fredo.*`) is registered with no
 * `featureId`; a feature context passes its owning `featureId` (the id must be
 * `<featureId>.`-prefixed — validated at list time).
 */
export function registerHotkeyContext(context: FeatureHotkeyContext, featureId?: string): void {
  if (!context || typeof context !== 'object') return;
  if (featureId === undefined) {
    platformDeclarations.push({ context });
  } else {
    if (typeof featureId !== 'string' || featureId.length === 0) return;
    const existing = explicitFeatureContexts.get(featureId) ?? [];
    existing.push({ context, featureId });
    explicitFeatureContexts.set(featureId, existing);
  }
  invalidate();
}

/**
 * Register the contexts a feature declares. Declarations for a feature already
 * discovered through `FredoFeatureClass.hotkeysContexts` are ignored, so a
 * feature can never be listed twice (mirrors `registerFeatureHotkeys`).
 */
export function registerFeatureHotkeyContexts(
  featureId: string,
  contexts: readonly FeatureHotkeyContext[],
): void {
  if (typeof featureId !== 'string' || featureId.length === 0) return;
  if (!Array.isArray(contexts) || contexts.length === 0) return;
  const existing = explicitFeatureContexts.get(featureId) ?? [];
  for (const context of contexts) existing.push({ context, featureId });
  explicitFeatureContexts.set(featureId, existing);
  invalidate();
}

/** Collect declared contexts: discovered features first, then explicit-only ones. */
function collectFeatures(): CollectedFeature[] {
  const out: CollectedFeature[] = [];
  const seen = new Set<string>();

  let features: readonly HotkeyContextContributor[] = [];
  try {
    features = getFeatures();
  } catch {
    features = [];
  }
  for (const feature of features) {
    if (!feature || typeof feature.id !== 'string' || feature.id.length === 0) continue;
    if (seen.has(feature.id)) continue;
    seen.add(feature.id);
    const declared = Array.isArray(feature.hotkeysContexts) ? feature.hotkeysContexts : [];
    out.push({
      featureId: feature.id,
      declared: declared.map((context) => ({ context, featureId: feature.id })),
    });
  }

  for (const [featureId, declarations] of explicitFeatureContexts) {
    if (seen.has(featureId)) continue;
    seen.add(featureId);
    out.push({ featureId, declared: declarations });
  }
  return out;
}

/** Validate ONE declaration against the known id set; returns its registered form. */
function validateDeclaration(
  declaration: ContextDeclaration,
  known: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): RegisteredHotkeyContext {
  const context = declaration.context;
  const contextId = context && typeof context.contextId === 'string' ? context.contextId : '';
  const parentId =
    context && typeof context.parentId === 'string' ? context.parentId : ROOT_CONTEXT_ID;
  const title = context && typeof context.title === 'string' ? context.title : '';

  let invalid: string | undefined;
  if (contextId.length === 0) {
    invalid = 'Missing context id';
  } else if (!isValidHotkeyActionId(contextId)) {
    invalid = `Malformed context id "${contextId}"`;
  } else if (seen.has(contextId)) {
    invalid = `Duplicate context id "${contextId}"`;
  } else if (declaration.featureId !== undefined) {
    if (contextId.startsWith('fredo.')) {
      invalid = `Feature "${declaration.featureId}" may not declare the platform context "${contextId}"`;
    } else if (!contextId.startsWith(`${declaration.featureId}.`)) {
      invalid = `Context id "${contextId}" is outside feature "${declaration.featureId}"`;
    }
  } else if (!contextId.startsWith('fredo.')) {
    invalid = `Platform context "${contextId}" must use the "fredo." namespace`;
  }

  if (!invalid && title.length === 0) {
    invalid = `Context "${contextId}" is missing a title`;
  }
  if (!invalid && !known.has(parentId)) {
    invalid = `Context "${contextId}" has an unknown parent "${parentId}"`;
  }

  return {
    contextId,
    parentId,
    title,
    featureId: declaration.featureId,
    invalid,
  };
}

function buildList(): readonly RegisteredHotkeyContext[] {
  const features = collectFeatures();

  // One synthesized base per feature: id = feature id, parent = ROOT.
  const bases = features.map<RegisteredHotkeyContext>((feature) => ({
    contextId: feature.featureId,
    parentId: ROOT_CONTEXT_ID,
    title: feature.featureId,
    featureId: feature.featureId,
  }));

  // Every id a parent (or a child) may legitimately reference.
  const known = new Set<string>([ROOT_CONTEXT_ID, ...bases.map((base) => base.contextId)]);
  for (const declaration of platformDeclarations) {
    const id = declaration.context?.contextId;
    if (typeof id === 'string' && id.length > 0) known.add(id);
  }
  for (const feature of features) {
    for (const declaration of feature.declared) {
      const id = declaration.context?.contextId;
      if (typeof id === 'string' && id.length > 0) known.add(id);
    }
  }

  const seen = new Set<string>([ROOT_CONTEXT_ID, ...bases.map((base) => base.contextId)]);
  const out: RegisteredHotkeyContext[] = [ROOT_CONTEXT];

  for (const declaration of platformDeclarations) {
    out.push(validateDeclaration(declaration, known, seen));
    seen.add(declaration.context?.contextId ?? '');
  }

  features.forEach((feature, index) => {
    out.push(bases[index]);
    for (const declaration of feature.declared) {
      out.push(validateDeclaration(declaration, known, seen));
      seen.add(declaration.context?.contextId ?? '');
    }
  });

  return out;
}

/** The single merged listing: declared contexts + one synthesized base per feature. */
export function listHotkeyContexts(): readonly RegisteredHotkeyContext[] {
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

/** Resolve one context by id. `null` for an unknown context. */
export function getHotkeyContext(id: HotkeyContextId): RegisteredHotkeyContext | null {
  for (const context of listHotkeyContexts()) {
    if (context.contextId === id) return context;
  }
  return null;
}

/** True when `id` is a well-formed context id — identical to `isValidHotkeyActionId`. */
export function isValidHotkeyContextId(id: string): boolean {
  return isValidHotkeyActionId(id);
}

/** True for the platform namespace (`fredo.`), including the ROOT context. */
export function isPlatformContext(id: HotkeyContextId): boolean {
  return typeof id === 'string' && id.startsWith('fredo.');
}

/** The base context for a focused feature: the feature id, else ROOT. */
export function resolveBaseContextId(focusedFeatureId: string | null): HotkeyContextId {
  return focusedFeatureId ?? ROOT_CONTEXT_ID;
}

function toBinding(action: RegisteredHotkeyAction, serialized: string): ResolvedBinding | null {
  const sequence = parseSequence(serialized);
  if (sequence.length === 0) return null;
  return {
    actionId: action.actionId,
    tier: action.tier,
    sequence,
    serialized,
    action,
  };
}

/**
 * Resolve every dispatchable binding for a focused feature along the active
 * context PATH (Spec #2958, R-1.1/R-1.2/R-1.3, R-2.2/R-2.3, R-5.1/R-5.2/R-5.3).
 *
 * - An `undefined` / empty `contextPath` is the base-only path for the focused
 *   feature (`[resolveBaseContextId(focusedFeatureId)]`).
 * - Fredo-tier bindings are always in force (the #2946 contract); a Fredo-tier
 *   action explicitly scoped to a non-ROOT context is in force only while that
 *   context is on the path.
 * - Feature-tier bindings are included only for the focused feature, from a
 *   context on the path (`contextId` omitted ⇒ the feature's base context), and
 *   are ordered by context depth DESC — base-context bindings last.
 * - A binding whose context is not on the path is never included (no silent
 *   fall-through to a sibling or another feature's context).
 */
export function resolveContextBindings(
  focusedFeatureId: string | null,
  contextPath: readonly HotkeyContextId[] | undefined,
  actions: readonly RegisteredHotkeyAction[],
): readonly ResolvedBinding[] {
  const base = resolveBaseContextId(focusedFeatureId);
  const path = contextPath && contextPath.length > 0 ? contextPath : [base];
  const depthById = new Map<HotkeyContextId, number>();
  path.forEach((id, index) => {
    if (!depthById.has(id)) depthById.set(id, index);
  });

  const fredo: ResolvedBinding[] = [];
  const feature: { readonly binding: ResolvedBinding; readonly depth: number }[] = [];

  for (const action of actions) {
    if (action.invalid) continue;
    const serialized = action.defaultSequence;
    if (typeof serialized !== 'string' || serialized.length === 0) continue;

    if (action.tier === 'fredo') {
      if (
        action.contextId !== undefined &&
        action.contextId !== ROOT_CONTEXT_ID &&
        depthById.get(action.contextId) === undefined
      ) {
        continue;
      }
      const binding = toBinding(action, serialized);
      if (binding) fredo.push(binding);
      continue;
    }

    if (action.featureId === undefined || action.featureId !== focusedFeatureId) continue;
    const contextId = action.contextId ?? action.featureId;
    const depth = depthById.get(contextId);
    if (depth === undefined) continue;
    const binding = toBinding(action, serialized);
    if (binding) feature.push({ binding, depth });
  }

  // Stable sort (ES2019+) keeps registry order within one context depth.
  feature.sort((a, b) => b.depth - a.depth);
  return [...fredo, ...feature.map((entry) => entry.binding)];
}

/** Test-only: clear every registration so tests start from a clean registry. */
export function resetContextRegistryForTests(): void {
  platformDeclarations.length = 0;
  explicitFeatureContexts.clear();
  cachedList = null;
  cachedKey = null;
  registryRevision = 0;
}
