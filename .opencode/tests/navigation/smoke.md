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

---

# P5 — engine contract changes (issue #3119)

Feature: the four engine/P4 contract changes the pilot requires. Minimum proof that the extended
grammar, the root-scoped V-08, the transient auto-exit and `placeRows` are present and the scoped
suite is green.

Verification policy: **static** — command exits plus two reads. No app launch for these rows.

> **Precondition.** `spec/3119` checked out; run from the repo root.

## Cases — P5

- [x] **S-11: The scoped navigation suite is green with the new titles.**
      `pnpm --filter @fredo/ui test:run src/shared/navigation`.
      **Expected:** exit 0; the reporter shows `arrow strokes resolve as bindable reserved
      strokes`, `plus and minus resolve as bindable reserved strokes`,
      `a direct alias shadowing only a child place key is valid`,
      `a direct alias shadowing the root place key is V-08`,
      `a mutation in a transient place pops exactly one level`,
      `a transient mutation announces the exit once`,
      `place rows list child places in declaration order`,
      `place rows stay out of the eight row verb cap`, and
      `formatKeyHint renders the four arrows as glyphs`; no nav test skipped or `todo`.

- [x] **S-12: Typecheck and build are clean, `dist` is real.**
      `pnpm --filter @fredo/ui typecheck` then `pnpm --filter @fredo/ui build`.
      **Expected:** both exit 0; zero diagnostics; zero warnings; `apps/ui/dist/index.html` and a
      non-empty `apps/ui/dist/assets/` exist (the AC7 marker scan reads them).

- [x] **S-13: The reserved-stroke constant is the extended set.**
      Read `apps/ui/src/shared/navigation/types.ts`.
      **Expected:** `ENGINE_RESERVED_STROKES` is exactly
      `['Escape','Enter','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-']` and
      `BINDABLE_STROKE_PATTERN` is still `/^[a-z0-9]$/`; `PENDING_TIMEOUT_MS` is `250`.

## Suite-level pass/fail — P5

PASS = S-11…S-13 green. A missing title, a skipped test, a warning-only build, or a missing
`dist` is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the committed files.

### Round 1 results — 2026-10-30 (spec/3119 @ `5e49d43`, tester)

S-11 PASS — `pnpm --filter @fredo/ui test:run` green (**294 files / 3881 tests**) and every
listed title is present verbatim in the committed test sources (`keyResolver.test.ts:353,389`,
`validation.test.ts:416,437`, `host.test.ts:478,492`, `models.test.ts:282,316,574`); no
`.skip`/`.todo`/`.only` anywhere in `apps/ui/src/shared/navigation`.
S-12 PASS — `typecheck` exit 0, `build` exit 0 (2863 modules, only the pre-existing >500 kB
chunk advisory), `apps/ui/dist/index.html` + `dist/assets/` populated.
S-13 PASS — `git diff origin/main HEAD -- apps/ui/src/shared/navigation/types.ts` shows the
reserved set becoming `['Escape','Enter','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-']`
and nothing else in the file; `BINDABLE_STROKE_PATTERN` / `PENDING_TIMEOUT_MS = 250` are
untouched by the diff.

---

# P8 — decommission (issue #3122)

Feature: the legacy hotkey runtime and every ADR-7 adapter are deleted; exactly ONE navigation
system remains. Minimum proof that the deletion landed, the one mount is in place, the manifest is
single-sourced and the retained applications still boot.

Verification policy: **static** for S-14…S-18 (absent-token greps, source reads, committed guards,
command exits) and **live** for S-19…S-21 (the isolated webview). A static-only PASS for a live row
is a FALSE PASS.

> **Precondition.** `spec/3122` checked out from the repo root. Isolated env:
> `dev-env.ps1 -Up -Spec 3122 -EnvId <id> -EnvSlot <n> -RequireIsolation`, ports from
> `.opencode/tmp/envs/<id>/manifest.json`, `tauri_driver_session start {port: ports.mcp}`.

## Cases — P8

- [ ] **S-14 (R-1 / AC1) — no legacy runtime and no retired token in the tree.**
  Run `rg -n "shared/hotkeys|HotkeysProvider|HotkeyAnnouncer|HotkeyBar|hotkeyBarModel|hotkeyElements|hotkeyGrammar|commandSurfaceStore|commandSurfaceFixture|ApplicationCommandSurface|FredoApplicationClass\.commandSurface|data-hotkey|data-fredo-hotkey|data-fredo-pending-sequence|WIREFRAME_ACTIONS\.hotkey" apps/ .opencode/tests/ docs/ --glob '!docs/archive/**'`.
  **Expected:** zero matches; `apps/ui/src/shared/hotkeys/` and `apps/ui/src/shared/components/hotkeys/` absent; the committed `apps/ui/src/shared/navigation/__tests__/legacyAbsence.test.ts` green; `pnpm --filter @fredo/ui build` exit 0.
  **Edge:** a hit only under `docs/archive/**` (recorded allowlist, not a FAIL); a token in a comment/string (the guard strips them but scans template interpolations); a stale `dist` (delete it first).

