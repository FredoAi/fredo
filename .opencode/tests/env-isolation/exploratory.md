# env-isolation — Exploratory

Unscripted edge/failure probes for the dev/test-round isolation guard (#3066). A confirmed
finding **promotes** to `functional.md` as a new `F-` row (keep the origin note). The Tester
adds probes below beyond the script.

> **Verification policy: live** — probes observe a running app / process table under a finite
> timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down via the `dev-env.ps1` lever;
> never an unbounded run. Never read the REAL shared dir (`%APPDATA%\com.fredo.app`) — it is
> denied out-of-repo; use the `FREDO_SHARED_APPDATA_DIR` fixture identity.

## Prompt lines

- [ ] **E-1:** What happens when `FREDO_SHARED_APPDATA_DIR` itself is a path that does not
  exist, is relative, or is blank — does the guard fail closed or fall back to the default
  shared identity?
- [ ] **E-2:** Does a path that merely shares a string prefix with the shared dir
  (`…\com.fredo.app-other`) get falsely refused? (Must NOT.)
- [ ] **E-3:** Does a JUNCTION / symlink / 8.3 short name pointing at the fixture shared dir
  resolve to the same identity, or can a round escape the guard through it?
- [ ] **E-4:** With BOTH `FREDO_PG_PASSWORD_FILE` and `FREDO_PG_KEYCHAIN_DISABLED` set and the
  dir isolated, does `AssertIsolation` exit 0 (seams allowed)? Does the audit record list
  both seams?
- [ ] **E-5:** What does the guard do when `-RequireIsolation` is set AND env mode redirects
  to a legit env root — is there a double-refusal or a conflicting audit record?
- [ ] **E-6:** If the audit file `.opencode/state/env-isolation.jsonl` is deleted / truncated
  / made read-only mid-run, does the guard still fail closed (or does a write error let a
  round proceed)?
- [ ] **E-7:** Does a `dev-env.ps1 -Action Status` after a shared-root round surface the
  `is the SHARED cluster dir` violation through its `isolation` line?
- [ ] **E-8:** Can a round reach the shared dir through `-ServingCheckout` + a relative
  `FREDO_DATA_DIR`, or through `FREDO_PG_LOCK_DIR` alone (the lock dir is injected too)?
- [ ] **E-9:** After a refusal, is the audit line's `resolvedAppDataDir`/`resolvedPgDataDir`
  the ACTUAL resolved value (not the requested one) — does a `..` traversal get canonicalized
  before it is recorded?
- [ ] **E-10:** Does a legacy `Up` WITHOUT the marker but WITH a stray `FREDO_PG_PASSWORD_FILE`
  in the environment proceed (guard off) — and is that the intended boundary? (Confirm the
  seam is only refused when the guard is armed / env mode.)
- [ ] **E-11:** Does the env-scoped teardown ever enumerate port owners (which could kill a
  foreign process) rather than only manifest PIDs? (Lever: `-Lever NoGlobalImageKill`, then
  hand-inspect the Down path.)
- [ ] **E-12:** Does a refusal leave a partial lease (`env-leases/<Spec>.json`) or a partial
  manifest that a later round misreads?
