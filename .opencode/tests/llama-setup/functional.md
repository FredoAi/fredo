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

- [ ] F-01: On MS-1 (or MS-2/MS-3), open Settings (gear) → Companion. `tauri_webview_dom_snapshot`
      + `tauri_webview_screenshot` the content area.
  **Expected:** the Companion content renders the llama setup wizard (title + one row per
      prerequisite with a per-step state + the install affordance when actionable). The strings
      "Show Fredo Companion", the teleport tip ("Hold Ctrl and right-click") and the auto-return
      control are ABSENT — DOM query returns 0 for each.
  - **Edge:** repeat for MS-2 and MS-3 (partial readiness is still "not set up" → wizard-only).
    Required data: a constructed not-set-up state.

## F-02 (AC1) — Normal controls absent while the wizard is shown

- [ ] F-02: With the wizard rendered on MS-1, `tauri_webview_find_element` / `execute_js` for the
      toggle, the teleport tip, and the auto-return input by text/label.
  **Expected:** zero matches for "Show Fredo Companion", the teleport tip, and the auto-return
      control — the wizard and the normal companion controls are mutually exclusive.
  - **Edge:** a stale hidden node (display:none) does not count — the elements must not be in the
    rendered DOM.

## F-03 (AC1) — No flash of normal controls while detection is `checking`

- [ ] F-03: Reopen Companion and sample the DOM immediately (before the detection promise
      resolves): poll `execute_js` for the toggle every ~50 ms; timestamp samples.
  **Expected:** the wizard/`checking` state gates the content from first paint — the normal
      toggle/tip never render transiently (no flicker of "Show Fredo Companion" before the wizard
      settles).
  - **Edge:** slow/never-resolving detection still never shows the normal controls; a detection
    error is gated to the wizard (AC5).

## F-04 (AC2) — `llama-server` availability reported independently

- [ ] F-04: On MS-2 (server present) and MS-3 (server absent), read the wizard's `llama-server`
      row + its status text; `tauri_ipc_monitor` the detection response.
  **Expected:** the `llama-server` row reports its OWN state — installed/present on MS-2,
      missing/not-found on MS-3 — independent of the model-files row. The detection is a real
      binary resolution, not a hardcoded value.
  - **Edge:** multiple `llama-server` entries on PATH (real vs WindowsApps stub); a broken/slow
    `where` lookup surfaces an error state, not "present".

## F-05 (AC2) — Required model files presence reported independently

