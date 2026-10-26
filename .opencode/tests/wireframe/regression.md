# Wireframe — Regression

> "Must not change" baseline for the **Wireframe** domain, first seeded at Spec #3070
> (Slice 1). Run on every testing phase that touches the hotkey element model, the launcher
> app registry, the Companion skill registry, the theme contract, or the settings shell.
>
> **Verification policy: live.** Each row carries a live webview receipt + an uploaded capture
> (document state, not telemetry — no `telemetry_spans` receipt is expected for this feature).
> A static-only PASS fails closed.

## Must NOT change

- [ ] **R-1 (hotkey duplicate guard — the highest-risk regression).** The shipped
      `data-hotkey` model keys duplicate detection off the FIRST step
      (`hotkeyElements.ts:132-146`) and throws `DuplicateHotkeyError` in DEV, so any overlap
      crash-loops the whole webview.
      **Expected:** `document.body[data-fredo-hotkey-duplicate]` is absent and
      `[data-testid="hotkeys-duplicate-error"]` is absent with Wireframe focused, unfocused,
      and alongside Mission Monitor + Diagram + My Work Items + Optimizely + Dev Mode; the
      extended `featureHotkeyKeys.test.ts` pins the toolbar file's 22 keys and a 36-key union
      with no duplicate; the shipped 14-key set (`s d r a z j f q e c i x b v`) resolves
      exactly as before; Mission Monitor `n`/`p` and Diagram `f` are still NOT mounted
      (`featureHotkeyKeys.test.ts:96-106` assertion unchanged).
      Cross-ref `.opencode/tests/hotkeys/` R-39/R-40/R-42 (one engine, one action table,
      no double-fire).
- [ ] **R-2 (pre-existing bare-key dispatch).** With the Wireframe app CLOSED, every shipped
      element hotkey still fires on its own app's control (Mission Monitor `s`, My Work Items
      `r`/`a`/`z`/`j`, Optimizely `f`/`q`/`e`/`c`, Dev Mode `x`/`v`/`i`/`b`) and text-entry
      suppression still passes characters through verbatim.
      Cross-ref `.opencode/tests/hotkeys/` F-96/F-97/F-99 and `regression.md` R-43/R-44.
- [ ] **R-3 (bar contract).** `hotkeys-keybar` / `hotkeys-keybar-list` /
      `hotkeys-keybar-row` keep their `data-hotkey-key` / `data-hotkey-action` /
      `data-hotkey-availability` semantics; the bar is still non-focusable and
      `aria-hidden`, `document.activeElement` is never changed by it, and it hides when
      `data-fredo-hotkey-count` is `0`. The wireframe rows are ADDITIVE.
      Cross-ref `.opencode/tests/hotkeys/` F-106/F-107.
- [ ] **R-4 (launcher grid).** The launcher shows the `Wireframe` tile via the eager glob
      (`allApplications.ts:5`) with NO `Home.tsx`/registry edit; the tile set equals
      `SHOWABLE_FEATURES` names + Wireframe; `dedupeByApplicationId` first-wins still holds;
      query filter, arrow-key nav (clamp, no wrap), Enter/Space open and every other tile's
      `aria-label` are unchanged.
      Cross-ref `.opencode/tests/launcher/` R-33/R-36/R-7 and `.opencode/tests/app-icon/`.
- [ ] **R-5 (Companion skills).** `open_app`, `close_app`, `doom_mode` behave identically with
      the wireframe skill registered: the registry is additive
      (`with_app_control_doom_and_wireframe`), the offer order is
      `open_app, close_app, doom_mode, wireframe`, exactly one `llm-skill-call` listener per
      skill, and the existing replies/copy are unchanged. The wireframe catalog has no dead
      id: all 25 declared actions are invocable through the same `llm-skill-call` path (F-43,
      F-44a–F-44c); a declared-but-unreachable id is a FAIL.
      Cross-ref `.opencode/tests/companion/` R-50..R-52 and `.opencode/tests/doom-mode/`.
