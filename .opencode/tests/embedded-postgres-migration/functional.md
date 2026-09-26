# embedded-postgres-migration — Functional

Feature: the concrete migration approach for moving Fredo's local persistence from embedded
SQLite (`fredo.db`, `rusqlite 0.32` bundled) to embedded PostgreSQL
(`theseus-rs/postgresql-embedded`). Issue #2964 — a **spike** whose deliverable is a written
migration design at file-level detail and/or a disposable PoC. It ships **no production
migration**; the migration is mandated (HOW, not whether — the "whether" is an explicit
non-goal).

Verification policy: **static** — evidence is the committed deliverable file(s) plus, if a
PoC was produced, its execution under a finite timeout. There is no telemetry/span/event/UI
surface for this feature, so NO `telemetry_spans` evidence applies.

Required artifact paths are a hard dependency — the Developer/Architect commits: the design
doc at `docs/research/2964-postgres-migration-approach.md` (+ section files under
`docs/research/2964-postgres-migration-approach/`) and, if produced, an isolated PoC crate at
`spikes/2964-postgres-migration/` with committed `results/` and a committed `README.md`
carrying the exact reproducible command + its finite wall-clock bound. `.opencode/tmp/` is
gitignored and is NOT evidence.

Regression numbers are reconciled against the prior spike's committed data:
`spikes/2948-embedded-postgres/results/measurements.json` (+ `QUESTIONS.md`,
`docs/research/2948-embedded-postgres-spike.md`).

## Cases

- [ ] **F-1 (AC1) — all six scope areas present.**
  Open the deliverable on the spec branch and confirm a section for EACH of: (1) schema
  mapping, (2) store/module migration path, (3) `fredo.db` data migration/backfill,
  (4) startup/lifecycle, (5) packaging/install, (6) rollback/reversibility. Each states a
  chosen approach OR a named blocker.
  **Expected:** six distinct areas, each non-empty and approach-or-blocker bearing. The
  "do not re-litigate whether to migrate" non-goal is allowed as its own section but does
  NOT count as one of the six. **FAIL** = any area absent, placeholder ("TBD"/no blocker),
  or two areas collapsed into one heading.

- [ ] **F-2 (AC1) — each area names files/modules (`file:line`).**
  For every citation, Read the cited path and check the line is in range.
  **Expected:** the store/module area cites real files under `infrastructure/storage/*`,
  `infrastructure/rtdb/store.rs`, `infrastructure/feature_data/*`; the schema and
  data-migration areas name every `fredo.db` store — AppStore KV, FeatureStore `feature_*`,
  canonical `chat_rows`, `tool_use_rows`, `agent_session_rows`, `telemetry_spans`. Every
  cited path resolves on `main`. **FAIL** = dangling path/line, bare wildcard with no
  concrete file, or a prose file name with no line ref where one is clearly available.

- [ ] **F-3 (AC2) — regression → position table covers every #2948 regression.**
  Open the regression section; reconcile each number with
  `spikes/2948-embedded-postgres/results/measurements.json`.
  **Expected:** EVERY one of the six named categories carries a position — (1) cold start
  +9,724.8 ms (~260×), (2) peak RSS 8.2× / +232.7 MiB, (3) install +164 MB AND data dir
  +57.8 MiB (one combined row or two, both numbers present), (4) batch upsert ~5.4× slower,
  (5) point read ~12–15× slower, (6) range read ~1.2–1.6× faster — each with an explicit
  **mitigate / accept / re-measure** position + one-line rationale, PLUS the `pg.stop()` ~11 h
  teardown hang positioned. Extra rows are allowed. **FAIL** = any named category silently
  unaddressed, "address later" with no named re-measure trigger, install+data-dir with one
  number missing, range read stated as slower, or the `pg.stop()` hang absent.

- [ ] **F-4 (AC3) — PoC vs written design, stated with why.**
  **Expected:** the deliverable explicitly states which was produced and WHY. Design-only:
  names every changed file AND its new contract. PoC: reproducible, self-contained, changes
  no production path. **FAIL** = both claimed and neither complete; a "design" naming only
  modules without per-file contracts; a PoC claimed with no committed source.

- [ ] **F-5 (AC4) — open questions list blocking reason + resolving evidence.**
  Enumerate the open-questions section.
  **Expected:** each entry = question + why it blocks the follow-up implementation spec +
  what evidence resolves it. **FAIL** = entry missing either half, or zero entries with no
  justification.