- [ ] F-05: On MS-3 (models present) and MS-2 (models absent), read the wizard's model-files row +
      status text.
  **Expected:** the model-files row reports its own state — present on MS-3, missing on MS-2 —
      independent of the `llama-server` row. This may reuse `check_model_files`, but the row's
      state must be driven by it (not the wizard's own flag).
  - **Edge:** only GGUF present (mmproj missing) and vice-versa ⇒ the model-files prerequisite is
    NOT satisfied (partial files are not "present").

## F-06 (AC2) — Partial readiness never reads "complete" (both directions)

- [ ] F-06: On MS-2 (server-only) and MS-3 (models-only), snapshot the Companion content + any
      readiness/summary label.
  **Expected:** neither state reads complete/ready and neither renders the normal companion
      controls — the wizard is shown with exactly one prerequisite satisfied and the other
      missing. `llama-server` present ∧ models missing ≠ complete; models present ∧
      `llama-server` missing ≠ complete.
  - **Edge:** both partial states; a readiness label (if any) must name the missing prerequisite.

## F-07 (AC3) — Install action invokes the backend install command

- [ ] F-07: Start `tauri_ipc_monitor`; click the wizard's install action. Capture IPC + console.
  **Expected:** an install command invoke is captured (the `winget install llama.cpp`-backed
      backend command) and/or the backend log shows the winget invocation; the wizard row enters
      `running`/`checking` with a spinner — the click is wired to a real command.
  - **Edge:** double-click does not fire two concurrent installs (see E-04); if the sandbox denies
    real winget, exercise the controlled shim/backend seam and label the real-install verb
    UNVERIFIED-with-named-blocker (G-053).

## F-08 (AC3) — Re-check after install: `checking` → installed/missing, NO reload

- [ ] F-08: After completing F-07 on MS-1 with a controlled successful install (shim materializes
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

- [ ] F-09: During a slow/simulated install, interact with the app chrome (open settings nav /
      toggle a section) and read the OTHER prerequisite row; record wall-clock duration.
  **Expected:** the webview stays responsive (chrome interaction works, no freeze/dead input); the
      install runs off the UI thread (async command); the other prerequisite row remains readable
      and its state is not blanked by the running install.
  - **Edge:** several-second install; a hung install produces an actionable error (AC5) rather
    than an indefinite spinner.

## F-10 (AC4) — Both prerequisites satisfied → normal Companion settings render

- [ ] F-10: On MS-4 (or after F-08 resolves both satisfied), read the Companion content.
  **Expected:** the normal Companion settings render IN PLACE of the wizard — "Show Fredo
      Companion" toggle + auto-return control + teleport tip present; the wizard's prerequisite
      rows ABSENT. (Launch of the server is #2857 — out of scope.)
  - **Edge:** reached by detection-on-open AND by the post-install re-check; the persistence/
    settings surfaces (#2853) still function.

## F-11 (AC4) — Wizard → normal controls transitions without reopen/reload

- [ ] F-11: Complete an install on MS-1 so both prerequisites become satisfied while the Companion
      settings modal stays open; then read the DOM + `performance.timeOrigin`.
  **Expected:** the wizard is replaced by the normal companion controls without closing/reopening
      the modal and without a reload — the transition is driven by the re-check (AC3).
  - **Edge:** transition while the user is mid-interaction with the wizard; the auto-return /
    visibility controls are immediately usable after the swap.

## F-12 (AC5) — winget unavailable → actionable error, remains not-set-up

- [ ] F-12: On MS-5 (winget absent/shadowed), open the wizard and trigger the install.
      Snapshot the error UI + capture console.
  **Expected:** an actionable error names the cause and the next step (e.g. winget / App Installer
      unavailable) and/or the install command output; the wizard REMAINS not-set-up — no normal
      companion controls, no "complete" label; the failed prerequisite stays missing; a retry
      affordance exists.
  - **Edge:** winget present but the verb resolves to nothing; console shows no `Uncaught`.

## F-13 (AC5) — Install non-zero exit / throw → actionable error, remains not-set-up

- [ ] F-13: Drive an install that returns a non-zero exit (shim exits 1) and, separately, one that
      throws/rejects; capture the error UI + console.
  **Expected:** the wizard shows an actionable error (command + exit code / error output tail) and
      remains not-set-up; retry available; no crash and no false "complete".
  - **Edge:** a non-zero exit AFTER partial progress; an exception thrown before any output; the
    error state is visually distinct from the idle-missing state.

## F-14 (AC5) — Install reports success but server still not resolvable → not complete

- [ ] F-14: Use a shim that exits 0 but does NOT put `llama-server` on PATH (or a real install
      whose bin dir is not yet on the running process's PATH). Trigger install, then re-check.
  **Expected:** the wizard does NOT declare success — the `llama-server` row stays missing and the
      wizard stays not-set-up (a reported install success is never trusted over a fresh detection).
      No false "complete".
  - **Edge:** the PATH-refresh case (fresh install not visible to the running process) — correct
    behavior is "still not set up"; a restart/re-resolve would fix it (exploratory E-01).

## F-15 (NF) — Console hygiene, no UI freeze, build gates

- [ ] F-15: After EVERY leg read `tauri_read_logs(source="console")`; run `pnpm --filter @fredo/ui
      build`; `cargo check` if Rust was touched.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded` in any leg; build exit 0 /
      zero TS errors; `cargo check` zero warnings (Rust legs); existing `check_model_files`
      consumers still typecheck (R-2).
  - **Edge:** console read AFTER interaction (an install-race error only appears post-click), not
    only at boot; no re-render loop from the detection/install state effects (AGENTS.md #523).

## F-16 (LIVE) — Mandatory live telemetry receipt (same run as F-01..F-15)

- [ ] F-16: While the wizard surface is exercised (same run/window-set as the live legs), run
      `fredo emit --event-type chat` + `--event-type tool_use` with distinct session ids; query the
      RTDB row tables + `telemetry_spans` (telemetry-query skill); capture the wizard DOM/screenshot.
  **Expected:** both events `{"queued":true}` and classify into `chat_rows`/`tool_use_rows` under
      their session ids; `telemetry_spans` returns a NON-ZERO count with a recent `max(timestamp)`
      — the live-policy receipt (mirrors companion F-17). A static-only PASS is a FALSE PASS.
  - **Edge:** re-run the receipt on the tested tip (the branch may move); keep the emit + query
    output in the `## Tests Runs` evidence.
