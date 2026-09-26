# embedded-postgres-migration — Smoke

Feature: embedded PostgreSQL migration approach spike (#2964). The deliverable is static
(files), not a running product surface, so the standard app-boot smoke boilerplate is
N/A — the adapted smoke checks below confirm the deliverable is present, honest, and
non-invasive.

> No `telemetry_spans` evidence applies (verification policy: **static**). No app window,
> no `fredo emit`, no row subscriptions are exercised by this spike.

- [ ] **S-1: Deliverable present.** The design doc (expected
  `docs/research/2964-embedded-postgres-migration.md`) exists on the spec branch and is
  non-empty.
- [ ] **S-2: Six areas present.** F-1's six scope-area headings all appear (quick pass, full
  detail in `functional.md` F-1/F-2).
- [ ] **S-3: Regression table present.** A regression → position table with six rows exists
  (quick pass, reconciled in F-3).
- [ ] **S-4: No production impact.** Spec-branch diff vs `main` touches no production
  persistence/observability path; if any tracked file is touched, both build gates are green
  (`cargo check …` zero warnings; `pnpm --filter @fredo/ui build` exit 0).
- [ ] **S-5: PoC (if produced) runs bounded and tears down.** Exact committed command exits
  within its finite timeout and leaves no orphan `postgres.exe` (full detail in F-9). If no
  PoC was produced, mark N/A and confirm the deliverable states the design-only choice.

## Smoke-level pass/fail

PASS = S-1..S-4 green; S-5 green if a PoC was produced, else N/A with a stated design-only
choice. Any production-path change or orphaned `postgres.exe` = FAIL.
