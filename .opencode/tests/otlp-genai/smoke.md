# otlp-genai - Smoke

Standard smoke checks adapted for a non-UI feature. No UI surface here - smoke verifies the app boots, the OTLP receiver is live, the adapter test suite runs, and telemetry-query works so functional cases can execute.

## App boot + pipeline sanity

- [ ] S-1: App window renders - `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors - `tauri_read_logs(source="console", lines=50)` shows no "Error:"/"Uncaught"/"Maximum update depth exceeded"
- [ ] S-3: OTLP gRPC receiver live - a telemetry-query SELECT over `telemetry_spans` returns rows (receiver + DB up)
- [ ] S-4: Adapter/ECE unit suite compiles and passes - `cargo test` in `apps/tauri/src-tauri` (adapter modules `opencode.rs` + `otlp.rs` + `contract_633.rs` + `contract_633_ac6c.rs` + `contract/` + `telemetry/`) exits 0
- [ ] S-5: Rust builds clean - `cargo check` in `apps/tauri/src-tauri` is zero-warning
- [ ] S-6: Screenshot captured - `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds