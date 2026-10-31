/**
 * Spec #3120 (rework) ST-2 — the companion instruction-composer open bridge.
 *
 * A tiny module-scoped pub/sub (the same shape the retired `launcherBridge`
 * used) so any surface can ask the ONE teleport-attached instruction box to
 * open without importing the companion entity or adding a second dispatch path:
 *
 *   - the Wireframe command bar's `Ask` (`source: 'command-bar-ask'`)
 *   - a keyboard affordance (`source: 'keyboard'`)
 *   - the teleport settle itself (`source: 'teleport'`)
 *
 * The bridge holds NO React state and NO DOM reference; each webview's module
 * instance is its own bus (the composer only ever mounts in the window hosting
 * Fredo). The last request is retained so an entity that mounts AFTER the
 * request (the overlay mounting on the teleport arrival) can still resolve the
 * requested app.
 *
 * The request shape is BINDING (Architect's names block):
 * `{ source, appId?, focus: true }` — `appId` is an ABSENT key when unknown
 * (never an explicit `null`).
 */

export type CompanionComposerOpenSource = 'command-bar-ask' | 'teleport' | 'keyboard';

export interface CompanionComposerOpenRequest {
  readonly source: CompanionComposerOpenSource;
  /** ABSENT KEY when unknown (never an explicit null). */
  readonly appId?: string;
  readonly focus: true;
}

type ComposerOpenListener = (request: CompanionComposerOpenRequest) => void;

const listeners = new Set<ComposerOpenListener>();
/** The most recent request — read by an entity that mounts after the publish. */
let lastRequest: CompanionComposerOpenRequest | null = null;

/** Publish an open request to every subscriber in this webview. */
export function requestCompanionComposerOpen(request: CompanionComposerOpenRequest): void {
  // Normalise the optional key: absent (never `undefined`/`null`) when unknown.
  const normalized: CompanionComposerOpenRequest =
    request.appId === undefined || request.appId === null || request.appId.trim() === ''
      ? { source: request.source, focus: true }
      : { source: request.source, appId: request.appId, focus: true };
  lastRequest = normalized;
  for (const listener of [...listeners]) listener(normalized);
}

/** Subscribe to composer open requests. Returns an unsubscribe function. */
export function subscribeCompanionComposerOpen(listener: ComposerOpenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The most recent open request, or `null` when none was published. The entity
 * reads this on mount so a request published before it mounted (the overlay
 * arriving after a not-hosted teleport) still reaches target resolution.
 */
export function peekCompanionComposerRequest(): CompanionComposerOpenRequest | null {
  return lastRequest;
}

/** Test-only: drop the retained request + subscribers. Never call from app code. */
export function resetCompanionComposerBridgeForTests(): void {
  lastRequest = null;
  listeners.clear();
}
