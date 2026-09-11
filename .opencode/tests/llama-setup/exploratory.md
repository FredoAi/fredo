# Llama Setup — Exploratory

> Unscripted edge/failure probes for the guided llama.cpp setup wizard domain. Seeded at Spec
> #2855. A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin
> note). These are probes, not pass/fail ACs — the tester explores, then promotes anything that
> turns out to be a real invariant.
> **Verification policy: live** — probes run on a running app + real/simulated host commands.

## Probes

- [ ] **E-01 — PATH refresh after a real install.** Install llama.cpp via winget (if permitted)
      while Fredo is running; immediately re-check WITHOUT restarting Fredo. Does detection see the
      new `llama-server`, or is the running process's PATH stale (install dir not yet on process
      env)? Probe whether the wizard re-resolves PATH fresh or caches it at start. Record the
      expected-vs-actual. A "still missing until restart" is the likely correct behavior (F-14);
      a false "complete" is a finding.
  - Prompt: `winget install llama.cpp` then re-check; also try the WinGet-Links `%LOCALAPPDATA%\
    Microsoft\WinGet\Links` refresh after a new shell. Tool: `tauri_ipc_monitor` + DOM read +
    `tauri_read_logs`.

- [ ] **E-02 — Partial readiness combinations.** Build MS-2 (server-only) and MS-3 (models-only)
      with a PATH stub + file moves; toggle between all four combinations (neither, server-only,
      models-only, both) by adding/removing a stub and the model files. Does the gate flip
      correctly at each boundary, with no stale "complete"?
  - Prompt: state transitions while the settings modal stays open; a file added/removed between
    checks.

- [ ] **E-03 — Detection error state.** Make the `llama-server` probe error (empty PATH / a `where`
    that exits non-zero unexpectedly) and the model probe error (models dir unreadable). Does the
    wizard surface an error/detection-failed state for that prerequisite, and does it never read
    "complete"?
  - Prompt: deny-list / rename a binary; a locked/permission-denied models dir.

- [ ] **E-04 — Re-check / re-click while an install is running.** Double-click the install action;
    click another install/retry while one is in flight; navigate away and back mid-install. Are
    concurrent installs prevented (button disabled / guard)? No duplicated commands, no corrupted
    state?
  - Prompt: `tauri_ipc_monitor` counts of the install command; DOM disabled state; console.

- [ ] **E-05 — winget present but the install fails (network blocked / package missing).** Force a
    non-zero winget exit or no-network; does the wizard show the real tail and stay not-set-up?
  - Prompt: block the source, or use a shim that exits non-zero with a message.

- [ ] **E-06 — Close the window / cancel mid-install.** Close the settings modal (or the app)
      while the install is running; reopen. Any orphan process, wedge, stale spinner, or
      "complete" from a partially-run install?
  - Prompt: kill/close during the spinner; check for lingering `winget` processes.

- [ ] **E-07 — Partial model files.** Only `gemma-4-E2B-it-Q4_K_M.gguf` present, or only
      `mmproj-F16.gguf`. Does the model-files prerequisite treat this as missing (not present)?
      Does the wizard name which file is missing?
  - Prompt: add one file at a time; read the row detail.

- [ ] **E-08 — Models in a non-default / custom directory.** Point the models dir elsewhere
      (or place files in a custom path); does detection honor the configured location the same way
      `check_model_files` does?
  - Prompt: read `gguf_path`/`mmproj_path` from `check_model_files` for the actual dir; move files.

- [ ] **E-09 — Multiple `llama-server` on PATH.** A real binary plus a WindowsApps false-positive
      (or vice versa). Does the wizard resolve the correct/usable one and not report a broken stub
      as usable?
  - Prompt: order the PATH; add a stub that exits 127.

- [ ] **E-10 — Long path / spaces / Unicode in the models dir.** Does detection + the wizard handle
      a path with spaces and non-ASCII without crashing or mangling the label?
  - Prompt: a models subdir with spaces.

- [ ] **E-11 — Theme + error legibility.** Render the wizard (including the error state) in light
      and dark presets; is the error text/action legible (≥ 4.5:1) and token-native?
  - Prompt: `ThemePresetSelector`, then trigger an install failure.

- [ ] **E-12 — Install → re-check → transition without reopen.** From a not-set-up modal, run a
      successful install; watch the wizard swap to the normal controls with the modal open. Any
      flicker, stale state, or need to reopen?
  - Prompt: continuous DOM poll across the transition; `performance.timeOrigin` unchanged.
