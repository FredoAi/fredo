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

> Seeded at triage for Spec #3198. Quick paths only; full assertions live in the named
> `functional.md` rows.

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
- [ ] S-8: **V2 install quick path** — `fredo setup --install-plugin --no-restart-service` against
      the shipped `apps/opencode-plugin/dist/index.js` (build it if absent). The opt-out is the safe
      form on this host: a real write would otherwise restart this pipeline's own shared service
      (G-461). EXPECTED: exit 0; one `[fredo]` line naming `…\.config\opencode\plugins\fredo.js` and
      "global"; the installed hash equals the dist hash; the skipped-restart message follows.
      Full assertions F-14/F-15/F-17(b3).
- [ ] S-9: **Capture quick path** — copy the external lever to
      `.opencode/tmp/3198/`, run it with marker `FREDO_QA_3198_R2D` and
      `-OtlpEndpoint http://localhost:<env ingest_grpc_port>`, then resolve the session by the
      marker and count its rows. EXPECTED: ≥1 `telemetry_spans` row for that session (the lever
      hosts its own server — disclosed pre-existing-service gap). Full assertions F-17(a).
- [ ] S-10: **Restart-failure quick path (R-2e)** — seed the destination with different bytes, delete
      the fixture's default journal `%TEMP%\fredo-3198-shim-journal.txt`, then run the fake control
      CLI through the forwarder:
      `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Cli -ShimDir
      .opencode/tests/setup/fixtures/shim-opencode-service-fail -Args "--install-plugin"`.
      EXPECTED: **exit 1**; the journal holds one `service restart`; the rendered failure message
      names the child's own detail and `opencode service restart`; `fredo.js` is still on disk
      (hash = `dist/index.js`); and in the same app process the `otel` step is **`error`** — never
      `ok`, never `missing`, never `restart_required`. Full assertions F-17(c)/F-16.
