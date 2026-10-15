# pg-auth-recovery — Exploratory

Unscripted edge/failure probes for the embedded-PostgreSQL `AuthMismatch` recovery banner and the
`WHILE Failed` log-flood back-off (issue #3067 and its following slices). A confirmed finding
**promotes** to `functional.md` as a new `F-` row (keep the origin note). The Tester adds probes below
beyond the script.

> **Verification policy: live** — probes observe a running app/supervisor under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); the named failure mode
> is the #2948 ~11 h `pg.stop()` hang. Never an unbounded run.

## Prompt lines

- [ ] **E-1:** What does the banner do if the supervisor flaps `failed`/`authMismatch` → `starting` →
  `failed` within one poll interval — does it flicker, or does the bounded poll settle? Is the
  appearance announced once (aria-live) or repeatedly?
- [ ] **E-2:** Does the poll keep running (and the banner stay accurate) when the app is left open for
  several minutes in `Failed`, and does it stop cleanly with no leaked interval after `Down`?
- [ ] **E-3:** With TWO webviews open on the same app, do both render the same banner state, and does
  confirming reset in one clear it in the other within one poll interval (backend-global snapshot)?
- [ ] **E-4:** Does a reset invoked while the supervisor is `attached` (headless daemon owns the data
  dir) return `ok:false` with a clear `-reset-error`, and leave the state unchanged?
- [ ] **E-5:** If the forced/real auth mismatch is present at boot, is the fail-closed engine's
  `engine not ready` family the ONLY flood, or do other unrelated errors also repeat unthrottled?
- [ ] **E-6:** Does a DISTINCT storage error (not the engine-not-ready family) still emit at full rate
  while `Failed` — i.e. is the back-off keyed per-site rather than globally coalesced?
- [ ] **E-7:** After a successful recovery, does a subsequent re-entry into `Failed`/`authMismatch`
  re-arm the back-off from the base interval (schedule reset), or does it resume from the cap?
- [ ] **E-8:** Does the banner survive a live theme switch (light ↔ dark) with correct tokens, and
  does its text remain legible (no colour-alone signalling)?
- [ ] **E-9:** If `pg_supervisor_status` returns a `failureKind` the frontend does not know (a future
  kind), does `classifySupervisorStatus` degrade to `unavailable` (banner absent) rather than crash?
- [ ] **E-10:** On a healthy `ready` cluster with the lever unset, is the app-log window free of
  `engine not ready` lines (the non-vacuous control for F-5)?
