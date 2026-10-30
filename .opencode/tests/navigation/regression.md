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
