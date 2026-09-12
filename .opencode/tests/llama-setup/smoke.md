# Llama Setup — Smoke

> Standardized smoke checks for the guided llama.cpp setup wizard domain (seeded at Spec #2855).
> Short, high-signal: app boots + the Companion settings / wizard surface is reachable. Evidence:
> `tauri_webview_dom_snapshot` / `tauri_webview_screenshot` / `tauri_read_logs(source="console")`.
> **Verification policy: live.**

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] S-3: Feature surface reachable — open Settings (gear) → Companion; the section renders (either the llama setup wizard on a not-set-up machine, or the normal companion controls on a set-up machine).
- [x] S-4: Telemetry Settings accessible — the settings dialog opens with its sections/nav visible.
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2855/e2e/smoke.jpeg")` succeeds.
- [x] S-6: Wizard quick path — on a not-set-up machine the wizard shows both prerequisite rows (`llama-server` + model files) with a per-row state, and no normal companion controls are rendered.

## Execution Log — round 1 (2026-09-11, spec/2855 @ c5c29c42)

All six smoke checks PASS live. S-1 body non-empty; S-2 console clean (only pre-existing
`motion() is deprecated` warning) checked after every interaction; S-3 gear → Companion renders
the wizard (MS-3: llama missing / models installed); S-4 settings nav visible; S-5
`.opencode/tmp/2855/e2e/*.jpeg` captured; S-6 `companion-step-llama-server` +
`companion-step-model-files` rendered with per-row state, `companion-controls` query = 0.

## Execution Log — round 2 (2026-09-11, spec/2855 @ b7cc2d13 / e735e92)

All six smoke checks PASS live again after the winget-id fix. S-1 body non-empty; S-2 console clean
after every interaction (only pre-existing `motion() is deprecated` warning); S-3 gear → Companion
renders the wizard on MS-3; S-4 settings nav visible; S-5 new round-2 screenshots under
`.opencode/tmp/2855/e2e/`; S-6 `companion-step-llama-server` + `companion-step-model-files` rendered
with per-row state, `companion-controls` query = 0.

**Round-2 note:** the real `Install llama.cpp` action now resolves + installs `ggml.llamacpp`
(round 1 failed with "No package found matching input criteria."). See functional F-08/F-14/F-17.

## #2856 — Smoke (three-file model acquisition)

> Quick sanity for the per-file download surface. Use the stub base URL + manifest override;
> never a real multi-GB download.

- [x] S-7: On a not-ready machine, the Companion model step renders THREE file rows, each with its
      own icon+text status ("Missing"), and the step summary reads incomplete.
- [x] S-8: Start acquisition against the injected stub manifest + server; the in-flight row enters `downloading` and
      a progress affordance renders (determinate or indeterminate); no console `Error:`/`Uncaught`.
- [x] S-9: Screenshot the three-file model step —
      `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2856/e2e/model-step.jpeg")`
      succeeds.

## Execution Log — round 1 (2026-09-11, spec/2856 @ 0f3f3595)

Real wizard-driven pull (superseding the stub methodology per the binding human directive). S-7
PASS (3 rows, all `Missing`, summary `0 of 3`, step `data-state=incomplete`); S-8 PASS (real
`download_model` → `downloading` with determinate progress, no console errors); S-9 PASS
(screenshots captured under `.opencode/tmp/2856/e2e/` and uploaded to
`.opencode/evidence/2856/`). Console clean after every interaction (only the pre-existing
`motion() is deprecated` warning).

## Execution Log — round 2 (2026-09-12, spec/2856 @ 1bef0ef5)

Real wizard-driven round (human directive). S-7 PASS (mixed state: `model` Missing + detail
`Incomplete — 1304074347 of 2620370976 bytes`, `vision`/`mtp` Present with resolved paths; step
`2 of 3 present`; summary names the interrupted file). S-8 PASS (resume click → `model` entered
`downloading` with determinate `Progress.Root` (`data-value`, `aria-valuetext`); vision/mtp
`skipped`; no console errors). S-9 PASS (screenshots under `.opencode/tmp/2856/e2e/`, uploaded to
`.opencode/evidence/2856/`). Console clean after every leg (only pre-existing `motion()` warning).
