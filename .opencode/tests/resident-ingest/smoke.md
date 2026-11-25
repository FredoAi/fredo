# resident-ingest — Smoke

Feature: the ONE resident owner of the embedded PostgreSQL cluster and the OTLP receivers
(Spec #3194; supersedes the retired `headless-ingest/` suite). Short standardized sanity checks
before deeper testing. The feature's surface is the running desktop app plus its two receivers.

> **Verification policy: LIVE** — every row's receipt is a live read (`pg_supervisor_status`,
> `stream_health`, a `telemetry_spans` row, a DOM capture) or a bounded process/port observation.
> Static-only smoke cannot pass.

> **Isolation.** All rows run inside this issue's env (`-EnvId spec3194 -EnvSlot 1`); ports come
> from `<env-root>/manifest.json`. Never touch the machine-global 4317/4318 or the shared cluster.

## Cases

- [ ] **S-1: App window renders.** `dev-env.ps1 -Action Up` for the env, then
  `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>` with children (a
  fresh isolated boot can take 3–5 min to paint — wait it out, do not re-boot).
  **Expected:** non-empty body, no blank shell.

- [ ] **S-2: No console errors.** `tauri_read_logs(source="console", lines=50)` after boot.
  **Expected:** no `Error:` / `Uncaught` / `Maximum update depth exceeded`.

- [ ] **S-3: The resident app owns the cluster.** Status JS →
  `state:"ready"` with non-null `pid` and `port` and no `attached` key.
  **Expected:** ready + own pid/port; `owner-census.ps1 … -StatusJson <file>` exits 0 with
  `CENSUS=PASS`. (Was `headless-ingest/smoke.md` S-4 "headless daemon boots" — INVERTED: there is
  no second process.)

- [ ] **S-4: Both OTLP receivers are bound by the app.**
  `verify-env-isolation.ps1 -ManifestPath <m>` and the census binding clauses.
  **Expected:** `otlpGrpc` and `otlpHttp` both bound and owned by `CENSUS_APP_PID` (the app;
  NEVER `STATUS_PID`, which is the postmaster — `binder_is_app_pid_otlp_grpc` /
  `binder_is_app_pid_otlp_http`); exit 0.
  (Was `headless-ingest/smoke.md` S-1's listener clause — retargeted to the resident owner.)

- [ ] **S-5: A live span lands.** Inject one span (injector `--count 1 --prefix e2e-3194-<guid8>`)
  and read it back with its own CONFIRM SQL.
  **Expected:** exactly 1 row, `end_time_ns IS NOT NULL`, `ingested_at` newer than the
  pre-injection snapshot. (Was `smoke.md` S-7 — CONFIRMED, lever updated to the committed
  injector; `fredo emit` writes no spans, G-256.)

- [ ] **S-6: Quit is bounded and leaves nothing.** Quit via `quit_app` (the product's own path);
  time it; run `owner-census.ps1 -ExpectStopped -PgPort <the port S-3 printed>`.
  **Expected:** exit 0, `CENSUS=PASS`, PG port closed, both OTLP ports closed, no `postgres.exe`
  under the env root. (Was `smoke.md` S-6 "daemon stops bounded via the file lever" — INVERTED:
  the file lever no longer exists.)

- [ ] **S-7: Screenshot captured.**
  `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3194/e2e/smoke.jpeg")`.
  **Expected:** file written. (Was `smoke.md` S-5 — CONFIRMED.)

## Suite-level pass/fail

PASS = S-1…S-7 green. Any blank shell, console error, missing listener, absent live span row,
unbounded quit, or surviving postmaster = FAIL.
