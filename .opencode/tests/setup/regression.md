# setup — Regression

> "Must not change" baseline for the Setup auto-open removal + launcher tile (Issue #3010).
> Run on the `spec/3010` tip. **Verification policy: live** — a static-only PASS is a FALSE PASS.

## R-1 — Home desktop does NOT open Setup on mount (regression pin, G-123 continuous)

- [ ] R-1: Mount the Home desktop with `plugin_installed` UNSET (the falsy condition that used to
      fire) and advance timers past 1200 ms.
  **Expected:** NO Setup window opens; `settingsService.get` is never called with `plugin_installed`.
  - **Static unit pin (ST-3, non-AC):** `apps/ui/src/applications/home/components/__tests__/Home.noAutoSetup.test.tsx`
    mounts Home, advances fake timers, asserts no Setup window + no `plugin_installed` read — must
    PASS unmodified.
  - **Live leg:** F-1 (fresh boot, samples +0 / +1.4 s / +5 s) and F-7(a).
  - **Edge:** reload (`Ctrl+R`) re-holds; boot with an empty/fresh store.

## R-2 — The launcher grid still enumerates the live feature registry (no hardcoded list)

- [ ] R-2: The grid tiles equal `SHOWABLE_FEATURES.map(f => f.name)` for the tested tip; the
      `setup` feature is registered exactly once (no ghost/duplicate tile). Reference
      `.opencode/tests/launcher/regression.md` R-2 and `.opencode/tests/launcher/functional.md` F-48.
  - **Edge:** `dedupeByApplicationId` still keeps one tile per id.

## R-3 — Existing feature opens are unchanged

- [ ] R-3: The tile routes through the SHIPPED `onOpenFeature` → `openApp` → `createAppOpener`
      path (no new window-dedup logic); re-invoke focuses/restores the same window. Reference
      `.opencode/tests/launcher/regression.md` R-3/R-8 and `.opencode/tests/window-manager/`.
  - **Edge:** presentation default stays `same-window` (no per-app default override added).

## R-4 — Settings → Fredo Setup is not regressed

- [ ] R-4: The Settings nav id `plugin-setup` (label `Fredo Setup`) still renders `<SetupWizard/>`
      — the SettingsSurface suites that mock `SetupWizard` and assert the `plugin-setup` nav item
      must remain green, unmodified.
  - **Edge:** light + dark; section switch back and forth.

## R-5 — Boot path integrity (effect deletion must not break other boot work)

- [ ] R-5: After the effect removal, Home's remaining boot effects still run: feature registration,
      zone-layout hydration, presentation hydration; Mission Monitor renders live sessions on boot
      (F-7c). No dangling 1200 ms timer, console clean. Reference `.opencode/tests/window-manager/`
      F-38 and `.opencode/tests/desktop-shell/`.
  - **Edge:** re-render loop absent (`Maximum update depth exceeded` = 0).

---

## #3198 — must not change

> Seeded at triage for Spec #3198. These rows pin what the version gate / plugin install /
> OTLP-writer retirement MUST NOT break. Evidence: committed source (static) where the
> property is a shape, live where a user observes it.

## R-6 — the setup wire shape stays snake_case and additive

- [ ] R-6: read `CliCheckResult` / `SetupPlan` / `CheckAllSetupResult`
      (`apps/tauri/src-tauri/src/applications/setup/commands.rs:18-66`) and the consumed keys in
      `apps/ui/src/applications/setup/components/SetupWizard.tsx:107-146`.
  **Expected:** the structs still carry **no** `#[serde(rename_all)]`; the serialized JSON keys
      are snake_case (`fredo_path`, `in_path`, `binary_path`, `opencode_plugin_installed`,
      `opencode_configured`, `can_proceed`, `steps`); the new fields are `opencode_version`
      (opt-in, absent when undetermined) and `opencode_min_major`; every pre-existing key is
      still present (additive only).
  - **Edge:** an injected `rename_all` (camelCase) breaks the shipped wizard and must FAIL this
    row; a `null` `opencode_version` (instead of an absent key) is G-413 FAIL.

## R-7 — command names, registration and the wizard surface are unchanged

- [ ] R-7: `rg` the seven command names (`check_all_setup`, `get_setup_plan`,
      `check_cli_installations`, `install_plugin`, `run_setup_step`, `check_otel_configured`,
      `configure_otel`) in `lib.rs:985-994` and `runtime/command_manifest.rs:86-95`; open the
      Setup surface from the launcher tile and from Settings → `plugin-setup`.
  **Expected:** all seven registered exactly once, names unchanged; the rail/wizard surface is
      unchanged in structure (reuses `.opencode/tests/setup/functional.md` F-1..F-4); no new
      settings section, no token/layout change.
  - **Edge:** `install_plugin` stays `async`; the `fredo-path` and `model` steps untouched.

## R-8 — the not-found message is byte-identical

- [ ] R-8: `cargo test` the two pins `shell_not_found_message_names_the_shell`
      (`applications/terminal/commands.rs:1802`) and
      `resolve_binary_not_found_message_names_opencode` (`:1825`), and grep the literal
      `` `opencode` not found in PATH `` (`:196-197`).
  **Expected:** both tests green, unmodified; the string still reads
      "`opencode` not found in PATH. Install OpenCode from https://opencode.ai or via your package
      manager." — the version gate adds a SEPARATE blocked message (terminal suite F-92) and must
      not edit this one.
  - **Edge:** a launch where the binary is genuinely missing must still produce this string.

## R-9 — the docs stop teaching the retired mechanism without losing the true claims

- [ ] R-9: `rg -n "OPENCODE_(OTLP_ENDPOINT|ENABLE_TELEMETRY|OTLP_PROTOCOL)" docs/` and
      `rg -n "per project|works with OpenCode" docs/ CHANGELOG.md`.
  **Expected:** no shipped doc instructs the user to export the three variables as the capture
      setup (historical/ledger mentions in `research/`, `docs/agentic-pipeline/**` are out of
      scope and may stay); zero "install the plugin in each project" and zero unqualified
      "works with OpenCode"; the true claims are PRESENT (functional F-20/F-21).
  - **Edge:** a doc that mentions the variables only to say they are no longer needed is a PASS
    (it must say so); silent deletion that also drops the "global plugin" claim is a FAIL.
