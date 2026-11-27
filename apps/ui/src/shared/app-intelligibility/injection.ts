/**
 * Spec #3244 ST-4 — the per-turn injection record (the live receipt).
 * Extended by Spec #3243 ST-3 with the order loop's three per-turn facts.
 *
 * # Why this module exists
 *
 * AC-2 / AC-3 / AC-4 are runtime observables, and `telemetry_logs` is NOT an
 * accepted live receipt (known gate gap M9). So the plan emits a **per-turn
 * injection span** carrying the turn's injection facts — and this module is the
 * ONE place those facts are derived from the turn's own inputs (never
 * hand-authored, R-4b).
 *
 * The facts ride the existing structured-status turn as an optional argument
 * (`LlmChatWithStatusOptions.injection` → the Rust `llm_chat_with_status`), which
 * persists them into `telemetry_spans` as `span_name = "companion.injection"`.
 * The QA reads that span set back to assert the description reached the turn, the
 * pair's size, and freshness between turns.
 *
 * # The negative witness (AC-5 / R-5b)
 *
 * `taught` and `perAppEntries` are read from the description+pair path's own
 * per-app enablement declaration — [`PAIR_PATH_PER_APP_SOURCES`] — which is EMPTY
 * by design: the path resolves EVERY app from `resolveAppDescription` + the host
 * capture seam and consults no per-app table. Scoped claim: this is the
 * description+pair path only, NOT a claim that Fredo has no per-app code for any
 * app (`mission-monitor` carries a per-app GROUNDING registrar —
 * `MissionMonitorPanel.tsx:881` — which is selection metadata, not enablement).
 *
 * # The order-loop facts (Spec #3243 ST-3; AC-4 / R-4a)
 *
 * Three REQUIRED fields turn AC-4 from an invariant you can only read in the
 * source into a run-derived receipt:
 *
 *   - `placementId` — the placement identity this turn belongs to (`''` when
 *     Fredo is not placed, which is the ungrounded composer's published
 *     contract). Read from the module-scoped placement store at build time, so
 *     every turn carries the identity it actually ran under and two placements
 *     can never share one — with no per-call-site wiring to forget;
 *   - `orderActionCount` / `orderSurfaceDigest` — how many actions the target app
 *     DECLARES and a content digest of that table (`0` / the empty-table digest
 *     when it declares none).
 *
 * All three are REQUIRED on the wire with no `serde(default)` on the Rust side: a
 * defaulted `''` would make a real placement read as unplaced, which is exactly
 * the plausible-but-wrong number the receipt exists to prevent (G-511).
 *
 * Pure by construction: no React, no DOM, no IPC, no side effects. The only
 * state it reads is the module-scoped placement store — the run's own state.
 */

import { readPlacement } from '../placement/placementStore';
import {
  contentDigest,
  serializeOutline,
  utf8ByteLength,
  type ScreenOutline,
} from './screenOutline';

/**
 * The declared order surface of the app a turn is aimed at, as the receipt needs
 * it (`0` actions / the empty digest when the app declares none).
 *
 * Structurally typed on purpose: the order surface's own declaration
 * (`shared/order/orderActions.ts`) is assignable to this without an import, so
 * the receipt has no compile-time dependency on another capsule's module.
 */
export interface OrderSurfaceFactSource {
  readonly actions: readonly {
    readonly id: string;
    readonly risk: string;
    readonly undoable: boolean;
  }[];
}

/**
 * The `orderSurfaceDigest` value for an app that declares NO order surface.
 *
 * A constant derived from the canonical empty table (never a hand-typed hex
 * string), so the "declares none" reading is recomputable from this module.
 */
export const EMPTY_ORDER_SURFACE_DIGEST: string = contentDigest(
  canonicalOrderSurface({ actions: [] }),
);

/**
 * The canonical serialization of a declared order surface: one `[id, risk,
 * undoable]` triple per action, in declaration (offer) order.
 *
 * Declaration order is part of the surface's identity — it is the order the
 * model is offered — so it is preserved here rather than sorted.
 */
function canonicalOrderSurface(surface: OrderSurfaceFactSource): string {
  return JSON.stringify(surface.actions.map((action) => [action.id, action.risk, action.undoable]));
}

/**
 * The injection facts of ONE companion turn — the payload the Rust
 * `llm_chat_with_status` persists as the `companion.injection` span.
 */
