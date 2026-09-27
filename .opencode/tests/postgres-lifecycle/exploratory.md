# postgres-lifecycle — Exploratory

Unscripted edge/failure probes for the embedded-PostgreSQL lifecycle supervisor (issue #2974 and
its following slices). A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep
the origin note). The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running supervisor/app under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); the named failure
> mode is the #2948 ~11 h `pg.stop()` hang. Never an unbounded run.

## Prompt lines

- [ ] **E-1:** What happens when a second Fredo instance starts while a postmaster already owns the
  data dir? Does it attach, refuse with a clear error, or corrupt the data dir (open question
  §10.6)? A second postmaster on one data dir is corruption.
- [ ] **E-2:** Does a data-dir wipe leave the KV marker pointing at a now-reused PID, and does the
  sweep stay on the safe no-kill path when the reused PID is an unrelated live process?
- [ ] **E-3:** If the release profile were set to `panic = "abort"`, is the startup sweep truly the
  sole recovery — i.e. does an abort-orphaned postmaster get reclaimed on the next start with no
  manual intervention?
- [ ] **E-4:** Does the crate-spawned postmaster flash a console window on GUI launch (open
  question §10.3), and is `CREATE_NO_WINDOW`/log redirection achievable or a documented divergence?
- [ ] **E-5:** What does the readiness probe do if the server accepts TCP but rejects auth, or
  accepts auth but the database is missing — does it fail closed with a structured error or retry
  to the cap?
- [ ] **E-6:** Does the exit hook run the bounded stop AFTER dependent stores stop writing (open
  question §10.4), or can a store write race the teardown?
- [ ] **E-7:** On repeated quit/relaunch cycles, does the PID marker always end cleared, and are
  there ever two `postgres.exe` images for one data dir?
- [ ] **E-8:** Does the sweep tolerate a marker written by a DIFFERENT app version/format (malformed
  text, whitespace, a hex PID) without killing anything and without erroring?
- [ ] **E-9:** During a crash (Task-Manager kill of the app) that orphans a postmaster, is the next
  start's sweep the observed recovery, and is the whole demonstration bounded?
- [ ] **E-10:** Does the ephemeral port change across restarts (no fixed-port leak), and does the
  app still connect to the new port on every leg?
