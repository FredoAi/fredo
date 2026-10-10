# doom-native — Smoke Test Cases (Spec #3023)

> Standardized app-boots + core-path sanity boilerplate (adapted to the native Doom surface).
> Runs on this feature's testing phase.
>
> **Verification policy: live** — the smoke receipt includes the `telemetry_spans` live-pipeline
> reference (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed
> `psql` on the PG default as a DISCLOSED fallback, G-284). A static-only smoke cannot pass.
> **Doom emits NO OTLP span — the check proves the pipeline, not the feature; DISCLOSE.**
>
> **Native-engine scope:** the core-path smoke runs the REAL native in-process engine on the
> bundled `DOOM1.WAD`; a stub standing in for the engine is NOT a valid smoke engine
> (G-033/G-314), and a committed-but-never-run script is never a PASS.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3 (native engine) **Doom core path** — activate via `iddqd` from a fresh pre-feature state; the `doom` window opens (game-only: `doom-root` + `doom-frame-canvas` + `doom-frame-desc`); the canvas paints live pixels driven by a STEP; the process inventory shows ZERO separate engine image.
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3023/e2e/smoke.jpeg")` succeeds.
- [ ] S-6 (native engine) **Close-teardown quick path** — close the `doom` window natively (`plugin:window|close {label:"doom"}`): `doom-mode-changed {active:false}`; the process inventory shows zero engine image and the port check is clean.
- [ ] S-7 (live-pipeline receipt) **`telemetry_spans` non-zero** with a recent `max(ingested_at)` (app-pool read; managed-`psql` fallback DISCLOSED).
- [ ] S-8 (PG-default boot) `storage_engine_status` = PostgreSQL / PG supervisor ready (not SQLite).
- [ ] S-9 **Mission Monitor still renders** live sessions with the native-Doom feature present (the F-E2E gate row).
- [ ] S-10 (native, offline) **Fresh-install offline boot** — no network, no staged toolchain/engine: entering Doom Mode becomes playable via the native engine (no download, no from-source build). (AC4 gate; a stub/script is NOT a PASS.)
- [ ] S-11 (CI-parity) **Build hygiene** — `cargo check --locked` ZERO warnings; `cargo test --locked` green; `cargo clippy --locked -- -D warnings` clean; `pnpm --filter @fredo/ui build` green (if UI touched).
