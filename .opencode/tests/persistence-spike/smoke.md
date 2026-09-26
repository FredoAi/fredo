# persistence-spike — Smoke

Feature: embedded PostgreSQL vs embedded SQLite evaluation. Issue #2948 (SPIKE). Quick
sanity checks before deeper testing. This spike has **no UI surface** and ships **no
production code**, so the standard app-boot smoke is reduced to build-green + PoC-runnable
sanity. Per the README, any future spec that gives this feature a UI/runtime surface must
restore the app-boot checks (S-1..S-5 boilerplate).

## Cases

- [ ] **S-1: production app builds — Rust.** `cargo check` in `apps/tauri/src-tauri`
  completes with zero errors and zero warnings.
  **Expected:** identical to `main`; spike is not a workspace member.

- [ ] **S-2: production app builds — UI.** `pnpm --filter @fredo/ui build` exits 0 with no
  TypeScript errors. **Expected:** unchanged from `main`.

- [ ] **S-3: PoC command is reachable and documented.** The committed reproducible-steps
  doc names a single copy-pasteable command + working dir; the referenced script/source
  exists at that path on the spec branch.
  **Expected:** both present and consistent. **FAIL:** missing file or steps that do not
  match the committed command.

- [ ] **S-4: PoC smoke run.** Execute the documented PoC command once; it exits 0 and
  prints both a write and a read result.
  **Expected:** write-then-read success (heading for T-QA-1 / F-1).

- [ ] **S-5: evidence artifacts committed.** The raw numbers file, 9-question answer set,
  and decision record exist at their committed paths and are non-empty.
  **Expected:** all three present. **FAIL:** any missing or uncommitted (an artifact only
  under `.opencode/tmp/` does not count).

- [ ] **S-6: no-app-runtime-wiring.** Grep `lib.rs` / `AppRuntime` / `apps/tauri/Cargo.toml`
  for the spike crate name → zero references.
  **Expected:** spike is completely isolated from production.
