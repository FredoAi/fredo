# navigation — Smoke

Feature: the headless NavigationEngine P3 core (issue #3117). Minimum proof that the module is
present, dispatchable and buildable on the `spec/3117` tree.

Verification policy: **static** — three command exits plus two file-presence reads. No app
launch, no webview, no telemetry; none applies.

> **Precondition.** `spec/3117` checked out; run from the repo root. Test paths are relative to
> `apps/ui/src/shared/navigation/__tests__/`.

## Cases

- [ ] **S-1 (REQ-10.4 / build gate) — the scoped module suite is green.**
  Run `pnpm --filter @fredo/ui test:run src/shared/navigation`.
  **Expected:** exit 0; the reporter lists the navigation suites and no navigation test is skipped
  or `todo`.
  **Edge:** zero tests collected (a renamed path — FAIL, not a pass); a failing suite; `.only`
  hiding suites.

- [ ] **S-2 (REQ-10.4 / build gate) — the whole suite is green.**
  Run `pnpm --filter @fredo/ui test:run`.
  **Expected:** exit 0 with no new failures versus `main`.
  **Edge:** an unrelated flake (re-run once, record both); a navigation test polluting globals.

- [ ] **S-3 (REQ-10.4 / build gate) — typecheck and build are clean.**
  Run `pnpm --filter @fredo/ui typecheck` then `pnpm --filter @fredo/ui build`.
  **Expected:** both exit 0; `tsc --noEmit` reports zero diagnostics; `tsc && vite build` reports
  zero warnings.
  **Edge:** a warning-only build (FAIL); a `tsc` diagnostic in an excluded `__tests__` file (out of
  `typecheck` by design — the source scan pins `any` instead).

- [ ] **S-4 (REQ-01.1 / AC1) — the eleven modules and the public index exist.**
  Read the directory listing of `apps/ui/src/shared/navigation/` and `index.ts`.
  **Expected:** exactly `types.ts`, `registry.ts`, `resolver.ts`, `keyResolver.ts`, `dispatch.ts`,
  `journal.ts`, `context.ts`, `discover.ts`, `manifest.ts`, `validation.ts`, `index.ts`, plus a
  `__tests__/` directory; `index.ts` re-exports every public name from the binding block.
  **Edge:** a module moved into a subfolder (the purity scan's flat list fails); a missing
  `index.ts`; an extra scratch file.

- [ ] **S-5 (REQ-10.3 / AC9) — the golden manifest file is committed and parseable.**
  Read `apps/ui/src/shared/navigation/__tests__/fixtures/wireframe.navigation.golden.json`.
  **Expected:** the file exists, is non-empty, parses as JSON, and contains the `manifest` block
  (appId, appName, skillName, description, commands, actionIds) with `actionIds` ending in exactly
  one `listActions`.
  **Edge:** the file generated at test time instead of committed (FAIL); an empty `commands`
  array; a duplicated `listActions`.

- [ ] **S-6 (QA suite) — the four feature suites are persisted.**
  Read `.opencode/tests/navigation/`.
  **Expected:** `functional.md`, `regression.md`, `smoke.md` and `exploratory.md` all exist and are
  non-empty.
  **Edge:** a suite persisted under the wrong folder name (breaks the `tests-commit` lookup);
  a stale duplicate under another feature folder.

## Suite-level pass/fail

PASS = S-1..S-6 green. Any non-zero exit, any missing module or golden file, or any unpersisted
suite is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the committed files.

---

# P4 — UI surfaces (issue #3118)

Feature: the three navigation surfaces + `NavKeycap` + the announcement layer and the DEV-only
prototype route. Minimum proof that the new slice builds, type-checks, keeps the shipped colour
gate green and renders on the dev route.

Verification policy: **static** for S-7/S-8 (command exits + artifact reads) and **live** for
S-9/S-10 (the dev route in the running desktop app).

> **Precondition.** `spec/3118` checked out; run from the repo root.

## Cases — P4

- [ ] **S-7 (AC1–AC9 / build gate) — typecheck and build are clean, and `dist` is real.**
  `pnpm --filter @fredo/ui typecheck` then `pnpm --filter @fredo/ui build`.
  **Expected:** both exit 0; `tsc --noEmit` zero diagnostics; `tsc && vite build` zero warnings;
  `apps/ui/dist/index.html` and a non-empty `apps/ui/dist/assets/` exist after the run (the AC8
  marker scan in F-25 reads this artifact — a missing `dist` is a FAIL, not a skip).
  **Edge:** a warning-only build (FAIL); a stale `dist` from an earlier commit (rebuild before the
  scan); a test-only file breaking `tsc` (tests are excluded from `typecheck` by design).

- [ ] **S-8 (AC5 / colour gate) — the shipped contrast gate is green and unchanged in scope.**
  `pnpm --filter @fredo/ui contrast:gate`.
  **Expected:** exit 0 over the shipped presets with the pre-change pair count; no change to
  `apps/ui/src/app/theme/contract/tokens.ts` or `surfaces.ts` in this spec's diff.
  **Edge:** a new token added to satisfy a nav colour (changes the gate → FAIL); widening
  `defaultScanTargets()` in this slice (**declined** — a named follow-up needing its own
  first-green run, G-406; the scoped sweep in F-22 is the binding `shared/` cover).

- [ ] **S-9 (AC8 / dev route boots) — the dev-only prototype route renders.**
  `pnpm dev:tauri`, then `tauri_webview_execute_js` →
  `window.location.replace('/?view=navigation-preview')`.
  **Expected:** a `tauri_webview_dom_snapshot` shows `navigation-rail`, `navigation-trail` and (after
  activating `? Map`) `navigation-map`; the map lists the demo places `Canvas, Create, Edit,
  Arrange, Style, View, File`; a screenshot is captured for the record.
  **Edge:** a route that renders `Home` (the DEV guard or the inlined `'navigation-preview'`
  literal in the `Router.tsx` DEV branch is wrong); a blank screen from a failed lazy import; a
  stale dev server serving the previous commit.

- [ ] **S-10 (no console errors / `#523` regression) — the surfaces mount without a render loop.**
  `tauri_read_logs(source="console", lines=50)` after interacting with the dev route (enter/exit a
  place, open/close the map, run a verb, undo once).
  **Expected:** no `Error:`, no `Uncaught`, and in particular no `Maximum update depth exceeded`
  (the shipped `#523` failure signature); `tauri_read_logs(source="system")` shows no panic from the
  webview.
  **Edge:** an error only on the second open of the map; an unhandled rejection from a fired
  announcement subscription.

## Suite-level pass/fail — P4

PASS = S-7..S-10 green. Any non-zero exit, a missing/empty `dist`, a changed contrast-gate scope, a
dev route that does not render its three surfaces, or any console error is a FAIL. The receipt is
the POSTED `## Tests Runs` comment plus the screenshots/DOM snapshots.
