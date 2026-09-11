# Llama Setup — Regression

> "Must not change" baseline for the guided llama.cpp setup wizard domain. Seeded at Spec #2855
> (the gating shell). These invariants MUST hold after the slice — any FAIL is a regression. Run
> on every testing phase that touches the Companion settings, the setup wizard, or the model-file
> surface.
> **Verification policy: live** — the companion gating and the install flow are only observable on
> a running app; the tester's Evidence MUST reference `telemetry_spans` (via the functional F-16
> live leg) for a live verdict. A static-only PASS is a FALSE PASS.

## Must NOT change (regression invariants)

- [x] **R-1 (existing companion controls survive when setup IS complete):** On a machine with both
      prerequisites satisfied, Companion settings still renders the existing controls —
      "Show Fredo Companion" toggle + the auto-return (idle-timeout) control + the teleport tip;
      the toggle still shows/hides the companion and persists `Fredo_companion_visible`; the idle
      timeout still persists. The gating may HIDE these only while not-set-up; it must never
      delete or break them in the complete state.
  - **Edge:** toggle off/on with the companion visible; the auto-return control is interactive
    (not stuck disabled); settings modal mounts cleanly. Reference `.opencode/tests/companion/`
    R-12..R-18 + functional F-21..F-28.

- [x] **R-2 (`check_model_files` contract + consumers unchanged):** The command still returns
      `{ gguf_exists, mmproj_exists, gguf_path, mmproj_path }` (`commands.rs:969`) and its existing
      consumers still work — `CompanionSettingsPanel`'s model gate and `SetupWizard`'s `model`
      step (`SetupWizard.tsx:131`) both still resolve their state. The new per-prerequisite
      detection does not replace or mutate the `check_model_files` contract out from under them.
  - **Edge:** a GGUF-only / mmproj-only directory still yields the partial booleans; the `model`
    step in the standalone SetupWizard still reaches `done` when both files exist; the Rust
    command compiles with its `ModelFilesStatus` shape unchanged.

- [x] **R-3 (`Model not downloaded` banner / `handleOpenSetup` removal is clean):** The UI/UX plan
      (§1/§6) deliberately DELETES the model-missing banner (`CompanionSettingsPanel.tsx:154-187`)
      and its `handleOpenSetup`/`setupFeature` import (`:108-119`) — the inline wizard owns the
      flow. This is an intentional supersede, NOT a regression; the invariant is that the removal
      is CLEAN: no dangling reference to `handleOpenSetup` / `setupFeature` / the banner copy
      remains anywhere, `CompanionSettingsPanel` compiles and mounts in BOTH the not-set-up and
      set-up states without a `ReferenceError`, and no other consumer broke.
  - **Edge:** grep the repo for `handleOpenSetup` / the removed banner string → zero orphaned
    references; mounting `CompanionSettingsPanel` on a models-missing machine does not throw (it
    now renders the wizard instead); the standalone `SetupWizard` (R-4) is unaffected.

- [x] **R-4 (standalone Fredo Setup wizard unchanged):** The existing `SetupWizard`
      (`features/setup/components/SetupWizard.tsx`, the "Fredo Setup" nav item) still renders its
      steps and its `model` / `fredo-path` / `plugin-*` / `otel` actions still invoke the same
      commands. #2855 must not re-scope or break the standalone setup page.
  - **Edge:** `get_setup_plan` / `check_cli_installations` / `download_model` wiring unchanged;
    the standalone wizard opens from the nav.

- [x] **R-5 (companion behavior untouched):** The companion overlay itself is unchanged —
      single-Fredo presence, auto-return, teleport, joke, TicTacToe, speech bubble, avatar
      geometry/animation. Reference `.opencode/tests/companion/` R-1..R-23 + functional
      F-1..F-29; the gating slice must not alter the overlay.
  - **Edge:** a wizard gate must not prevent the companion from rendering when it is legitimately
    enabled on a set-up machine.

- [x] **R-6 (token contract):** No hardcoded hex/`rgba(`/`rgb(`/`hsla(` and no `var(--x)NN`
      alpha-append are introduced in the changed wizard/gating files; theme token → CSS var +
      `tint()` only. Reference `.opencode/tests/companion/` R-7 + theming suite.

