# wireframe-navigation — Regression

"Must not change" baseline for the **declaration-driven Wireframe surface** (Spec #3119). Runs on
this spec's testing phase and on any later phase that touches `shared/navigation/`, the
Wireframe shell, the hotkey bar, the theme contract, or the file seams.

> **Verification policy: live** for the rendered rows; **static** is used ONLY for the
> prove-a-negative source/diff rows (they read `git diff` output and committed sources — an
> absence cannot be witnessed by the surface that is claimed absent, G-408). No
> `telemetry_spans` receipt is expected.
>
> Env + driver: see `functional.md` (isolated `wf3119-a`, MCP port `"16001"`, built-in
> `tauri_driver_session`).

## Must NOT change

- [x] **R-N1 (P4 surfaces intact).** `.opencode/tests/navigation/` P4 rows F-16…F-27 keep
      passing UNMODIFIED: the rail's 8-row cap + `more…`, the map's dialog/roles/search/aliases/
      globals sections, the trail's newest-first + per-entry undo, the one polite region, the
      opacity/transform-only motion rule, the scoped right-colour sweep.
      **Expected:** no P4 test file edited except the ADDITIVE ST-1 extensions named in the plan
      (`models.test.ts`, `commandRail.test.tsx`, `host.test.ts`, `keycap.test.tsx`,
      `singleLiveRegion.test.tsx`, `navTheme.test.ts`, `fixtures.ts`); a deleted or weakened P4
      assertion is a FAIL (G-125).
      **Edge:** a re-baselined `NAV_*` literal (must stay byte-identical — QA asserts the
      constant, never a design snapshot).

- [x] **R-N2 (other applications' hotkeys and bar — static + live).** No other app's element
      hotkey is touched and its bar rows still list.
      **Expected:** with Wireframe CLOSED, Mission Monitor `s`, My Work Items `r`/`a`/`z`/`j`,
      Optimizely `f`/`q`/`e`/`c`, Dev Mode `x`/`v`/`i`/`b` still fire on their own controls;
      `document.body[data-fredo-hotkey-count]` for a non-Wireframe focused app is unchanged from
      the pre-change build; text-entry suppression still passes characters through.
      Cross-ref `.opencode/tests/hotkeys/` F-96/F-97/F-99, R-43/R-44.

- [x] **R-N3 (no global hotkey refactor — P8 stay-out, static).**
      `git diff <merge-base>...HEAD -- apps/ui/src/shared/hotkeys apps/ui/src/shared/components/hotkeys`
      **Expected:** the spec diff contains NO path under `shared/hotkeys/` or
      `shared/components/hotkeys/`; `shared/hotkeys/__tests__` green unmodified (including
      `themeHygiene.test.ts` › `only the announcer file declares aria-live`).
      **Edge:** a "small" edit to `HotkeyAnnouncer` to share the region (FAIL — the migration
      adopts the existing region via `channel="legacy"` instead).

- [x] **R-N4 (document shape + parse rules unchanged).** `WIREFRAME_SCHEMA_VERSION === 1`,
      `WIREFRAME_APP_ID === 'wireframe'`, `WIREFRAME_APP_TAG === 'fredo.wireframe'`,
      `WIREFRAME_FILE_EXTENSION === 'wireframe.json'`, `WIREFRAME_GROUP_MIN_MEMBERS === 1`.
      **Expected:** a Slice-1 document with no `groups` still opens with `groups: []`; the three
      rejection messages are byte-identical to the shipped copy —
      `This file is not readable JSON. Nothing changed.`,
      `This file isn't a Wireframe document (app tag "other.app"). Nothing changed.`,
      `Unsupported Wireframe document version "2". Nothing changed.` — and dangling
      `memberIds` reconciliation / duplicate-membership first-wins are unchanged.
      Cross-ref `wireframe/regression.md` R-15, `wireframe/functional.md` F-50/F-51/F-52/F-83.

- [x] **R-N5 (file seams unchanged).** Save As / Open / Export still resolve the per-command
      seams with the shipped precedence `FREDO_WIREFRAME_CANCEL=1` > `FREDO_WIREFRAME_FAIL_FILE=1`
      > own seam (`_SAVE_PATH`/`_OPEN_PATH`/`_EXPORT_PATH`) > shared
      `FREDO_WIREFRAME_FILE_PATH` > native dialog.
      **Expected:** each seam writes only its own artefact (the PNG never lands on the document
      path); CANCEL leaves document/path/dirty unchanged with NO banner and NO file; FAIL_FILE
      shows `wireframe-file-error` with the document intact; CANCEL+FAIL_FILE ⇒ cancel wins; the
      file rows are no longer visually disabled during an operation (accepted delta — assert
      BEHAVIOUR, never the retired disabled affordance, plan Q-15).
      Cross-ref `wireframe/functional.md` F-31/F-32/F-33/F-35.

- [x] **R-N6 (one undo step per mutation preserved).** Every shipped document mutation (create,
      move, resize, duplicate, delete, lock, group, ungroup, group-lock, align, distribute,
      reorder, style fields, page dims) still commits exactly ONE undo step, and an editor-only
      state change (selection, snap, guides, pan, zoom) commits none.
      **Expected:** the `wireframe/functional.md` one-undo rows (F-10/F-11/F-24/F-25/E-15/E-16
      and the #3071 F-61…F-83 clauses) still pass under the journal; a value-equal no-op still
      commits nothing (`-dirty` unchanged, no entry).

- [x] **R-N7 (canvas behaviour unchanged).** Smart guides
      (`wireframe-canvas[data-wireframe-guides]` > 0 mid-drag, `'0'` on drop), the transformer's
      visible-movable pinning, the pan hit surface, export page-space invariance (byte-identical
      at 100 % / 400 % / 10 %), the `#523` no-render-loop rule, and the canvas lazy chunk
      (own `dist` chunk, `konva` out of the entry).
      **Expected:** `wireframe/functional.md` F-27/F-33/F-56/F-73/F-78/E-16/E-20/E-21 hold; no
      per-pointer-move React state.

- [x] **R-N8 (no new dependency / no platform surface — static).**
      `apps/ui/package.json` and the `apps/ui` importer in `pnpm-lock.yaml` are unchanged
      key-for-key; no new Tauri capability/plugin; no `global-shortcut` registration; no new
      persisted settings key; `Cargo.lock` unchanged (no Rust change expected).

- [x] **R-N9 (settings shell + launcher untouched).** `SettingsSurface.tsx` is not edited;
      Wireframe keeps `hasSettings=false` (no Wireframe section); the launcher still shows the
      `Wireframe` tile via the eager glob with no `Home.tsx`/registry edit.
      Cross-ref `.opencode/tests/settings/` R-11/R-12, `.opencode/tests/launcher/` R-33/R-36/R-7.

- [x] **R-N10 (legacy-surface contracts that other consumers still rely on — static).**
      `WIREFRAME_ACTIONS` remains the handler registry with `id`/`title`/`description`/
      `toolbar`/`run` (only `hotkey` removed), so the retained capabilities are not re-authored;
      `NavKeycap` / `Keycap` and the always-on bar still serve every other app; `src/index.ts`
      exports are append-only (no removed export).
      **Edge:** an export removed with the command surface (FAIL — the companion relay type
      `AppCommandIntent` may remain, the app's `commandSurface` may not).

- [x] **R-N11 (build + suite gates).** `pnpm --filter @fredo/ui build` exit 0, zero TS errors;
      `pnpm --filter @fredo/ui test:run` green (no `.skip`/`.todo`/`.only` in the navigation or
      wireframe suites); `pnpm --filter @fredo/ui contrast:gate` green with the pre-change pair
      count; `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked` zero
      warnings; no assertion weakened or deleted (G-125).

## Overlapping prior-feature suites (run alongside)

- `.opencode/tests/navigation/` — the engine + P4 surface contract (extended by this spec for
  the reserved-stroke grammar, V-08 root scope, `placeRows`, host transient auto-exit, traces).
- `.opencode/tests/wireframe/` — the Wireframe capability suite, re-baselined in place.
- `.opencode/tests/hotkeys/` — the element-declared hotkey model, the bar, the duplicate guard.
- `.opencode/tests/launcher/`, `.opencode/tests/settings/`, `.opencode/tests/companion/`,
  `.opencode/tests/theming/`, `.opencode/tests/theme-contract/`,
  `.opencode/tests/contrast-gate/`, `.opencode/tests/postgres-only-persistence/`.

## Suite-level pass/fail

PASS = every row green with the observed diff/paths or live receipt quoted. Any out-of-scope
path, any change under `shared/hotkeys/`, any dependency delta, any weakened assertion, or any
new failing suite is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the
committed suites.

---

## Round 1 results — 2026-10-30 (spec/3119 @ `5e49d43`, tester)

| Row | Result | Evidence |
|---|---|---|
| R-N1 | PASS | `shared/navigation` suites green (`keyResolver`, `validation`, `models`, `host`, `a11y`, `singleLiveRegion`, `navTheme`, `commandRail`, `navigationMap`, `reducedMotion`, `announce`, `keycap`, `windowNfr`) inside the 294-file run; the edits are the additive ST-1 extensions named in the plan. |
| R-N2 | PASS (bar/model leg live) | With Wireframe focused `hotkeys-keybar 0`; Mission Monitor focused → `hotkeys-keybar 1` with 1 model row. Per-app key firing matrix is unchanged by construction: `git diff --stat origin/main HEAD -- apps/ui/src/shared/hotkeys apps/ui/src/shared/components/hotkeys` is **empty**. |
| R-N3 | PASS | Same empty diff over `shared/hotkeys/` and `shared/components/hotkeys/`; `shared/hotkeys/__tests__` green unmodified. |
| R-N4 | PASS | `schemaVersion:1`, `app:"fredo.wireframe"` in the seam-written document; Open of that document restored it (count 1, page `1280x800`, `dirty=false`); the three rejection messages are pinned by `wireframeFileActions.test.ts` (20/20 green). |
| R-N5 | PASS | Save As wrote the seam artefact; Open read it; Export PNG produced the page PNG at `FREDO_WIREFRAME_EXPORT_PATH`. `CANCEL=1` launch → no banner, `path=""`, `dirty=true`, document intact, seam file byte-unchanged. `FAIL_FILE=1` launch → `wireframe-file-error` reading `wireframe file operation failed (FREDO_WIREFRAME_FAIL_FILE=1)`, document intact. CANCEL+FAIL precedence is pinned by `wireframeFileActions.test.ts` (unit), not driven live — disclosed. |
| R-N6 | PASS | Every mutation performed live committed exactly one entry (`Rectangle`, `Add Text/Icon/Section/Image`, `Bring forward`, `Fill`, `Move`, `Resize`, `Update page`); editor-only changes (`Pan`, `Toggle snap`, `Enter/Exit place`, arrows) committed navigation entries or none and never flipped `-dirty`. |
| R-N7 | PASS | Canvas drag/resize/pan unchanged: guides overlay hooks present, one commit per gesture, `#523` no-render-loop (console clean), canvas lazy chunk `WireframeCanvasImpl-*.js` in `dist`. |
| R-N8 | PASS | `git diff --stat origin/main HEAD -- apps/ui/package.json pnpm-lock.yaml apps/tauri/src-tauri/Cargo.lock` → empty; no new capability/plugin. |
| R-N9 | PASS | `SettingsSurface.tsx` unedited (diff); Wireframe tile opened from the launcher by name with no `Home.tsx`/registry edit. |
| R-N10 | PASS | `WIREFRAME_ACTIONS` retained as the handler registry (`toolbar:true` count 33, pinned by `wireframeRailParity`); `src/index.ts` exports untouched. |
| R-N11 | PASS | `build` exit 0 (2863 modules); full `test:run` 294 files / 3881 tests; `contrast:gate` 4 files / 50 tests; no `.skip`/`.todo`/`.only` in the wireframe or navigation suites. `cargo check --locked` substituted by `git diff --stat origin/main HEAD -- apps/tauri` → **empty** (no Rust source changed) — disclosed. |
