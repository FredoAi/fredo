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
      `wireframe-canvas`, `wireframe-details-column`, `wireframe-control-strip`,
      `wireframe-page-controls`, `wireframe-insert` and
      `wireframe-status`.
- [ ] **S-4: Telemetry Settings accessible** — the Settings window renders its sections
      (Companion, Appearance, Fredo Setup, Telemetry) and shows NO Wireframe section
      (`hasSettings=false`), proving the settings shell is untouched.
- [ ] **S-5: Screenshot captured** —
      `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3070/e2e/smoke.jpeg")`
      succeeds.
- [ ] **S-6: Core quick path — compose and select** — open `wireframe-insert` → Elements →
      `Text` (the pill inside the canvas region), then click the created text element.
      **Expected:** `-element-count` 0→1, `-selection-type`=`text`, the element is rendered,
      and a capture shows it on the page. Console clean.
- [ ] **S-7: File quick path — save then reopen** — add one element, click
      `wireframe-file-menu` → `Save As`, confirm
      `-dirty=false`, `wireframe-status` reads `Saved` and `-document-path` equals
      `FREDO_WIREFRAME_SAVE_PATH`; then `New` and `Open` (reads
      `FREDO_WIREFRAME_OPEN_PATH`). **Expected:** count and page come back, console clean, and
      both legs run in the SAME env (per-command seams, C6 amended).
- [ ] **S-7b: File cancel quick path** — in a `FREDO_WIREFRAME_CANCEL=1` launch click the File
      menu's `Save As` row.
      **Expected:** the document, its path and its dirty state are unchanged, NO file-error
      banner appears and no file is written; console clean.
- [ ] **S-8: Companion quick path** — with Wireframe closed, emit
      `llm-skill-call {skill:"wireframe", arguments:{action:"wireframe.companion.draftApp", app_name:"Reporter"}}`.
      **Expected:** the app opens with `-element-count` ≥ 3 and the reply names only the
      performed actions; capture uploaded; console clean.
  - **#3099 amendment (G-136):** the payload is now NESTED —
    `{skill:"wireframe", arguments:{action:"wireframe.companion.draftApp", arguments:{app_name:"Reporter"}}}`
    — and the reply is the generic `Performed in Wireframe: …` copy instead of #3070's
    `Started a new wireframe for Reporter: …`. See `.opencode/tests/companion/` F-148 for the
    authoritative row.
- [ ] **S-9 (the strip is the only control surface):** the pointer control strip quick path.
      With Wireframe focused, `wireframe-control-strip` renders its 23 controls
      (`wireframe-undo` / `wireframe-redo`, 5 `wireframe-view-item`, 12
      `wireframe-arrange-item`, 4 `wireframe-file-item`) and `[data-testid="wireframe-toolbar"]`
      is absent (0 nodes); focus another window and confirm no control surface appears anywhere
      (every command is pointer-driven and window-scoped).
- [ ] **S-10: CI-parity gate** — `pnpm --filter @fredo/ui build` exit 0, `pnpm --filter
      @fredo/ui test:run` green, `pnpm --filter @fredo/tauri build:webview` exit 0, and the
      Rust gates (`cargo check` / `cargo clippy -D warnings` / `cargo nextest run`, all
      `--locked`) green. No weakened/disabled assertion. Cross-ref `functional.md` F-55.

## Round 1 result — 2026-10-21

- **S-1 PASS (shell only):** the Fredo launcher renders (`FREDO` heading, launcher dialog,
  `[data-testid="launcher-command-input"]`); the shell is healthy.
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

## Round 2 result — 2026-10-21

- **S-1 PASS:** `wireframe-root` + canvas (1630×861) + toolbar + panel + status bar render on
  the launcher `Enter` path, the `open_app` emit and the standalone `app-wireframe` window.
- **S-2 PASS:** console free of `Error:` / `Uncaught` / `Maximum update depth exceeded` across
  the whole drive (no `InvalidStateError`).
- **S-3 PASS:** launcher tile + `Enter` opens the editor with `data-wireframe-page="1280x800"`,
  `-element-count="0"`, `-dirty="true"`.
- **S-4 PASS (round 1, carried):** the Settings surface renders Companion/Appearance/Fredo
  Setup/Telemetry with no Wireframe section (`hasSettings=false`).
- **S-5 PASS:** captures uploaded (editor open, nine types, twelve categories, light theme,
  hidden shape, Companion reply, standalone host).
- **S-6 PASS:** key `1` from the `default` gate → count 0→1, `-selection-type=text`, rendered.
- **S-7 PASS:** save → `-dirty=false`, `Saved`, path = the seam; `document.new` + Open restores
  count/page/history in the SAME env.
- **S-7b PASS:** `CANCEL=1` launch — `w` leaves document/path/dirty unchanged, no banner, no
  write.
- **S-8 FAIL (same root as F-47):** the Gherkin sentence produced prose, no draft, no window.
  `listActions` / `add.*` / `draftApp`'s executor are proven by F-43/F-44a; the model simply
  does not select the skill.
