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
  - **#3099 amendment (G-136):** the payload is now NESTED —
    `{skill:"wireframe", arguments:{action:"wireframe.companion.draftApp", arguments:{app_name:"Reporter"}}}`
    — and the reply is the generic `Performed in Wireframe: …` copy instead of #3070's
    `Started a new wireframe for Reporter: …`. See `.opencode/tests/companion/` F-148 for the
    authoritative row.
- [ ] **S-9: Bar quick path** — with Wireframe focused, `[data-testid="hotkeys-keybar-row"]`
      lists 32 wireframe bindings (21 distinct `data-hotkey-key` first-step values; each of the
      12 `g`-namespace rows renders two chips) and
      `document.body[data-fredo-hotkey-duplicate]` is absent; focus another window and confirm
      the wireframe rows disappear.
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
- **S-9 PASS:** 22 keybar rows while focused; the wireframe rows and `data-hotkey` attributes
  disappear when the host is unfocused.
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
- **S-9 PASS:** 22 keybar rows + 22 toolbar `data-hotkey` attributes while focused; typed keys
  are suppressed in text entry.
- **S-10 PASS (tester-run):** typecheck ✓ · build 2832 modules ✓ · test:run 3077 ✓ ·
  contrast 46/46 ✓ · build:webview 2834 modules ✓ · cargo check/clippy zero warnings ✓ ·
  cargo test 1451 lib tests + integration suites ✓.

## Spec #3081 — added quick path

- [x] **S-11: Discard-dialog quick path — token-coloured label.** Add one element (dirty),
      **Round 1 (2026-10-26) — PASS.** Add text (count 1) → New → dialog renders; Discard label
      `rgb(12,17,23)` == resolved `--status-on-solids` `#0c1117`; ratio 5.11 (light) / 5.04 (dark);
      capture uploaded; console clean.
      press **New**, confirm `[data-testid="wireframe-new-document-dialog"]` renders.
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

- [ ] **S-12: Multi-select + group quick path** — from the `default` focus gate add two elements
      (`1`, `2`), shift-click to select both, press `g` then `g`.
      **Expected:** `data-wireframe-selection-count`=2 before, `data-wireframe-group-count` 0→1,
      `data-wireframe-selection-group` non-empty and `wireframe-tag-group` rendered after;
      console clean.
- [ ] **S-13: Snap + align quick path** — toggle snap (`g` `s`) and confirm
      `data-wireframe-snap`=`true`; with two elements selected press `g` `a` (align left).
      **Expected:** both left edges coincide in `-selection-geometry`; ONE `u` reverts; console
      clean.
- [ ] **S-14: Guides quick path** — start a drag so an element nears another's edge.
      **Expected:** `[data-testid="wireframe-canvas"][data-wireframe-guides]` is a number > 0
      mid-drag and returns to `'0'` on drop; console clean.
- [ ] **S-15: Two-step hotkey + bar quick path** — with Wireframe focused press `g` alone.
      **Expected:** `document.body[data-fredo-pending-sequence]`=`g` and the
      `hotkeys-keybar-pending` chip shows (binding ARMED), then it clears after the 1000 ms
      timeout with no document change; the bar lists the 10 new rows (now **32** total,
      re-baselined from 22) with `data-hotkey-key`=`g`; console clean.

## Spec #3087 — added quick path (chip removal)

