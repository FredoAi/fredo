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
