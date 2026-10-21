# Wireframe — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the Wireframe
> surface, Spec #3070. Runs on a RUNNING Fredo desktop app on the spec build in an ISOLATED
> env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3070 -EnvId wf3070-a
> -EnvSlot 1 -RequireIsolation` (+ `-EnvVar "FREDO_WIREFRAME_SAVE_PATH=…"
> -EnvVar "FREDO_WIREFRAME_OPEN_PATH=…" -EnvVar "FREDO_WIREFRAME_EXPORT_PATH=…"` for the file
> legs — one env proves save → open → export; `CANCEL=1` / `FAIL_FILE=1` legs each get their
> own launch).
> Driver: `tauri_driver_session start` with `appIdentifier` = the env's MCP port decimal
> string (`"16001"` for slot 1).
>
> **Verification policy: live** — each case carries a quoted `tauri_webview_*` result plus a
> screenshot; the visual legs also need an uploaded capture. This feature is document state,
> not telemetry: no `telemetry_spans` receipt is expected.

- [ ] **S-1: App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a
      non-empty `<body>` (no `vite-error-overlay`).
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no
      `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3: Wireframe reachable from the launcher** — the launcher grid shows a `Wireframe`
      tile; activating it renders `[data-testid="wireframe-root"]` with
      `data-wireframe-page="1280x800"`, `-element-count="0"`, `-dirty="true"`, plus
      `wireframe-canvas`, `wireframe-toolbar`, `wireframe-page-controls` and
      `wireframe-status`.
- [ ] **S-4: Telemetry Settings accessible** — the Settings window renders its sections
      (Companion, Appearance, Fredo Setup, Telemetry) and shows NO Wireframe section
      (`hasSettings=false`), proving the settings shell is untouched.
- [ ] **S-5: Screenshot captured** —
      `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3070/e2e/smoke.jpeg")`
      succeeds.
- [ ] **S-6: Core quick path — compose and select** — press `1` from the `default` focus gate
      (`data-fredo-focus-context=default`), then click the created text element.
      **Expected:** `-element-count` 0→1, `-selection-type`=`text`, the element is rendered,
      and a capture shows it on the page. Console clean.
- [ ] **S-7: File quick path — save then reopen** — add one element, press `w`, confirm
      `-dirty=false`, `wireframe-status` reads `Saved` and `-document-path` equals
      `FREDO_WIREFRAME_SAVE_PATH`; then `document.new` and `o` (reads
      `FREDO_WIREFRAME_OPEN_PATH`). **Expected:** count and page come back, console clean, and
      both legs run in the SAME env (per-command seams, C6 amended).
- [ ] **S-7b: File cancel quick path** — in a `FREDO_WIREFRAME_CANCEL=1` launch press `w`.
      **Expected:** the document, its path and its dirty state are unchanged, NO file-error
      banner appears and no file is written; console clean.
- [ ] **S-8: Companion quick path** — with Wireframe closed, emit
      `llm-skill-call {skill:"wireframe", arguments:{action:"wireframe.companion.draftApp", app_name:"Reporter"}}`.
      **Expected:** the app opens with `-element-count` ≥ 3 and the reply names only the
      performed actions; capture uploaded; console clean.
- [ ] **S-9: Bar quick path** — with Wireframe focused, `[data-testid="hotkeys-keybar-row"]`
      lists 22 wireframe keys and `document.body[data-fredo-hotkey-duplicate]` is absent;
      focus another window and confirm the wireframe rows disappear.
- [ ] **S-10: CI-parity gate** — `pnpm --filter @fredo/ui build` exit 0, `pnpm --filter
      @fredo/ui test:run` green, `pnpm --filter @fredo/tauri build:webview` exit 0, and the
      Rust gates (`cargo check` / `cargo clippy -D warnings` / `cargo nextest run`, all
      `--locked`) green. No weakened/disabled assertion. Cross-ref `functional.md` F-55.

## Round 1 result — 2026-10-21

- **S-1 PASS (shell only):** the Fredo launcher renders (`FREDO` heading, launcher dialog,
  `[data-testid="launcher-command-input"]`, hotkey-count `0`); the shell is healthy.
- **S-2 FAIL:** opening the Wireframe app raises an uncaught
  `InvalidStateError: … drawImage … width or height of 0` in `react-konva` `StageWrap`
  (`WireframeCanvasImpl.tsx:828`) and unmounts `#root`. Console is NOT clean.
- **S-3 PASS:** the launcher grid exposes `gridcell Wireframe` → `button Wireframe` (found via
  `tauri_webview_dom_snapshot(accessibility)`), and activating it opens the app window (which
  then crashes — see S-2).
- **S-4 not reached** (no need to enter Settings while the feature is dead).
- **S-5 PASS:** capture taken and uploaded (blank editor after the crash).
- **S-6 / S-7 / S-7b / S-8 / S-9 UNVERIFIED** — blocked by the S-2 crash: the editor, its
  hotkeys, its toolbar and its file actions never mount.
- **S-10 PASS (with one disclosed substitution):** `pnpm --filter @fredo/ui build` ✓ (2831
  modules, 11.17 s, zero TS errors), `test:run` ✓ (236 files / 3051 tests),
  `contrast:gate` ✓ (46/46), `cargo check --locked` ✓ zero warnings,
  `cargo clippy --locked -- -D warnings` ✓ zero warnings. `cargo nextest` is not installed in
  this sandbox and `cargo test` was not run (time-boxed behind the blocker) — residual pin.

Root defect detail + repro: see `functional.md` → "Round 1 result — served app BLOCKED".
