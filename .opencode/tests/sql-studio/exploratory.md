# sql-studio — Exploratory

Unscripted probes for the SQL Studio identity + decluttered-shell slice. A confirmed finding
**promotes** to `functional.md` as a new `F-` row (keep the origin note). Prompt lines below — the
Tester probes beyond the script.

> **Verification policy: LIVE** — probes run against the running app + embedded cluster.

## Prompt lines

- Probe: after the strip removal, where did the Disconnect control land, and does it collide with
  a conditionally-rendered sibling (e.g. the schema inspector, the status region) in the app's
  normal first-open state (persisted built-in row, none live)? Measure rects for overlap/clipping
  (G-253).
- Probe: is the empty-state copy reachable at all now that #3029 seeds the built-in row — and if
  the built-in is deleted, does the empty copy read "SQL Studio" and offer a working "Add
  connection"?
- Probe: resize the window very narrow/very wide — does the full-width connections list clip its
  exempt children (status dot, built-in badge, SSL label, actions) or collapse the name before the
  fit width (G-274)?
- Probe: with a long connection name, does the ellipsis stay the intended overflow behaviour
  (`title` tooltip correct) rather than truncating at the fit width?
- Probe: is there any residual reference to `AccessModeBadge` (string, testid, CSS, story) after
  retirement — search the tree; a runtime/console "unknown testid" or a stray `db-access-mode-badge`
  match is a finding.
- Probe: toggle light/dark with the app connected — does the relocated Disconnect stay
  contrast-visible and focus-visible in both themes?
- Probe: force `FREDO_DBCLIENT_FORCE_FAIL=connect` and connect the built-in — is the failure typed,
  is the Disconnect affordance absent (nothing connected), and does the app stay interactive?
- Probe: in a `new-window` presentation, does the window title read "SQL Studio" (not the Tab title
  only), and does the app still render the decluttered shell?

## Prompt lines — resize slice (#3049)

- Probe (rapid reversals): drag a divider back and forth rapidly for several seconds — does it
  jitter, drop pointer capture mid-gesture, leave a stuck cursor, or trip a re-render loop
  ("Maximum update depth exceeded")? Is the drag coalesced or laggy (G-275)?
- Probe (extreme narrow window): shrink the window far below the sum of both sidebar minimums —
  does a defined precedence hold (workspace min wins), or do the sidebars overlap, vanish, or clip
  each other?
- Probe (drag-across-editor selection): start a drag on a divider and sweep across the SQL editor /
  results grid — is any text selected, does the editor lose its caret or scroll position, does the
  results grid lose its selection?
- Probe (keyboard path): is there ANY keyboard affordance for the splits (a separator role with
  arrow-key resize, or focusable handles)? A pointer-only split with no keyboard path is an
  accessibility finding.
- Probe (presentation modes): resize the splits, then switch `same-window` / `new-window` — do the
  sizes persist or restore, or reset?
- Probe (multi-tab / multi-result): resize S3 with several result sets or after Run-all — does the
  grid keep its scroll position and selection?
- Probe (theme + accent): resize, then change theme (light/dark) and the user accent — does the
  divider affordance stay visible and contrast-adequate, and does a resize mid-transition break?
- Probe (zoomed content): zoom the webview / change font scaling — do the persisted pixel sizes and
  the min/max clamps still behave, or does content clip?

## Run log

### Round 1 — 2026-10-13 (spec/3048 @ bc741d6)

PASS: Disconnect placement (no sibling collision — 8px gap); empty-state reach + "SQL Studio" copy;
window resize (fixed 283px column, cards flush, no exempt-child clipping); long-name intended
ellipsis with `title`; zero residual `db-access-mode-badge`; light/dark with the app connected.
NOT RUN this round: the `FREDO_DBCLIENT_FORCE_FAIL=connect` env-gated leg and the `new-window`
presentation leg (neither is a case FAIL — recorded as exploratory gaps).
