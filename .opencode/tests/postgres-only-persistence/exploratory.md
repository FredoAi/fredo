# postgres-only-persistence — Exploratory

Unscripted edge/failure probes for the PostgreSQL-only domain (spec #3005). A confirmed finding
**promotes** to `functional.md` as a new `F-` row (keep the origin note). The Tester adds probes below
beyond the script.

> **Verification policy: live** — probes observe a running app / boot under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); never an unbounded run.
> **Induction levers:** `FREDO_PG_PASSWORD_FILE` (sentinel), `FREDO_PG_KEYCHAIN_DISABLED` (fallback),
> `FREDO_DATA_DIR` (isolated app-data under `.opencode/tmp/3005/`).

## Prompt lines

- [ ] **E-1:** What happens when the PostgreSQL pool cannot be reached at cold start now that SQLite is
  gone — does the app fail closed with a structured error (never a `.db` fallback), and does
  `storage_engine_status.ready` stay `false` with a reason?
- [ ] **E-2:** Does a `cached_set` issued before `hydrate` completes get flushed exactly once (no lost
  write, no duplicate row) across a restart?
- [ ] **E-3:** Is `boot-config.json` written atomically (no torn/empty file on a crash mid-write), and
  what does a corrupt/absent file do — cleared marker (absent/empty ⇒ cleared) with a fresh PID?
- [ ] **E-4:** On keychain unavailable (`FREDO_PG_KEYCHAIN_DISABLED`) does the GUI fall back to
  `fredo-loopback-fallback` WITHOUT writing it anywhere, and does a later keychain-available boot
  re-resolve consistently?
- [ ] **E-5:** With a legacy SQLite file AND a stale settings cache present, does the app still boot on
  PG and leave the legacy file byte-identical?
- [ ] **E-6:** Does the occurrence gate flag a denied token in an unexpected class (e.g. a `.md` under
  `docs/` vs `.opencode/tests/**`), and never flag a legitimate `historic-narrative` mention?
- [ ] **E-7 (console):** `tauri_read_logs(source="console")` after every probe — any `Error:` /
  `Uncaught` / `Maximum update depth exceeded` is a defect invalidating that leg's evidence.
