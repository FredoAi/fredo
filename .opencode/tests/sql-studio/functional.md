# sql-studio — Functional

Durable functional suite for the **SQL Studio** app identity + decluttered shell feature domain
(the built-in database tool formerly labelled "PostgreSQL" in the UI: app identity rename, removal
of the in-app header strip, retirement of the access-mode badge, a relocated Disconnect, and a
full-width connections list). Seeded at issue **#3048**. Extends and links the existing
`database-client`-surface suites rather than duplicating them:

- `.opencode/tests/postgres-client/` — the client's functional surface (connect, schema, query,
  history/export, read-only safety, credential secrecy).
- `.opencode/tests/db-client-builtin/` — the seeded built-in "Fredo" read-only connection.
- `.opencode/tests/postgres-naming/` — the embedded-cluster identity domain (engine strings).

> **Verification policy: LIVE** — every case observes a running app: rendered DOM geometry, a
> text scan for app-identity strings, and screenshots. The testing exit gate and audit fail-closed
> unless the Tester's Evidence references a live DOM/screenshot capture AND a `telemetry_spans`
> non-zero receipt taken from a live OTLP-ingested action (never `fredo emit`, G-256). A
> static/unit-only PASS is a FALSE PASS.

> **G-263 SAFETY:** every live leg is bounded and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -Spec 3048`. Bounds: connect
> ≤10 s; app start ≤180 s; every managed-`psql` ≤60 s. Never a bare `postgres`/`pg_ctl`/`psql`.

> **G-284 READ LEVER:** the `telemetry-query` skill / managed `psql` read the embedded cluster;
> the read-only-no-side-effect proof (F-7) uses the managed `psql` via
> `.opencode/scripts/run-exitcode.ps1 -Command "<psql> <uri> …"` (database `fredo`), the URI from
> `pg_supervisor_status`.

> **INDUCTION LEVERS (G-275/G-300):** `FREDO_DBCLIENT_FORCE_FAIL=connect|auth|timeout|query`
> (inert when unset) induces the connect-failure edge; `FREDO_DBCLIENT_STATE_DIR=<empty dir>`
> emulates a fresh profile.

## Cases

- [ ] **F-1 (R-1 / Q-1.1) — app identity "SQL Studio" on registry / window / dock.**
  Boot the app; open it from the dock/launcher; present it `same-window` and `new-window`
  (Settings → Apps).
  **Expected:** the app identity reads **"SQL Studio"** on every user-visible app-name surface
  (dock label, window title, tab title). Static pin: `databaseClientFeature.name === 'SQL Studio'`
  (`registration.test.tsx` updated).
  **Edge:** engine string "PostgreSQL 16.0" may still appear (it is NOT an app identity).
  **FAIL** = any app-name surface reads "PostgreSQL".

- [ ] **F-2 (R-1 / Q-1.2) — in-app title/copy reads "SQL Studio".**
  Scan `db-client-root` text content.
  **Expected:** any in-app app title/copy reads "SQL Studio" (or is absent if the strip is removed,
  F-4); NO app-identity "PostgreSQL" appears.
  **Edge:** "PostgreSQL" in an engine/server-version string is exempt and must be classified as
  engine, not identity. **FAIL** = an in-app app-identity string reads "PostgreSQL".

- [ ] **F-3 (R-1 / Q-1.3) — settings-section label "SQL Studio".**
  Open Settings; locate the app's section + panel heading.
  **Expected:** nav section + panel heading read "SQL Studio" (the `DatabaseClientSettings.tsx:90`
  copy "PostgreSQL client preferences" is renamed); section still auto-discovers (no central-list
  edit). **FAIL** = labelled "PostgreSQL".

- [ ] **F-4 (R-1 / Q-1.4 + R-2 / Q-2.1..Q-2.3) — no header strip; empty-state copy; space reclaimed.**
  Reach the empty state (delete the built-in row → no re-seed, `db-client-builtin F-5`; reload).
  **Expected:** no in-app header strip (icon + title + badge) renders in ANY state;
  `db-client-root`'s first content child is the workspace layout row, not a strip; the
  `db-connections-empty` copy names "SQL Studio" with no app-identity "PostgreSQL"; measured gap
  between `db-client-root` content top and `db-connections-panel` top is ≤ layout padding
  (≤ ~9px) — no reserved strip band; the 3-region workspace still lays out.
  **Edge:** connected vs disconnected; read-only vs read-write. **FAIL** = a strip renders, an
  empty gap remains, or the empty copy says "PostgreSQL".

- [ ] **F-5 (R-1 / Q-1.5) — repo docs updated.**
  Inspect the doc lines the Architect names (e.g. `ARCHITECTURE.md:547,600` and the app catalogue
  table) that name the TOOL/app.
  **Expected:** they read "SQL Studio"; engine references (Postgres engine, `database-client` id,
  `db_*` commands, `postgres` role/db) are unchanged.
  **FAIL** = a tool/app-name doc reference still reads "PostgreSQL", or an engine reference was
  wrongly renamed.

- [ ] **F-6 (R-3 / Q-3.1) — access-mode badge no longer renders anywhere.**
  Inspect the DOM while disconnected, connected read-only (built-in "Fredo"), and connected
  read-write (`qa-rw`).
  **Expected:** zero matches for `db-access-mode-badge` in all three states.
  **Edge:** read-write leg requires an ordinary `accessMode=readWrite` connection.
  **FAIL** = the badge renders in any state.

- [ ] **F-7 (R-3 / Q-3.3) — read-only default + enforcement unchanged.**
  Connect the built-in "Fredo" row (read-only); submit `CREATE TABLE qa_3048(x int)`, `INSERT`,
  `UPDATE`, `DELETE`, `DROP`.
  **Expected:** every non-`read` statement refused `readOnlyBlocked` BEFORE server contact; a
  managed-`psql` read confirms no side effect. Mirrors `db-client-builtin F-9`.
  **FAIL** = any statement executes.

- [ ] **F-8 (R-3 / Q-3.4) — connect/disconnect still work; failure path typed.**
  Click the built-in "Fredo" row; `SELECT 1`. Then set `FREDO_DBCLIENT_FORCE_FAIL=connect` and
  re-attempt.
  **Expected:** the happy path connects ≤10 s (`db-connection-status-builtin-fredo` →
  `connected`, `SELECT 1` → `1`); the forced-failure leg yields a typed error with no
  hang/panic and no "connected" state.
  **FAIL** = prompt, refusal, hang, or panic.

- [ ] **F-9 (R-3 / Q-3.5) — read-write mode + destructive confirm unchanged.**
  On an ordinary read-write connection run UPDATE/DELETE/DROP → confirm gate; cancel, then confirm.
  **Expected:** the warning appears; the statement does NOT run unless confirmed; confirm runs
  exactly once. Mirrors `postgres-client F-5`. **FAIL** = destructive runs unconfirmed.

- [ ] **F-10 (R-4 / Q-4.1..Q-4.2, G-265) — Disconnect reachable from within the app.**
  From the default no-connection state, connect the built-in "Fredo" row; locate the relocated
  Disconnect affordance; Tab to it; activate with Enter/Space.
  **Expected:** the affordance is present with a real RESTING rect (`webview_find_element`),
  keyboard-reachable, focus-visible, labelled; activating it calls `db_disconnect`, sets status
  "Disconnected", and returns `db-connection-status-builtin-fredo` to `idle`.
  **Edge:** disconnected state — the affordance is absent or disabled (never an enabled no-op).
  **FAIL** = Disconnect unreachable, or disconnect does not tear down the session.

- [ ] **F-11 (R-5 / Q-5.1) — connections header + cards fill the column width.**
  With ≥1 connection, measure `db-connections-panel` vs the `Connections` header row
  (`ConnectionsPanel.tsx:88-105`) and each `db-connection-row-<id>` card (`:174-324`).
  **Expected:** header + every card share the column's left/right x — right edge flush, no right
  dead space.
  **Edge:** 1 connection and ≥2 connections. **FAIL** = a card/header narrower than its column.

- [ ] **F-12 (R-5 / Q-5.2, G-274) — no premature truncation; ellipsis target + exempt children.**
  With a long-named ordinary connection at the normal column width, inspect `db-connection-name`
  (`:212-225`) and `db-connection-target` (`:257-273`).
  **Expected:** both render fully (`scrollWidth ≤ clientWidth`) with `title` tooltips intact; the
  ellipsis TARGET is exactly those two text nodes; EXEMPT children (status dot `:202-211`,
  built-in badge `:226-246`, SSL label `:247-255`, Edit/Delete actions `:281-320`) keep their box
  and are not clipped.
  **FAIL** = premature ellipsis at the fit width, or a clipped exempt child.

- [ ] **F-13 (R-5 / Q-5.3) — column-width-change edge (NOW IN SCOPE — driven by #3049).**
  Drive the left-column / connections width change via the new S1 divider (see **F-19**).
  **Expected (updated #3049):** the column is no longer fixed — the historical note
  ("column FIXED at `width="300px"`, `flexShrink={0}`") is SUPERSEDED by #3049, which makes the
  left sidebar resizable. Verify the width change here by deferring to **F-19**; do NOT re-record
  this row UNVERIFIED. The named blocker #3049 is now the feature under test.
  **FAIL** = the width change cannot be driven (defer to **F-19**'s verdict).

- [ ] **F-14 (NFR-1) — theme (light/dark).**
  Toggle the theming application; re-screenshot the shell, the full-width list, and the relocated
  Disconnect.
  **Expected:** all render correctly in both themes; no unstyled/invisible element.
  **FAIL** = a broken element in either theme.

- [ ] **F-15 (NFR-2) — token compliance / no hardcoded colors.**
  Inspect `DatabaseClientFeature.tsx`, `ConnectionsPanel.tsx`, `DatabaseClientSettings.tsx`.
  **Expected:** no hex/rgba literals; semantic tokens / `tint()` only; the removed
  `AccessModeBadge` leaves no orphaned token usage. **FAIL** = a hardcoded color.

- [ ] **F-16 (NFR-3) — accessibility.**
  Keyboard-drive the relocated Disconnect (Tab/Enter), verify focus + label; inspect the status
  region.
  **Expected:** Disconnect keyboard-reachable + labelled; `db-status-operation` (`role=status`,
  `aria-live=polite`) intact; no `role=status` badge remnant.
  **FAIL** = unreachable/unlabelled control, or a lost live region.

- [ ] **F-17 (NFR-4) — zero-warning build.**
  Run `pnpm --filter @fredo/ui build`; run `pnpm test`.
  **Expected:** build exits 0 with zero TS errors; vitest green with no dangling `AccessModeBadge`
  import and no badge assertion left. `cargo check` N/A unless a Rust file is touched.
  **FAIL** = any TS error or failing test.

- [ ] **F-18 (NFR-5, LIVE receipt) — `telemetry_spans` non-zero.**
  Drive a live OTLP-ingested agent action (never `fredo emit`, G-256) during the run; query
  `telemetry_spans`.
  **Expected:** non-zero at the read with the source/lever disclosed; DOM/screenshot evidence
  captured for the rendering rows. **FAIL** = a static-only receipt.

## RESIZE cases (#3049 — four draggable splits)

Slice on top of #3048. Four splits are in scope — **S1** left sidebar ↔ workspace (width),
**S2** right sidebar ↔ workspace (width), **S3** editor ↔ results (height, inside `QueryTabs.tsx`),
**S4** connections ↔ schema-explorer (height, inside the left sidebar). Every geometry claim is a
**before/after pair** read live via `webview_find_element` bounding rects — a single frame cannot
prove a size change. Implementation detail may name the exact handles, min/max and persisted field;
the tester binds GA-5/GA-6/GA-8 to whatever the plan names.

> **INDUCTION LEVERS (G-275/G-300):** the drags, over-drags, window resize
> (`tauri_manage_window resize`) and full-restart (`dev-environment`) are the drivable levers for
> F-19..F-32. The ONLY edge with no in-app lever is the corrupt/out-of-range persisted size —
> scoped as the unit pin **F-33 (non-AC)**, never a live FAIL row.

- [ ] **F-19 (AC1 / S1) — left-sidebar width resize, both directions.**
  Connect the built-in "Fredo" session; drag the S1 divider right (wider), then left (narrower).
  **Expected:** the left column rect width tracks the pointer 1:1; the centre workspace
  (`db-query-workspace`) left edge moves by the same delta; both directions work; the new width
  holds after release; sidebar + workspace report `scrollWidth ≤ clientWidth` and
  `scrollHeight ≤ clientHeight` (excluding intended inner scrollers).
  **Edge:** at declared min; at declared max; narrow window; disconnected (no session).
  **FAIL** = the split does not move in a direction, or the workspace fails to reflow.

- [ ] **F-20 (AC2 / S2) — right-sidebar width resize, both directions.**
  Drag the S2 divider left (wider), then right (narrower).
  **Expected:** the right column rect width tracks the pointer; the workspace right edge moves by
  the same delta; both directions work; holds after release; no clip on either side.
  **Edge:** at declared min; at declared max; narrow window. **FAIL** = no move / clipping.

- [ ] **F-21 (AC3 / S3) — editor ↔ results height resize, both directions.**
  Run a query so the editor AND `ResultsGrid` both have content; drag the S3 horizontal divider up
  (editor taller), then down (results taller).
  **Expected:** the editor block and the results region heights track the pointer in both
  directions; the tab strip + export row stay intact; the grid remains scrollable; holds after
  release. **Edge:** up + down; at declared min/max; 0 rows and many rows.
  **FAIL** = no move, a clipped region, or a broken tab strip.

- [ ] **F-22 (AC3 / S4) — connections ↔ schema height resize, both directions.**
  With the schema tree loaded, drag the S4 horizontal divider inside the left sidebar up (schema
  taller), then down (connections taller).
  **Expected:** `ConnectionsPanel` and `SchemaTree` heights track the pointer in both directions;
  the left column does not clip its children; holds after release.
  **Edge:** up + down; at declared min/max; schema unloaded. **FAIL** = no move / clipping.

- [ ] **F-23 (AC4) — min clamp, each of S1/S2/S3/S4.**
  For each split, drag the pointer well past the declared min (toward 0).
  **Expected:** the size stops at the split's declared min — never collapses to 0; the other
  pane/workspace never disappears; release keeps the clamped value; no negative/NaN geometry, no
  overflow. **Edge:** width min vs height min; a window too narrow to honour a sidebar min → the
  defined clamp precedence (workspace min wins). **FAIL** = a split collapses below its min.

- [ ] **F-24 (AC4) — max clamp, each of S1/S2/S3/S4.**
  For each split, drag the pointer well past the declared max (toward the far edge).
  **Expected:** the size stops at the declared max — a sidebar can never expand to hide the
  workspace (workspace stays ≥ its min visible size); release keeps the clamped value; no
  clipping/overflow at max. **Edge:** width max vs height max; narrow window.
  **FAIL** = a split exceeds its max or hides the workspace.

- [ ] **F-25 (AC1–AC4) — no-clip / clean reflow at min AND max.**
  Set each split to its min (screenshot + geometry), then to its max (screenshot + geometry).
  **Expected:** at every allowed extreme the status bar, tab strip and export row remain intact;
  every region reports `scrollWidth ≤ clientWidth` (no horizontal overflow/clipping); content
  reflows rather than overflowing — at BOTH a wide (≥1600px) and a narrow (≤900px) window, in light
  AND dark theme. **FAIL** = any clipping/overflow at an allowed size.

- [ ] **F-26 (AC5, edge) — restart persistence.**
  Change each split to a non-default size, capture geometry, FULLY quit and relaunch the app (not a
  webview reload); re-measure without touching any divider.
  **Expected:** each split's post-restart rect equals its pre-restart rect (within 1px); the
  persisted preference document carries the same values; zero re-adjustment.
  **Edge:** set to min then restart; set to max then restart. **FAIL** = a size is not restored.

- [ ] **F-27 (AC5) — no text selection during drag.**
  Drag a divider across the SQL editor, tab labels and result cells; sample mid-drag and after
  release. **Expected:** `window.getSelection().isCollapsed === true` throughout the drag and after
  release; the mid-drag screenshot shows no selection highlight over any pane.
  **Edge:** drag starting over the editor; over a tab label; crossing the results grid.
  **FAIL** = any selected text or highlight.

- [ ] **F-28 (AC5) — clean release (pointer capture).**
  Release the pointer mid-drag; release while the pointer is outside the window; force a
  `pointercancel`. **Expected:** on pointerup/pointercancel further pointer moves do not resize;
  the element/`document` pointer listeners are gone; pointer capture is released; no stuck cursor; a
  subsequent drag works. **Edge:** release outside the window; `pointercancel`; two consecutive
  drags. **FAIL** = a stuck capture/listener/cursor.

- [ ] **F-29 (AC5) — resize cursor / affordance.**
  Hover each divider. **Expected:** computed `cursor` is `col-resize` on the two vertical dividers
  (S1/S2) and `row-resize` on the two horizontal dividers (S3/S4); the divider has a visible
  token-coloured affordance and a non-zero, hit-testable rect.
  **Edge:** hover vs idle; both themes. **FAIL** = no/incorrect cursor or an unhittable divider.

- [ ] **F-30 (NFR-1) — no re-render loop / console-clean.**
  Drag continuously for ~5 s, including rapid direction reversals.
  **Expected:** `tauri_read_logs(source="console")` shows no "Maximum update depth exceeded", no
  React key/act warnings, no unhandled errors; the drag is coalesced (no runaway re-render).
  **FAIL** = a re-render loop or console warning.

- [ ] **F-31 (NFR-2) — zero-warning build + unit pins.**
  Run `pnpm --filter @fredo/ui build` and `pnpm test`.
  **Expected:** build exits 0 with zero TS errors; vitest green, including the clamp-helper and
  tolerant-deserializer unit pins (**F-33**); `cargo check` only if a Rust file is touched.
  **FAIL** = any TS error or failing test.

- [ ] **F-32 (NFR-3) — theming-token-only.**
  Inspect the divider/layout source and rendered styles.
  **Expected:** no hex/rgba literals; no alpha-append on a `var()` (`var(--x)NN` forbidden); divider
  colours come from `border.*`/`bg.*`/`fg.*` tokens or the shared `tint()` helper; renders correctly
  in light AND dark theme (plus a user accent override). **FAIL** = a hardcoded colour.

- [ ] **F-33 (unit pins — NON-AC, G-300/G-275).** No live lever for a corrupt/out-of-range
  persisted size. Pin (a) the clamp helper (extend/reuse `clampPref`,
  `DatabaseClientSettings.tsx:27`): below min → min, above max → max, rounded in range, non-finite →
  fallback; and (b) the tolerant deserializer (`storage.ts` `parsePrefs`/`numberOr`): a corrupt /
  absent / out-of-range persisted layout loads the documented defaults instead of throwing (R-4.5).
  **Non-AC** — never contributes AC PASS. **FAIL** = the helper/deserializer throws or returns an
  out-of-range value.

## Suite-level pass/fail

PASS = F-1..F-12, F-14..F-33 all green, F-13 verified via F-19 (no longer recorded UNVERIFIED),
every NFR check holds, and the run carries a live `telemetry_spans` receipt + DOM/screenshot
evidence. Any user-visible app-identity "PostgreSQL"; a rendered header strip or empty gap; a
rendered `db-access-mode-badge`; a write executed on the read-only connection; an unreachable
Disconnect; a card narrower than its column; a split that does not move, collapses below its min,
exceeds its max, clips/overflows at an allowed size, or fails to restore after restart; text
selected during a drag or a stuck capture/listener/cursor; a re-render loop; a hardcoded colour or
alpha-append on a `var()`; or a static-only receipt = **FAIL**. UNVERIFIED rows (no reachable
lever) are not PASS — the verdict fails closed (G-033). **F-33 is a pin and never an AC FAIL row.**

## Run log

### Round 1 — 2026-10-13 (spec/3048 @ bc741d6) — Verdict: **PASS**

All cases PASS except **F-13** (UNVERIFIED-with-blocker #3049, per the plan).
Live `telemetry_spans` receipt: `SELECT count(*) AS telemetry_spans FROM telemetry_spans`
through the product's own SQL Studio session → **1863** (app-pool stat `telemetry_get_stats`
spanCount 1797). Disclosed deviations: **B-1** the plan's `qa-rw` form fixture is unreachable
(the form's Test-before-Save needs the keychain-only loopback password), so F-9 / F-6 read-write /
F-11 ≥2 / F-12 long-name used the documented `FREDO_DBCLIENT_STATE_DIR` seam with a hand-authored
`builtin:true` read-write connection; **B-2** the managed-`psql` read lever could not authenticate,
so the `telemetry_spans` receipt came through the product session + app-pool stat.
No new F- cases promoted (no confirmed exploratory defect).