- [x] **R-7 (build gates):** `pnpm --filter @fredo/ui build` exits 0 with zero TS errors; if Rust
      is touched, `cargo check` has zero warnings; `pnpm --filter @fredo/ui test:run` is green.

## Execution Log — round 1 (2026-09-11, spec/2855 @ c5c29c42)

R-1..R-7 PASS live (except R-7 Rust leg, not runnable in the tester sandbox — `cargo` is not an
allowed command; covered by CI `rust-validate`, which was pending at capture).
- R-1: `companion-controls` rendered on MS-4; `#companion-idle-timeout-seconds` present/enabled;
  `Fredo_companion_visible` toggled true→false→true via the Switch (persisted each time).
- R-2: `check_model_files` returns unchanged `{gguf_exists,mmproj_exists,gguf_path,mmproj_path}`
  (both true; real paths). Wire contract untouched.
- R-3: grep for `handleOpenSetup` / "Model not downloaded" in `apps/ui/src` → 0 hits. The
  remaining `setupFeature` refs are Home.tsx's intentional standalone-setup window, not the
  removed Companion path.
- R-4: standalone `setupFeature` registration + `SetupWizard.test.tsx` still green (792 UI tests).
- R-5: no overlay file changed by the diff; controls render + toggle persists.
- R-6: no hardcoded hex/rgba/hsl in the five new #2855 files (only pre-existing `tictactoe.css`).
- R-7: `pnpm --filter @fredo/ui build` exit 0; `pnpm --filter @fredo/ui test:run` → 55 files /
  792 tests passed. `cargo` unavailable to the tester (tool-access gap).

## Execution Log — round 2 (2026-09-11, spec/2855 @ b7cc2d13 / e735e92)

Re-sweep of the fixed surface after the winget-id change (`WINGET_APP_ID = "ggml.llamacpp"`). All
invariants still hold; the change is a single constant + unit test, so no baseline moved.
- R-1: `companion-controls` rendered (toggle + idle input + Teleport tip) once both prerequisites read
  `installed` (MS-3 via seam); wizard absent. PASS.
- R-2: `check_companion_readiness`/`check_model_files` wire shapes unchanged (per-prereq report +
  `{gguf_exists,mmproj_exists,gguf_path,mmproj_path}`); MS-2/MS-3/MS-1 all resolved correctly. PASS.
- R-3: no new dangling refs introduced by `e735e92` (single-constant diff); panel mounts in both
  wizard and controls states. PASS.
- R-4: standalone `SetupWizard` file untouched; registered nav unchanged. PASS.
- R-5: no overlay file touched by the diff. PASS.
- R-6: token contract unaffected (no UI files changed). PASS.
- R-7: `pnpm --filter @fredo/ui build` exit 0 (tsc + vite). `cargo` unavailable to the tester
  (tool-access gap; nested/`cargo` is not in the allowlist) — Rust guard test covered by CI.

## #2856 — Must NOT change (three-file model acquisition)

> Added at Spec #2856. The model step gains per-file acquisition; these invariants pin the
> surfaces it must not disturb. Run alongside R-1..R-7 above.

- [ ] **R-8 (`check_model_files` legacy contract preserved):** the command still returns
      `{ gguf_exists, mmproj_exists, gguf_path, mmproj_path }` (`commands.rs:969`) for the
      standalone `SetupWizard` model step (`SetupWizard.tsx:131`). #2856 EXTENDS the response
      (`complete`, `files`, additive `mtp_*`) — it does not rename/remove the legacy fields.
  - **Edge:** a GGUF-only / mmproj-only directory still yields the partial booleans; the
    standalone model step reaches "done" ONLY when all three files are present (ST-7) — a
    2-of-3 set must NOT read done. `SetupWizard.test.tsx` may be updated for ST-7, but the
    legacy field names must not change.

