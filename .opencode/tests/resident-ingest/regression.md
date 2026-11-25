# resident-ingest — Regression

The "must not change" baseline for the single-owner refactor (Spec #3194). Every row here is a
property the spec must NOT disturb; the neighbouring suites it links own the detailed surface.
Supersedes `.opencode/tests/headless-ingest/regression.md` for the daemon-shaped rows (see
`retirement-ledger.md`).

> **Verification policy: LIVE** where the row names a runtime property; **static** rows are
> self-declared and are checked from committed source. The default-path rows run with every
> retired seam unset (there is nothing left to unset — that is the point).

## No-change baseline

- [ ] **R-1: the `pg_supervisor_status` wire shape is unchanged except the removals.**
  Read the status JS; list its keys.
  **Expected:** keys are `state, port, pid, error, dataDir, logPath, failureKind`; **no `attached`
  key** and `state ∈ {disabled, starting, ready, failed}`; `port`/`pid` are numbers while `ready`;
  `error` null while ready. (Was `headless-ingest/regression.md` R-1 → CONFIRMED with the removal
  clause; the removal itself is F-4(iii).)
  **FAIL:** a surviving `attached` key, a fifth state, or a renamed field (consumers break).

- [ ] **R-2: the stream-health wire stays additive and its three pinned strings stay byte-identical.**
  (i) read the probe + heartbeat in the healthy state and list their keys;
  (ii) the `degraded`-without-failure state via `FREDO_STREAM_HEALTH_FORCE=ingest-down`.
  **Expected:** (i) no `ingestFailure` key in the serialized payload when there is no failure
  (ABSENT KEY, never `null` — G-413), every pre-existing key still present with the same names;
  (ii) `health-line-telemetry` reads `Degraded` + `Telemetry stalled` with **no**
  `technicalDetail` node and the aria-label byte-identical to the shipped one
  (`stream-health/functional.md:54` behaviour, UI/UX U-5); `healthy` still reads `Healthy` +
  `Streaming`, `down` still reads `Down` + `Stream stopped`.
  **FAIL:** an explicit `null`, a renamed key, or any of the three pinned strings changed.
  **Edge:** the `ingestFailure` present/absent serialization is pinned at unit level too
  (G-413 producer side, ST-2's `health.rs` tests) — this row is the wire-side partner.

- [ ] **R-3: the other Postgres consumers do not regress.** Settings → Database still classifies a
  non-ready state as unavailable (`Database is not ready.`) and the database-client connection
  edit path still reads `port` from the same command. Walk both surfaces once.
  **Expected:** same copy and behaviour as `main`; no `attached` in either surface.
  Links: `postgres-config/`, `db-client-builtin/`.

- [ ] **R-4: the row pipeline is untouched.** `git diff origin/main <spec-branch> -- apps/tauri/src-tauri/src/infrastructure/rtdb`
  **Expected:** `health.rs` only (the additive `ingestFailure` slot + fields); classifier, merge
  rules, flush cadence, retention and `emit_row_delivery_batch` byte-identical.
  Links: `stream-health/`, `event-persistence/`, `mission-monitor/`.

- [ ] **R-5: boundedness is preserved (G-263).** Every start/stop/readiness/teardown wait in the
  touched paths keeps its finite bound; `PG_EXIT_HOOK_BOUND` and the synchronous hard-kill fallback
  still exist (`pg_supervisor/mod.rs`, `runtime::stop_bounded`).
  **Expected:** unchanged constants; no unbounded wait introduced by the deletion.

- [ ] **R-6: loopback-only binds.** The four env endpoints listen on `127.0.0.1` only.
  **Expected:** no `0.0.0.0` listener row for Vite/MCP/OTLP/PG.

- [ ] **R-7: the kept seams still work (G-296).** `FREDO_INGEST_GRPC_PORT` /
  `FREDO_INGEST_HTTP_PORT` remain the app's OWN receiver-port overrides; a caller value wins and a
  blank/unset value falls back to the default — **these two seams are KEPT** (they are the GUI's
  own ports, not the daemon's).
  **Expected:** set to two free ports → both receivers bind them (census names the ports); blank →
  defaults (4317/4318) or the env-derived values, unchanged from `main`.

- [ ] **R-8: the in-process spike stays present.** `apps/tauri/src-tauri/tests/spike_2989_headless_ingest.rs`
  still exists and is unchanged (G-281/G-290 forbid deleting it).
  **Expected:** file present; its content diff empty.

- [ ] **R-9: the retired corpus is gone and nothing still teaches it (the sweep's own row).**
  (i) `.opencode/tests/headless-ingest/` does not exist at the spec tip (the delegate is
  `retirement-ledger.md`, which carries the disposition of every former row);
  (ii) the committed fixture lives at `.opencode/tests/resident-ingest/fixtures/otlp-trace-chat.json`;
  (iii) a literal search of `.opencode/tests/**` for `fredo ingest` returns only ABSENCE
  assertions / ledger rows (each hit dispositioned — G-445: the row states the covered vocabulary
  `fredo ingest` and the uncovered remainder: a bare filename or a prose mention, which is
  searched separately per retired subject: `headless-ingest`, `--run-ms`, `--shutdown-file`,
  `headless-ingest.json`, `run_ingest_daemon`).
  **Expected:** (i) absent; (ii) present and the old path absent; (iii) every hit is an absence
  assertion or a disposition row, none presents the mode as available.
  **FAIL:** the folder surviving the round, a row still DRIVING the daemon, or an undispositioned
  prose hit.
  **Edge:** `background-capture/registry-entry.ps1` legitimately writes the legacy VALUE
  `"<exe>" ingest` (`-SeedLegacy`/`-SeedForeign`) — that is a stored value, not a command
  (allowlisted, F-10).

## Linked suites (overlapping surface — run their regression rows too)

- [ ] **L-1:** `.opencode/tests/postgres-lifecycle/` — bounded start/stop, orphan sweep
  (the supervisor surface the single owner still uses).
- [ ] **L-2:** `.opencode/tests/postgres-naming/` + `postgres-connection-headroom/` — database
  identity (`fredo`) and the `max_connections > pool cap` headroom.
- [ ] **L-3:** `.opencode/tests/resident-shell/` — the resident process/tray/quit-gate surface the
  AC5 leg depends on.
- [ ] **L-4:** `.opencode/tests/stream-health/` — the heartbeat/LED contract the typed failure
  rides on (its F-5 was re-cut by this spec: see the suite).
- [ ] **L-5:** `.opencode/tests/fredo-health-led/` — the LED rows and the composed label
  (U-8's live DOM absence assertion).
- [ ] **L-6:** `.opencode/tests/background-capture/` — the login entry and the retired-copy sweep.
- [ ] **L-7:** `.opencode/tests/fredo-cli/` — the CLI's `--help`/exit-code contract F-9 extends.

## Notes

- A second postmaster, a surviving sibling receiver, or a `healthy` read under a bound OTLP port is
  the defect this spec removes — never a "known" regression.
- G-280: an orphan `postgres.exe` left by an earlier `dev-env Down` is an environment artifact;
  report it with pid + start time, and only count processes whose command line names THIS env root.
