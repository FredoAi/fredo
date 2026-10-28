# application-data — Smoke

Standard app-boots + core-path sanity for the application-data storage layer (issue #3075). The
spec's OWN core path is the static unit suite + the gated PG integration binary (see `functional.md`);
these smoke rows confirm the app still boots and the store command surface is reachable after the
identifier-hardening change.

> **Verification policy: static** for the spec's ACs; the smoke rows below are the standard app-boot
> checks (adapted) and are the only rows that touch the running app.

- [ ] **S-1: App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] **S-3: Store command surface reachable** — invoke `application_store_query` with a VALID payload
  (an existing app/table, `order_by: null`) → returns rows (no error). Then invoke it with an injection
  payload (`order_by: "id; DROP TABLE x"`) → returns the typed `IdentifierError` string, and the table
  still exists. (A thin wrapper over `query`; the rejection is also pinned statically in `functional.md`.)
- [ ] **S-4: Settings accessible** — gear/nav opens the settings dialog with sections visible
  (confirms the `settings` table / `SettingsStore` rename did not break the control plane).
- [ ] **S-5: Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3075/e2e/smoke.jpeg")` succeeds.

## Build-gate quick path

- [ ] **S-6: `cargo check` zero warnings** (from `apps/tauri/src-tauri/`) and **`cargo nextest run` green**
  — the spec's primary gate (REQ-5.2).
- [ ] **S-7: `FREDO_TEST_PG=1 cargo test --locked --test storage_engine_pg` green** — the gated
  in-process embedded-PostgreSQL suite (bounded start/stop; never a bare `postgres`/`pg_ctl`).
