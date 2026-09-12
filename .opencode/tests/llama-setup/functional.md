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

> **ROUND 1 EXECUTION NOTE (human directive):** the plan's stub-server / `model_manifest_path`
> override methodology was SUPERSEDED by a BINDING human directive — a **real wizard-driven pull**
> of the 3 pinned HF files into `C:\Code\fredo\models\gemma-4-e2b-it-qat\`, with a real
> kill-mid-download + Range resume. No stub manifest and no stub server were used. F-19/F-21/F-25/
> F-27/F-29 are Rust `cargo test` unit rows — the tester sandbox cannot run `cargo` (tool-access
> gap); they are covered by CI `rust-validate` + the developer's local receipt.

- [x] **F-18 (R-1):** PASS (round 1, real). MS-6 baseline: 3 rows, each `Missing`; summary
      `Incomplete — no model files downloaded yet (0 of 3).`; step `data-state=incomplete`; status
      `0 of 3 present`; exact filenames incl. `MTP/…`.

- [ ] **F-19 (R-1, S):** UNVERIFIED (round 1) — named blocker: `cargo` is not in the tester sandbox
      allowlist; covered by 15 `model_download_state` unit tests (CI `rust-validate`) + dev receipt.

- [x] **F-20 (R-2):** PASS (round 1, real). Real pull MS-6→MS-8: model→present, vision→present,
      mtp→present; determinate progress; all 3 SHA-256 match the pinned manifest. Skip semantics
      additionally proven in the AC4 resume (`vision`/`mtp` emitted `state:"skipped"`).

- [ ] **F-21 (R-2, S):** UNVERIFIED (round 1) — named blocker: `cargo` unavailable (see F-19).

- [x] **F-22 (R-2, G-123):** PASS (round 1, real). Sampled the live step throughout the pull:
      `complete` appears ONLY when all 3 are present; during model download the step read
      `Downloading 1 of 3…` (vision+mtp `Missing`), never complete.

- [x] **F-23 (R-3):** PASS (round 1, real). After the pull all 3 rows read `Present` with resolved
      absolute paths; step `data-state=complete`, status `3 of 3 present`, summary
      `Complete — all 3 model files are present.`; `download` button unmounted. Re-check re-probes
      in place, no reload.

- [x] **F-24 (R-3):** PASS (round 1, real). Moved `MTP/…gguf` aside → Re-check → step `incomplete`,
      `2 of 3 present`, summary names EXACTLY `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf`; then moved the
      `model` file aside → summary names exactly `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf`. Restored →
      complete again.

- [ ] **F-25 (R-3, S):** UNVERIFIED (round 1) — named blocker: `cargo` unavailable (see F-19).

- [x] **F-26 (R-4):** **PASS (round 2, real)** — on `spec/2856 @ 1bef0ef5` the interrupted `model`
      file (partial prefix 1,304,074,347 B) resumed via HTTP `Range` and **completed in-session**.
      The FIRST progress event on resume carried `downloaded: 1304074347` = the exact on-disk
      offset (Range proof); the stream then ran continuously to `downloaded: 2620370976` (100%) in
      **40.7 s** for the remaining 1,316,296,629 B (~32.4 MB/s) with **no** `error` state and **no**
      retry needed (ST-2R removed the pre-body prefix-hash stall). `vision`/`mtp` each emitted
      `state:"skipped"` (never re-fetched, bytes untouched). Final in-place SHA-256
      `e5310072…a16889` matches the pinned manifest. Click→complete ≈ 84.5 s (file mtime), of which
      ~44 s was the debug-build 1.3 GB prefix SHA-256 seed performed BEFORE the GET (by design).
      Round-1's non-terminating resume defect is CLOSED.
      *(round 1: UNVERIFIED with the `error decoding response body` reset after ~5–9 MB on 3
      consecutive attempts — superseded.)*

- [ ] **F-27 (R-4, S):** UNVERIFIED (round 1) — named blocker: `cargo` unavailable (see F-19).

- [ ] **F-32 (R-4):** N/A — Cancel is not in scope (architect decision G-023); no `-cancel` control
      ships (verified absent on all 3 states).

- [x] **F-28 (R-5):** PASS (round 1, real). A real mid-stream transport error rendered the `model`
      row as `Error` with an inline persistent detail (`error decoding response body`) and a per-file
      `Retry` button (`aria-label="Retry Model (text) download"`); step `data-state=error`, status
      `Download failed`, summary names the failed file; `vision`/`mtp` stayed `Present`; step never
      complete.

- [ ] **F-29 (R-5, S):** UNVERIFIED (round 1) — named blocker: `cargo` unavailable (see F-19).

- [x] **F-30 (NF):** PASS (round 1, real, partial). UI stayed responsive throughout the multi-GB
      pull; progress advanced at ~100 ms cadence (throttle); status is icon+text with role/aria-live;
      tokens via `tint()`; console clean after every leg.

- [x] **F-31 (LIVE):** PASS (round 1). `fredo emit` chat + tool_use both `{"queued":true}`;
      `chat_rows(e2e-2856-chat)=1` (init), `tool_use_rows(e2e-2856-tool)=1`; `telemetry_spans`
      total 13,067, 2,653 in the last 15 min, newest ingested `2026-09-11T23:48:14.927Z`.

## Execution Log — round 1 (2026-09-11, spec/2856 @ 0f3f3595)

**Method (binding human directive):** real dev app, real Companion wizard `Download model files`
click, real HF endpoint (pinned revision `66a399f6…`), files hashed IN PLACE under
`C:\Code\fredo\models\gemma-4-e2b-it-qat\`. `models_dir` set via the IPC `save_setting` seam; NO
`model_manifest_path` override; NO stub server.

**Real receipts — fresh full pull (run 1):**

| File | Bytes (actual = expected) | Wall clock (first→terminal progress event) | SHA-256 (bun streaming) |
|------|---------------------------|--------------------------------------------|--------------------------|
| model | 2,620,370,976 | 82.1 s (97:17:55.612→97:20:57.751) | `e5310072…a16889` ✔ pinned |
| vision | 986,833,728 | 30.9 s (97:20:58.235→97:21:29.095) | `38b33846…6efe02` ✔ pinned |
| mtp | 59,235,648 | 2.2 s (97:21:29.564→97:21:31.738) | `586f2460…e4aae0` ✔ pinned |

Total wall clock click→complete ≈ **127.7 s** for **3,666,440,352 B** (≈ 28.7 MB/s). Progress
cadence ~100 ms (Throttle `PROGRESS_MIN_INTERVAL`), 1,150 progress events across the 3 files.

**Interrupt / resume receipts:** killed the app mid-`model` at 543,186,458 B (interrupt #1). On
restart the row read `Missing` + `Incomplete — 543186458 of 2620370976 bytes` (summary
`Incomplete — incomplete: gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf (interrupted download).`), step
`incomplete` — vision+mtp `Present`. The resume's FIRST progress event carried
`downloaded: 1281035595` = the exact on-disk partial offset at that moment (HTTP `Range` proof);
`vision`/`mtp` each emitted `state:"skipped"` (not re-fetched).

**Non-terminating resilience defect (new finding, NOT promoted to an exclusive FAIL row; folded
into F-26):** the app's reqwest stream reset (`error decoding response body`) after ~5–9 MB on
3 consecutive attempts on the same file (offsets 1,281,035,595 → 1,289,973,111 → 1,297,305,495).
Resume always restarts from the persisted offset (no corruption — the on-disk bytes are a correct
prefix), but the file never completed in-session. `bun fetch` (undici) of the same range completed
in 31 s, so the endpoint is healthy — the defect is in the app's transfer resilience (no automatic
retry/backoff on a mid-stream body-decoding error). Evidence: AC5 screenshot + the trace offsets.

**Final filesystem state:** `model` file at 1,297,305,495 B (partial, correct prefix); `vision` and
`mtp` complete and hash-verified. The completed files were hashed at completion BEFORE any
interrupt; no corruption occurred across interrupts.

## Execution Log — round 2 (2026-09-12, spec/2856 @ 1bef0ef5)

**Retry context:** re-test after the round-1 FAIL on F-26/AC4 (resume-to-completion). Fix on tip:
`acquire_file` seeds the resume SHA-256 hasher BEFORE the GET + a bounded `MAX_DOWNLOAD_ATTEMPTS=5`
retry/backoff re-issuing the `Range` GET from the persisted offset. Method unchanged: real dev app,
real Companion wizard click, real pinned HF endpoint, no manifest override, no stub server. All
files hashed IN PLACE under `C:\Code\fredo\models\gemma-4-e2b-it-qat\`.

**F-26 resume fixture:** the round-1 partial `model` file, on disk at **1,304,074,347 B** (vision
2.0 MB larger than the round-1 snapshot because the environment had advanced slightly), vision+mtp
complete. `models_dir` = `C:\Code\fredo\models`; `model_manifest_path` = unset (compiled default).

**Receipts (all files hashed in place after the run):**

| File | Bytes | SHA-256 | Pinned |
|------|-------|---------|--------|
| model | 2,620,370,976 | `e531007218dfab990486a5de7676a6932d6ea8dea233d1f698d7c21cf8a16889` | match |
| vision | 986,833,728 | `38b33846f56426cd650e0e574d78de125abdfcedf35c0d7f6929f6ffe26efe02` | match |
| mtp | 59,235,648 | `586f2460b909008640981ec34060aa864e03c144fbabfb3173c4335087e4aae0` | match |

**F-26 resume timing:** first progress event at +43.7 s after click (debug-build prefix SHA-256 seed,
pre-GET), carrying `downloaded=1,304,074,347`; streamed to 100% at +84.4 s; resumed transfer 40.7 s
for 1,316,296,629 B ≈ 32.4 MB/s. No `error` state across the whole 408-event run (states observed:
`downloading`, `present`, `skipped`). `vision`/`mtp` skipped.

**F-20/F-22/F-23/F-24 regression (fresh, round 2):** moved `MTP/…gguf` aside → Re-check → step
`incomplete`, `2 of 3 present`, summary `Incomplete — missing: MTP/mtp-gemma-4-E2B-it-Q4_0.gguf.`;
click Download → only `mtp` re-downloaded (determinate progress `0% · 0 B / 56.5 MB` →
`7% · 3.9 MB / 56.5 MB` → `Present`; `model`/`vision` `skipped`) → `3 of 3 present`. Repeated with
`vision` moved aside (986,833,728 B re-downloaded in 30.5 s; `model`/`mtp` skipped): step read
`Downloading 3 of 3…` / summary `Incomplete — downloading: mmproj-BF16.gguf.` throughout and only
reached `3 of 3 present` / `Complete — all 3 model files are present.` after vision verified.

**F-31 QA-7 live receipt (round 2):** `fredo emit --event-type chat` +
`--event-type tool_use` both `{"queued":true}`; `chat_rows(e2e-2856-r2-chat)=1`,
`tool_use_rows(e2e-2856-r2-tool)=1`; `telemetry_spans` total **13,511**, **348** ingested in the
last 15 min, newest `2026-09-12T00:30:02.742Z`.

**F-25/F-27/F-29 (static) remain UNVERIFIED** — named blocker unchanged: `cargo` is not in the
tester sandbox allowlist; covered by CI `rust-validate` (`cargo test --locked`, 445 passed incl. the
3 new round-2 tests) and the developer receipt.

**Final filesystem state:** all three files complete and hash-verified (model 2,620,370,976; vision
986,833,728; mtp 59,235,648). A pre-existing round-1 leftover `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf.ac4-bak`
(2,620,370,976 B) remains in the dir (not created by this round; not a manifest file).

---

## #2857 — Out-of-process `llama-server` launch + legacy in-process engine removal (Spec #2857)

> Extends the SAME suite/feature domain. Rows F-33..F-46 add the launch/health/round-trip/
> orphan ACs and the in-process-engine removal. **REQ ids are AC-aligned 1:1** (`R-1`=AC1 …
> `R-5`=AC5) per G-022 — keep the mapping when extending.
> **Verification policy: live.**
>
> **BINDING human methodology (inline):** REAL verification through the product path. NO stub
> servers on a scratch port, NO scratch-dir shortcuts, NO bypassing the real backend commands.
> The launch/health/round-trip/orphan ACs MUST be driven against a REAL `llama-server` launched
> by the product. If a real model load is impossible in the tester's resource/time budget, the
> affected row is UNVERIFIED-with-named-blocker carrying residual substantiation (prior live
> evidence on the unchanged surface + a unit/CI pin) per **G-131** — never fabricate a PASS.
> **G-130:** F-39 must reproduce the real streaming/volume class, not only a fast small fixture.
> **No `cargo` in the tester shell** (from #2855) — Rust build/clippy/test gates are covered by
> CI `rust-validate`; the tester drives the live product path and does NOT run `cargo`.
>
> **Test data / host facts:** real models under `models_dir`
> (`C:\Code\fredo\models\gemma-4-e2b-it-qat\`): `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf` (~2.62 GB),
> `mmproj-BF16.gguf` (~0.99 GB), `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf` (~59 MB). Real
> `llama-server.exe`; on this host winget `ggml.llamacpp` created NO Links shim (E-13), so set
> `llama_server_path` to the real binary (or its install dir). Settings seams (restore after each
> leg): `models_dir`, `llama_server_path`, and the port/context/sampling settings the Architect
> names. The human's `.bat` defaults are the AC1 expected set. **Timing budget:** a real ~2.6 GB
> CUDA load + mmproj + MTP draft is heavy — allow/record a health wait of ~60–180 s (cold disk)
> plus post-ready TTFT; the app's bounded timeout must be ≥ this. NOTE: the UI's frontend
> `LAUNCH_WATCHDOG_MS` (proposed 45 s) is a no-hang affordance, NOT the authoritative health
> timeout — a still-loading healthy server must stay in `starting`, never flip to `failed`.

### Functional — #2857

- [ ] **F-33 (R-1/AC1):** Capture the generated launch config for the current persisted settings:
      `tauri_ipc_monitor` the `launch_llama_server` invoke (its detail exposes the config PATH per
      UI §5 — Architect to define the file/format) and read that file / the log's config echo.
      **Expected:** every required flag is present with a value — `--model`,
      `--mmproj`, `--model-draft`, `--spec-type draft-mtp`, `--spec-draft-n-max 2`, `--fit off`,
      `--load-mode none`, `--gpu-layers all`, `--threads 6`, `--threads-batch 12`, `--reasoning on`,
      `--ctx-size 131072`, `--temp 1.0`, `--top-p 0.95`, `--top-k 64`, `--parallel 1`,
      `--kv-unified 1`, `--log-verbosity 4`, `--alias Gemma-4-E2B` — 18/18, zero missing, zero
      empty. Paths are RESOLVED absolute on-disk paths, not the `.bat`'s relative `gguf\…`.
  - **Edge:** a path with spaces is one quoted token; an absent `--model-draft`/`--mmproj` file ⇒
    explicit error, never a dropped flag; restore defaults.

- [ ] **F-34 (R-1/AC1):** Config derives from PERSISTED SETTINGS — change a bound setting, relaunch,
      re-capture; clear the override and re-capture. **Expected:** the captured value reflects the
      persisted setting; unset ⇒ the `.bat` default; changing one setting changes exactly its flag.
  - **Edge:** blank setting falls back to default; out-of-range value rejected/clamped without a
    bad launch; restore the setting.

- [ ] **F-35 (R-2/AC2):** On a ready host start the companion via the wizard's
      `companion-step-server-launch` → `-start` (command `launch_llama_server`); capture IPC + the
      OS process list + backend logs; read the card's `data-server-state`.
      **Expected:** a REAL `llama-server.exe` starts (child of Fredo) with the F-33 config; the
      resolved binary path + config are logged; `data-server-state` goes `starting` → `healthy`
      (chip "Running"); no in-process engine load.
  - **Edge:** missing/broken binary ⇒ F-41; a second start does not duplicate the process; a stale
    server from a prior crash is reclaimed or reported.

- [ ] **F-36 (R-2/AC2):** Arm `tauri_ipc_monitor`, start the companion, send NO chat; probe
      `http://127.0.0.1:<configured-port>/health` (+ `/v1/models`) and read `-phase`.
      **Expected:** health returns a success status on the configured port BEFORE any chat/completion
      request is issued (IPC order: health OK → ready → first chat); the card stays
      `data-server-state=starting` with the "Waiting for health check…" caption until health passes;
      readiness is the REAL HTTP result, not a fixed delay.
  - **Edge:** port held by another process ⇒ explicit start failure (F-41), never false ready; a
    port override honored; one bad probe retried within budget.

