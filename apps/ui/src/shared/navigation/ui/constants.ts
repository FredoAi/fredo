/**
 * Spec #3118 (P4), ST-1 — the bound names block for the navigation surfaces.
 *
 * Every test id, data attribute, accessible name, copy string and bound below is the
 * **binding test contract** of the P4 plan (`## Software Architect` §2). The wave-2
 * components (ST-2…ST-5), the QA suites and the docs §11 contract all read these names
 * from here, so a surface can never invent a parallel literal.
 *
 * PURE: constants only. No imports, no runtime, no DOM read.
 *
 * DELIBERATELY ABSENT: the dev-route literals (`'view'` / `'navigation-preview'`) and
 * `NAV_PREVIEW_GLYPH_KEYS`. This file is `[root]`-exported by ST-7, so a dev-only literal
 * here is guaranteed to reach `apps/ui/dist/assets/**` and would make AC8's production
 * exclusion unsatisfiable by construction (Architect C2 / QA GAP 4). The route literals are
 * inlined in `app/routes/Router.tsx`'s DEV branch.
 */

// ── DOM hooks ────────────────────────────────────────────────────────────────
// Spec #3120 (P6 rescope, ST-5): the vertical column became the bottom command bar.
// SYMBOLS are unchanged (binding for downstream consumers); only the string VALUES move
// from `navigation-rail*` to `navigation-bar*`. `NAV_RAIL_PLACE_TESTID` is now the LAST
// breadcrumb segment (UIUX-D4), never a standalone heading.
export const NAV_RAIL_TESTID = 'navigation-bar';
export const NAV_RAIL_BREADCRUMB_TESTID = 'navigation-bar-breadcrumb';
export const NAV_RAIL_PLACE_TESTID = 'navigation-bar-place';
export const NAV_RAIL_TRANSIENT_TESTID = 'navigation-bar-transient';
export const NAV_RAIL_LIST_TESTID = 'navigation-bar-list';
/**
 * Retained symbol + string VALUE (`navigation-rail-places`). Since the round-7 follow-up the
 * bar DOES render the current place's child-place group, as a `role="list"` BEFORE the verb
 * cluster. The value stays `navigation-rail-places` because the durable suite binds it.
 */
export const NAV_RAIL_PLACES_TESTID = 'navigation-rail-places';
/**
 * Retained symbol + string VALUE (`navigation-rail-place-row`) for one child-place row. The
 * bar renders these rows before the verb cluster (they are excluded from the 8-row verb cap).
 * The value stays `navigation-rail-place-row` because the durable suite binds it.
 */
export const NAV_RAIL_PLACE_ROW_TESTID = 'navigation-rail-place-row';
export const NAV_RAIL_ROW_TESTID = 'navigation-bar-row';
export const NAV_RAIL_RISK_TESTID = 'navigation-bar-risk';
export const NAV_RAIL_MORE_TESTID = 'navigation-bar-more';
export const NAV_RAIL_ASK_TESTID = 'navigation-bar-ask';
export const NAV_RAIL_MAP_TESTID = 'navigation-bar-map';

export const NAV_MAP_TESTID = 'navigation-map';
export const NAV_MAP_SEARCH_TESTID = 'navigation-map-search';
export const NAV_MAP_PLACE_TESTID = 'navigation-map-place';
export const NAV_MAP_ROW_TESTID = 'navigation-map-row';
export const NAV_MAP_KEY_TESTID = 'navigation-map-key';
export const NAV_MAP_ALIAS_TESTID = 'navigation-map-alias';
export const NAV_MAP_GLOBAL_TESTID = 'navigation-map-global';
export const NAV_MAP_EMPTY_TESTID = 'navigation-map-empty';

export const NAV_TRAIL_TESTID = 'navigation-trail';
export const NAV_TRAIL_ENTRY_TESTID = 'navigation-trail-entry';
export const NAV_TRAIL_ACTOR_TESTID = 'navigation-trail-actor';
export const NAV_TRAIL_PATH_TESTID = 'navigation-trail-path';
export const NAV_TRAIL_TIME_TESTID = 'navigation-trail-time';
export const NAV_TRAIL_UNDO_TESTID = 'navigation-trail-undo';
export const NAV_TRAIL_EMPTY_TESTID = 'navigation-trail-empty';

export const NAV_KEYCAP_GROUP_TESTID = 'navigation-keycap-group';
export const NAV_KEYCAP_TESTID = 'navigation-keycap';

export const NAV_ANNOUNCER_TESTID = 'navigation-announcer';
export const NAV_ANNOUNCER_LABEL = 'Navigation announcements';

