# opencode-plugin - Smoke

Standard smoke checks adapted for a non-UI feature. This feature has NO UI surface (the plugin is a backend emitter) - the smoke set below checks the host app boots, the plugin builds, and the OTLP pipeline is reachable so functional cases can run.

## Host boot + pipeline sanity

- [ ] S-1: App window renders - `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors - `tauri_read_logs(source="console", lines=50)` shows no "Error:"/"Uncaught"/"Maximum update depth exceeded"
- [ ] S-3: OTLP gRPC receiver reachable - a telemetry-query SELECT over `telemetry_spans` returns rows (proves the receiver and DB are live before functional cases run)
- [ ] S-4: Plugin build passes - `bun build` in `apps/opencode-plugin` exits 0
- [ ] S-5: Plugin typecheck passes - `tsc --noEmit` in `apps/opencode-plugin` exits 0
- [ ] S-6: Screenshot captured - `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds

## Spec #3197 additions (V2 build → install → currency, before any live leg)

- [ ] S-7: plugin build passes at the spec tip - `pnpm --filter @fredo/fredo-opencode-plugin build`
  exits 0 and `apps/opencode-plugin/dist/index.js` exists and is non-trivial in size
- [ ] S-8: plugin typecheck passes - `pnpm --filter @fredo/fredo-opencode-plugin typecheck` exits 0
- [ ] S-9: plugin installed through the NATIVE path (Setup → SetupWizard / `install_plugin`, never a
  filesystem copy) and currency proven - `Get-FileHash ~\.config\opencode\plugins\fredo.js` equals
  `Get-FileHash apps\opencode-plugin\dist\index.js` (never Grep the `~` path)
- [ ] S-10: isolated env up and ports resolved - `dev-env.ps1 -Action Up -Spec 3197 -EnvId <lease
  envId> -EnvSlot <slot> -RequireIsolation`, then `manifest.json` yields non-zero `ports.otlpGrpc`
  and `ports.pg` (G-307 re-resolve if 0); record both in the verdict