- [ ] **F-37 (R-2c / NF):** During the real model load, interact with app chrome and record
      wall-clock timings; observe the `-phase` captions + the `LAUNCH_WATCHDOG_MS` behaviour; read
      console after every leg. **Expected:** webview responsive (no freeze/dead input); named phases
      render (config → starting → health) with spinner + indeterminate progress < 100 ms; the
      BACKEND health wait is bounded (record its value); console clean.
  - **Edge:** cold-disk slow load inside budget ⇒ still `healthy`; the frontend watchdog (proposed
    45 s) must NOT mislabel a still-loading healthy server as `failed`; app exit during load ⇒ F-40.

- [ ] **F-38 (R-3/AC3):** Send a companion chat message; sample the answer DOM (`execute_js`) + the
      server request log; watch the `llm_chat` → `llm-token`/`llm-done` IPC.
      **Expected:** the prompt reaches the server and the reply STREAMS back — the
      `SpeechBubble`/answer DOM shows ≥2 distinct partial contents over time, then the final text
      matching the completion; assistant rows still land on the chat surface.
  - **Edge:** multi-turn context; abort mid-stream; slow TTFT; a server-unreachable `llm_chat`
    error surfaces one line (never a second chat surface).

- [ ] **F-39 (R-3c, G-130 streamed class):** Ask for a LONG generation (target ≥ ~300 output
      tokens / ≥ ~20 s of streaming) and sample the answer DOM across the window. **Expected:**
      tokens render INCREMENTALLY across multiple samples (not one final block); TTFT + total
      wall-clock recorded; other surfaces responsive.
  - **Edge:** very long output does not stall; a 1-token/instant reply is NOT acceptable evidence.