- [ ] **R-6 (theme contract).** No hardcoded hex/`rgba(`/`hsla(` and no `var(--x)NN`
      alpha-append enters the new files; `allowlist.ts` gains no entry; Konva colours resolve
      from theme CSS vars at paint time and re-resolve on preset/accent change.
      Cross-ref `.opencode/tests/theming/` R-7 and `.opencode/tests/theme-contract/`.
- [ ] **R-7 (settings shell).** `SettingsSurface.tsx` is not edited; `hasSettings=false` for
      Wireframe so no settings nav item/section appears; the sibling sections (Companion,
      Appearance, Fredo Setup, Telemetry) are functionally unchanged.
      Cross-ref `.opencode/tests/settings/` R-11/R-12 and `.opencode/tests/companion/` R-31/R-32.
- [ ] **R-8 (persistence medium).** The document is a FILE — no `application_store_*` row, no
      settings KV, no RTDB row is written for canvas/document state. A DB-row assertion for
      AC4 is invalid; the only writes are the per-command file seams
      (`FREDO_WIREFRAME_SAVE_PATH` / `_OPEN_PATH` / `_EXPORT_PATH`, falling back to the shared
      `FREDO_WIREFRAME_FILE_PATH`), each of which writes only its own artefact — the export
      must never land on the document path. `FREDO_WIREFRAME_CANCEL=1` and
      `FREDO_WIREFRAME_FAIL_FILE=1` write NOTHING.
      Cross-ref `.opencode/tests/postgres-only-persistence/`.
- [ ] **R-9 (startup bundle).** `allApplications.ts` is an eager glob, so the entry chunk must
      not grow by the canvas library: `konva`/`react-konva` stays behind `React.lazy` and is
      emitted in its own chunk; the app opens fine when that chunk loads.