export interface CompanionInjectionFacts {
  readonly appId: string;
  /** Did the description+pair path resolve the target per-app? */
  readonly taught: boolean;
  /** How many per-app enablement entries the path consulted. */
  readonly perAppEntries: number;
  readonly descriptionBytes: number;
  readonly screenshotBytes: number;
  readonly simplifiedHtmlBytes: number;
  /** The injected outline's node count (Spec #3244, ST-6; AC-4) — its size
   *  alongside the byte count. */
  readonly simplifiedHtmlNodes: number;
  /** Did a cap bite the injected outline (Spec #3244 rework; AC-4) — the span's
   *  own truncation flag, so the AC-4 record's `truncated`/`bindingCap` are
   *  derived from the run's receipt instead of hand-asserted. */
  readonly simplifiedHtmlTruncated: boolean;
  readonly screenshotDigest: string;
  readonly simplifiedHtmlDigest: string;
  /**
   * The placement identity this turn belongs to (Spec #3243 ST-3; R-4a) — `''`
   * when Fredo is not placed. REQUIRED on the wire, never defaulted.
   */
  readonly placementId: string;
  /**
   * How many actions the target app DECLARES for orders (Spec #3243 ST-3; R-1a)
   * — `0` when it declares none. REQUIRED on the wire, never defaulted.
   */
  readonly orderActionCount: number;
  /**
   * A content digest of the declared order-surface table (Spec #3243 ST-3) — the
   * empty-table digest when the app declares none. REQUIRED on the wire, never
   * defaulted.
   */
  readonly orderSurfaceDigest: string;
}


/**
 * The description+pair path's per-app enablement sources.
 *
 * EMPTY by design. The path resolves a target app — built-in OR installed —
 * from `resolveAppDescription` (ST-1) plus the host capture seam (ST-3), and
 * consults no per-app table. This declaration is the ONE enumeration of the
 * path's per-app enablement, so a source added here would flip the witness and
 * the QA source-sweep (R-5b) would redden.
 */
export const PAIR_PATH_PER_APP_SOURCES: readonly string[] = Object.freeze([]);

/** The witness: does the description+pair path resolve the target per-app? */
export function pairPathTaught(): boolean {
  return PAIR_PATH_PER_APP_SOURCES.length > 0;
}

/** The witness: how many per-app entries the path consulted. */
export function pairPathPerAppEntries(): number {
  return PAIR_PATH_PER_APP_SOURCES.length;
}

/** The turn inputs the facts are derived from. */
export interface CompanionInjectionInput {
  readonly appId: string;
  /** The resolved description injected into the turn, when one was. */
  readonly description?: string;
  readonly outline: ScreenOutline;
  readonly screenshotPngBase64: string;
  /**
   * The app's DECLARED order surface, when the run resolved one (Spec #3243
   * ST-3). Absent ⇔ the app declares none ⇒ `orderActionCount: 0` and the
   * empty-table digest — a real zero, never a missing key.
   */
  readonly orderSurface?: OrderSurfaceFactSource;
}

/**
 * Derive the injection facts from the turn's OWN inputs (R-4b: the numbers come
 * from the run, never a constant). Byte counts are UTF-8 bytes of exactly what
 * crossed into the turn; digests are content fingerprints of the same values.
 *
 * The placement identity is read from the module-scoped placement store AT BUILD
 * TIME, so the facts carry the placement the turn actually ran under (AC-4's
 * receipt) rather than a value a call site could pass in stale or forget.
 */
export function buildCompanionInjectionFacts(
  input: CompanionInjectionInput,
): CompanionInjectionFacts {
  const outlineJson = serializeOutline(input.outline);
  const orderSurface = input.orderSurface;
  const placement = readPlacement();
  return {
    appId: input.appId,
    taught: pairPathTaught(),
    perAppEntries: pairPathPerAppEntries(),
    descriptionBytes: utf8ByteLength(input.description ?? ''),
    screenshotBytes: utf8ByteLength(input.screenshotPngBase64),
    simplifiedHtmlBytes: utf8ByteLength(outlineJson),
    simplifiedHtmlNodes: input.outline.nodes.length,
    simplifiedHtmlTruncated: input.outline.truncated,
    screenshotDigest: contentDigest(input.screenshotPngBase64),
    simplifiedHtmlDigest: contentDigest(outlineJson),
    placementId: placement === null ? '' : placement.placementId,
    orderActionCount: orderSurface === undefined ? 0 : orderSurface.actions.length,
    orderSurfaceDigest:
      orderSurface === undefined
        ? EMPTY_ORDER_SURFACE_DIGEST
        : contentDigest(canonicalOrderSurface(orderSurface)),
  };
}