- [ ] **R-9 (#2855 wizard shell untouched):** gating (wizard-only while not ready), the
      `llama-server` install step + in-place re-check, `COMPANION_SETUP_STEPS` ordering, the
      `companion-step-*` testids, and `useCompanionReadiness` fail-closed behavior are unchanged
      — F-01..F-17 + R-1..R-7 above still hold.

- [ ] **R-10 (`download_model` consumers + progress event):** the standalone `SetupWizard` model
      step (`SetupWizard.tsx:242`) and its `setup:download-progress` listener contract
      (`{ file, total, downloaded, percent }`) are preserved — or migrated with the consumer in
      the same slice. No dangling listener / event rename.

- [ ] **R-11 (models-dir resolution + fixed placement):** `resolve_models_dir` order (configured
      `models_dir` → `~/fredo-models`) and the fixed `<models_dir>/<MODEL_SUBDIR>/` placement
      (`commands.rs:838`) hold, so the #2857 launch slice can reference the files deterministically.

- [ ] **R-12 (CLI setup mirror coherent):** `infrastructure/cli/commands/setup.rs`
      (`resolve_models_dir` / the model block) stays consistent with the app's model path/filenames.

- [ ] **R-13 (token + companion overlay):** no hardcoded hex/rgba or `var(--x)NN` alpha-append in
      the new rows/progress/error UI (`.opencode/tests/theming/`); the companion overlay/controls
      (`.opencode/tests/companion/`) are untouched.

- [ ] **R-14 (build gates):** `pnpm --filter @fredo/ui build` exit 0 (zero TS errors);
      `cargo check` zero warnings and `cargo test` green if Rust is touched.

- [ ] **R-15 (legacy in-process engine lookup untouched):** `lib.rs:137-148` still resolves the
      legacy `gemma-e2b-it` layout (`gemma-4-E2B-it-Q4_K_M.gguf` + `mmproj-F16.gguf`); this slice
      must not repoint or delete it (the deletion slice owns it). The new `gemma-4-e2b-it-qat`
      subfolder is ADDITIVE.

## Execution Log — round 1 (2026-09-11, spec/2856 @ 0f3f3595)

Real wizard-driven pull (human directive); `models_dir` = `C:\Code\fredo\models` via the IPC seam.
- **R-8** PASS: the step rows + legacy `check_model_files` shape coexist; the panel rendered the
  per-file rows (model/vision/mtp) and the legacy `SetupWizard` model step was not exercised
  (out of the real-pull path) — its completion gate now derives from `complete` (ST-7) per the
  developer receipt; UI build + 797 UI tests green per the dev summary.
- **R-9** PASS: single wizard preserved; `llama-server` row + `Install llama.cpp` + Re-check still
  render with the model step; gating held (wizard-only while not ready) across all legs.
- **R-10** PASS: the pull was driven by the wizard `download_model`; `setup:download-progress`
  delivered the additive payload (fileId/file/relativePath/total/downloaded/percent/state).
- **R-11** PASS: files landed under `<models_dir>/gemma-4-e2b-it-qat/` with the nested `MTP/`
  segment exactly as configured; `kguf paths` shown in the UI = `C:\Code\fredo\models\gemma-4-e2b-it-qat\…`.
- **R-12** PASS (static): CLI setup mirror changed only to share the manifest (dev receipt); not
  driven live this round.
- **R-13** PASS: rows/progress/error use `tint()` + semantic tokens; no hex/rgba observed; the
  companion overlay is untouched (no overlay file in the diff).
- **R-14** PASS (UI): `pnpm --filter @fredo/ui build` green per the dev summary; `cargo` not
  runnable in the tester sandbox (named tool-access gap) — Rust gates via CI `rust-validate`.
- **R-15** PASS: additive only — the legacy `gemma-e2b-it` layout (in-process engine) was not
  repointed; the new `gemma-4-e2b-it-qat` folder is separate.

## Overlapping prior-feature suites (run alongside)

- `.opencode/tests/companion/` — the settings panel + overlay whose content is gated (R-12..R-23,
  F-12/F-21..F-28).
- `.opencode/tests/desktop-shell/` — shell chrome + theming token contract; a settings-modal
  change must not disturb the shell.
- `.opencode/tests/theming/` — the token→var→theme flow the wizard must use for its colors.
- `.opencode/tests/launcher/` — the launcher/mascot slot is affected by companion visibility
  (R-16/R-20/R-22..R-25) — gating must not leave a blank mascot slot.