- [ ] **F-40 (R-3/AC3):** Exit Fredo cleanly (and once via force-kill) with a server running; after
      the app is gone list OS processes + probe the port; on relaunch observe the
      `exited`/`Restart` lifecycle if the backend re-probe trigger exists.
      **Expected:** no `llama-server.exe` survives (zero orphans; port free) — the child is
      terminated on app exit.
  - **Edge:** exit while generating; exit during load; hard-kill may orphan — record actual
    behavior + next-launch recovery; two windows do not double-own the process.

- [ ] **F-41 (R-4/AC4):** Force a START failure (non-existent binary / non-zero shim / port held by
      another listener); start the companion. **Expected:** within the bounded timeout the
      `companion-step-server-launch` card enters `data-server-state=failed` with the actionable
      copy ("Couldn't start the companion server… then choose Retry."), `-retry` + `-recheck`
      present, focus moved to the error group (`role=group`, `aria-label="Companion server error"`),
      NEVER an infinite spinner; readiness never `healthy`; no chat issued.
  - **Edge:** missing `llama-server` guides to install; a binary exiting with output surfaces the
    tail; a held port is not misread as healthy.

- [ ] **F-42 (R-4/AC4):** Force a health failure/timeout (server starts but `/health` never answers,
      or load beyond the backend budget); start the companion. **Expected:** after the bounded
      backend budget the card enters `failed` with the health-timeout copy ("…didn't answer its
      health check in time. It may still be loading the model — choose Retry…"); no hang, not
      `healthy`; no chat attempted; `-retry` present; the process cleaned up or clearly reported.
  - **Edge:** server up but 500/timeout; load inside vs beyond budget; the frontend watchdog's
    "taking longer than expected" copy does NOT pre-empt the backend verdict; close modal mid-wait;
    no leftover spinner on reopen.

- [ ] **F-43 (R-5/AC5, whole-workspace grep — G-103):** Grep BOTH workspaces +
      `Cargo.toml`/`Cargo.lock`/manifests for `llama-cpp-2`, `llama_cpp_2`, `llama-cpp-sys-2`,
      `LlmEngine`, `load_with_vision`, `features/llm`. **Expected:** zero live references —
      `llama-cpp-2` gone from the dependency graph (`Cargo.toml` + `Cargo.lock`), no `LlmEngine`
      type/import/startup, `features/llm` removed; any residual `vendor/llama-cpp-2` outside the
      build/import graph and its handling stated.
  - **Edge:** residual doc/comment references declared, not silent; grep scope covers `apps/ui` AND
    `apps/tauri`; nothing in `apps/ui` imports the removed engine.

- [ ] **F-44 (R-5/AC5):** Live removal + old-path replacement — boot the app on a ready host;
      confirm no legacy in-process startup load; exercise the new setup/launch flow. **Expected:**
      the app boots WITHOUT the legacy in-process model load (no `fredo::llm` engine-load log, no
      in-process GPU init); the new setup flow owns readiness; no dangling consumer of the old
      model-check path throws.
  - **Edge:** legacy `gemma-e2b-it` layout no longer consulted; standalone `SetupWizard` still
    resolves its model step; models-missing machine still guides to setup.

- [ ] **F-45 (NF):** Console + build hygiene across every leg. **Expected:** no `Error:`/`Uncaught`/
      `Maximum update depth exceeded` after any interaction; `pnpm --filter @fredo/ui build` exit 0;
      Rust `cargo check`/`clippy`/`test` GREEN via CI `rust-validate` (tester has NO `cargo`);
      screenshots captured.
  - **Edge:** console read AFTER interaction; no re-render loop from health/stream effects (#523).

- [ ] **F-46 (LIVE):** While the live legs run, `fredo emit --event-type chat` + `--event-type
      tool_use`; query the RTDB row tables + `telemetry_spans` (telemetry-query skill); capture the
      UI. **Expected:** both `{"queued":true}` and rows classify under their session ids;
      `telemetry_spans` returns a NON-ZERO count with a recent `max(timestamp)` — the live-policy
      receipt. A static-only PASS is a FALSE PASS.
  - **Edge:** re-run on the tested tip; keep emit + query output in `## Tests Runs`.

## Execution Log — round 2 (2026-09-12, spec/2857 @ 61f77d18)

Real product path only (no stubs/scratch). `llama_server_companion_dir` = `C:\Code\fredo\.runtime\companion\`
(ST-11 receipt: `generate_llama_server_config` returned that `.bat` path; `Test-Path` True; log created there).
`models_dir` kept at `C:\Code\fredo\models` (the manifest appends `gemma-4-e2b-it-qat`; the brief's
"models_dir = the subdir" would double-nest — recorded, not authored). `llama_server_path` = the resolved
winget `ggml.llamacpp` CPU build.

**Headline:** AC1 config generation is fully correct (18/18 flags, resolved absolute paths, setting-derived),
but **AC2 launch/health FAILS**: the spawned child dies at argument parse with `error: invalid argument: 1`.
Diagnosis proved the offending argument is `--kv-unified` emitted with a value (error value tracked the config
exactly: `1`→`invalid argument: 1`, then `{"kvUnified":false}` → `invalid argument: 0`); reducing
`ctxSize`/`gpuLayers` did NOT change the fatal (E-13 CPU-build hypothesis refuted). AC1 was NOT weakened.

| Case | Result (round 2) | Evidence |
|------|------------------|----------|
| F-33 | **PASS** | returned `.bat` + Read: `--model`/`--mmproj`/`--model-draft` abs paths, `--spec-type draft-mtp`, `--spec-draft-n-max 2`, `--fit off`, `--load-mode none`, `--gpu-layers all`, `--threads 6`, `--threads-batch 12`, `--reasoning on`, `--ctx-size 131072`, `--temp 1.0`, `--top-p 0.95`, `--top-k 64`, `--parallel 1`, `--kv-unified 1`, `--log-verbosity 4`, `--alias Gemma-4-E2B` (18/18). `Test-Path` on `MTP/mtp-…gguf` literal = True |
| F-34 | **PASS** | `{"ctxSize":4096,"temp":0.5}` changed exactly `--ctx-size 4096` + `--temp 0.5`; cleared → defaults restored |
| F-35 | **FAIL** | card `starting` (spinner, disabled+aria-busy) but child dies `error: invalid argument: 1`; never `healthy` |
| F-36 | **FAIL** | `/health` never binds (server dead at startup); no 200 |
| F-37 | **PASS** | webview + chrome Re-check responsive during the 180 s wait; phase caption + 45 s watchdog copy; card stayed `starting` (never `failed`); console clean |
| F-38 | **UNVERIFIED** | named blocker: AC2 defect — no healthy server; `llmChat` reached "💭 Thinking…" but no token/done (ensure-healthy can never succeed) |
| F-39 | **UNVERIFIED** | named blocker: AC2 defect — no stream exists to sample |
| F-40 | **UNVERIFIED** | named blocker: no server ever ran + no `llama-server.exe` process-lister / :8080 probe in the tester sandbox; ST-7 hook+sweep present/CI-tested |
| F-41 | **PASS** | `llama_server_path` = real non-executable file → `launch_llama_server` returned immediately `{code:"spawnFailed", state:"error", success:false}`; card failed surface = actionable copy + Retry/Re-check |
| F-42 | **PASS** | AC1-default launch → at exactly 180 s card `failed` with health-timeout copy, `role=group`, `aria-label="Companion server error"`, focus moved, Retry present, never healthy |
| F-43 | **PASS** | 0 matches for `llama-cpp-2`/`llama_cpp_2`/`llama-cpp-sys-2`/`LlmEngine`/`load_with_vision`/`features::llm::`; `vendor\llama-cpp-2` + `src\features\llm` absent; `Cargo.toml`/`Cargo.lock` clean; `ModelSelector` gone |
| F-44 | **PASS** | newest `telemetry_logs` target `fredo::llm` is `2026-09-12T00:40:12Z` (pre-deploy) — none this boot (17:22:38Z); `LlmEngine|llama-cpp` message count = 0 |
| F-45 | **PASS** | console clean after every leg (only pre-existing `motion()` warn); `pnpm --filter @fredo/ui build` exit 0; CI `rust-validate` pass |
| F-46 | **PASS (LIVE)** | both `fredo emit` → `{"queued":true}`; `chat_rows(e2e-2857-r2-chat)=1`, `tool_use_rows(e2e-2857-r2-tool)=1`; `telemetry_spans` total 14030, newest ingested `2026-09-12T17:26:53.621Z`, 867 in last 15 min |

**Round-2 open defect (for the Architect):** `LlamaServerConfig::to_args()` (`config.rs:154-155`) always emits
`--kv-unified 0|1`; the resolved winget CPU `llama-server` rejects a value on this switch
(`error: invalid argument: <value>`), so the AC1 argv can never reach `/health` on this host. Requires an
Architect/PO resolution — the AC1 parameter contract was not modified to force a pass.