- [ ] **R-10 (console / loops).** No `Maximum update depth exceeded`, `Uncaught` or `Error:`
      across app open/close, selection churn, 50 drags, theme switches and repeated undo/redo
      (AGENTS.md #523 — no effect keyed on an array `.length` or a fresh object).
- [ ] **R-11 (build + CI parity).** `pnpm --filter @fredo/ui build` exit 0 zero TS errors;
      `pnpm --filter @fredo/ui test:run` green; `pnpm --filter @fredo/tauri build:webview`
      exit 0 (served host); `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml
      --locked`, `cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked --
      -D warnings`, `cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml
      --locked` green; no assertion weakened/disabled (G-125).
- [ ] **R-12 (no new platform surface).** No new Tauri capability/plugin, no `global-shortcut`
      registration, no OS-wide hotkey, no new persisted settings key; `Cargo.lock` changes
      only if a Rust dependency is genuinely added (`rfd` is already vendored).

## Overlapping prior-feature suites (run alongside)

- `.opencode/tests/hotkeys/` — the element-declared `data-hotkey` model, the bar, the
  duplicate guard, text-entry/terminal suppression.
- `.opencode/tests/companion/` — skill declaration → offer → `llm-skill-call` → honest reply,
  and the existing `open_app`/`close_app` rows.
- `.opencode/tests/launcher/` — the app grid, tile set, keyboard nav, open lifecycle.
- `.opencode/tests/settings/` — the settings shell and its section contract.
- `.opencode/tests/theming/` + `.opencode/tests/theme-contract/` — token → CSS var → theme.
- `.opencode/tests/doom-mode/` — the `doom_mode` skill that shares the registry.

## Round 1 result — 2026-10-21

- **R-1 (duplicate guard) UNVERIFIED** — the 22 wireframe `data-hotkey` attributes never mount
  (the app crashes at canvas mount), so the collision surface cannot be observed live. The
  unit pin (`featureHotkeyKeys.test.ts`, 5 tests) is green.
- **R-2 (pre-existing bare-key dispatch) UNVERIFIED** — no driver pass this round; the
  wireframe keys are absent so a bare-key pass-through cannot be contrasted.
- **R-3 (bar contract) UNVERIFIED** — same cause (editor never mounts).
- **R-4 (launcher grid) PASS (partial)** — the launcher renders `gridcell Wireframe` →
  `button Wireframe` through the eager glob with no `Home.tsx` edit; the grid set is intact.
  Keyboard-nav/aria rows of `.opencode/tests/launcher/` were not re-run.
- **R-5 (Companion skills) UNVERIFIED** — the `open_app` skill resolves `Wireframe` and opens
  the window (live receipt: `window.__TAURI__.event.emit('llm-skill-call', …)` → the app
  window opened), but the round trip cannot complete because the editor crashes.
- **R-6 (theme contract) PASS (static)** — zero `#rrggbb` / `rgb(` / `rgba(` / `hsl(` literals
  and zero `var(--x)NN` alpha-append in `apps/ui/src/applications/wireframe/**`;
  `allowlist.ts` contains no wireframe entry; `canvasPalette.test.ts` + `rawColorScan.test.ts`
  green.
- **R-7 (settings shell) PASS (static)** — `SettingsSurface.tsx` untouched; the app declares
  `hasSettings=false`; no wireframe nav item in the settings surface.
- **R-8 (persistence medium) PASS (static)** — the document is a user FILE; no
  `application_store_*` call and no RTDB row in the wireframe sources.
- **R-9 (startup bundle) PASS (build receipt)** — `konva`/`react-konva` land in
  `assets/WireframeCanvasImpl-BMlK6N31.js` (307.43 kB), separate from the entry
  `assets/index-BPAunTLj.js` (2,903.09 kB). The "opens fine when that chunk loads" half is
  FAILED by the mount crash.
- **R-10 (console) FAIL** — the open raises `Uncaught InvalidStateError` (see
  `functional.md` → Round 1 result).
- **R-11 (build + CI parity) PASS with the nextest substitution disclosed** — build ✓,
  test:run ✓ (3051), contrast:gate ✓, cargo check ✓, cargo clippy ✓ (all zero warnings).
- **R-12 (no new platform surface) PASS (static)** — no new capability/plugin, no
  `global-shortcut` registration; `Cargo.lock` unchanged (canvas deps are UI-side only).

## Round 2 result — 2026-10-21

- **R-1 (duplicate guard) PASS (live)** — `data-fredo-hotkey-duplicate` and
  `hotkeys-duplicate-error` absent with Wireframe focused, unfocused and with the standalone
  `app-wireframe` window open; 22 mounted keys; no console `DuplicateHotkeyError`.
- **R-2 (pre-existing bare-key dispatch) PASS (live)** — with Wireframe unfocused its 22
  `data-hotkey` attributes are gone (`data-fredo-hotkey-count` 22→0) so a bare key cannot reach
  it; the toolbar controls stay visible/clickable (height 53 px unchanged).
- **R-3 (bar contract) PASS (live)** — 22 `hotkeys-keybar-row` entries with
  `data-hotkey-key`/`-action`; rows disappear on unfocus; the bar never takes focus.
- **R-4 (launcher grid) PASS** — the Wireframe tile renders/opens through the eager glob with
  no `Home.tsx` edit; `Enter`/tile activation open the editor.
- **R-5 (Companion skills) PASS** — `open_app` opened Wireframe three ways, `close_app_window`
  returned `true` for the standalone window, one reply per request; all 25 wireframe ids are
  invocable through the one `llm-skill-call` path (F-43/F-44a–c). `doom_mode` not re-run.
- **R-6 (theme contract) PASS** — zero colour literals / alpha-append in the new sources
  (including the boundary + placeholder); no `allowlist.ts` entry; palette re-resolved on the
  theme switch (accent + page pixels changed).
- **R-7 (settings shell) PASS** — `SettingsSurface.tsx` untouched; no Wireframe section.
- **R-8 (persistence medium) PASS** — the only writes are the three file seams; no DB/settings/
  RTDB write; CANCEL wrote nothing; FAIL_FILE wrote nothing.
- **R-9 (startup bundle) PASS** — `WireframeCanvasImpl-wT5Qv7JC.js` (307.81 kB) is its own
  chunk; the lazy chunk loaded and painted in every host.
- **R-10 (console / loops) PASS** — no `Maximum update depth exceeded`/`Uncaught`/`Error:`
  after drags, resizes, 30 zooms, a theme switch and Companion traffic.
- **R-11 (build + CI parity) PASS (with disclosed omissions)** — build ✓ (2832 modules),
  test:run ✓ (3056), contrast:gate ✓ (46), cargo check ✓ zero warnings; clippy/nextest/
  build:webview not re-run this round (round 1 green; no Rust change in the fix commit).
- **R-12 (no new platform surface) PASS (static)** — unchanged from round 1.

## Round 3 result — 2026-10-21 (env `wf3070-r3`, served `c045877`)

- **R-1 (duplicate guard) PASS (live)** — `data-fredo-hotkey-duplicate` absent and
  `hotkeys-duplicate-error` absent with the focused standalone `app-wireframe` host (22 mounted
  keys) and with the main host unfocused (`data-fredo-hotkey-count=0`, 0 toolbar
  `data-hotkey` attributes); no console `DuplicateHotkeyError`.
- **R-2 (pre-existing bare-key dispatch) PASS (live)** — the unfocused main host carried 0
  `data-hotkey` attributes and a bare key produced no editor action (the view stayed put while
  the host was unfocused); the focused standalone host carried all 22 and every key fired.
- **R-3 (bar contract) PASS (live)** — 22 `hotkeys-keybar-row` entries while focused, 22-key
  `data-fredo-hotkey-count`; the bar never takes focus (typing in the launcher/panel was never
  diverted). The unfocused reading was 0 rows (consistent with the count).
- **R-4 (launcher grid) PASS** — the Wireframe tile opens the editor through the eager glob in
  both presentations (`same-window` tile and `app-wireframe` own window).
- **R-5 (Companion skills) PARTIAL** — `wireframe.add.card` invoked through the real
  `llm-skill-call` channel in BOTH presentations (own window: exactly one card; main-window
  contrast leg: +1 card), and the `wireframe` skill is now genuinely offered on the live
  transport (F-47 completes). `open_app`/`close_app`/`doom_mode` were not re-driven this round.
- **R-6 (theme contract) PASS (live)** — dark → `light-default` repainted the canvas
  (page pixel 45,45,45 → 247,248,250 = `--card-bg` `#f7f8fa`); zero colour literals /
  alpha-append in the new sources (round-2 static scan unchanged; the round-3 diff adds only a
  transparent hit surface).
- **R-7 (settings shell) PASS** — the app has no settings section; Settings → Apps gained the
  per-app presentation control (existing shell, no wireframe-specific nav).
- **R-8 (persistence medium) PASS** — the only writes were the three file seams
  (`doc-a.wireframe.json`, `page-export`); no DB/settings/RTDB write from the editor.
- **R-9 (startup bundle) PASS (round 2 build receipt)** — the lazy chunk is unchanged this round
  (no canvas import was added); the canvas painted in both hosts.
- **R-10 (console / loops) PASS** — `tauri_read_logs(source="console", level="error")` returned
  no rows after the full drive (drags, pans, 30 zoom steps, property edits, theme switch,
  Companion traffic).
- **R-11 (build + CI parity) NOT RE-RUN by the tester this round** — disclosed: the round-3
  commits are the developer's; build/test/clippy evidence for `c045877` is the developer's gate
  output, not a tester receipt. Tester-side static checks (source scan, i18n/copy strings,
  catalog ids) were re-read, not re-run.
- **R-12 (no new platform surface) PASS (static)** — no capability/plugin/dependency change in
  the round-3 diff; the pan surface is a Konva node, not a DOM hook.
- **NEW regression pin (E-16):** an element drag must NOT move the view — see
  `functional.md` E-16 (**PASSED in round 4**).
- **NEW regression pin (E-21):** an export must be viewport-invariant — see `functional.md`
  F-33 / `exploratory.md` E-21 (**PASSED in round 4**: byte-identical at 100 % / 400 % / 10 %).

## Round 4 result — 2026-10-21 (env `wf3070-r4`, served `7d03f3c`)

- **R-1 (duplicate guard) PASS (live)** — `data-fredo-hotkey-duplicate` and
  `hotkeys-duplicate-error` absent in the focused editor (22 mounted keys); no console
  duplicate throw.
- **R-2 (pre-existing bare-key dispatch) PASS (live)** — a bare `KeyboardEvent` dispatch does
  NOT reach the engine (9 synthetic keydowns → count 0); the driver's real key events do, and
  with a panel input focused the engine correctly suppresses them
  (`data-fredo-hotkeys-disabled=true`, `focus-context=text-entry`) while the character lands in
  the field.
- **R-3 (bar contract) PASS (live)** — 22 `hotkeys-keybar-row` entries, 22-key
  `data-fredo-hotkey-count`, 22 toolbar `data-hotkey` attributes, identical key list.
- **R-4 (launcher grid) PASS** — the app opened from the launcher (`Wireframe` + Enter), from
  `open_app` skill emits in three separate envs, and from the Companion Gherkin.
- **R-5 (Companion skills) PASS (live, partial coverage)** — `wireframe.add.section` /
  `.add.text` / `.add.card` performed through the real `llm-skill-call` path via the Gherkin
  draft; the four file ids performed through the same channel (F-44c). `open_app` re-driven;
  `close_app`/`doom_mode` carried from round 3.
- **R-6 (theme contract) PASS (static, round-4 diff)** — the round-4 commit adds no colour: the
  capture view is a paint override and the page-node capture introduces no token. Round-3 live
  theme receipt stands (`useCanvasPalette` untouched).
- **R-7 (settings shell) PASS** — the app has no settings section; Settings → Companion was used
  (shipped surface) to turn the Companion on.
- **R-8 (persistence medium) PASS (live)** — the only writes were the file seams
  (`doc-a.wireframe.json`, `page-export`); the three denied/optional launches wrote **nothing**
  (Test-Path false for every cancelled/failed seam).
- **R-9 (startup bundle) PASS (round-4 build receipt)** — `WireframeCanvasImpl-CjRUbVOx.js`
  (308.18 kB) is its own chunk beside the 2,914.16 kB entry; `flushSync` comes from the entry's
  existing react-dom, so no chunk change was introduced.
- **R-10 (console / loops) PASS** — `tauri_read_logs(source="console", level="error")` returned
  no rows after the full round-4 drive, and **no `flushSync` warning** appeared during the
  export matrix.
- **R-11 (build + CI parity) PASS (tester-run)** — typecheck ✓ · build 2832 modules ✓ ·
  test:run 239 files / 3077 tests ✓ · contrast:gate 46/46 ✓ · build:webview 2834 modules ✓ ·
  `cargo check --locked` zero warnings ✓ · `cargo clippy --locked -- -D warnings` zero
  warnings ✓ · `cargo test --locked` 1451 lib tests + integration suites ✓.
- **R-12 (no new platform surface) PASS (static)** — no capability/plugin/dependency/manifest
  change in `481a590`; the capture view is a store field, not a DOM hook, and is explicitly
  excluded from `data-wireframe-*`, undo and the saved JSON (round-4 pins).

## Spec #3081 — added regression pin

- [x] **R-13 (colour-literal pin — extends R-6).** No raw-colour literal may enter
      **Round 1 (2026-10-26) — PASS.** `contrast:gate` 46/46 (no wireframe hit); named-colour
      source scan → zero hits; no wireframe entry in `allowlist.ts`/`rawColorBaseline.ts`; the
      Discard button (`WireframeToolbar.tsx:393`) carries `color="status.onSolids"`.
      `apps/ui/src/applications/wireframe/**` — **including NAMED colours** (`white`/`black`).
      The shipped `rawColorScan.ts` matches only hex / `rgb(`/`hsl(` / `var(--x)NN`, so the
      named-colour clause needs the wireframe-scoped check the fix must add (see F-58).
      **Expected:** `pnpm --filter @fredo/ui contrast:gate` reports zero wireframe hits AND the
      named-colour scan reports zero; the Discard button (`WireframeToolbar.tsx:390-397`) carries
      `status.onSolids`, not `white`; no wireframe entry appears in `allowlist.ts` /
      `rawColorBaseline.ts` (a new baseline entry for wireframe = FAIL).
      **Edge:** the pin must fail if a `color="white"`/`bg="black"` literal is reintroduced
      (verify with a scratch edit, then revert); `tint()`/`color-mix(...)` is not a literal.
      Cross-ref `.opencode/tests/contrast-gate/` F-5 (anti-widening) and
      `.opencode/tests/theme-contract/`.
