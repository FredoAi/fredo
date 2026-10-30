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
  under `apps/ui/src/shared/hotkeys/`, `apps/ui/src/shared/companion/`, `apps/ui/src/applications/`,
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
  `index.ts`; zero application or `shared/hotkeys` imports; zero `emit(`/`telemetry`/`span`
  identifiers in the eleven modules; `docs/ARCHITECTURE.md` carries the tree row and subsection
  saying the module has no consumer yet.
  **Edge:** an application wired early (FAIL — out of scope); an event emitted from the journal;
  a `console` call left in a module.

- [ ] **R-7 (AC1–AC10) — the existing suite does not regress.**
  Run `pnpm --filter @fredo/ui test:run`.
  **Expected:** exit 0 with no new failures versus `main`; the shipped `shared/hotkeys/` and
  `shared/companion/` suites remain green.
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
barrel and everything under `shared/hotkeys/` are byte-identical.

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

- [ ] **R-11 (AC9) — the legacy runtime is untouched and still the only runtime in shipped apps.**
  `git diff <merge-base>...HEAD -- apps/ui/src/shared/hotkeys apps/ui/src/shared/components/hotkeys`
  **Expected:** empty (zero bytes). `shared/hotkeys/__tests__` (`themeHygiene.test.ts`,
  `HotkeysProvider.test.tsx`, `announcer.test.tsx`, `HotkeyBar.test.tsx`) green **unmodified** —
  `themeHygiene.test.ts` › `only the announcer file declares aria-live` still passes because no file
  was added to that scan's `FILES` list and no `aria-live` was added to a scanned file.
  `Router.test.tsx` (4 titles, including the default-route title "routes the default (no view) to
  Home") still green with the new DEV branch in place.
  **Edge:** a "small" edit to `HotkeyAnnouncer` to share the region (FAIL — P4 may not edit
  `shared/hotkeys/`); a guard typo that makes every route hit the preview (breaks `Router.test.tsx`).

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
P3 module or to `shared/hotkeys/`, any `applications/` edit, any dependency delta, or any new failing
suite is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the committed suites.
