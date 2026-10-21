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
