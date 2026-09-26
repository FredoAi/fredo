# persistence-spike — Smoke

Feature: embedded PostgreSQL vs embedded SQLite evaluation. Issue #2948 (SPIKE). Quick
sanity checks before deeper testing. This spike has **no UI surface** and ships **no
production code**, so the standard app-boot smoke is reduced to build-green + PoC-runnable
sanity. Per the README, any future spec that gives this feature a UI/runtime surface must
restore the app-boot checks (S-1..S-5 boilerplate).

## Cases

- [x] **S-1: production app builds — Rust.** `cargo check` in `apps/tauri/src-tauri`
  completes with zero errors and zero warnings.
  **Expected:** identical to `main`; spike is not a workspace member.
  **Round 1 (2026-09-26) result: PASS.** `Finished \`dev\` profile [unoptimized + debuginfo]
  target(s) in 1m 27s` (exit 0, zero warnings/errors).

- [x] **S-2: production app builds — UI.** `pnpm --filter @fredo/ui build` exits 0 with no
  TypeScript errors. **Expected:** unchanged from `main`.
  **Round 1 (2026-09-26) result: PASS.** `✓ 2624 modules transformed` / `✓ built in 9.77s`
  (exit 0; only the pre-existing Vite chunk-size advisory).

- [x] **S-3: PoC command is reachable and documented.** The committed reproducible-steps
  doc names a single copy-pasteable command + working dir; the referenced script/source
  exists at that path on the spec branch.
  **Expected:** both present and consistent. **FAIL:** missing file or steps that do not
  match the committed command.
  **Round 1 (2026-09-26) result: PASS.** `README.md:34-112` names the working dir
  (`spikes/2948-embedded-postgres`) and the exact commands (`cargo build --release --bins`,
  `cargo run --release --bin poc`, `cargo run --release --bin measure`); all four bins are
  declared in `Cargo.toml:17-31` and present under `src/`.

- [ ] **S-4: PoC smoke run.** Execute the documented PoC command once; it exits 0 and
  prints both a write and a read result.
  **Expected:** write-then-read success (heading for T-QA-1 / F-1).
  **Round 1 (2026-09-26): NOT RUN — bounded-run directive.** The runtime binaries were not
  executed (the unbounded `pg.stop()` previously hung ~11 h). Runtime evidence is the
  committed measured run (`results/measurements.json`: PG started, upserted, read back 9000
  rows). Covered by F-1.

- [x] **S-5: evidence artifacts committed.** The raw numbers file, 9-question answer set,
  and decision record exist at their committed paths and are non-empty.
  **Expected:** all three present. **FAIL:** any missing or uncommitted (an artifact only
  under `.opencode/tmp/` does not count).
  **Round 1 (2026-09-26) result: PASS.** `results/measurements.json` (119 lines),
  `QUESTIONS.md` (139 lines, Q1–Q9), `docs/research/2948-embedded-postgres-spike.md`
  (187 lines) all on `origin/spec/2948`.

- [x] **S-6: no-app-runtime-wiring.** Grep `lib.rs` / `AppRuntime` / `apps/tauri/Cargo.toml`
  for the spike crate name → zero references.
  **Expected:** spike is completely isolated from production.
  **Round 1 (2026-09-26) result: PASS.** `grep
  postgresql_embedded|postgresql-embedded|embedded-postgres-spike` over `apps/` → No files
  found; `apps/tauri/src-tauri/Cargo.toml` unchanged in the diff.

## Round 1 (2026-09-26) outcome

**PASS (S-1, S-2, S-3, S-5, S-6 green; S-4 not run by bounded-run directive).** No UI
surface exists, so no app-boot/DOM/console smoke applies.
