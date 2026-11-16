# postgres-connection-headroom — Exploratory

Unscripted edge/failure probes for the embedded-PostgreSQL connection-headroom domain (issue
#3028). A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin
note). The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running supervisor/app under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever). Never an unbounded
> run. Named read lever: `.opencode/skills/telemetry-query/telemetry-query.ps1` (managed `psql`,
> database `postgres`); port from `pg_supervisor_status`/manifest `ports.pg` (G-307); password from
> the OS keychain (`fredo.postgres` / `loopback:password`) or `FREDO_PG_PASSWORD_FILE`. App-pool
> fallback (`telemetry_get_stats` / `feature_data_read`) if `psql` is refused — DISCLOSE it.

## Prompt lines

- [ ] **E-1:** Hold exactly `pool-cap` connections, then hold one more — at what `S` does the
  refusal appear, and is it exactly the structured `FATAL: sorry, too many clients already` (no
  hang, no partial connect)?
- [ ] **E-2:** Saturation during a live agent session — does ingest keep landing rows/spans while
  every server slot is held, or does the pool block? Time the first blocked store read.
- [ ] **E-3:** Open the built-in PG app's saved connections up to `MAX_OPEN_CONNECTIONS` while the
  app pool is at cap — does the server admit them all, and which client is refused first when the
  server runs out?
- [ ] **E-4:** Change the server limit, Apply/restart (postgres-config surface) — does the new
  value take effect live, and does the pool cap stay 8 across the restart?
- [ ] **E-5:** Kill a held `psql` session (Task Manager / `Cancel` the bounded command) — is the
  backend reaped promptly, and does a churn loop of connect/disconnect leak slots over time?
- [ ] **E-6:** Pin a PG port (postgres-config surface) near a held-connection storm — does the
  loopback-only bind hold and does the port never collide with 4317/4318/9223?
- [ ] **E-7:** Scan the PG log + `telemetry_logs` for the loopback password / connection string
  after a saturated session — is anything captured in cleartext?
- [ ] **E-8:** With the headless daemon owning the cluster (headless-ingest surface), can a second
  GUI client + `psql` both connect within the same budget, and is the same `S` in effect?
- [ ] **E-9:** Re-run the saturation immediately after an app restart — is the headroom identical
  (no per-boot drift), and does a stale `postmaster.pid`/orphan change admission?
- [ ] **E-10:** Set the server limit to a large value in an override data dir — does the app still
  boot bounded, and does the memory footprint stay within the desktop profile?
