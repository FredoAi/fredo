# mission-monitor - Smoke

Standard smoke checks for the Mission Monitor surface (frontend UI + the OTLP
delivery pipeline it consumes).

- [ ] S-1: App window renders - `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors - `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Mission Monitor reachable - toolbar opens the feature; ReactFlow canvas renders (`.react-flow` present)
- [ ] S-4: OTLP gRPC receiver live - a telemetry-query SELECT over `telemetry_spans` returns rows (receiver + DB up)
- [ ] S-5: Adapter/ECE unit suite passes - `cargo test` on the comm modules exits 0
- [ ] S-6: Frontend builds - `pnpm --filter @fredo/ui build` exits 0
- [ ] S-7: Screenshot captured - `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds

## Spec #2449 additions (re-open of #2218)

- [ ] S-8: custom-event matcher unit passes - contract.test.ts includes a passing isCustomEventDelivery case (AC4)

## Spec #2694 additions (reading-order flip, auto-focus, token badge)

- [ ] S-9: flipped chain renders on boot - open Mission Monitor with a replayed ≥3-node session; PASS if nodes render oldest-at-top with downward edges and no console errors
- [ ] S-10: token badge states render - replay a session mixing turns with usage and a sentinel turn; PASS if numbers / dashes / `tokens n/a` all render without a crash