// ── stable data attributes (G-403 class anchors) ─────────────────────────────
//
// Spec #3122 (P8), ST-1 — DELIBERATELY NOT INTRODUCED: `NAV_LABEL_ATTR`, `NAV_KEY_ATTR`,
// `NAV_ACTION_ATTR` and `NAV_MODE_ATTR`. The Names Block reserved them as possible
// successors to the deleted legacy row hooks, but the binding UI/UX correction
// establishes that NO retained test addresses a navigation row by label/key/action/mode —
// a row is addressed by its verb id (`NAV_VERB_ID_ATTR`). Their absence is intentional;
// reintroducing one would add a product attribute with no consumer.
/** Present on EVERY navigation surface root: 'rail' | 'map' | 'trail'. */
export const NAV_SURFACE_ATTR = 'data-nav-surface';
/** Present on the navigation keycap root. */
export const NAV_KEYCAP_ATTR = 'data-nav-keycap';
export const NAV_PLACE_ID_ATTR = 'data-nav-place-id';
export const NAV_VERB_ID_ATTR = 'data-nav-verb-id';
export const NAV_ACTOR_ATTR = 'data-nav-actor'; // 'human' | 'companion' | 'system'
export const NAV_CURRENT_ATTR = 'data-nav-current'; // 'true' on the current place
export const NAV_AVAILABILITY_ATTR = 'data-nav-availability'; // 'available' | 'disabled'
export const NAV_RISK_ATTR = 'data-nav-risk'; // Risk value
export const NAV_COMPACT_ATTR = 'data-nav-compact'; // 'true'

// ── accessible names ────────────────────────────────────────────────────────
export const NAV_RAIL_ARIA_LABEL = 'Command bar';
export const NAV_MAP_ARIA_LABEL = 'Navigation map';
export const NAV_TRAIL_ARIA_LABEL = 'Activity trail';

// ── copy (test-asserted literals) ───────────────────────────────────────────
export const NAV_MORE_LABEL = 'more…';
/** Accessible name for the `more…` affordance (the visible label stays `more…`). */
export const NAV_MORE_ARIA_LABEL = 'More actions in this place — opens the map';
/** Micro-label above the child-place rows in the rail. */
export const NAV_RAIL_PLACES_LABEL = 'Places';
export const NAV_EMPTY_TRAIL_COPY = 'Nothing yet — your actions will appear here';
export const NAV_UNAVAILABLE_REASON = 'Not available for the current selection';
export const NAV_TRANSIENT_MARKER_SUFFIX = 'one action';
export const NAV_RISK_LABELS = {
  safe: 'Safe',
  mutating: 'Changes',
  destructive: 'Destructive',
  external: 'External',
} as const;
export const NAV_ACTOR_LABELS = {
  human: 'You',
  companion: 'Companion',
  system: 'System',
} as const;

// ── G-324 adjudication bundle — the UI/UX Expert's §13 values, ACCEPTED as bound ──
// Each of these is UI copy on a SHIPPED surface (never dev-route-only), so it belongs in
// this root-exported file. QA asserts the CONSTANTS — never a design-doc snapshot — so a
// design wording edit cannot silently redefine a passing test (G-324/G-419).
export const NAV_MAP_SEARCH_LABEL = 'Search places, actions and keys';
export const NAV_MAP_EMPTY_COPY = 'No matching places, actions or keys';
export const NAV_MAP_ALIASES_HEADING = 'Direct aliases';
export const NAV_MAP_GLOBALS_HEADING = 'Global keys';
export const NAV_MAP_CURRENT_LABEL = 'Current place';
export const NAV_RAIL_EMPTY_COPY = 'No actions in this place';
export const NAV_MAP_HINT_COPY = '↑ ↓ move · Enter run · Esc close';

// ── global entries: glyph ↔ declared verb id (docs/NAVIGATION_ENGINE.md §4) ──
export const NAV_MAP_VERB_ID = 'app.map'; // rail/global "Map"
export const NAV_ASK_VERB_ID = 'app.ask'; // rail/global "Ask"
export const NAV_GLYPH_BY_VERB_ID = {
  [NAV_MAP_VERB_ID]: '?',
  [NAV_ASK_VERB_ID]: '/',
} as const;
export const NAV_GLYPH_ACCESSIBLE_NAME = {
  '?': 'Question mark',
  '/': 'Slash',
} as const;
/** Bindable strokes the published map declares for the two globals (never the glyph). */
export const NAV_GLOBAL_BINDINGS = {
  [NAV_MAP_VERB_ID]: 'm',
  [NAV_ASK_VERB_ID]: 'k',
} as const;

// ── motion ─────────────────────────────────────────────────────────────────
export const NAV_MOTION_MS = 150; // opacity/transform only
export const NAV_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// ── bounds ─────────────────────────────────────────────────────────────────
export const NAV_RAIL_MAX_ROWS = 8; // mirrors discover.RAIL_MAX_ROWS
export const NAV_RAIL_TITLE_MIN_WIDTH_PX = 48; // the ONE ellipsizing child per row (G-274)
// Spec #3120 (P6 rescope, ST-5) — the horizontal bar's geometry (UIUX-D6).
export const NAV_BAR_MIN_HEIGHT_PX = 44; // the bar may GROW vertically when the cluster wraps
export const NAV_BAR_ROW_MIN_WIDTH_PX = 96; // rows never collapse below this floor
export const NAV_BAR_ROW_GAP_PX = 2;
