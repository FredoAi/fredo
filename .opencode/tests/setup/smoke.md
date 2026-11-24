# setup — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the Fredo Setup surface.
> Runs on a running Fredo desktop app on `spec/3010`. **Verification policy: live.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Setup surface reachable — on boot NO Setup window auto-opens; the launcher tile `#fredo-launcher-grid [role="button"][aria-label="Fredo Setup"]` exists exactly once, and activating it opens `div[role="group"][aria-label="Fredo Setup"]` rendering `SetupWizard`.
- [ ] S-4: Settings→Fredo Setup reachable — open Settings; the `plugin-setup` nav item (label `Fredo Setup`) renders `<SetupWizard/>`.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3010/e2e/smoke.jpeg")` succeeds.
- [ ] S-6: Live receipt — `telemetry_spans` non-zero with a recent timestamp from the env's `ports.pg` (the live-policy gate; a static-only PASS is a FALSE PASS).

## #3198 — set of quick paths

> Seeded at triage for Spec #3198, **re-cut in round 3** with the install-time restart removed: the
> quick paths no longer name `--no-restart-service`, a restart outcome or `restart_required`. Quick
> paths only; full assertions live in the named `functional.md` rows.

- [ ] S-7: **V1 gate quick path** — boot the 1.x fixture through the committed forwarder (it
      prepends the fixture dir and drops every PATH entry that resolves an `opencode.*`; QA adds no
      `.exe` fixture — full LEVER note in `functional.md` F-9):
      `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Up -ShimDir
      .opencode/tests/setup/fixtures/shim-opencode-1x -Spec 3198 -EnvId spec3198 -EnvSlot <n>
      -RequireIsolation`, then open the Setup surface. EXPECTED: the payload's `binary_path` /
      plan `in_path` resolves INSIDE the fixture directory and the gate shows an ERROR naming the
      found version and `opencode upgrade` + `fredo setup --check` (and **no** `--major`);
      a `binary_path` outside the fixture dir is a FAILED DRIVE (round-1 L-1), not a product FAIL.
      No success state, no plugin write. Full assertions F-9/F-13.
- [ ] S-8: **V2 install quick path** — `fredo setup --install-plugin` (**no flag**: the
      install-time restart was removed in round 3, so the write is safe on a machine whose shared
      service hosts this pipeline) against the shipped `apps/opencode-plugin/dist/index.js` (build it
      if absent). Record the shared service's port owner (`opencode service status` →
      `([uri]$url).Port` → `Get-NetTCPConnection -LocalPort <port> -State Listen | Select
      OwningProcess`) **before and after**. EXPECTED: exit 0; one `[fredo]` line naming
      `…\.config\opencode\plugins\fredo.js` and "global"; the installed hash equals the dist hash;
      the destination `LastWriteTime` ≥ the run start (the install-instant stamp); **no**
      restart/skip line of any kind; the shared service pid **unchanged** — a changed pid is a
      FAILED DRIVE (`product still restarts the shared service`), never a PASS.
      Full assertions F-14/F-15/F-17(b).
- [ ] S-9: **Capture quick path** — copy the external lever to
      `.opencode/tmp/3198/`, run it with marker `FREDO_QA_3198_R2D` and
      `-OtlpEndpoint http://localhost:<env ingest_grpc_port>`, then resolve the session by the
      marker and count its rows. EXPECTED: ≥1 `telemetry_spans` row for that session (the lever
      hosts its own server — disclosed pre-existing-service gap). Full assertions F-17(a).
- [ ] S-10: **No-restart quick path (round-3 replacement for the deleted restart-failure path)**
      — seed the destination with different bytes, delete the fixture journal, then run the fake
      control CLI through the forwarder:
      `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Cli -ShimDir
      .opencode/tests/setup/fixtures/shim-opencode-service-ok -Args "--install-plugin"`.
      EXPECTED: **exit 0**; the journal is **absent or empty — zero lines** (the product dispatches
      no `service restart` at all); the output is exactly one `PLUGIN_INSTALLED_GLOBAL_MSG` line;
      `fredo.js` matches `dist/index.js`; and in the app `check_all_setup`'s `otel` step is **`ok`**
      with the mechanism detail — never a restart outcome, never `missing`, never
      `restart_required`. Full assertions F-17(b)/F-16.
