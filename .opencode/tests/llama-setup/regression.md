# Llama Setup — Regression

> "Must not change" baseline for the guided llama.cpp setup wizard domain. Seeded at Spec #2855
> (the gating shell). These invariants MUST hold after the slice — any FAIL is a regression. Run
> on every testing phase that touches the Companion settings, the setup wizard, or the model-file
> surface.
> **Verification policy: live** — the companion gating and the install flow are only observable on
> a running app; the tester's Evidence MUST reference `telemetry_spans` (via the functional F-16
> live leg) for a live verdict. A static-only PASS is a FALSE PASS.

## Must NOT change (regression invariants)

- [ ] **R-1 (existing companion controls survive when setup IS complete):** On a machine with both
      prerequisites satisfied, Companion settings still renders the existing controls —
      "Show Fredo Companion" toggle + the auto-return (idle-timeout) control + the teleport tip;
      the toggle still shows/hides the companion and persists `Fredo_companion_visible`; the idle
      timeout still persists. The gating may HIDE these only while not-set-up; it must never
      delete or break them in the complete state.
  - **Edge:** toggle off/on with the companion visible; the auto-return control is interactive
    (not stuck disabled); settings modal mounts cleanly. Reference `.opencode/tests/companion/`
    R-12..R-18 + functional F-21..F-28.

- [ ] **R-2 (`check_model_files` contract + consumers unchanged):** The command still returns
      `{ gguf_exists, mmproj_exists, gguf_path, mmproj_path }` (`commands.rs:969`) and its existing
      consumers still work — `CompanionSettingsPanel`'s model gate and `SetupWizard`'s `model`
      step (`SetupWizard.tsx:131`) both still resolve their state. The new per-prerequisite
      detection does not replace or mutate the `check_model_files` contract out from under them.
  - **Edge:** a GGUF-only / mmproj-only directory still yields the partial booleans; the `model`
    step in the standalone SetupWizard still reaches `done` when both files exist; the Rust
    command compiles with its `ModelFilesStatus` shape unchanged.

- [ ] **R-3 (`Model not downloaded` banner / `handleOpenSetup` removal is clean):** The UI/UX plan
      (§1/§6) deliberately DELETES the model-missing banner (`CompanionSettingsPanel.tsx:154-187`)
      and its `handleOpenSetup`/`setupFeature` import (`:108-119`) — the inline wizard owns the
      flow. This is an intentional supersede, NOT a regression; the invariant is that the removal
      is CLEAN: no dangling reference to `handleOpenSetup` / `setupFeature` / the banner copy
      remains anywhere, `CompanionSettingsPanel` compiles and mounts in BOTH the not-set-up and
      set-up states without a `ReferenceError`, and no other consumer broke.
  - **Edge:** grep the repo for `handleOpenSetup` / the removed banner string → zero orphaned
    references; mounting `CompanionSettingsPanel` on a models-missing machine does not throw (it
    now renders the wizard instead); the standalone `SetupWizard` (R-4) is unaffected.

- [ ] **R-4 (standalone Fredo Setup wizard unchanged):** The existing `SetupWizard`
      (`features/setup/components/SetupWizard.tsx`, the "Fredo Setup" nav item) still renders its
      steps and its `model` / `fredo-path` / `plugin-*` / `otel` actions still invoke the same
      commands. #2855 must not re-scope or break the standalone setup page.
  - **Edge:** `get_setup_plan` / `check_cli_installations` / `download_model` wiring unchanged;
    the standalone wizard opens from the nav.

- [ ] **R-5 (companion behavior untouched):** The companion overlay itself is unchanged —
      single-Fredo presence, auto-return, teleport, joke, TicTacToe, speech bubble, avatar
      geometry/animation. Reference `.opencode/tests/companion/` R-1..R-23 + functional
      F-1..F-29; the gating slice must not alter the overlay.
  - **Edge:** a wizard gate must not prevent the companion from rendering when it is legitimately
    enabled on a set-up machine.

- [ ] **R-6 (token contract):** No hardcoded hex/`rgba(`/`rgb(`/`hsla(` and no `var(--x)NN`
      alpha-append are introduced in the changed wizard/gating files; theme token → CSS var +
      `tint()` only. Reference `.opencode/tests/companion/` R-7 + theming suite.

- [ ] **R-7 (build gates):** `pnpm --filter @fredo/ui build` exits 0 with zero TS errors; if Rust
      is touched, `cargo check` has zero warnings; `pnpm --filter @fredo/ui test:run` is green.

## Overlapping prior-feature suites (run alongside)

- `.opencode/tests/companion/` — the settings panel + overlay whose content is gated (R-12..R-23,
  F-12/F-21..F-28).
- `.opencode/tests/desktop-shell/` — shell chrome + theming token contract; a settings-modal
  change must not disturb the shell.
- `.opencode/tests/theming/` — the token→var→theme flow the wizard must use for its colors.
- `.opencode/tests/launcher/` — the launcher/mascot slot is affected by companion visibility
  (R-16/R-20/R-22..R-25) — gating must not leave a blank mascot slot.
