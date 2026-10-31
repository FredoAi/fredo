# navigation — Regression

Feature: the headless NavigationEngine P3 core (issue #3117). This slice is **additive**: it
adds the leaf module `apps/ui/src/shared/navigation/`, one export line in `apps/ui/src/index.ts`
and an `docs/ARCHITECTURE.md` note. Nothing shipped is modified, no consumer is wired, and no
telemetry signal is introduced.

Verification policy: **static** — every case is a source-text/diff property or a committed test
exit. There is no app, webview or `telemetry_spans` surface for this feature; none is planned.

> **Precondition.** `spec/3117` checked out; `main` is the comparison base. Run from the repo
> root. Test paths are relative to `apps/ui/src/shared/navigation/__tests__/`.

## Cases

- [ ] **R-1 (REQ-01.1 scope / AC1) — the diff touches only the sanctioned paths.**
  Run `git diff --name-only main...HEAD`.
  **Expected:** every path is inside one of: `apps/ui/src/shared/navigation/**`,
  `apps/ui/src/index.ts`, `docs/ARCHITECTURE.md`, `.opencode/tests/navigation/**`. Zero paths
  under the legacy keyboard runtime (deleted in P8), `apps/ui/src/shared/companion/`, `apps/ui/src/applications/`,
  `apps/tauri/`, or any package/config file.
  **Edge:** a formatting-only change to an application file (FAIL); a deleted shipped file; a
  new workspace package; a `pnpm-lock.yaml` entry.

- [ ] **R-2 (AC1 public surface) — the root export is append-only.**
  Read `apps/ui/src/index.ts`; run `pnpm --filter @fredo/ui test:run src/shared/navigation`.
  **Expected:** the diff adds exactly ONE line, `export * from './shared/navigation';`, after the
  previous final export block; no existing `export` line is edited, reordered or removed;
  `rootExport.test.ts` › `root export exposes the six navigation entry points` is green.
  **Edge:** the line inserted mid-file (breaks the append-only section rule); a duplicate export
  name silently dropped by `export *` (the six-entry-point import catches it); a re-export list
  written by hand instead of `export *`.

- [ ] **R-3 (REQ-10.5 / build gate) — no new runtime or dev dependency.**
  Read `apps/ui/package.json` and the `apps/ui` importer in `pnpm-lock.yaml`; compare to `main`.
  **Expected:** `dependencies` and `devDependencies` are unchanged key-for-key; the lockfile
  importer block is unchanged; `fast-check` has no import, no `package.json` entry and no lockfile
  importer delta (its only two occurrences in `apps/ui` are comment-only mentions in
  `__tests__/property.test.ts` and `__tests__/fixtures.ts` — prose, not a dependency); the seeded
  PRNG lives in `__tests__/fixtures.ts` (mulberry32, ~10 lines).
  **Edge:** a transitive-only lock change; a devDependency added "for tests"; a `@types/node`
  addition (unnecessary — `__tests__` is excluded from `typecheck`).

- [ ] **R-4 (REQ-01.5, REQ-10.1 / AC1, AC3) — determinism and property reproducibility.**
  Run `pnpm --filter @fredo/ui test:run src/shared/navigation` twice.
  **Expected:** both runs exit 0 with identical pass counts; `determinism.test.ts` › `identical
  inputs produce deep-equal results` and › `reordering irrelevant declaration input does not
  change output order` are green; `property.test.ts` › `property run generates 3000 cases` is
  green with `PROPERTY_SEEDS = [1, 42, 2026]` × `PROPERTY_CASES_PER_SEED = 1000`; no
  `Math.random` in any module or test fixture.
  **Edge:** a wall-clock or `Math.random` seed (non-reproducible — FAIL); a seed list trimmed
  below the 1,000-case floor; a run whose case count varies between invocations.

- [ ] **R-5 (REQ-03.3 / AC2) — the `c r` / `r` trace pair still differs only in `placePath`.**
  **Expected:** `traces.test.ts` › `c r and r differ only in journal placePath` green; both
  dispatch `place.rect` with args `{}` and the same mutation effect; both end at cursor
  `['wireframe.canvas']`; the journal `placePath` is `['wireframe.canvas','wireframe.create']`
  versus `['wireframe.canvas']`. `c r` writes a navigation entry for `place.create` then one
  mutation entry carrying `exitedBy:'verb'` — never a second navigation entry.
  **Edge:** the two path columns conflated (Reading #3); a second navigation entry for the
  transient exit; `exitedBy:'none'` on the rect entry.

- [ ] **R-6 (scope / AC1) — no consumer is wired and no telemetry is emitted.**
  Grep the repo for `shared/navigation` imports; Grep the module for `emit`, `telemetry`, `span`.
  **Expected:** the only non-test importers are `apps/ui/src/index.ts` and the module's own
  `index.ts`; zero application or legacy-runtime imports; zero `emit(`/`telemetry`/`span`
  identifiers in the eleven modules; `docs/ARCHITECTURE.md` carries the tree row and subsection
  saying the module has no consumer yet.
  **Edge:** an application wired early (FAIL — out of scope); an event emitted from the journal;
  a `console` call left in a module.

- [ ] **R-7 (AC1–AC10) — the existing suite does not regress.**
  Run `pnpm --filter @fredo/ui test:run`.
  **Expected:** exit 0 with no new failures versus `main`; the navigation and companion suites
  remain green (the legacy runtime's suite is deleted in P8 / #3122; see the P8 section).
  **Edge:** a navigation test polluting a global (fails an unrelated suite); a `.only` left in a
  navigation suite (silently skips the rest — FAIL); an unhandled rejection.

- [ ] **R-8 (Reading #8 / AC9) — the shipped companion manifest is untouched.**
  Read `apps/ui/src/shared/companion/manifest.ts` and its golden fixture.
  **Expected:** both are byte-identical to `main`; `shared/navigation/manifest.ts` declares its
  own `CompanionManifest` (§8 shape) and imports nothing from `shared/companion/`.
  **Edge:** importing the shipped `{ surfaces: [...] }` type into the navigation module; adding
  navigation commands to the shipped companion manifest; editing the shipped golden file.

## Suite-level pass/fail

PASS = R-1..R-8 green with the observed diff/paths quoted. Any out-of-scope path, any change to
a shipped export line, any dependency delta, or any new failing suite is a FAIL. The receipt is
the POSTED `## Tests Runs` comment plus the committed suites.

---

# P4 — UI surfaces (issue #3118)

Feature: the `CommandRail` / `NavigationMap` / `ActivityTrail` / `NavKeycap` / announcement layer,
a `ui/` subdirectory of `shared/navigation/`, one DEV-only route under `app/dev/`, and one DEV-gated
branch in `app/routes/Router.tsx`. **P3 is frozen**: the eleven headless modules, the headless
barrel and everything under the legacy runtime are byte-identical (P4 historical; P8 deletes it).

Verification policy: **static** for the rows below (diff + source + suite exits). The P4 functional
suite carries the live rows.

> **Precondition.** `spec/3118` checked out; `main` is the comparison base; run from the repo root.

## Cases — P4

- [ ] **R-9 (P3 freeze / AC1, AC2, AC7) — the eleven headless modules and the headless barrel are untouched.**
  `git diff <merge-base>...HEAD -- apps/ui/src/shared/navigation/types.ts registry.ts resolver.ts
  keyResolver.ts dispatch.ts journal.ts context.ts discover.ts manifest.ts validation.ts index.ts`
  **Expected:** empty (zero bytes). `pnpm --filter @fredo/ui test:run src/shared/navigation` stays
  green with the P3 titles unchanged — in particular `purity.test.ts` › `declares exactly eleven
  modules and a __tests__ directory` (it iterates a hard-coded 11-file list and never lists the
  directory, so the new `ui/` subdirectory is safe — verify that is still true), the never-pad
  invariant at `discover.test.ts:124`, and `rootExport.test.ts`.
  **Edge:** a "typo fix" in `discover.ts` (FAIL — out of scope); a regenerated navigation golden
  file; a reordered `export *` line.

- [ ] **R-10 (AC9) — nothing under `apps/ui/src/applications/` changed, and no app mounts the new surfaces.**
  `git diff <merge-base>...HEAD -- apps/ui/src/applications`
  **Expected:** empty (zero bytes). A source scan finds no `CommandRail` / `NavigationMap` /
  `ActivityTrail` / `NavigationAnnouncer` / `NavigationHost` import or mount anywhere under
  `src/applications/**`, and no file under `src/shared/navigation/**` imports `applications/`.
  The only sanctioned path outside the new modules is the DEV branch in `app/routes/Router.tsx`.
  **Edge:** a whitespace-only application change; a new file under `applications/`; a deleted
  shipped app; a nav import in Wireframe "to preview it" (FAIL — that is P5).

- [ ] **R-11 (AC9) — legacy runtime frozen for P4 ONLY; SUPERSEDED BY P8.**
  `git diff <merge-base>...HEAD -- <legacy keyboard runtime and legacy component dirs>`
  **Expected (P4 historical):** empty (zero bytes); the legacy suite unmodified; `Router.test.tsx`
  green with the DEV branch in place. **P8 supersession (#3122):** this row does NOT apply to the P8
  round — the runtime is deleted and the absence is asserted by the P8 section (R-19/R-24). Keeping
  this historical row for the P4 record.
  **Edge:** a "small" edit to the legacy announcer (FAIL for P4); a guard typo that makes every
  route hit the preview (breaks `Router.test.tsx`).

- [ ] **R-12 (build gate / NFR) — no new runtime or dev dependency.**
  Read `apps/ui/package.json` and the `apps/ui` importer in `pnpm-lock.yaml`; compare to `main`.
  **Expected:** unchanged key-for-key; no `axe-core`, `jest-axe`, focus-trap library, or date
  library; any test helper is dependency-free (the a11y assertion is a role/name/focus probe suite
  on the shipped stack: vitest + jsdom + `@testing-library/react` + `jest-dom`).
  **Edge:** a devDependency added "for the a11y test" (FAIL); a transitive-only lock delta; a
  `@types/node` addition (unnecessary).

- [ ] **R-13 (AC9 / scope) — the Rust tree and the pre-existing dirty Cargo manifest are untouched.**
  `git diff <merge-base>...HEAD -- apps/tauri` and `git status --short apps/tauri/src-tauri/Cargo.toml`.
  **Expected:** the spec diff contains **no** `apps/tauri/**` path; a pre-existing local modification
  to `Cargo.toml` is acknowledged and left exactly as found (never reverted, never extended). The
  cargo legs of the CI-parity set still pass.
  **Edge:** reformatting `Cargo.toml` "because it was dirty" (FAIL); attributing a pre-existing local
  change to this spec; skipping a cargo leg.

## Suite-level pass/fail — P4

PASS = R-9..R-13 green with the observed diff/paths quoted. Any out-of-scope path, any change to a
P3 module or to the legacy runtime, any `applications/` edit, any dependency delta, or any new failing
suite is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the committed suites.

---

# P5 — engine contract changes (issue #3119)

Feature: the four contract changes the Wireframe pilot requires (reserved strokes, V-08 root
scoping, host transient auto-exit, `CommandRailModel.placeRows`). **P4's R-10 "no
`applications/` change" is SUPERSEDED BY DESIGN:** this spec is the pilot that wires the first
application, so a Wireframe-only import/mount IS the sanctioned change — any OTHER application
still may not import the navigation surfaces.

Verification policy: **static** (diff + source + suite exits). The pilot's live rows are in
`.opencode/tests/wireframe-navigation/`.

## Cases — P5

- [ ] **R-14 (scope) — the engine diff touches only the sanctioned shared paths.**
  `git diff <merge-base>...HEAD -- apps/ui/src/shared/navigation`
  **Expected:** changed files are exactly `types.ts`, `validation.ts`, `ui/format.ts`,
  `ui/types.ts`, `ui/models.ts`, `ui/CommandRail.tsx`, `ui/host.ts`, the paired
  `__tests__`/`ui/__tests__` files, `__tests__/fixtures.ts` + `__tests__/traces.test.ts`, and
  `docs/NAVIGATION_ENGINE.md`. **Byte-identical (zero bytes of diff):** `registry.ts`,
  `resolver.ts`, `keyResolver.ts`, `dispatch.ts`, `journal.ts`, `context.ts`, `discover.ts`
  (beyond the additive `placeRows`-supporting change if the Architect moves it there — record
  which file owns it), `manifest.ts`, `index.ts`.
  **Edge:** a "typo fix" in `dispatch.ts` (FAIL — the funnel order is frozen); a regenerated
  navigation golden file; a reordered `export *`.
  **Note:** if `placeRows` is implemented in `discover.ts` instead of `ui/models.ts`, that single
  file is added to the sanctioned set and the row records the substitution (never a silent pass).

- [ ] **R-15 (P3 pins unchanged) — eleven modules, no dependency, no `.only`.**
  **Expected:** `purity.test.ts` › `declares exactly eleven modules and a __tests__ directory`
  green with the same hard-coded 11-file list; `imports only sibling ./ modules` and
  `reads no clock, global, timer, I/O or network` green; `apps/ui/package.json` + the lockfile
  importer unchanged key-for-key; no `.skip`/`.todo`/`.only` in the nav suites.
  **Edge:** a new module for the grammar (fails the pin — the constant IS the change); a
  devDependency added "for the traces test"; a `Date.now(` smuggled into `format.ts`.

- [ ] **R-16 (scope) — no consumer outside Wireframe, no telemetry.**
  Grep for `shared/navigation` imports.
  **Expected:** the only `applications/**` importers are under
  `applications/wireframe/**`; zero imports from any other application, from the legacy runtime,
  or from `shared/companion/`; zero `emit(`/`telemetry`/`span` identifiers added to the engine
  modules; the engine still emits nothing.
  **Edge:** a second application wired "for symmetry" (FAIL — P7); a `console` call left in a
  module; a hotkeys import from `ui/announce.tsx` reaching into `applications/`.

## Suite-level pass/fail — P5

PASS = R-14…R-16 green with the observed diff quoted. Any change to the frozen funnel/journal
modules, any module-count change, any dependency delta, any second consumer, or any new failing
suite is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the committed suites.

---

# P8 — decommission (issue #3122)

Feature: deleting the legacy runtime + the eight deprecated apps must NOT change behaviour for the
retained applications, re-tune a key, or move the companion wire shape. **P4's R-11 (legacy runtime
frozen) is SUPERSEDED BY DESIGN:** P8 deletes it, so the "zero diff under the legacy runtime" rows no
longer apply to this issue. The retained observable is the same navigation behaviour on the
navigation-only stack.

Verification policy: **static** for the diff/source/config rows; the behaviour legs are the `[live]`
rows in `functional.md` F-47…F-50.

> **Precondition.** `spec/3122` tree; `main` is the comparison base. Run from the repo root.

## Cases — P8

- [ ] **R-17 (no key re-tuning) — the three global chords and every app stroke are byte-identical to the declaration.**
  Read `apps/ui/src/shared/navigation/ui/globalKeys.ts` and the retained surfaces (`wireframeSurface.ts`, `terminal`, `mission-monitor`, `database-client`, `dev-mode`, `windowSystemSurface.ts`).
  **Expected:** `NAVIGATION_GLOBAL_CHORDS` is exactly `primary+space → window.launcher.toggle`, `primary+tab → window.focus.next`, `primary+shift+tab → window.focus.previous`; no app key id/stroke changed vs `main`; Wireframe's root keys remain `c/e/a/s/v/f/m/k` + arrows; Dev Mode's keys remain `x/i/b/v`.
  **Edge:** a "harmless" re-tune; a chord moved into the app declaration grammar; a new global added.

- [ ] **R-18 (retained applications still behave) — launcher, companion and CLI open only retained apps.**
  Open Mission Monitor, Wireframe, Terminal, Database Client, Settings, Fredo Setup and Theming from the launcher; run one companion `open_app` call for a retained app; run `fredo open-app mission-monitor`.
  **Expected:** each retained app opens through the one window kernel; the companion call performs the open; the CLI resolves the identity; no retired id resolves; console clean.
  **Edge:** an unknown/retired name performs zero actions and reports it; a hidden app (Dev Mode) is not discoverable.

- [ ] **R-19 (no dependency / zero warnings / dirty manifest untouched).**
  Read `apps/ui/package.json` + the `apps/ui` importer of `pnpm-lock.yaml` vs `main`; run `pnpm --filter @fredo/ui build` and `cargo check` from `apps/tauri/src-tauri`; hash `apps/tauri/src-tauri/Cargo.toml` before and after.
  **Expected:** dependencies/lockfile importer unchanged key-for-key; build exit 0, zero TS errors; `cargo check` zero warnings; the pre-existing dirty `Cargo.toml` hash is unchanged.
  **Edge:** a devDependency added "for the test"; a warning-only build (FAIL); reformatting `Cargo.toml` "because it was dirty" (FAIL).

- [ ] **R-20 (human-owned files untouched).**
  `git diff --quiet -- AGENTS.md opencode.json`.
  **Expected:** exit 0; byte-unchanged.
  **Edge:** a docs reference to them is fine; editing either file is a FAIL.

- [ ] **R-21 (no visual change) — the bound surface hooks and the contrast gate are unchanged.**
  Read `apps/ui/src/shared/navigation/ui/constants.ts`; run `pnpm --filter @fredo/ui contrast:gate`.
  **Expected:** every retained `data-nav-*` test hook keeps its value (`data-nav-keycap`, `data-nav-verb-id`, `data-nav-availability`, the `navigation-bar*` / `navigation-map*` / `navigation-trail*` testids); the four reserved hooks are used only where a retained test needs them; contrast gate exit 0 with the pre-change pair count; no new theme token.
  **Edge:** a hook silently renamed; a new token added to satisfy a colour.

- [ ] **R-22 (companion wire shape unchanged).**
  Read `surface_registry.rs` wire structs and `shared/companion/manifest.ts`.
  **Expected:** `register_app_command_surfaces` / `app_command_surfaces` / `AppCommandSurfaceRegistry` retained; the wire fields (`id`, `label`, `description`, `risk`, `args`, `aliases`, `listLabel` absent-key rule) unchanged; the publisher still calls the same command; `journal.undo` + `listActions` ordering unchanged.
  **Edge:** a removed wire field; `risk`/`aliases` switched to explicit `null`; a new IPC command.

- [ ] **R-23 (Dev Mode verbs unchanged).**
  Read `devModeSurface.ts`.
  **Expected:** the four shipped verbs `dev-mode.events.clear`, `dev-mode.search.focus`, `dev-mode.states.all`, `dev-mode.view.applicationData` (plus `view.rows`) unchanged; `showable = false`; the Konami path is the only entry.
  **Edge:** a verb renamed; `showable` flipped true (FAIL — discoverable).

- [ ] **R-24 (`data-fredo-passthrough` kept, no other legacy hook).**
  `rg -n "data-fredo-passthrough" apps/`; `rg -n "data-fredo-hotkey|data-fredo-pending-sequence" apps/`.
  **Expected:** `BODY_PASSTHROUGH_ATTR` / `data-fredo-passthrough` present in `terminalPassthrough.ts`; zero of the retired hooks.
  **Edge:** the passthrough attribute renamed; a legacy hook reintroduced.

- [ ] **R-25 (one dispatch listener).**
  `rg -n "addEventListener\('keydown'" apps/ui/src`; read `globalKeys.ts`.
  **Expected:** exactly ONE navigation chord listener (`globalKeys.ts`, capture phase, idempotent); app keys stay element-scoped `onKeyDown`; the Konami and DetailPanel listeners are not double-fired.
  **Edge:** a second document listener; a synthetic double-fire.

- [ ] **R-26 (no user data deleted).**
  Diff the settings/data schema vs `main`; read the migration path.
  **Expected:** no user-data deletion beyond dead hotkey controls (there are none); no new migration; the retention/eviction rules unchanged.
  **Edge:** a removed settings key that a retained app reads; a destructive migration.

- [ ] **R-27 (settings shell + sibling sections unchanged).**
  Open Settings; compare the nav sections vs `main`.
  **Expected:** the static Companion/Appearance/Fredo Setup/Telemetry sections + the retained discovered feature sections render unchanged; the SaveFooter contract and section-switch remount are intact; no Hotkeys section.
  **Edge:** a removed sibling section; a blank content pane.

- [ ] **R-28 (no route/launcher/CLI behaviour change for retained apps).**
  Diff `Router.tsx` / `Home.tsx` / the launcher entry paths; open every retained app from each path.
  **Expected:** the only removed branches are the retired `showDiagram` / `my-workitems` transition / `currentPage === 'dev-mode'` page branches; every retained path (grid, open-apps row, search Enter, companion, CLI, `open_app_window`) still opens the same app.
  **Edge:** a retained app losing an entry path; `open_app_window` resolving a retired id.

## Suite-level pass/fail — P8

PASS = R-17…R-28 green with every diff/config value quoted. Any key re-tune, any dependency delta, a changed wire shape, a changed retained surface hook, an edited human-owned file, a user-data deletion, or a retained app losing an entry path is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the committed suites.
