# headless-ingest — Exploratory

Feature: the headless ingest daemon (`fredo ingest`). Seeded at issue **#2992**. Unscripted probes
for edge/failure states. A confirmed finding **promotes** to `functional.md` as a new `F-` row
(keep the origin note). Never run an unbounded binary (G-263) — bound every probe.

## Prompts

- [ ] **E-1: start-time failure modes.** Force a start failure (corrupt/absent PG data dir,
  unwritable lock dir, occupied OTLP port) and observe the error shape and exit code.
  Does the daemon fail closed with a structured message within the bound, leaving no lock,
  descriptor, or orphan? Promote to F-1/F-3 if the failure is unbounded or unstructured.

- [ ] **E-2: shutdown-file races.** Create the shutdown file (a) before start, (b) immediately
  after start, (c) during an active ingest flush. Does every path drain, release the lock, and
  exit bounded? Any dropped/lost row? Promote if a row is lost or the bound is exceeded.

- [ ] **E-3: lock held by a non-postgres process / foreign lock dir.** Hold
  `<lock_dir>/postgres.lock` with another process and start the daemon; observe detection vs
  silent reuse. Promote if the message is unclear or a second postmaster starts.

- [ ] **E-4: descriptor tampering.** Rewrite the descriptor with a live but unrelated pid, a
  non-`fredo.exe` image, a closed port, and malformed JSON; boot the GUI at each. Confirm the
  fail-closed fallback and that no unrelated process is killed. Promote on any unsafe kill/attach.

- [ ] **E-5: control-plane contention.** Attach the GUI while the daemon is mid-write of
  `postgres_pid`; repeat rapidly. Watch for `SQLITE_BUSY`/lock errors or a stale credential.
  Promote to F-12 on a reproducible lock failure.

- [ ] **E-6: app-data-dir edge parity.** Set `FREDO_DATA_DIR` with a trailing separator, mixed
  case, and an empty string; compare daemon vs GUI resolution. Promote to F-11 on any mismatch.

- [ ] **E-7: registry robustness.** Enable, then delete the registry value out-of-band, then
  disable via the UI; enable twice; enable with the exe path containing spaces. Promote to F-8 on
  a non-idempotent/incorrect result.

- [ ] **E-8: orphan inventory after an induced crash.** Hard-kill the daemon (no graceful path);
  inventory `postgres.exe` and sockets. Does the next start's sweep reclaim the orphan? G-280:
  a `dev-env Down` orphan is environment, not a spec FAIL. Promote only if the daemon's own
  crash-recovery leaves a wedge.

- [ ] **E-9: run-ms self-terminate.** Start with `FREDO_INGEST_RUN_MS`; confirm bounded
  self-terminate with the same teardown guarantees as the file lever. Promote if teardown differs.
