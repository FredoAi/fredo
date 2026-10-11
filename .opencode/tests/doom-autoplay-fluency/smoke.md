# doom-autoplay-fluency — Smoke Test Cases (Spec #3026)

> Standardized app-boots + core-path sanity boilerplate (adapted to the Doom fluency surface).
> Runs on this feature's testing phase.
>
> **Verification policy: live** — the smoke receipt includes the `telemetry_spans` live-pipeline
> reference (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed
> `psql` on the PG default as a DISCLOSED fallback, G-284). **Doom emits NO OTLP span — the check
> proves the pipeline, not the feature; DISCLOSE.** A static-only smoke cannot pass.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3 (Doom core path) **Doom window opens + paints live frames** — activate via `iddqd` from a fresh pre-feature state; the `doom` window opens (game-only: `doom-root` + `doom-frame-canvas` + `doom-frame-desc`); the canvas paints live, DISTINCT frames (seam-driven; never a static redelivery); the process inventory shows only `fredo.exe` (native in-process engine).
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3026/e2e/smoke.jpeg")` succeeds.
- [ ] S-6 (quick teardown) **Close-teardown quick path** — close the `doom` window natively (`plugin:window|close {label:"doom"}`): `doom-mode-changed {active:false}`; the autoplay phase is not `Running`; process inventory shows only `fredo.exe` and no new listener.
- [ ] S-7 (live-pipeline receipt) **`telemetry_spans` non-zero** with a recent `max(ingested_at)` (app-pool read; managed-`psql` fallback DISCLOSED).
- [ ] S-8 (PG-default boot) `storage_engine_status` = PostgreSQL / PG supervisor ready.
- [ ] S-9 **Mission Monitor still renders** live sessions with the fluency change present (the E2E gate row).
- [ ] S-10 (CI-parity) **Build hygiene** — `cargo check --locked` ZERO warnings; `cargo test --locked` green; `cargo clippy --locked -- -D warnings` clean; `pnpm --filter @fredo/ui build` green (UI frame transport touched).
- [ ] S-11 (determinism quick path) **ST-9 driver green** — `cargo test --locked` exercises `run_bounded_driver` (`applications/doom/engine.rs:583`) with the scripted source; the bounded run completes deterministically.