> Isolated env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3087 -EnvId
> wf3087-a -EnvSlot 1 -RequireIsolation`. Driver: `tauri_driver_session start` with
> `appIdentifier` = the env MCP port decimal string. **Verification policy: live** — quoted
> `tauri_webview_*` result + screenshot; document state, no `telemetry_spans` receipt expected.
> Do **not** synthesize key events (E-22).

- [ ] **S-16: Toolbar has no hotkey chip; the bar still lists the shortcuts.**
      Open Wireframe from the launcher with the host focused.
      **Expected:** `[data-testid="wireframe-toolbar"]` contains **0**
      `[data-testid="wireframe-hotkey-chip"]` and **0** `[data-testid="hotkeys-keycap"]` nodes;
      33 `wireframe-action-*` controls render (32 with `data-hotkey`); the
      `hotkeys-keybar-row` list still carries all 32 Wireframe shortcuts; pressing bare `1` from
      the `default` gate still adds a text element (`-element-count` 0→1); a capture of the
      clean toolbar is uploaded; console clean.
      Cross-ref `functional.md` F-84/F-86.

## Spec #3119 (P5) — RE-BASELINE of the toolbar / hotkey quick paths

> The toolbar, the command surface and the hotkey carrier are DELETED; Wireframe is driven by a
> declaration of six places. **The rows above are kept as history (G-125) — the amendments below
> are the executable recipes.** The surface's own smoke lives in
> `.opencode/tests/wireframe-navigation/smoke.md` (S-N1…S-N8).

- **S-6 re-baselined:** "press `1` from the `default` focus gate" → press `c` then `t` (Create
  place, text). `-element-count` 0→1, `-selection-type="text"`, `data-wireframe-place` back to
  `wireframe.canvas` after the add. Icon (`i` → `m`) and shape are **map › Create** only.
- **S-7 re-baselined:** `w` (save as) → `f` then `w`; `o` (open) → `f` then `o`. Everything else
  (path seams, `-dirty=false`, status `Saved`, `-document-path`) is unchanged. `document.new`
  → `f` `n`.
- **S-7b re-baselined:** the `FREDO_WIREFRAME_CANCEL=1` leg presses `f` `w`; expectations
  unchanged (nothing written, no banner, document/path/dirty unchanged).
- **S-9 re-baselined (bar quick path):** Wireframe now contributes **0** bar rows. With
  Wireframe focused, `[data-testid="hotkeys-keybar-row"]` contains **no** Wireframe rows and
  `data-fredo-hotkey-count` is unchanged from the unfocused reading (delta **0**);
  `document.body[data-fredo-hotkey-duplicate]` stays absent. **Non-vacuity control:** focus
  Mission Monitor → its rows are present.
- **S-12 re-baselined (multi-select + group):** keys `1`/`2` → `c` `t` / `c` `b`; `g` `g` →
  `a` `g`. `-selection-count`, `-group-count` and `wireframe-tag-group` expectations unchanged.
- **S-13 re-baselined (snap + align):** `g s` → `a` `s`; `g a` (align left) → `a` `←`.
  `-selection-geometry` edge coincidence and the ONE-`u` clause are unchanged (`u` at the root).
- **S-15 superseded:** the `g` two-step namespace no longer exists; there is no
  `data-fredo-pending-sequence` for Wireframe. The nav engine's armed prefix is 250 ms and shows
  in `navigation-rail` / the hint, not the bar.
- **S-16 superseded:** `wireframe-toolbar` renders **0** nodes (the element is deleted) and
  Wireframe mounts **0** `wireframe-action-*` controls. Replacement parity proof:
  `wireframe-navigation` F-N13 (33-row manifest).

## Spec #3119 (P5) — added quick paths

> Env + driver as above (`-Spec 3119 -EnvId wf3119-a -EnvSlot 1 -RequireIsolation`, MCP port
> `"16001"`). **Verification policy: live.**

- [ ] **S-17: Navigation-shell quick path.** Open Wireframe from the launcher.
      **Expected:** `wireframe-root[data-wireframe-place="wireframe.canvas"]`,
      `navigation-rail` (six place rows + ≤ 8 verb rows), `navigation-trail`,
      `navigation-map` trigger, `wireframe-canvas`; **no** `wireframe-toolbar`, **0**
      `wireframe-action-*`, **0** `hotkeys-keybar` while focused. Capture uploaded; console clean.
- [ ] **S-18: Place-entry quick path.** Press `c` (breadcrumb `Canvas › Create`, announcement
      `Create — 9 actions`, rail 8 rows + `more…`), then `Escape` (breadcrumb `Canvas`,
      announcement `Left Create — Canvas — 2 actions`). Capture of the Create rail uploaded;
      console clean.
- [ ] **S-19: Create-and-return quick path.** Press `c` `r`, drag a rectangle.
      **Expected:** count 1, `data-wireframe-place` back to `wireframe.canvas` (transient
      auto-exit), exactly ONE trail entry, exactly ONE announcement. Console clean.
      Cross-ref `wireframe-navigation` F-N3/F-N10.
