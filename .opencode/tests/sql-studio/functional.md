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

- [ ] **F-13 (R-5 / Q-5.3) — column-width-change edge (UNVERIFIED, blocker #3049).**
  Attempt to drive a connections-column width change.
  **Expected:** no in-app resize control exists this round — the column is FIXED at
  `DatabaseClientFeature.tsx:266` (`width="300px"`, `flexShrink={0}`); record this sub-edge as
  **UNVERIFIED-with-named-blocker #3049**, NOT a FAIL. Re-check when #3049 lands.
  **FAIL** is NOT assignable to this row; it is recorded UNVERIFIED.

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

## Suite-level pass/fail

PASS = F-1..F-12 and F-14..F-18 all green, every NFR check holds, F-13 recorded
UNVERIFIED-with-blocker (#3049), and the run carries a live `telemetry_spans` receipt +
DOM/screenshot evidence. Any user-visible app-identity "PostgreSQL"; a rendered header strip or
empty gap; a rendered `db-access-mode-badge`; a write executed on the read-only connection; an
unreachable Disconnect; a card narrower than its column; or a static-only receipt = **FAIL**.
UNVERIFIED rows (no reachable lever) are not PASS — the verdict fails closed (G-033).

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
