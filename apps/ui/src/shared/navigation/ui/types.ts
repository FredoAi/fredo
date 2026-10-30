/**
 * Spec #3118 (P4), ST-1 — the view-model vocabulary of the P4 surfaces.
 *
 * These are the ONE shapes the rail, the map and the trail render from. Each is produced by
 * `models.ts` from the shipped P3 projections (never from a second key table), so a surface
 * cannot diverge from the declaration (ADR-6 / R-6.1).
 *
 * Field-for-field binding: every field an acceptance criterion names is present here with the
 * exact name (G-417). Renaming one is a breaking change for wave 2.
 *
 * Types only: no runtime, no imports beyond the headless leaf vocabulary.
 */

import type { Actor, Risk } from '../types';

/** §11.1 — one breadcrumb / place-path record (structurally the envelope's `PlaceRef`). */
export interface NavPlaceRef {
  readonly id: string;
  readonly label: string;
  readonly transient: boolean;
  readonly sticky: boolean;
}

/** The rail's risk cue: `'none'` iff the verb is `safe`. */
export type NavRiskCue = 'none' | 'mutating' | 'destructive' | 'external';

/** R-1.2 / R-1.3 — one rail row. */
export interface CommandRailRow {
  readonly verbId: string;
  readonly title: string;
  readonly keys: readonly string[]; // every binding of the verb in this place
  readonly keyHint: string; // display text of the FIRST binding ('' when unbound)
  readonly risk: Risk;
  readonly riskCue: NavRiskCue; // 'none' iff risk === 'safe'
  readonly riskLabel: string | null; // null iff risk === 'safe' (R-7.2)
  readonly enabled: boolean;
  readonly reason: string | null; // NAV_UNAVAILABLE_REASON iff !enabled
  readonly tooltip: string; // navTooltip(...) (+ ' — <reason>' iff !enabled)
}

/** `/ Ask` and `? Map`. */
export interface NavAffordance {
  readonly glyph: string; // '?' | '/'
  readonly label: string; // 'Map' | 'Ask'
  readonly binding: string; // declared stroke, e.g. 'm' | 'k' (never the glyph)
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly tooltip: string;
}

/** R-1.1 — one child-place row (the "Places" rail section above the verbs). */
export interface CommandRailPlaceRow {
  readonly placeId: string;
  readonly label: string;
  /** The first stroke that enters this child place ('' when the parent declares none). */
  readonly key: string;
  /** Every stroke in the parent that enters this child place, declaration order. */
  readonly keys: readonly string[];
  readonly keyHint: string; // display text of the first entry stroke ('' when unbound)
  readonly transient: boolean;
  readonly tooltip: string; // `<label> — <n> actions (<key>)` (+ transient suffix)
}

/** R-1.1 … R-1.7 — the rail's ONE model. No key table, no `VerbDescriptor[]`. */
export interface CommandRailModel {
  readonly breadcrumb: readonly NavPlaceRef[]; // root → current
  readonly currentPlace: NavPlaceRef;
  readonly transientMarker: string | null; // `${label} · one action` iff transient
  readonly placeRows: readonly CommandRailPlaceRow[]; // child places, declaration order
  readonly rows: readonly CommandRailRow[]; // ≤ 8, declaration order; NEVER app.map/app.ask
  readonly overflow: number; // bound verbs beyond 8, excluding the two globals
  readonly actionCount: number; // rows.length + overflow, excluding the two globals
  readonly more: { readonly label: string; readonly opensFilteredTo: string } | null;
  readonly ask: NavAffordance; // enabled once the launcher ships (P6)
  readonly map: NavAffordance; // enabled === true
}

/** R-2.2 — one verb inside a place. */
export interface NavigationMapVerb {
  readonly verbId: string;
  readonly title: string;
  readonly risk: Risk;
  readonly riskLabel: string | null;
  readonly keys: readonly string[];
  readonly keyHint: string;
  readonly available: boolean;
  readonly reason: string | null;
  readonly tooltip: string;
}

/** R-2.2 — one key or alias row. */
export interface NavigationMapKey {
  readonly stroke: string;
  readonly keyHint: string;
  readonly glyph: string | null; // '?' | '/' for the two globals, else null
  readonly target: 'verb' | 'place';
  readonly targetId: string;
  readonly targetLabel: string;
  readonly source: 'place' | 'alias';
}

/** R-2.1 / R-2.2 — one place block. */
export interface NavigationMapPlace {
  readonly placeId: string;
  readonly label: string;
  readonly depth: number; // 0 = root
  readonly placePath: readonly NavPlaceRef[];
  readonly pathLabel: string; // 'Canvas › Create'
  readonly current: boolean;
  readonly transient: boolean;
  readonly sticky: boolean;
  readonly verbs: readonly NavigationMapVerb[];
  readonly keys: readonly NavigationMapKey[]; // source === 'place'
}

/** R-2.1 … R-2.6 — the map's ONE model. */
export interface NavigationMapModel {
  readonly appId: string;
  readonly currentPlaceId: string | null;
  readonly places: readonly NavigationMapPlace[]; // tree order
  readonly aliases: readonly NavigationMapKey[]; // source === 'alias' (distinct section)
  readonly globals: readonly NavigationMapKey[]; // app.map / app.ask with glyphs
  readonly filteredTo: string | null; // set by rail 'more…'
}

/** R-3.1 … R-3.5 — one trail row. */
export interface ActivityTrailEntry {
  readonly seq: number;
  readonly ts: string;
  readonly timeLabel: string; // 'HH:mm' — Intl.DateTimeFormat(undefined, {hourCycle:'h23'})
  readonly actor: Actor;
  readonly actorLabel: string; // NAV_ACTOR_LABELS[actor]
  readonly verbId: string;
  readonly label: string;
  readonly placePath: readonly NavPlaceRef[];
  readonly pathLabel: string;
  readonly undoable: boolean;
  readonly undoLabel: string | null; // 'Undo' iff undoable, else null
  readonly undoReason: string | null; // the authored consequence / undo copy iff !undoable
}

/** R-3.1 … R-3.5 — the trail's ONE model. */
export interface ActivityTrailModel {
  readonly entries: readonly ActivityTrailEntry[]; // newest first, ≤ 10
  readonly empty: boolean;
  readonly emptyCopy: string; // NAV_EMPTY_TRAIL_COPY
  readonly undoableCount: number;
}
