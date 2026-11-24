# resident-shell — Exploratory Tests

> Unscripted edge/failure probes for the resident shell (#3192). A confirmed finding here
> **promotes** to `functional.md` as a new `F-` row (keep the origin note). Every probe states its
> induction lever; a probe with no lever is recorded as a named blocker, never improvised.

## E-1 — tray unavailable ⇒ close exits (R-2d)

- [ ] **E-1:** Probe the "shell refuses the tray" state. **Lever:** none ships in this slice — the
  only proof available is the unit pin RT-5 (`ResidentShellState::default().tray_installed() ==
  false`; `ExitRequested{code:None}` prevents exit ONLY when true). Record the unit output and the
  code path; do NOT invent a `FREDO_*` seam. A live leg needs a test-only seam (QA-4).

## E-2 — the guard is per-environment, not global

> **Status (round 2): legitimate NAMED BLOCKER — non-binding probe, not a FAIL.** A second environment
> needs a second `dev-env` env (its own cluster, ports and pipe) while the round's evidence is
> attributed to the ONE leased env (`<env-root>/evidence.json`), so a second env's observations are
> not attributable to this issue's round. No AC row depends on this probe. Drive it only if a second
> env is already up; otherwise record the blocker and move on. The probe text below stays as the
> durable recipe for a multi-env round.

- [ ] **E-2:** With env A resident, boot env B
  (`powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3192 -EnvId spec3192-b -EnvSlot <n>`).
  Probe both `app_lifecycle_status` and both window lists. **Expected:** BOTH apps stay resident and
  each reports only its own `main` window; neither is refused/focused by the other — the
  single-instance key is the per-env IPC pipe (`FREDO_CLI_PIPE`), so the supported multi-env workflow
  is intact. A global refusal here is a FAIL (it would break multi-env).
  **Lever:** distinct `-EnvId`/`-EnvSlot` → distinct pipe/ports/data dir.

## E-3 — quit during an in-flight turn

> **Status (round 2): fold OPPORTUNISTICALLY.** If F-5/F-3 already leaves a terminal session live when
> `quit_app` runs, this probe costs nothing extra and must be recorded; if no session is live at quit
> time, do not spend a separate close/quit cycle on it — disclose the fold. The postmaster leg rides
> the F-3 probe (`-Action Postmaster -PgDataDir <pre-quit pg_supervisor_status.dataDir>`), so a
> `POSTMASTER_COUNT=0` here is evidence only next to `PG_DATA_DIR_EXISTS=True`.

- [ ] **E-3:** Start a terminal session on a long-running command
  (`spawn_terminal_session`), confirm `get_pty_buffer{sessionId}` returns bytes, then `invoke('quit_app')`.
  **Expected:** quit completes within the bounded window; `fredo.exe` gone; the PTY child is gone (no
  orphan under the former app PID); the postmaster PID is gone; `process-hygiene.ps1 -List` reports
  no orphan for this run. A surviving PTY child is a finding (record its PID + parent).

## E-4 — second launch while the window is destroyed

- [ ] **E-4:** Destroy `main` (F-1a), then run `second-launch.ps1`. **Expected:** the SECOND process
  exits 0 and the FIRST instance recreates + focuses `main` (the AC4 edge). Confirm with the window
  list and `app_lifecycle_status.mainWindowOpen === true` afterwards.

## E-5 — rebuild in flight (idempotence)

- [ ] **E-5:** From `terminal`, fire `open_main_window` twice with no wait between. **Expected:** one
  `main` window in the list, `recreated` true only on the first call, no duplicate/stacked window, no
  console error. Two `Open` menu activations must never stack a second `main`.

## E-6 — close/reopen during a live capture

- [ ] **E-6:** Start an OTLP injection loop (repeat `inject-otlp-fixture.ts` with distinct prefixes),
  close `main` mid-flight, reopen. **Expected:** every injected span lands exactly once (no dupes, no
  losses), the reopened window renders, no panic in `telemetry_logs` (query `level='ERROR'` around
  the window), and ingestion continues after the reopen.

## E-7 — stale / malformed persisted workspace

- [ ] **E-7:** Seed `Fredo_layout_zones` with (a) `version: 2`, (b) a layout with zero zones, (c) an
  assignment naming `no-such-window`, (d) `enabled:false`. Reopen `main` each time.
  **Expected:** the store stays on its clean default or degrades gracefully
  (`parsePersistedZoneLayout` drops bad layouts, keeps unknown windowIds as degraded placeholders);
  `main` still restores; no crash; the empty/degraded state is visible, never a blank surface.

## E-8 — Doom Mode survives a main-window destroy (Rust-owned transient)

> **Status (round 2): legitimate NAMED BLOCKER — non-binding probe, not a FAIL.** Doom Mode needs its
> separate native engine process and level assets, which this round does not boot; no AC row depends
> on this probe (`R-6b`'s AC observable is the persisted WORKSPACE, driven by F-6b/E-7). If a Doom
> window is already live, drive it; otherwise record the blocker.

- [ ] **E-8:** `enter_doom_mode`, destroy `main`, reopen, `invoke('get_doom_mode_status')`.
  **Expected:** still `active`; the reopened UI re-seeds from the Rust state (no restart). This is the
  stronger variant of R-6b (state the app owns, not the webview).

## E-9 — subscription residual (observation, not an AC)

> **Status (round 2): legitimate NAMED BLOCKER — non-binding OBSERVATION, never a FAIL.** Paste
> whatever the surface reports if it is reachable in the round's existing close/reopen cycles; if it
> is not, record the blocker. No AC row depends on it and it must never fail the round.

- [ ] **E-9:** Close + reopen `main` N times (N >= 3) and record whatever the app exposes about live
  query registrations (`telemetry_get_stats` / the RTDB subscription count) before and after.
  **Expected:** monotonic small growth, attributed to the documented residual (a destroyed webview
  never calls `unsubscribe_events`; `infrastructure/rtdb/subscriptions.rs` has no per-webview purge).
  This is an OBSERVATION for the backlog — the row-pipeline change is out of this slice; do NOT FAIL
  the round on it, but DO paste the numbers.

## E-10 — window list after quit

- [ ] **E-10:** After `quit_app`, re-run `tauri_manage_window(action="list")` and
  `tauri_driver_session start`. **Expected:** both fail cleanly (the bridge is gone) — a graceful
  disconnect, not a hang. Record the exact error text; a hang >30 s is a finding (boundedness).
