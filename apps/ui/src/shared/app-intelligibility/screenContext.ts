/**
 * Spec #3244 ST-4 — compose the per-turn injected pair (the DOM outline + ST-3's
 * screenshot) and the turn's injection facts.
 *
 * # The two legs, and who owns each
 *
 *   - the OUTLINE leg is this capsule's projector (`screenOutline.ts`), applied
 *     to the target's mounted DOM root in THIS webview; and
 *   - the SCREENSHOT leg is ST-3's host capture
 *     (`captureTarget.ts:captureTargetRegion`), composed here — never
 *     re-implemented, never re-declared.
 *
 * # One composition, one place
 *
 * `buildTurnScreenContext(appId)` is the ONE call a dispatch site makes. It
 * resolves the target's description (ST-1), projects the outline, fits it to the
 * turn's byte bound, captures the screenshot FRESH (ST-3 / R-3a), and derives the
 * injection facts (R-4b) from exactly those inputs. A leg that cannot be produced
 * is a TYPED result, never a silent empty pair.
 *
 * # Freshness (R-3a / AC-3)
 *
 * Nothing is cached: every call re-projects the DOM and re-captures the screen, so
 * the pair always reflects the app's current state.
 *
 * # Typed "nothing to read" (R-2c)
 *
 * The `unavailable` result carries the reason, and the caller surfaces it — a turn
 * is never dispatched blind.
 */

import { captureTargetRegion } from './captureTarget';
import { resolveAppDescription } from './description';
import type { AppDescription } from './description';
import { buildCompanionInjectionFacts } from './injection';
import type { CompanionInjectionFacts } from './injection';
import { requestInstalledOutline } from './installedOutline';
import {
  SCREEN_OUTLINE_MAX_NODES,
  simplifyDom,
  type ScreenOutline,
  type ScreenPair,
} from './screenOutline';
import { fitScreenContextOutline } from '../components/companion/companionDispatch';

/** Why a turn's screen context could not be produced. */
export type ScreenContextUnavailableReason =
  | 'unknownApp'
  /** The app is not rendered in THIS webview (it is not mounted here). */
  | 'notMountedHere'
  /**
   * Spec #3244 ST-7 — the app renders in a SEPARATE installed-app webview and its
   * outline did not arrive through the beacon uplink (not open, timeout, or a
   * rejected nonce). A typed "nothing to read", never an empty pair.
   */
  | 'beaconUnavailable'
  /** The host capture produced nothing for the target's rectangle. */
  | 'captureUnavailable';

/** The ONE result of building a turn's screen context. */
export type TurnScreenContext =
  | {
      readonly kind: 'context';
      readonly pair: ScreenPair;
      readonly description: AppDescription;
      readonly facts: CompanionInjectionFacts;
    }
  | {
      readonly kind: 'unavailable';
      readonly appId: string;
      readonly reason: ScreenContextUnavailableReason;
    };

/**
 * The mounted element carrying `data-fredo-app-id` for `appId`, matched by
 * ATTRIBUTE VALUE (never a selector built from the id, so an id can never inject
 * into a query). Mirrors the lookup the shipped surfaces use.
 */
export function findInWindowAppRoot(appId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const candidates = document.querySelectorAll<HTMLElement>('[data-fredo-app-id]');
  for (const candidate of candidates) {
    if (candidate.getAttribute('data-fredo-app-id') === appId) return candidate;
  }
  return null;
}

/**
 * Project the target app's mounted screen into a bounded outline.
 *
 * `null` when the app is not rendered in this webview — the typed "not here"
 * answer, never an empty outline pretending to be a screen.
 */
export function projectTargetScreenOutline(
  appId: string,
  maxNodes: number = SCREEN_OUTLINE_MAX_NODES,
): ScreenOutline | null {
  const root = findInWindowAppRoot(appId);
  if (root === null) return null;
  return simplifyDom(root, maxNodes);
}

/**
 * Build ONE turn's screen context: the fitted pair plus the injection facts.
 *
 * The description is resolved FIRST (R-1b: an app with no resolved description
 * never produces a pair — the caller takes the typed-failure path instead), then
 * the outline is projected and fitted to the turn's byte bound, then the
 * screenshot is captured fresh. The facts are derived from exactly those values.
 */
export async function buildTurnScreenContext(appId: string): Promise<TurnScreenContext> {
  const resolution = resolveAppDescription(appId);
  if (resolution.kind !== 'resolved') {
    return { kind: 'unavailable', appId, reason: 'unknownApp' };
  }
  const description = resolution.description;

  // The outline leg: read the target's DOM HERE when it is mounted in this
  // webview; otherwise the app renders in its OWN installed-app webview, so fetch
  // the outline through the host's beacon uplink (Spec #3244 ST-7) — the same
  // bounded `ScreenOutline` shape, so the rest of this composition is unchanged.
  const inWindowOutline = projectTargetScreenOutline(appId);
  const outline = inWindowOutline ?? (await requestInstalledOutline(appId));
  if (outline === null) {
    return {
      kind: 'unavailable',
      appId,
      reason: inWindowOutline === null ? 'beaconUnavailable' : 'notMountedHere',
    };
  }

  const fitted = fitScreenContextOutline(outline, description);
  const captured = await captureTargetRegion(appId);
  if (captured === null) {
    return { kind: 'unavailable', appId, reason: 'captureUnavailable' };
  }

  const pair: ScreenPair = {
    screenshotPngBase64: captured.screenshotPngBase64,
    outline: fitted,
  };
  return {
    kind: 'context',
    pair,
    description,
    facts: buildCompanionInjectionFacts({
      appId: description.appId,
      description: description.description,
      outline: fitted,
      screenshotPngBase64: captured.screenshotPngBase64,
    }),
  };
}
