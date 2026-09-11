# Llama Setup — Functional

> Durable functional suite for the guided llama.cpp setup wizard feature domain. Seeded at
> Spec #2855 (the wizard SHELL: gating + detection + one-click `winget install llama.cpp` with
> re-check). Future specs extend it — #2856 adds the model-download step, #2857 adds the
> server-launch step (both OUT of scope for this suite's #2855 rows).
> One `- [ ]` case per observable behavior; rows map 1:1 to the QA Plan in
> `.opencode/tmp/2855/triage.md` `## QA Expert` (AC1..AC5 + NF + LIVE).
> **Verification policy: live** — every row is provable only on a running app + a real host
> command. Evidence per case: `tauri_webview_dom_snapshot` / `tauri_webview_execute_js` /
> `tauri_webview_screenshot` / `tauri_webview_interact` / `tauri_ipc_monitor` +
> `tauri_read_logs(source="console")` + the mandatory live `telemetry_spans` receipt (F-16).
> A static-only PASS is a FALSE PASS.
> **Windows-only** (human directive) — a non-Windows host is a named-blocker skip, never a PASS.
> **Serving checkout:** `spec/2855` on a running Fredo desktop app, MCP driver `com.fredo.app`.
>
> **Constructed machine states** (F-01..F-15 reuse these; construct honestly and say which was used):
> - MS-1 NOT set up — no `llama-server` on PATH, model files absent.
> - MS-2 server-only — `llama-server` resolvable, model files absent.
> - MS-3 models-only — model files present, `llama-server` absent.
> - MS-4 BOTH — `llama-server` resolvable + model files present.
> - MS-5 winget unavailable — `winget` shadowed/absent.
> Model files: `gemma-4-E2B-it-Q4_K_M.gguf` + `mmproj-F16.gguf` under `<models>/gemma-e2b-it/`
> (read the exact dir from `check_model_files`'s `gguf_path`/`mmproj_path`).
> `llama-server` simulation: a stub `llama-server.cmd` early on PATH that satisfies the
> detection's resolution (`where llama-server`) — state it; a real `winget install llama.cpp`
> is preferable where permitted.

## F-01 (AC1) — Not set up → Companion settings shows ONLY the wizard

- [x] F-01: On MS-1 (or MS-2/MS-3), open Settings (gear) → Companion. `tauri_webview_dom_snapshot`
      + `tauri_webview_screenshot` the content area.
  **Expected:** the Companion content renders the llama setup wizard (title + one row per
      prerequisite with a per-step state + the install affordance when actionable). The strings
      "Show Fredo Companion", the teleport tip ("Hold Ctrl and right-click") and the auto-return
      control are ABSENT — DOM query returns 0 for each.
  - **Edge:** repeat for MS-2 and MS-3 (partial readiness is still "not set up" → wizard-only).
    Required data: a constructed not-set-up state.

## F-02 (AC1) — Normal controls absent while the wizard is shown

- [x] F-02: With the wizard rendered on MS-1, `tauri_webview_find_element` / `execute_js` for the
      toggle, the teleport tip, and the auto-return input by text/label.
  **Expected:** zero matches for "Show Fredo Companion", the teleport tip, and the auto-return
      control — the wizard and the normal companion controls are mutually exclusive.
  - **Edge:** a stale hidden node (display:none) does not count — the elements must not be in the
    rendered DOM.

## F-03 (AC1) — No flash of normal controls while detection is `checking`

- [x] F-03: Reopen Companion and sample the DOM immediately (before the detection promise
      resolves): poll `execute_js` for the toggle every ~50 ms; timestamp samples.
  **Expected:** the wizard/`checking` state gates the content from first paint — the normal
      toggle/tip never render transiently (no flicker of "Show Fredo Companion" before the wizard
      settles).
  - **Edge:** slow/never-resolving detection still never shows the normal controls; a detection
    error is gated to the wizard (AC5).

## F-04 (AC2) — `llama-server` availability reported independently

- [x] F-04: On MS-2 (server present) and MS-3 (server absent), read the wizard's `llama-server`
      row + its status text; `tauri_ipc_monitor` the detection response.
  **Expected:** the `llama-server` row reports its OWN state — installed/present on MS-2,
      missing/not-found on MS-3 — independent of the model-files row. The detection is a real
      binary resolution, not a hardcoded value.
  - **Edge:** multiple `llama-server` entries on PATH (real vs WindowsApps stub); a broken/slow
    `where` lookup surfaces an error state, not "present".

## F-05 (AC2) — Required model files presence reported independently

- [x] F-05: On MS-3 (models present) and MS-2 (models absent), read the wizard's model-files row +
      status text.
  **Expected:** the model-files row reports its own state — present on MS-3, missing on MS-2 —
      independent of the `llama-server` row. This may reuse `check_model_files`, but the row's
      state must be driven by it (not the wizard's own flag).
  - **Edge:** only GGUF present (mmproj missing) and vice-versa ⇒ the model-files prerequisite is
    NOT satisfied (partial files are not "present").

## F-06 (AC2) — Partial readiness never reads "complete" (both directions)

- [x] F-06: On MS-2 (server-only) and MS-3 (models-only), snapshot the Companion content + any
      readiness/summary label.
  **Expected:** neither state reads complete/ready and neither renders the normal companion
      controls — the wizard is shown with exactly one prerequisite satisfied and the other
      missing. `llama-server` present ∧ models missing ≠ complete; models present ∧
      `llama-server` missing ≠ complete.
  - **Edge:** both partial states; a readiness label (if any) must name the missing prerequisite.

## F-07 (AC3) — Install action invokes the backend install command

- [x] F-07: Start `tauri_ipc_monitor`; click the wizard's install action. Capture IPC + console.
  **Expected:** an install command invoke is captured (the `winget install llama.cpp`-backed
      backend command) and/or the backend log shows the winget invocation; the wizard row enters
      `running`/`checking` with a spinner — the click is wired to a real command.
  - **Edge:** double-click does not fire two concurrent installs (see E-04); if the sandbox denies
    real winget, exercise the controlled shim/backend seam and label the real-install verb
    UNVERIFIED-with-named-blocker (G-053).

## F-08 (AC3) — Re-check after install: `checking` → installed/missing, NO reload — **FAIL (round 1)**

- [x] F-08: **PASS (round 2)** — After completing F-07 on MS-1 with a controlled successful install (shim materializes
      `llama-server` / real install), observe the row + overall readiness; read
      `performance.timeOrigin` and the navigation-entry count before and after.
  **Expected:** the row transitions `checking` → `installed` (or `missing` if the install did not
      make the binary resolvable — stale PATH, see F-14). The readiness re-evaluates IN PLACE:
      `performance.timeOrigin` and navigation count are unchanged; no `location.reload`, no full
      page reload.
  - **Edge:** a successful install with a STALE PATH stays `missing` (correctly not complete);
    install completing without the user reopening the modal; the wizard presents the updated state
    without a manual re-open.

## F-09 (AC3 / NF) — No UI freeze while the install runs; other prerequisite stays readable

- [x] F-09: During a slow/simulated install, interact with the app chrome (open settings nav /
      toggle a section) and read the OTHER prerequisite row; record wall-clock duration.
  **Expected:** the webview stays responsive (chrome interaction works, no freeze/dead input); the
      install runs off the UI thread (async command); the other prerequisite row remains readable
      and its state is not blanked by the running install.
  - **Edge:** several-second install; a hung install produces an actionable error (AC5) rather
    than an indefinite spinner.

## F-10 (AC4) — Both prerequisites satisfied → normal Companion settings render

- [x] F-10: On MS-4 (or after F-08 resolves both satisfied), read the Companion content.
  **Expected:** the normal Companion settings render IN PLACE of the wizard — "Show Fredo
      Companion" toggle + auto-return control + teleport tip present; the wizard's prerequisite
      rows ABSENT. (Launch of the server is #2857 — out of scope.)
  - **Edge:** reached by detection-on-open AND by the post-install re-check; the persistence/
    settings surfaces (#2853) still function.

## F-11 (AC4) — Wizard → normal controls transitions without reopen/reload

- [x] F-11: Complete an install on MS-1 so both prerequisites become satisfied while the Companion
      settings modal stays open; then read the DOM + `performance.timeOrigin`.
  **Expected:** the wizard is replaced by the normal companion controls without closing/reopening
      the modal and without a reload — the transition is driven by the re-check (AC3).
  - **Edge:** transition while the user is mid-interaction with the wizard; the auto-return /
    visibility controls are immediately usable after the swap.

## F-12 (AC5) — winget unavailable → actionable error, remains not-set-up — **UNVERIFIED (round 1)**

- [ ] F-12: **UNVERIFIED (round 1)** — On MS-5 (winget absent/shadowed), open the wizard and trigger the install.
      Snapshot the error UI + capture console.
  **Expected:** an actionable error names the cause and the next step (e.g. winget / App Installer
      unavailable) and/or the install command output; the wizard REMAINS not-set-up — no normal
      companion controls, no "complete" label; the failed prerequisite stays missing; a retry
      affordance exists.
  - **Edge:** winget present but the verb resolves to nothing; console shows no `Uncaught`.

## F-13 (AC5) — Install non-zero exit / throw → actionable error, remains not-set-up

- [x] F-13: Drive an install that returns a non-zero exit (shim exits 1) and, separately, one that
      throws/rejects; capture the error UI + console.
  **Expected:** the wizard shows an actionable error (command + exit code / error output tail) and
      remains not-set-up; retry available; no crash and no false "complete".
  - **Edge:** a non-zero exit AFTER partial progress; an exception thrown before any output; the
    error state is visually distinct from the idle-missing state.

## F-14 (AC5) — Install reports success but server still not resolvable → not complete — **UNVERIFIED (round 1)**

- [x] F-14: **PASS (round 2)** — Use a shim that exits 0 but does NOT put `llama-server` on PATH (or a real install
      whose bin dir is not yet on the running process's PATH). Trigger install, then re-check.
  **Expected:** the wizard does NOT declare success — the `llama-server` row stays missing and the
      wizard stays not-set-up (a reported install success is never trusted over a fresh detection).
      No false "complete".
  - **Edge:** the PATH-refresh case (fresh install not visible to the running process) — correct
    behavior is "still not set up"; a restart/re-resolve would fix it (exploratory E-01).

## F-15 (NF) — Console hygiene, no UI freeze, build gates

- [x] F-15: After EVERY leg read `tauri_read_logs(source="console")`; run `pnpm --filter @fredo/ui
      build`; `cargo check` if Rust was touched.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded` in any leg; build exit 0 /
      zero TS errors; `cargo check` zero warnings (Rust legs); existing `check_model_files`
      consumers still typecheck (R-2).
  - **Edge:** console read AFTER interaction (an install-race error only appears post-click), not
    only at boot; no re-render loop from the detection/install state effects (AGENTS.md #523).

## F-16 (LIVE) — Mandatory live telemetry receipt (same run as F-01..F-15)

- [x] F-16: While the wizard surface is exercised (same run/window-set as the live legs), run
      `fredo emit --event-type chat` + `--event-type tool_use` with distinct session ids; query the
      RTDB row tables + `telemetry_spans` (telemetry-query skill); capture the wizard DOM/screenshot.
  **Expected:** both events `{"queued":true}` and classify into `chat_rows`/`tool_use_rows` under
      their session ids; `telemetry_spans` returns a NON-ZERO count with a recent `max(timestamp)`
      — the live-policy receipt (mirrors companion F-17). A static-only PASS is a FALSE PASS.
  - **Edge:** re-run the receipt on the tested tip (the branch may move); keep the emit + query
    output in the `## Tests Runs` evidence.

## F-17 (AC3, promoted from E-05 / round 1) — One-click install must use a resolvable winget id

- [x] F-17: **PASS (round 2)** — Trigger `Install llama.cpp` on a machine with `winget` present; read the backend
      `install_llama_cpp` result (`output`/`error`/`code`).
  **Expected:** `winget install` resolves the llama.cpp package and installs (exit 0) — or a
      genuine environment failure (no network / source unavailable) is surfaced. It must NOT
      fail deterministically because the requested PackageIdentifier does not exist.
  - **Actual (round 1, FAIL):** `install_llama_cpp` ran the real verb and returned
    `{"success":false,"code":"installFailed","output":"No package found matching input criteria."}`.
    Cause: the command uses `winget install --id llama.cpp -e` (`WINGET_APP_ID = "llama.cpp"`,
    `setup/commands.rs:1094`). `-e` forces an EXACT PackageIdentifier match; the canonical
    winget package id is **`ggml.llamacpp`** (PackageName `llama.cpp`), so `--id llama.cpp -e`
    never matches (verified: `manifests/l/llama` → 404 in microsoft/winget-pkgs;
    `manifests/g/ggml/llamacpp/.../ggml.llamacpp.installer.yaml` → `PackageIdentifier: ggml.llamacpp`).
  - **Actual (round 2, PASS):** live `install_llama_cpp` now runs the real
    `winget install --id ggml.llamacpp -e --accept-package-agreements --accept-source-agreements
    --disable-interactivity`; a fresh UI click installed `ggml.llamacpp` (extracted to
    `%LOCALAPPDATA%\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\
    llama-server.exe`), and a second backend invoke returned
    `{"success":false,"output":"Found an existing package already installed...No available upgrade found...",
    "code":"installFailed"}` — i.e. the package RESOLVED (no "No package found"). The id defect is fixed
    and a guard unit test pins `WINGET_APP_ID == "ggml.llamacpp"` (`e735e92`).
  - **Repro:** open Settings → Companion (not set up) → `Install llama.cpp`; or invoke
    `install_llama_cpp` directly. Row flips `running` → `error`; the one-click install can never
    reach `installed` on a standard winget repo.
  - **Fix direction:** use `WINGET_APP_ID = "ggml.llamacpp"` (keep `--id … -e`) or match the
    documented `winget install llama.cpp` (drop `--id`+`-e` for a name/moniker search).

## Execution Log — round 1 (2026-09-11, spec/2855 @ c5c29c42)

Machine states constructed via the `save_setting`/`get_setting` seams (`models_dir`,
`llama_server_path`) — no user model files moved, no PATH/SYSTEM changes; originals restored
(both reset to `""`, functionally unset) and the companion toggle restored to `true`.
- MS-3 (models only): llamaServer=missing, modelFiles=installed.
- MS-2 (server only): llamaServer=installed (`llama_server_path` → scratch stub), modelFiles=missing.
- MS-1 (neither): both missing.
- MS-4 (both): llamaServer=installed + modelFiles=installed → `ready:true`.
- MS-5 (winget absent): NOT constructible — cannot shadow winget on the running process's PATH.

| Case | Result | Evidence (round 1) |
|------|--------|--------------------|
| F-01 | PASS | wizard-only on MS-3/MS-2/MS-1; toggle/tip/auto-return absent (DOM query `false`) |
| F-02 | PASS | `[data-testid="companion-controls"]` absent on all not-set-up states |
| F-03 | PASS | MutationObserver across Companion remount: `companion-controls` never appeared (0), wizard 3× |
| F-04 | PASS | llamaServer installed on MS-2 / missing on MS-3 — independent of modelFiles |
| F-05 | PASS | modelFiles installed on MS-3 / missing on MS-2; partial (1 of 2) → missing |
| F-06 | PASS | both partial directions render "1 of 2 prerequisites ready — setup required", no controls |
| F-07 | PASS | install click → row `running`, button disabled + `aria-busy`, indeterminate progress; backend invoked |
| F-08 | **FAIL** | real `winget install --id llama.cpp -e` → "No package found matching input criteria"; row `running`→`error`, never `installed` (wrong exact id — see F-17) |
| F-09 | PASS | install runs off UI thread (`spawn_blocking`); UI responsive; other row readable |
| F-10 | PASS | MS-4 → `companion-controls` render, wizard absent |
| F-11 | PASS | in-place MS-2→MS-4 re-check swap with modal open; `performance.timeOrigin` unchanged, nav=1 |
| F-12 | **UNVERIFIED** | named blocker: cannot shadow/remove `winget` from the already-running app's PATH; branch covered by unit test `install_llama_cpp_winget_unavailable_is_actionable_and_not_complete` (static) |
| F-13 | PASS | install non-zero exit → "Setup failed: No package found matching input criteria.. Choose Retry or Re-check."; retry present; no controls; not "complete" |
| F-14 | **UNVERIFIED** | named blocker: cannot inject a successful winget shim into the app's fixed command path, so "success but server absent" is not drivable live |
| F-15 | PASS | console clean after every leg; `pnpm --filter @fredo/ui build` exit 0; `cargo` not runnable in tester sandbox (Rust via CI) |
| F-16 | PASS | `fredo emit` chat+tool both `{"queued":true}`; `chat_rows(e2e-2855-chat)=1`, `tool_use_rows(e2e-2855-tool)=1`; `telemetry_spans` total 12,009, 1,587 recent, newest ingested 2026-09-11T17:13:07.923Z |
| F-17 | **FAIL** | new — one-click install uses a non-existent exact winget id; see case body |

## Execution Log — round 2 (2026-09-11, spec/2855 @ b7cc2d13 / e735e92)

Fixed surface: `WINGET_APP_ID = "ggml.llamacpp"` (+ guard unit test). Gating/detection untouched.
States constructed via the backend `save_setting`/`get_setting` seams (`models_dir`,
`llama_server_path`) exactly as round 1; both keys restored to `""` and the panel remounted at the end.
The AC3 real-install leg was driven from the UI on MS-3 (llama missing, models present).

- **Real install verb RESOLVED/INSTALLED the package.** First UI `Install llama.cpp` click ran the real
  `winget install --id ggml.llamacpp -e ...`, installed `ggml.llamacpp` (row returned to `missing` with
  NO actionError ⇒ `success:true`), and extracted
  `…\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\llama-server.exe`.
  A second backend invoke returned `installFailed` with "Found an existing package already installed…
  No available upgrade found" — proving the package now RESOLVES (round 1 failed at "No package found").
- **In-session re-probe (no reload).** Row `running` (button `disabled` + `aria-busy`, indeterminate
  progressbar) → `missing`, with `performance.timeOrigin` (1789148151818.2) and navigation count (1)
  UNCHANGED. **F-14 verified live:** a successful install whose binary the stale running-process cannot
  resolve leaves the wizard not-set-up (no false "complete") — exactly the documented behavior.
  Named environment fact: winget created **no** `…\WinGet\Links\llama-server.exe` shim (the Links dir
  was verified empty via a read-only FS listing), so the real-install-only path reported `missing`.
- **`installed` transition (permitted backend seam).** With `llama_server_path` set to the real
  install-delivered binary, the install action's re-probe flipped the llama row to `installed`
  (resolved path shown) and, with models present, readiness re-evaluated in place → `companion-controls`
  rendered — no reload.

| Case | Result | Evidence (round 2) |
|------|--------|--------------------|
| F-01 | PASS | MS-1: wizard-only; `companion-controls`=0; "Show Fredo Companion"/teleport/idle-input absent; summary "2 prerequisites need attention" |
| F-02 | PASS | normal controls absent on MS-1/MS-3 (DOM query false) |
| F-03 | PASS | gated from first paint (no controls on remount) |
| F-04 | PASS | MS-2 llamaServer `installed` (resolved path) / MS-3 `missing` — independent of modelFiles |
| F-05 | PASS | MS-3 modelFiles `installed` / MS-1 `missing` ("0 of 2 model files present.") |
| F-06 | PASS | both partial directions render "1 of 2 prerequisites ready — setup required", no controls |
| F-07 | PASS | install click → row `running`, button disabled + `aria-busy`, progressbar; real winget invoked |
| F-08 | **PASS** | real install → in-place re-probe `running`→`missing` (F-14 stale-PATH); seam-assisted `installed`; timeOrigin/nav unchanged |
| F-09 | PASS | install off UI thread; chrome/DOM responsive during install; other row readable |
| F-10 | PASS | both satisfied → `companion-controls` render, wizard absent |
| F-11 | PASS | in-place wizard→controls swap with modal open; timeOrigin/nav unchanged |
| F-12 | **UNVERIFIED** | named blocker: cannot shadow/remove `winget` from the already-running app's inherited PATH (launch-environment override not drivable in the tester sandbox); branch covered by the `install_llama_cpp_winget_unavailable_*` unit test |
| F-13 | PASS | real winget non-zero exit → "Failed" row, actionable message, Retry + Re-check, focus moved, no controls, not "complete" |
| F-14 | **PASS** | install success but not resolvable (no Links shim / stale PATH) → stays `missing`, no false complete |
| F-15 | PASS | console clean after every leg (only pre-existing `motion()` warn); `pnpm --filter @fredo/ui build` exit 0; `cargo` unavailable to the tester (tool-access gap) |
| F-16 | PASS | `fredo emit` chat+tool `{"queued":true}`; `chat_rows(e2e-2855-r2-chat)=1`, `tool_use_rows(e2e-2855-r2-tool)=1`; `telemetry_spans` total 12,398, newest ingested 2026-09-11T17:43:54.122Z, 1,976 in last 15 min |
| F-17 | **PASS** | real `winget install --id ggml.llamacpp -e` resolves + installs the package (see case body) |

---

## #2856 — Three-file model acquisition with visible per-file progress (Spec #2856)

> Extends the SAME suite/feature domain (Companion setup wizard). Rows F-18..F-31 add the
> `modelFiles` step's per-file acquisition. **The required model set changes 2 → 3**
> (`gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf`, `mmproj-BF16.gguf`, `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf`
> from `unsloth/gemma-4-E2B-it-qat-GGUF`) — the #2855 count expectations for F-05/F-06/E-07
> ("n of 2") are superseded to "n of 3" for this spec; prior execution logs above are kept as
> the historical record.
> **Verification policy: live** (static leg = the `(S)` rows under `cargo test`).
> **Never download a real multi-GB file** — drive every state via the overrides:
> `save_setting("models_dir", …)`, the Architect's `model_download_base_url` +
> manifest override, and the local stub server `.opencode/tmp/2856/stub-server/`.
> Constructed model states: **MS-6** all 3 absent · **MS-7** model present+verified only ·
> **MS-8** all 3 present+verified · **MS-9** mtp present but truncated (0-byte/below-min).
> Proposed testids: step `companion-step-model-files` with `-status`/`-summary`/`-download`/
> `-cancel`/`-recheck`; file rows `companion-model-file-<slot>`
> (`model`|`vision`|`mtp`) with `-status`/`-progress`/`-retry` and `data-state`. Uniform four-state
> vocabulary `missing | downloading | present | error`; truncated = `missing` + an inline
> "interrupted" detail (no 5th state).

### Functional — #2856

- [ ] **F-18 (R-1):** On MS-6, open Settings → Companion → the model step. DOM snapshot + screenshot.
  **Expected:** three file rows render, each with its own icon+text status ("Missing"); the exact
  filenames are shown (incl. the `MTP/` segment for mtp); the step summary reads incomplete.
  - **Edge:** MS-7/MS-9 mixed state — each row independent, a 2-of-3 set stays incomplete and names
    the missing slot; never color-only.

- [ ] **F-19 (R-1, S):** Unit-test per-file status derivation from (presence, size, optional hash).
  **Expected:** absent→`missing`; `0 < size < expected`→`missing` + shortfall detail; `size == expected`→`present`;
  `size > expected`/IO error/SHA-256 mismatch→`error` (Architect API Contract). No 5th state; truncated is
  `missing` + detail.

- [ ] **F-20 (R-2):** On MS-7, inject the stub manifest + stub server, start acquisition; read rows + stub access log.
  **Expected:** the verified-present `model` is SKIPPED (no GET in the log; row stays `present`);
  `vision` enters `downloading` with a visibly advancing progress bar; then `mtp`; all `present` on finish.
  - **Edge:** absent/unknown `Content-Length` → indeterminate progress (not a frozen 0%); a
    present-but-truncated file is re-acquired, not skipped.

- [ ] **F-21 (R-2, S):** Unit-test the acquisition state machine.
  **Expected:** stable file order; verified-present files skip the transport; progress fractions
  monotonic 0→100 for the in-flight file.

- [ ] **F-22 (R-2, G-123):** During a slow in-flight download, sample summary + companion gate ~every 150 ms.
  **Expected:** at NO sample does the step read complete/ready; the gate never yields to the normal
  companion controls while a file is in flight.
  - **Edge:** a near-instant stub still never shows a false complete; after file 1 completes, the step
    stays incomplete until all three verify.

- [ ] **F-23 (R-3):** On MS-8 (manual placement after `models_dir` override), Re-check.
  **Expected:** model step COMPLETE/Installed; all three rows `present`; manual placement accepted
  (no forced re-download); in-place re-check, no reload.

- [ ] **F-24 (R-3):** On MS-9 (mtp truncated) then with `vision` removed, Re-check.
  **Expected:** stays INCOMPLETE and names EXACTLY the missing/truncated file(s) (`mtp`, then `vision`);
  truncated is not "present".

- [ ] **F-25 (R-3, S):** Unit-test aggregate completion.
  **Expected:** `complete` iff every required file verifies; otherwise the exact missing/truncated
  slot list. An extra unrelated file in the dir satisfies nothing.

- [ ] **F-26 (R-4):** Stub server in `abort` mode mid-file → start → restart in `range` mode.
  **Expected:** the aborted row shows error/incomplete + Retry; the retry makes a `Range: bytes=<n>-`
  request and RESUMES (or safely restarts if no Range); the already-complete `model` file is untouched
  and not re-requested; final bytes match the stub sources.
  - **Edge:** Range-ignoring server (200) → safe truncate+restart, no append corruption; pre-existing
    verified file never overwritten.

- [ ] **F-27 (R-4, S):** Unit-test resume with an injected transport (fail after N bytes).
  **Expected:** persisted partial offset is honored on retry; completed files skipped; assembled bytes
  equal the source; no-Range path truncates before writing.

- [ ] **F-32 (R-4, live — scope-flagged):** Start a slow stub download, then activate Cancel
  (`companion-step-model-files-cancel`).
  **Expected:** acquisition stops; the in-flight file returns to `missing` with the
  `Cancelled — download not complete.` detail; earlier `present` files untouched; step incomplete.
  - **Only run if the Architect commits a backend cancellation path;** otherwise the `-cancel`
    control must not ship (an untested Cancel affordance is a FAIL).

- [ ] **F-28 (R-5):** Stub returns HTTP 500 (and separately a dead port) for one file; start acquisition.
  **Expected:** that row shows an ERROR with an actionable message (URL/status/cause) + inline Retry;
  the step is NEVER complete; the gate stays not-ready; Retry re-attempts.
  - **Edge:** failure on file 2/3 keeps earlier rows `present`; a successful Retry clears the error;
    inline/persistent error, NOT a toast.

- [ ] **F-29 (R-5, S):** Unit-test transport-error mapping.
  **Expected:** 4xx/5xx, timeout, mid-stream reset each → per-file error; aggregation `incomplete`;
  error text carries the status/URL tail.

- [ ] **F-30 (NF):** During a slow download, interact with app chrome; read the error state in light AND dark.
  **Expected:** UI responsive (download off the UI thread); progress advances at a visible cadence;
  status is text+icon with `role="status"`/`aria-live`; tokens only (no hardcoded hex/rgba, no
  `var(--x)NN`); `pnpm --filter @fredo/ui build` exit 0; console clean after every leg.

- [ ] **F-31 (LIVE):** Same run as the live legs — `fredo emit --event-type chat` + `--event-type tool_use`;
  query RTDB rows + `telemetry_spans` (telemetry-query skill); capture the model-step DOM/screenshot.
  **Expected:** both emits `{"queued":true}`; rows classify; `telemetry_spans` non-zero/recent — the
  live-policy receipt. A static-only PASS is a FALSE PASS.
