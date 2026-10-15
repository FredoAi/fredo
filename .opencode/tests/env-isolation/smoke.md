# env-isolation — Smoke

Quick app-boot + core-path sanity for the dev/test-round isolation guard (#3066). Full detail
lives in `functional.md`.

> **Verification policy: LIVE** — a live receipt (`pg_supervisor_status` on a non-round
> legacy launch, a legacy `Up` readiness, or a process-table read) is required for a live
> verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** envs are started/stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -EnvId <id>`. Time-bound
> every leg; never run an unbounded binary. Never read the REAL shared dir (denied
> out-of-repo) — use the `FREDO_SHARED_APPDATA_DIR` fixture identity.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a
  non-empty `<body>` (on the AC4 observation launch, or the isolated env).
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no
  `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — the round's env root contains its `data` +
  `postgres` dirs and the app boots (isolated env) or the shared cluster boots to `ready`
  (AC4 observation).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with
  sections visible.
- [ ] **S-5:** Screenshot captured —
  `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/3066/e2e/smoke.jpeg")` succeeds.

## Isolation quick paths

- [ ] **S-6:** `-Lever SharedDirRefusal` reports `REFUSAL_EXITCODE=3`,
  `REFUSAL_MESSAGE_PRESENT=True`, `AUDIT_REFUSED=True`, `PG_SPAWNED=False`, `RESULT=PASS`.
- [ ] **S-7:** `-Lever SentinelRefusal` reports `SENTINEL_EXITCODE=3`,
  `SENTINEL_MESSAGE_PRESENT=True`, `AUDIT_SENTINEL=True`, `RESULT=PASS`.
- [ ] **S-8:** `-Lever IsolatedControl` reports `CONTROL_EXITCODE=0`, `AUDIT_ISOLATED=True`,
  `SEAMS_ALLOWED=True`, `RESULT=PASS` (keeps S-7 non-vacuous).
- [ ] **S-9:** `-Lever NoGlobalImageKill` reports `IMAGE_KILL_PRESENT=False`,
  `MANIFEST_TEARDOWN_PRESENT=True`, `IMAGE_GUARD_PRESENT=True`, `POSTGRES_SPAWNED=False`,
  `RESULT=PASS`.
- [ ] **S-10:** `-Lever SharedRootViolation` reports `VIOLATION_EXITCODE=1`,
  `SHARED_ROOT_VIOLATION_PRESENT=True`, `RESULT=PASS`.
- [ ] **S-11:** AC4 — after a completed round, a non-round legacy launch's
  `pg_supervisor_status` returns `state=="ready"` and `failureKind==null`.

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-11 green; S-4/S-5 green or a named blocker. Any shared-dir or
sentinel seam accepted, any refusal that proceeds/starts PG, a vacuous S-8 control, a global
image kill, a non-3 refusal exit, or a `authMismatch` on S-11 = **FAIL**.