- [ ] **S-15 (R-2 / AC2) — exactly one mount and one announcement region.**
  Read `apps/ui/src/main.tsx` and `apps/tauri/src/main.tsx`.
  **Expected:** each mounts `<NavigationProvider>` exactly once and contains zero `HotkeysProvider`; `rg -n "HotkeysProvider|resetApplicationMode" apps/ui/src/applications/app-window/StandaloneAppWindow.tsx apps/ui/src/main.tsx apps/tauri/src/main.tsx` returns zero; the live webview has exactly one `[data-testid="navigation-announcer"]` and no second `[aria-live]` navigation region.
  **Edge:** a double mount (two regions); a dev-only preview provider; an app provider that still renders its own announcer.

- [ ] **S-16 (R-4 / AC4) — one manifest from the declaration.**
  Read `apps/ui/src/shared/companion/fixtures/wireframe.companion.golden.json`; run `pnpm --filter @fredo/ui test:run src/shared/companion`.
  **Expected:** `schemaVersion === 3`; top-level keys are exactly `staticOffer`, `manifest`, `offer`; `manifest.parity.test.ts` green; the manifest command ids equal the fixture `offer.parameters.properties.action.enum` minus the single trailing `listActions`; no `navigation` wrapper and no second legacy `manifest`/`offer`.
  **Edge:** a regenerated-at-test-time fixture; a duplicated `listActions`; an extra top-level key.

- [ ] **S-17 (R-10 / AC10) — the boot set is exactly the retained eight.**
  Run `pnpm --filter @fredo/ui test:run src/applications/__tests__/retainedApplicationSet.test.ts`; read the test.
  **Expected:** `getApplications()` ids deep-equal the set `{wireframe, terminal, mission-monitor, database-client, theming, setup, settings, dev-mode}`; no retired id; the eight retired `applications/<id>/` trees are absent; `allApplications.ts` is the glob only.
  **Edge:** `create-workitem` (a feature id inside the `my-workitems` module — deleted with that tree); a duplicate registration (first-wins); a retired id left in a comment or a Rust test literal.

- [ ] **S-18 (R-9 / AC9) — every shipped surface validates and the matrix is green.**
  Run `pnpm --filter @fredo/ui test:run src/shared/navigation/validation.test.ts` and `pnpm --filter @fredo/ui test:run src/applications/__tests__/navigationParityMatrix.test.ts`.
  **Expected:** `validateSurface()` returns `{valid:true, diagnostics:[]}` for `wireframe`, `terminal`, `mission-monitor`, `database-client`, `dev-mode`, `window-system`; the parity matrix is green for the retained set; a fresh clone of `spec/3122` builds and its full suite is green (quote the clone path + HEAD sha in `## Tests Runs`).
  **Edge:** a surface validated against a stale clone; a cached `node_modules`/`dist` in the "fresh" clone (FAIL — not fresh).

- [ ] **S-19 (R-1, R-2 / AC1, AC2) — the isolated app boots with the one navigation shell.**
  Load the isolated webview; `tauri_webview_dom_snapshot(type="structure")`.
  **Expected:** `#root` mounts; the launcher renders; exactly one `[data-testid="navigation-announcer"]`; the Wireframe bar renders `navigation-bar`; no Vite error overlay; `tauri_read_logs(source="console")` has no `Error:`/`Uncaught`/`Maximum update depth exceeded` (a pre-existing warning may remain).
  **Edge:** a cold-start `about:blank` (Down → Up, then re-read); a stale dev server serving the previous commit.

- [ ] **S-20 (R-10.4 / AC10) — the Konami Easter egg still opens Dev Mode.**
  On the resting desktop press, in order, `ArrowUp ArrowUp ArrowDown ArrowDown ArrowLeft ArrowRight ArrowLeft ArrowRight b a`; then press `v`.
  **Expected:** one Dev Mode window opens through the window kernel; its bar renders `navigation-bar` over `devModeSurface` (root `dev-mode.events`); `v` moves to `dev-mode.applicationData` with one navigation journal entry; `x` runs `dev-mode.events.clear` or noops on an empty buffer (never an error); console clean.
  **Edge:** focus in an editable control (the Konami listener ignores it — focus the desktop); Dev Mode remains hidden (`showable=false`, no launcher tile/settings nav entry).

- [ ] **S-21 (R-2 / AC2) — terminal passthrough is intact.**
  `spawn_terminal_session {cli:"shell"}`; focus the terminal; type `echo 3122-passthrough`; press `Ctrl+Space`.
  **Expected:** while focused `document.body[data-fredo-passthrough="true"]`; the typed characters reach the PTY; no navigation verb fires; `Ctrl+Space` is suppressed in the terminal (and opens the launcher only from a non-terminal focus); console clean.
  **Edge:** no session (`list_terminal_sessions` → `[]`) is a named blocker, not a PASS.

## Suite-level pass/fail — P8

PASS = S-14…S-21 green with every absent-token scan returning no lines and every live value quoted. A static-only live row, a surviving token, a second mount/region, a fixture regenerated at test time, or a retired app in the boot set is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the committed files/guards.