- [ ] **F-6 (AC4) — `runtime-download` vs `bundled` carries a position.**
  **Expected:** a stated position on acquisition mode (`runtime-download` = network on first
  run; `bundled` = compile-time/offline and changes the +164 MB picture) OR a named reason
  it stays open + resolving evidence (#2948 exercised only `runtime-download`). **FAIL** =
  options restated with no position and no named reason; unqualified "bundled is better"
  with no evidence.

- [ ] **F-7 (AC5) — data preserved + named parity check.**
  **Expected:** states how AppStore KV, FeatureStore `feature_*`, canonical `chat_rows` /
  `tool_use_rows` / `agent_session_rows`, and `telemetry_spans` are carried across; names
  parity check(s) = row counts and/or content checksums; covers the strictly READ-ONLY
  `telemetry_spans` path and the one-shot markers (`rtdb.backfill.completed`, provider `.v2`
  marker) so backfill work is not duplicated/raced. **FAIL** = store omitted; "compare"
  with no count/checksum mechanism; markers unaddressed.

- [ ] **F-8 (AC5) — rollback/backout + cutover mode.**
  **Expected:** a defined backout path to SQLite + the parity verification that proves
  cutover preserved data; cutover decided (one-shot vs dual-write) WITH justification OR
  left open with a named blocker. **FAIL** = "restore a backup" with no SQLite steps; a path
  that cannot execute because the old engine/data is gone; no decision AND no blocker.

- [ ] **F-9 (G-263/G-264) — PoC reproducible: bounded run + guaranteed teardown (edge/negative).**
  If a PoC was produced, EXECUTE the exact committed command (no undocumented steps) under a
  finite wall-clock timeout; after exit check `Get-Process postgres` / `tasklist`; also
  exercise the timeout/panic/kill path.
  **Expected:** run completes within its declared finite bound; memory bounded; no orphan
  `postgres.exe` after normal OR forced exit; the timeout/panic path kills the child. The
  observed ~11 h `pg.stop()` hang is a designed-for failure mode with a bounded stop.
  **FAIL** = unbounded/blocking wait; orphaned `postgres.exe`; a run that never terminates
  (FAIL, not a skip). If the PoC only runs in `runtime-download` and the sandbox has no
  network, fall back to the committed `results/` AND record the blocker — do not PASS on
  inspection alone. **F-9 is N/A (vacuously green) iff NO PoC was produced** — the AC3
  design-only fallback, stated in the deliverable.

- [ ] **F-10 (non-goal) — no production code path changed + build-gate parity.**
  Inspect the spec-branch diff vs `main`; if any tracked file is touched run both gates.
  **Expected:** no hunk in `infrastructure/storage/*`, `infrastructure/rtdb/*`,
  `infrastructure/feature_data/*`, `telemetry_spans`/`sqlx` code, row wire types,
  `apps/tauri/src-tauri/Cargo.toml`, `fredo.db` migrations; any PoC isolated (`spikes/…`),
  not a workspace member, not wired into `lib.rs`/`AppRuntime`. If a tracked file is touched:
  `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml` zero warnings AND
  `pnpm --filter @fredo/ui build` exit 0, zero TS errors. **FAIL** = formatting-only
  production edit (still counts), dependency leak, or either gate red.

- [ ] **F-11 (non-functional) — time-box + Windows-first + hygiene.**
  **Expected:** deliverable states the 3-working-day time-box and whether it was met (or the
  overrun + cause); Windows-first (names `postgres.exe`/`pg_ctl`/data-dir path + Windows
  lifecycle); EOL/security posture of the vendored PG build acknowledged or an open question.
  **FAIL** = a Unix-only design assuming Linux; scope beyond the six areas + ACs with no
  blocker.

- [ ] **F-12 (evidence hygiene) — artifacts committed on the branch.**
  **Expected:** design doc, PoC source, and PoC `results/` committed on the spec branch;
  `.opencode/tmp/<issue>/` is not evidence; every quoted prior-spike number resolves to
  `spikes/2948-embedded-postgres/results/measurements.json` or a committed new `results/`
  file. **FAIL** = evidence only under gitignored `/tmp`; a number with no source artifact.

## Suite-level pass/fail

PASS overall = F-1, F-3, F-4, F-7, F-8, F-9, F-10 all green; F-2, F-5, F-6, F-11, F-12
green (a named blocker is admissible only inside F-1 areas, F-6 acquisition mode, and F-8
cutover mode — never in F-3, F-7, F-9, F-10). F-9 is vacuously green when no PoC was produced
(the AC3 design-only fallback). Any production-path change, any unbounded/non-terminating PoC,
any orphaned `postgres.exe`, or a regression table missing a named #2948 category = FAIL.
