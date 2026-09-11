# Llama Setup — Exploratory

> Unscripted edge/failure probes for the guided llama.cpp setup wizard domain. Seeded at Spec
> #2855. A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin
> note). These are probes, not pass/fail ACs — the tester explores, then promotes anything that
> turns out to be a real invariant.
> **Verification policy: live** — probes run on a running app + real/simulated host commands.

## Probes

- [x] **E-01 — PATH refresh after a real install.** (verified round 2) Install llama.cpp via winget (if permitted)
      while Fredo is running; immediately re-check WITHOUT restarting Fredo. Does detection see the
      new `llama-server`, or is the running process's PATH stale (install dir not yet on process
      env)? Probe whether the wizard re-resolves PATH fresh or caches it at start. Record the
      expected-vs-actual. A "still missing until restart" is the likely correct behavior (F-14);
      a false "complete" is a finding.
  - Prompt: `winget install llama.cpp` then re-check; also try the WinGet-Links `%LOCALAPPDATA%\
    Microsoft\WinGet\Links` refresh after a new shell. Tool: `tauri_ipc_monitor` + DOM read +
    `tauri_read_logs`.

- [x] **E-02 — Partial readiness combinations.** Build MS-2 (server-only) and MS-3 (models-only)
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

- [x] **E-04 — Re-check / re-click while an install is running.** Double-click the install action;
    click another install/retry while one is in flight; navigate away and back mid-install. Are
    concurrent installs prevented (button disabled / guard)? No duplicated commands, no corrupted
    state?
  - Prompt: `tauri_ipc_monitor` counts of the install command; DOM disabled state; console.

- [x] **E-05 — winget present but the install fails (network blocked / package missing).** Force a
    non-zero winget exit or no-network; does the wizard show the real tail and stay not-set-up?
  - Prompt: block the source, or use a shim that exits non-zero with a message.

- [ ] **E-06 — Close the window / cancel mid-install.** Close the settings modal (or the app)
      while the install is running; reopen. Any orphan process, wedge, stale spinner, or
      "complete" from a partially-run install?
  - Prompt: kill/close during the spinner; check for lingering `winget` processes.

- [x] **E-07 — Partial model files.** Only `gemma-4-E2B-it-Q4_K_M.gguf` present, or only
      `mmproj-F16.gguf`. Does the model-files prerequisite treat this as missing (not present)?
      Does the wizard name which file is missing?
  - Prompt: add one file at a time; read the row detail.

- [x] **E-08 — Models in a non-default / custom directory.** Point the models dir elsewhere
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

- [x] **E-12 — Install → re-check → transition without reopen.** From a not-set-up modal, run a
      successful install; watch the wizard swap to the normal controls with the modal open. Any
      flicker, stale state, or need to reopen?
  - Prompt: continuous DOM poll across the transition; `performance.timeOrigin` unchanged.

## Findings — round 1 (2026-09-11, spec/2855 @ c5c29c42)

Machine states were constructed through the backend `save_setting`/`get_setting` seams
(`models_dir`, `llama_server_path`) — least-destructive; no user files moved and no system PATH
changes. `llama_server_path` is the resolver's documented branch #1; the stub is a scratch file
under `.opencode/tmp/2855/`. All originals restored (both keys reset to `""`; companion toggle
back to `true`).

- **E-02 (verified):** toggled MS-3 → MS-2 → MS-1 → MS-4 via settings + Re-check; the gate flipped
  correctly at each boundary (`1 of 2 prerequisites ready` for both partial directions, `2
  prerequisites need attention` for neither, `companion-controls` only at both-installed). No stale
  "complete".