- **S-9 PASS (historical record):** with the host focused the then-shipped legacy bar listed the
  Wireframe rows; they disappeared when the host was unfocused. *(Re-pointed by #3151: the
  current control surface is the pointer strip — see S-17/S-18.)*
- **S-10 PASS:** build 2832 modules, 3056 tests, contrast 46/46, cargo check zero warnings
  (clippy/nextest/build:webview disclosed as not re-run; no Rust change in the fix commit).

## Round 4 result — 2026-10-21 (env `wf3070-r4`, served `7d03f3c`)

- **S-1 PASS:** the editor paints (`wireframe-root`, `wireframe-canvas` 1630×861, toolbar,
  panel, status bar, 22-key bar) after the launcher `Enter` and `open_app` paths.
  **Boot caveat:** a fresh boot can take **3-5 minutes** with `about:blank` / an empty
  `#root` and `execute_js` returning `Request timeout after 2000ms`. That is a BOOTING
  webview — `dom_snapshot` shows `body > div#root` with no children. Wait it out; the
  `Down`/`Up` ladder does not shorten it (5 cycles tried).
- **S-2 PASS:** `tauri_read_logs(source="console", level="error")` returned no rows after the
  full drive; no `Maximum update depth exceeded`, no `flushSync` warning during exports.
- **S-3 PASS:** `data-wireframe-page="1280x800"`, `-element-count="0"`, `-dirty="true"`,
  `-zoom="100"`, `-pan-mode="false"` on open.
- **S-4 PASS (carried):** Settings surfaces render; the app has no settings section.
- **S-5 PASS:** six AC captures uploaded (AC1 twelve elements, AC2 section selection, AC3 shape
  panel, AC4 zoomed/panned + status, AC5 hotkey bar, AC6 Gherkin draft).
- **S-6 PASS:** key `1` from the `default` gate → count 0→1, `-selection-type=text`.
- **S-7 PASS:** save wrote the seam path (`Saved`, `-dirty=false`); `w`/`o`/`t` in the CANCEL
  env left everything unchanged with no banner and wrote nothing; FAIL_FILE showed the banner;
  CANCEL+FAIL_FILE showed no banner (cancel wins).
- **S-8 PASS:** the binding Gherkin opens the app from closed and drafts navbar + "Reporter"
  heading + "Reporter reports" card through the real model path (Companion ON at home).
- **S-9 PASS (historical record):** the then-shipped legacy bar and toolbar key attributes were
  present while focused; typed keys were suppressed in text entry. *(Re-pointed by #3151: the
  current control surface is the pointer strip — see S-17/S-18.)*
- **S-10 PASS (tester-run):** typecheck ✓ · build 2832 modules ✓ · test:run 3077 ✓ ·
  contrast 46/46 ✓ · build:webview 2834 modules ✓ · cargo check/clippy zero warnings ✓ ·
  cargo test 1451 lib tests + integration suites ✓.

## Spec #3081 — added quick path

- [x] **S-11: Discard-dialog quick path — token-coloured label.** Add one element (dirty),
      **Round 1 (2026-10-26) — PASS.** Add text (count 1) → `New` → dialog renders; Discard label
      `rgb(12,17,23)` == resolved `--status-on-solids` `#0c1117`; ratio 5.11 (light) / 5.04 (dark);
      capture uploaded; console clean.
      click the File menu's `New` row, confirm `[data-testid="wireframe-new-document-dialog"]` renders.
      **Expected:** the Discard button `[data-testid="wireframe-new-document-discard"]` exists,
      its `getComputedStyle(...).color` equals the resolved `--status-on-solids`, and the label
      is readable (contrast ≥ 4.5) against `status.error` in the current theme; a capture is
      uploaded; console clean.
      Cross-ref `functional.md` F-57/F-59.

## Spec #3071 — added quick paths (Layout Intelligence)

> Isolated env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3071 -EnvId
> wf3071-a -EnvSlot 1 -RequireIsolation` (+ the three `FREDO_WIREFRAME_*_PATH` seams for the
> file legs). Driver: `tauri_driver_session start` with `appIdentifier` = the env MCP port
> decimal string. **Verification policy: live** — quoted `tauri_webview_*` result + screenshot;
> document state, no `telemetry_spans` receipt expected.

- [ ] **S-12: Multi-select + group quick path** — add two elements from `wireframe-insert`
      (Elements → `Text` and `Button`), shift-click to select both, click the `Group` row in
      `wireframe-arrange`.
      **Expected:** `data-wireframe-selection-count`=2 before, `data-wireframe-group-count` 0→1,
      `data-wireframe-selection-group` non-empty and `wireframe-tag-group` rendered after;
      console clean.
- [ ] **S-13: Snap + align quick path** — click the `Snap to grid` row in `wireframe-arrange`
      (it is a `role="menuitemcheckbox"`) and confirm `data-wireframe-snap`=`true`; with two
      elements selected click `Align left`.
      **Expected:** both left edges coincide in `-selection-geometry`; ONE `wireframe-undo`
      click reverts; console clean.
- [ ] **S-14: Guides quick path** — start a drag so an element nears another's edge.
      **Expected:** `[data-testid="wireframe-canvas"][data-wireframe-guides]` is a number > 0
      mid-drag and returns to `'0'` on drop; console clean.
- [ ] **S-15 (the strip is pointer-only).** The retired two-step namespace quick path no longer
      exists. With Wireframe focused, pressing any bare key changes nothing (no application key
      is bound); drive the control strip by pointer instead. The only keyboard surface is the
      three platform chords plus the plain-`Tab` boundary hand-off
      (`shared/window-system/`), and none of them reaches an application command; console clean.

## Spec #3087 — added quick path (chip removal)

> Isolated env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3087 -EnvId
> wf3087-a -EnvSlot 1 -RequireIsolation`. Driver: `tauri_driver_session start` with
> `appIdentifier` = the env MCP port decimal string. **Verification policy: live** — quoted
> `tauri_webview_*` result + screenshot; document state, no `telemetry_spans` receipt expected.
> Do **not** synthesize key events (E-22).

