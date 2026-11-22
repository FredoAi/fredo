# postgres-cluster-permission — Smoke

Feature: cluster-directory permission recovery in the embedded-PostgreSQL supervisor (issue
**#3188**, revises **#3180** — do not reopen). Short first-run pair: boot-and-ready, then the
armed-seam typed failure. Full detail lives in `functional.md`.

> **Verification policy: LIVE.** The live receipt is the quoted `pg_supervisor_status` payload (and,
> for S-2, the rendered `[data-testid="health-line-postgres"]` read). A static-only PASS is a FALSE
> PASS. **Evidence record:** the POSTED timeline comment, never a `.opencode/tmp/3188/` draft
> (**G-415**). No image file extensions in prose (**G-104**); an evidence frame is named only as an
> uploaded `https://github.com/user-attachments/...` URL.
>
> **G-263 SAFETY / G-451.** Start and stop ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up … -TimeoutSecs 600` / `-Action Down`,
> with the executing tool's window ≥ 660,000 ms. Every boot is bounded; a call that ends at a phase
> marker with no `ready` line is a CUT to re-drive, not a hang. One isolated env (`-EnvId 3188a`,
> `-RequireIsolation`), ONE `Up` at a time, `-Action Down` between cases.

## Smoke cases

- [ ] **S-1: Boot and ready.** With an EMPTY `<scratch>/leg-a/postgres/cluster` pre-created, run the
  G-449 pre-flight and boot with `FREDO_PG_DATA_DIR=<scratch>/leg-a/postgres/cluster` +
  `FREDO_PG_INSTALL_DIR=<env-root>/postgres-install`.
  **Expected:** a non-empty `<body>` (`tauri_webview_dom_snapshot(type="structure")`); then
  `pg_supervisor_status` reads `state:"ready"`, `dataDir` equal to the override path verbatim,
  `port`/`pid` populated, `failureKind` null; exactly one EMPTY `cluster.rejected-*` sibling exists
  under `<scratch>/leg-a/postgres/`; elapsed within the declared bounds.
- [ ] **S-2: Armed seam yields the typed failure.** On a FRESH EMPTY
  `<scratch>/leg-b/postgres/cluster`, boot with `FREDO_PG_CLUSTER_PERMISSION_FAIL=1` (+ the same
  data/install dirs).
  **Expected:** `pg_supervisor_status` reads `state:"failed"`, `failureKind:"dataDirPermissionDenied"`
  EXACTLY (never `null`/`unknown`), `error` non-empty and `[setup]`-tagged with the remedy words,
  `port`/`pid` null; the fixture is still present and still EMPTY; NO `cluster.rejected-*` sibling;
  the focused `[data-testid="health-line-postgres"]` row reads `data-health-state="down"` and carries
  the cause + remedy.
- [ ] **S-3: No console errors.** `tauri_read_logs(source="console", lines=50)` shows no `Error:` /
  `Uncaught` / `Maximum update depth exceeded` during S-1 and S-2.

## Smoke-level pass/fail

PASS = S-1, S-2 and S-3 green. FAIL = S-1 not `ready`, no vacate sibling, S-2 not
`dataDirPermissionDenied`/created a sibling, an unbounded wait, or a stale seam carried between
cases.
