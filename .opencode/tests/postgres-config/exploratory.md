# postgres-config — Exploratory

Unscripted edge/failure probes for the embedded-PostgreSQL configuration-editing domain (issue
#3022). A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).
The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running supervisor/app under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever). Never an unbounded
> run. Named induction seams: `FREDO_PG_DATA_DIR` / `FREDO_PG_LOCK_DIR` / `FREDO_PG_INSTALL_DIR`
> (state dir under `.opencode/tmp/3022/`), `FREDO_PG_PASSWORD_FILE` (drift), `FREDO_PG_KEYCHAIN_DISABLED`.

## Prompt lines

- [ ] **E-1:** Apply a change while the cluster is still `starting` — does the pane disable, queue,
  or race the boot? Is there any window where two postmasters target one data dir?
- [ ] **E-2:** Apply a password and a port change together in one Apply — are both persisted, and if
  the restart fails (collision) is BOTH the prior port AND the prior password retained?
- [ ] **E-3:** Kill the app (Task Manager) mid-Apply during a restart — on the next boot is the
  cluster `ready` on the prior config, and is no orphan/duplicate postmaster left?
- [ ] **E-4:** Set a password containing quotes, a backslash, or a newline — does it apply without
  breaking the SQL, and is it rejected cleanly if unsupported?
- [ ] **E-5:** Pin the SAME port that the ephemeral server currently holds, then release it — does
  apply succeed once free, and fail closed again if it is re-bound?
- [ ] **E-6:** Reset database while the keychain is unavailable (`FREDO_PG_KEYCHAIN_DISABLED`) — does
  it re-init with the documented fallback and warn WITHOUT the value?
- [ ] **E-7:** Set the highest verbosity, apply, and drive a live session — does the postmaster log
  ever capture the `ALTER USER … PASSWORD …` statement in cleartext? Scan for the sentinel.
- [ ] **E-8:** Change port → apply → change back to default (OS-assigned) → apply — does the
  OS-assigned mode restore correctly and change the port on each restart?
- [ ] **E-9:** Save the password, then read every IPC/config surface a consumer could call — is the
  cleartext ever returned to the frontend?
- [ ] **E-10:** Reset database on a large data dir — is the re-init bounded, and does the app stay
  usable (no hung pane) throughout?