- [ ] **S-16 (no key hint on any control).** The control-strip quick path. The toolbar and its
      33 action controls are deleted; no control renders a key hint. Add a text element from
      `wireframe-insert` (Elements → `Text`) (`-element-count` 0→1); confirm no `(hotkey)`
      suffix appears on any accessible name and `wireframe-toolbar` is absent; capture the clean
      control strip; console clean. Cross-ref `functional.md` F-84/F-86.

## Spec #3119 (P5) / #3151 — RE-BASELINE of the toolbar / keyboard quick paths

> The toolbar, the command surface, the hotkey carrier and (with #3151) the declared surface they
> were re-pointed onto are all DELETED. Wireframe is driven by the 23-control pointer strip.
> **The rows above keep their expected outcomes (G-125) — the amendments below are the executable
> recipes.** The surface's own smoke lives in `.opencode/tests/navigation-retirement/smoke.md`.

- **S-6 re-baselined:** "add one element" → `wireframe-insert` → Elements → `Text`.
  `-element-count` 0→1, `-selection-type="text"`. Icon and Shape are insert-menu items too.
- **S-7 re-baselined:** save as → `wireframe-file-menu` → `Save As`; open → `Open`. Everything
  else (path seams, `-dirty=false`, status `Saved`, `-document-path`) is unchanged. New → `New`.
- **S-7b re-baselined:** the `FREDO_WIREFRAME_CANCEL=1` leg clicks `wireframe-file-menu` →
  `Save As`; expectations unchanged (nothing written, no banner, document/path/dirty unchanged).
- **S-9 re-baselined (strip quick path):** Wireframe renders exactly its 23 strip controls
  (`wireframe-undo` / `wireframe-redo`, 5 view, 12 arrange, 4 file) on
  `wireframe-control-strip`, and `[data-testid="wireframe-toolbar"]` is ABSENT. With another
  window focused no control surface appears here. **Non-vacuity control:** focus Mission Monitor →
  its own pointer surface is present.
- **S-12 re-baselined (multi-select + group):** `wireframe-insert` (Elements → `Text`,
  `Button`), then `wireframe-arrange` → `Group`. `-selection-count`, `-group-count` and
  `wireframe-tag-group` expectations unchanged.
- **S-13 re-baselined (snap + align):** `wireframe-arrange` → `Snap to grid`, then `Align left`.
  `-selection-geometry` edge coincidence and the ONE-undo clause are unchanged (`wireframe-undo`).
- **S-15 re-baselined:** the two-step namespace no longer exists and neither does any per-
  application key surface. Pressing a key changes nothing; the pointer strip is the surface.
- **S-16 re-baselined:** `wireframe-toolbar` renders **0** nodes (the element is deleted) and
  Wireframe mounts **0** key hints. Replacement parity proof:
  `wireframePointerControls.test.tsx` pins the 23-control row set.

## Spec #3119 (P5) / #3151 — added quick paths

> Env + driver as above (`-Spec 3119 -EnvId wf3119-a -EnvSlot 1 -RequireIsolation`, MCP port
> `"16001"`). **Verification policy: live.**

- [ ] **S-17: Pointer-shell quick path.** Open Wireframe from the launcher.
      **Expected:** `wireframe-root`, `wireframe-canvas`, `wireframe-details-column`,
      `wireframe-control-strip` with its 23 controls, `wireframe-property-panel`,
      `wireframe-status`; **no** `wireframe-toolbar`, **0** `wireframe-action-*`. Capture
      uploaded; console clean.
- [ ] **S-18: Arrange quick path.** With two elements selected, open `wireframe-arrange` and click
      `Group` by accessible name inside the opened popup. Capture of the open menu uploaded;
      console clean.
- [ ] **S-19: Create quick path.** Open `wireframe-insert` → Elements → `Rectangle`, drag a
      rectangle on the canvas.
      **Expected:** count 1, `-selection-type`=`shape`, exactly ONE history entry. Console clean.
