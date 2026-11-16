/**
 * Spec #3151 (ST-2) — the application-level companion grounding source.
 *
 * Binding decision 7: the companion must keep grounding on the application in
 * front of Fredo and its current selection WITHOUT the navigation engine. Before
 * this module, `CompanionEntity` asked the live navigation host registry for a
 * context envelope, which dies with the engine. This module is the replacement
 * seam and carries ONLY what grounding consumes:
 *
 *   - the app identity (`appId` + `appName`, the composer's target chip), and
 *   - the selection summary (`count`/`kinds`/`label`/`ids`), index-aligned, and
 *   - `dirty` for document-bearing apps.
 *
 * No place path, no verbs, no journal, no limits map. It is a module-scoped
 * `Map<appId, provider>` read SYNCHRONOUSLY at turn time — mirroring the shape
 * the retired host registry already had (never a React context, never an IPC
 * call, never a subscription), so a turn can ground with no render cycle and no
 * round-trip.
 *
 * Registration contract: one provider per application, registered by the shell
 * that owns that application's selection. The LAST registration for an `appId`
 * wins and the returned disposer is idempotent (calling it twice, or after a
 * newer registration, never removes the newer provider).
 *
 * NFR-5: the consumer's byte guard (`companionDispatch.ts`) bounds the
 * serialized payload by `COMPANION_CAPABILITY_LIMITS.maxContextBytes` — the
 * unchanged 16384-byte cap, re-homed from the retired navigation leaf.
 */

/** The grounding payload version (`CompanionGrounding.version` must equal this). */
export const COMPANION_GROUNDING_VERSION = 1;

/**
 * The ONE surviving capability cap the companion still needs. Re-homed from the
 * retired navigation leaf's `CAPABILITY_LIMITS.maxContextBytes` — the value is
 * unchanged (16384 UTF-8 bytes).
 */
export const COMPANION_CAPABILITY_LIMITS: Readonly<{ maxContextBytes: 16384 }> = Object.freeze({
  maxContextBytes: 16384,
} as const);

/** The selection summary — `kinds` is index-aligned with `ids`. */
export interface CompanionGroundingSelection {
  readonly count: number;
  /** Index-aligned with `ids`. */
  readonly kinds: readonly string[];
  /** e.g. `'Rectangle'`, a session title; `null` when nothing is selected. */
  readonly label: string | null;
  readonly ids: readonly string[];
}

/** The ONE grounding payload — no place path, no verbs, no journal, no limits map. */
export interface CompanionGrounding {
  readonly version: 1;
  readonly appId: string;
  /** The application's display name (e.g. `'Wireframe'`, `'SQL Studio'`). */
  readonly appName: string;
  readonly selection: CompanionGroundingSelection;
  /** Document-bearing apps only; `false` otherwise. */
  readonly dirty: boolean;
}

/** An application's synchronous grounding source. */
export type CompanionGroundingProvider = () => CompanionGrounding | null;

interface GroundingEntry {
  readonly provider: CompanionGroundingProvider;
}

/** Module-scoped: the live providers keyed by `appId` (last registration wins). */
const registry = new Map<string, GroundingEntry>();

/**
 * Register one application's grounding source on mount; the returned disposer
 * unregisters it. Both registration and disposal are idempotent: registering
 * again replaces the entry (a StrictMode remount), and calling the disposer
 * twice — or after a newer registration — is a no-op that never removes the
 * newer provider.
 */
export function registerCompanionGrounding(
  appId: string,
  provider: CompanionGroundingProvider,
): () => void {
  const key = appId.trim();
  if (key === '') return () => {};
  const entry: GroundingEntry = { provider };
  registry.set(key, entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (registry.get(key) === entry) registry.delete(key);
  };
}

/**
 * A FRESH payload for `appId`, or `null` when the app registered no source (the
 * R-5.3 ungrounded-turn fallback). The payload is built on demand — never a
 * cached snapshot.
 */
export function readCompanionGrounding(appId: string): CompanionGrounding | null {
  const entry = registry.get(appId.trim());
  return entry === undefined ? null : entry.provider();
}

/** Registered app ids (diagnostics/tests only). */
export function listCompanionGroundingAppIds(): readonly string[] {
  return [...registry.keys()];
}

/** Test-only: drop every registered provider. Never call from app code. */
export function resetCompanionGroundingForTests(): void {
  registry.clear();
}