- **E-04 (verified):** during the in-flight install the button was `disabled` with
  `aria-busy="true"` and an indeterminate `role="progressbar"`; a second click cannot fire (plus the
  hook's synchronous `runningRef` guard).
- **E-05 (verified — turned into a FAIL finding):** `winget install --id llama.cpp -e` returns
  `"No package found matching input criteria."` The exact id does not exist; the canonical winget
  PackageIdentifier is **`ggml.llamacpp`** (PackageName `llama.cpp`). The wizard correctly renders
  the actionable error and stays not-set-up (AC5 behavior), but the one-click install can never
  succeed. **Promoted to `functional.md` F-17 (FAIL).**
- **E-07 (verified):** a models dir with only the GGUF reports modelFiles `missing` with detail
  `"1 of 2 model files present."` — partial files are not "present".
- **E-08 (verified):** detection honours the configured `models_dir` (tested against two custom
  scratch dirs) identically to the default.
- **E-12 (verified via the Re-check path):** with the modal open, an in-place re-probe flipped the
  panel from wizard (llama missing) to `companion-controls` with `performance.timeOrigin` unchanged
  and navigation count = 1. The install-driven entry to this transition is blocked by the E-05
  defect.
- **E-06 (not executed):** closing/cancelling the modal mid-install was not exercised.
- **E-09/E-10/E-11 (not executed):** multiple `llama-server` on PATH, Unicode/spaces in the models
  dir, and theme/legibility of the error row were not probed this round.

## Findings — round 2 (2026-09-11, spec/2855 @ b7cc2d13)

- **E-01 (verified):** a real `winget install` of `ggml.llamacpp` extracted `llama-server.exe` under
  `%LOCALAPPDATA%\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\`,
  but the running Fredo process did NOT see it: `check_companion_readiness` stayed `missing` across the
  in-session re-probe. Confirmed expected behavior (F-14) — the running process's PATH is stale.
- **E-05 (verified — now fixed):** with the corrected id the real verb no longer returns
  "No package found matching input criteria." Instead it installs the package; a repeat install of the
  same version returns winget's non-zero "No available upgrade found." (row `error`, actionable). The
  round-1 E-05 defect is closed by `e735e92`.
- **E-13 (verified, environment/package fact — no product defect in scope):** `ggml.llamacpp` is
  `InstallerType: zip` + `NestedInstallerType: portable`, and winget created **no** shim in
  `%LOCALAPPDATA%\Microsoft\WinGet\Links` (read-only FS listing returned `[]`). The resolver's branch
  #3 (`winget_links_shim()`) therefore never matches for this package on this host; the fresh-process
  branch #2 (`where llama-server`) is the only PATH path and is stale until restart. This is what makes
  the real-install-only re-probe `missing` (F-14). Recorded so #2856/#2857 do not assume a Links shim
  exists.
- **E-06/E-09/E-10/E-11 (not executed):** unchanged from round 1.

## Probes — #2856 (three-file model acquisition)

> Unscripted probes for the per-file download surface. Promote any confirmed invariant to
> `functional.md` (Spec #2856). Drive with the stub base URL / manifest override and the
> `.opencode/tmp/2856/stub-server/` modes — never a real multi-GB download.

- [ ] **E-14 — File collision / corruption.** Put a pre-existing file with the RIGHT name but
      wrong content/length in the models subdir, then start acquisition. Does it refuse to
      overwrite a verified file, and re-acquire a truncated/hash-mismatched one safely (no
      append-onto-garbage)?
  - Prompt: craft a 0-byte and a wrong-hash file; read the resulting bytes.

- [ ] **E-15 — Disk-full / permission-denied.** Make the models dir read-only (or point it at a
      non-writable path) and start acquisition. Is the failure surfaced per file (AC5) and never
      reported complete? Any leftover partial file?
  - Prompt: `attrib +r` on the dir, or a locked path.

- [ ] **E-16 — Close the modal / app mid-download.** Close the settings modal (or kill the app)
      while a file is downloading; reopen. Stale progress? Does the partial file resume, restart
      cleanly, or wedge?
  - Prompt: close during the spinner; compare the `.part`/final file bytes on reopen.

- [ ] **E-17 — Manual placement race.** Drop a complete valid file into the models dir while a
      download for that same file is in flight. Is the result the valid file (or a clean
      re-download), never a corrupt append?
  - Prompt: write the destination while streaming.

- [ ] **E-18 — `MTP/` nested subpath.** Does the mtp file's `MTP/` segment create/read the nested
      directory correctly on Windows (separators, case), and is the row's filename shown correctly?

- [ ] **E-19 — Long / spaced / Unicode models dir.** Point `models_dir` at a path with spaces and
      non-ASCII; does download + placement + verification still work and label correctly?

- [ ] **E-20 — Retry storm / concurrency.** Click Retry repeatedly while a download is in flight.
      Is a second concurrent download prevented (button disabled / synchronous guard)? No duplicated
      transport calls or interleaved writes to the same file?

- [ ] **E-21 — Redirect / chunked / unknown-length.** Stub a 302 redirect and a chunked response
      with no `Content-Length`. Does progress degrade to indeterminate and the file still verify?

- [ ] **E-22 — Progress listener churn.** Navigate away from Companion and back during a download.
      Any leaked listener, duplicated progress updates, or stale percent?

## Findings — round 1 (2026-09-11, spec/2856 @ 0f3f3595)

Real wizard-driven pull (human directive); `models_dir` = `C:\Code\fredo\models`.

- **E-16 (verified, promotes a new finding):** killed the app mid-download twice. On reopen the
  partial file is preserved (correct prefix at the exact persisted size) and reads `Missing` with an
  `Incomplete — N of M bytes` detail; the already-complete `vision`/`mtp` stayed `Present` and the
  resume emitted `state:"skipped"` for them (never re-fetched). **Promoted to `functional.md` F-20
  skip evidence + F-24.**
- **E-17 (verified):** the first resume event carried `downloaded = <on-disk partial>` — resume
  starts from the partial offset, never from zero, and never append-corrupts.
- **E-21 (real-endpoint variant, verified as a NEW DEFECT):** the app's reqwest stream resets
  (`error decoding response body`) after ~5–9 MB on 3 consecutive attempts against the real HF
  endpoint; a direct `bun fetch` of the same `Range` completed 1.32 GB in 31 s. The failure surfaces
  a correct inline `Error` + per-file `Retry` (AC5 behavior is correct), but the transfer cannot
  finish for a multi-GB file — a robustness gap (no automatic retry/backoff on mid-stream body
  decoding failure). **Recorded here; folded into the F-26 verdict (not a separate promoted
  functional row this round — it is an environment-resilience finding, not a UI vocabulary gap).**
- **E-14 (partially verified):** after 2 interrupts the on-disk file remained a valid prefix
  (resume re-hashed the prefix and continued); no append-onto-garbage observed.
- **E-15/E-18/E-19/E-20/E-22 (not executed):** disk-full/permission, nested-`MTP` case-variant,
  Unicode paths, retry-storm concurrency, and listener churn were not probed this round (the
  real-pull legs dominated the session).
