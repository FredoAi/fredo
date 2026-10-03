# multi-env-isolation — Exploratory

Unscripted edge/failure probes for the multiple-isolated-environments feature (#2944). A confirmed
finding **promotes** to `functional.md` as a new `F-` row (keep the origin note). The Tester adds
probes below beyond the script.

> **Verification policy: live** — probes observe running envs under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down via the `dev-env.ps1` lever; never an
> unbounded run.

## Prompt lines

- [ ] **E-1:** What happens when a third env C is started on the same machine — does it allocate
  disjoint ports, or does it collide with A/B? Does any env ever silently reuse another env's port?
- [ ] **E-2:** If an env's data dir is wiped while its app is down, does its next start recover
  cleanly without touching the other env's DB?
- [ ] **E-3:** Does a stale PID in env A's manifest that has been reused by an unrelated live
  process (e.g. a browser) ever get killed by A's sweep?
- [ ] **E-4:** Does a `dev-env.ps1 -Action Restart -EnvId A` while B is running disturb B's
  endpoints, PIDs, DB, or cache?
- [ ] **E-5:** What does `tauri_driver_session status` report with two envs connected — is the
  default-app selection deterministic, and is every call still `appIdentifier`-resolved?
- [ ] **E-6:** Does a crash/hard-kill of env A leave its own manifest consistent for the next
  start's sweep, without leaving a marker that points at B?
- [ ] **E-7:** Do two envs writing the SAME session id concurrently interleave in any shared
  write-behind cache or lock, or are they fully separated per env?
- [ ] **E-8:** Does the `fredo` CLI resolve to the intended env's endpoint/pipe when both envs are
  running, or is there a default-env ambiguity?
- [ ] **E-9:** Does the evidence audit reject a record whose fields are individually valid but
  whose DB path and checkout path belong to different envs?
- [ ] **E-10:** Is every env's start/stop bounded when the other env holds a shared resource
  (e.g. a lock), or can one env's boot hang unbounded on the other?
