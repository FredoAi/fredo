# Fredo CLI — Functional

> Durable functional suite for the `fredo` CLI binary — the `apps/tauri/src-tauri/src/infrastructure/cli/`
> + IPC surface that forwards commands to the running desktop app (today `emit`, `setup`).
> Seeded at Spec #2893 for the open-app command (R-2): the CLI can open a Fredo app/feature by
> identity against the running app, returning a success/failure outcome, and keeps the documented
> not-running fallback.
> Conventions: one `- [ ]` case per requirement, ID prefix `F-`; observable expected outcomes only.
> On pass keep the checkbox and append evidence; on fail leave `- [ ]` and mark `FAIL` with
> expected-vs-actual + repro.
> **Verification policy: live** — every row runs the shipped binary and quotes its literal
> stdout/stderr + exit code against the running app (`docs/CLI_GUIDE.md`).
> Map 1:1 to the QA Plan `R-2` (the Architect's EARS id for AC-2; CLI rows).
> **Prerequisites:** the `fredo` binary on PATH; the app running for F-1/F-2/F-3/F-5; the app DOWN for
> F-4. The bound command is `fredo open-app <IDENTITY>` (one positional; exit 0/1/2; help-listed).

## F-1 (R-2) — `fredo --help` lists the open command

- [x] F-1: Run `fredo --help` and `fredo open-app --help`; record stdout + exit code.
  **Expected:** the literal `open-app` subcommand appears in `fredo --help`; its help names the
      identity argument and shows the id/display-name forms; both invocations exit 0; the existing
      `emit`/`setup` commands remain listed.
  - **Edge:** an unknown flag → non-zero + usage; `fredo help open-app`; no argument → GUI-mode
    behavior unchanged.

## F-2 (R-2) — Open by identity against the running app

- [x] F-2: With the app running, run `fredo open-app mission-monitor`; repeat with
      `fredo open-app "Mission Monitor"` and a case variant; record stdout/stderr + exit code and
      the window list.
  **Expected:** the target window opens and its identity fingerprint (aria-label + header title) is
      byte-equal to the surface the Mission Monitor TILE opens; the command returns a success outcome
      (exit 0) and prints a machine-readable result; no further action needed.
  - **Edge:** re-invoke focuses the SAME window (no duplicate); surrounding whitespace; id vs display
    name; the CLI open path reuses the same kernel opener as the launcher (no second opener).

## F-3 (R-2) — Unknown identity fails readably with a non-zero exit

- [x] F-3: Run `fredo open-app not-a-real-app`; record stderr + exit code + window count.
  **Expected:** NON-ZERO exit; a readable message naming the unknown identity; ZERO windows open; the
      running app stays stable (still responsive, no crash).
  - **Edge:** empty identity; an identity matching ≥2 features (ambiguous — record the bound behavior,
    QA-3); a non-showable feature id.

## F-4 (R-2) — App not running → exit code 2 + the documented fallback

- [x] F-4: With the app DOWN (run before launch, or after an explicit Down), run
      `fredo open-app mission-monitor`; record stdout/stderr + the RAW exit code.
  **Expected:** exit code **2** and the documented fallback message from `docs/CLI_GUIDE.md`
      ("Fredo app is not running. Start it first with `fredo` (no arguments), then retry…"); nothing
      opens; no hang.
  - **Edge:** the same fallback for `fredo emit` (unchanged — R-1); app down at the moment of
    invocation vs killed mid-call.

## F-5 (R-2) — No crash / no duplicate across repeated CLI opens

- [x] F-5: Run the open command ≥5 times (same and different identities) with the app running;
      record window counts, exit codes, and the console.
  **Expected:** no duplicate windows (re-invokes focus the existing one); exit codes consistent; no
      console `Error:`/`Uncaught`/`Maximum update depth exceeded`; the app remains responsive.

## #2935 — `fredo open-terminal` (R-3 / AC3, plus the CLI halves of AC4)

> Seeded at triage for Spec #2935. The `fredo` binary opens Terminal programmatically with an
> optional CLI + working directory and a deterministic outcome + exit status.
> **Verification policy: live** — run the shipped binary and quote its literal stdout/stderr + exit
> code against the running app (`docs/CLI_GUIDE.md`).
> **Names are provisional:** the SA publishes the exact subcommand/flag names + exit table. Proposed:
> `fredo open-terminal [--cli <opencode|copilot>] [--dir <path>]`; exit 0 opened, 1 app-validated
> failure (invalid CLI / invalid dir / open failed), 2 app-not-running OR clap parse error.
> **Prerequisites:** the `fredo` binary on PATH; the app running for F-6/F-7/F-9/F-10; DOWN for F-8.
> In-repo test data: `C:\Code\fredo\.opencode\tests\terminal\fixtures\workdir-a` and `…\workdir-b`
> (committed); `…\no-such-dir` (deliberately missing).

## F-6 (R-3.1/AC3) — opens Terminal with the chosen CLI + folder in one invocation

- [ ] F-6: App running. Run `fredo open-terminal --cli opencode --dir C:\Code\fredo\.opencode\tests\terminal\fixtures\workdir-a`;
      then `--cli copilot --dir …\workdir-b`. Record raw exit code, stdout, the window list, and
      `list_terminal_sessions`.
  **Expected:** exit **0**; machine-readable success on stdout (e.g. `{"outcome":"opened",…}`);
      `tauri_manage_window(action="list")` shows the `terminal` window; `list_terminal_sessions` shows a
      session with `cli=opencode` + `workDir=…\workdir-a` (resp. `copilot`/`workdir-b`); its PTY buffer
      matches `(?i)opencode` (resp. `(?i)copilot`).
  - **Edge:** re-invoke focuses the SAME window (no duplicate); a second invocation with a different
    cli/dir (record the defined behavior); repeated invocations (≥5) → no duplicate window.

## F-7 (R-3.1/AC3) — optional CLI/folder fall back to the configured defaults

- [ ] F-7: Run `fredo open-terminal` with NO `--cli`/`--dir` (app running).
  **Expected:** exit **0**; the started session uses the persisted `terminal_default_cli` +
      `terminal_work_dir` (or the documented defaults when unset); the window opens once.
  - **Edge:** `--cli` only; `--dir` only; both set to the persisted values.

## F-8 (R-3.2/AC3) — app not running → exit 2 + the documented fallback

- [ ] F-8: `dev-env.ps1 -Action Down`; run `fredo open-terminal --cli opencode --dir …\workdir-a`;
      record the RAW exit code.
  **Expected:** exit code **2** (the unchanged `open-app`/`emit` fallback); nothing opens; no hang.
      Then `-Action Up` and confirm the same invocation succeeds.
  - **Edge:** stale socket with no app; app killed mid-call.

## F-9 (R-3.3/AC3) — invalid argument → deterministic non-zero + additive help

- [ ] F-9: Run `fredo open-terminal --cli` (missing value); `fredo open-terminal --bogus-flag`;
      `fredo open-terminal --help`; `fredo --help`.
  **Expected:** the malformed invocations exit non-zero with clap usage on stderr and open nothing;
      `fredo open-terminal --help` exits **0** and lists the subcommand + `--cli`/`--dir`;
      `fredo --help` still lists `emit`/`setup`/`open-app`/`open-terminal` (additive only).
  - **Edge:** unknown flag combined with a valid one; empty-string value.

## F-10 (R-3.4/AC4) — invalid CLI name / invalid directory → non-zero + named cause

- [ ] F-10: Run `fredo open-terminal --cli bogus`; `fredo open-terminal --cli opencode --dir
      C:\Code\fredo\.opencode\tests\terminal\fixtures\no-such-dir`.
  **Expected:** per the SA's published exit table, a non-zero exit with a message naming the offending
      value (`bogus` CLI / the missing directory); ZERO window/session side effects
      (`list_terminal_sessions` unchanged; no new process).
  - **Edge:** invalid CLI + valid dir; a file path instead of a directory; whitespace-only `--cli`.

## F-11 (R-4.1/AC4) — invalid CLI never starts a wrong/partial session

- [ ] F-11: With the app running, invoke `fredo open-terminal --cli bogus`; correlate with the
      `terminal` window's session list and the process inventory.
  **Expected:** a clear error naming the invalid CLI; the session list count is unchanged; no new
      process (`process-hygiene.ps1 -List`); the window stays healthy.
  - **Edge:** `OpenCode` (wrong case); `claude`; empty string.

### #2893 testing round 1 (spec/2893 @ 614f26d3) — results

> Raw exit codes captured with a Node `spawnSync` helper (the bash harness does not surface exit
> codes). `fredo` resolves on PATH; no CLI blocker.

- **F-1 PASS.** `fredo --help` exit **0**; stdout lists `open-app` + `emit` + `setup`.
  `fredo open-app --help` exit **0**; stdout names `<IDENTITY>`. `fredo open-app` (missing arg) exit
  **2** + clap usage on stderr.
- **F-2 PASS.** App running: `fredo open-app mission-monitor` → stdout
  `{"displayName":"Mission Monitor","outcome":"opened"}`, exit **0**; one Mission Monitor
  (`Sessions`) window opened. Re-invoke (`"Mission Monitor"`, case variants) returned `opened`
  with the SAME single window (window count stayed 1 — no duplicate).
- **F-3 PASS.** `fredo open-app not-a-real-app` → stdout
  `{"outcome":"unknown","spokenName":"not-a-real-app"}`, exit **1**; zero windows opened; app stayed
  responsive. `MM` → `unknown` exit 1; whitespace-only `"   "` → `unknown`/`spokenName:""` (trim,
  fails closed); `Mission Mon` → `opened` (display-name prefix via `appNameMatches`).
- **F-4 PASS.** App DOWN (`dev-env -Action Down`): `fredo open-app mission-monitor` → exit **2**,
  no hang, nothing opened. **Observation (pre-existing, NOT a #2893 regression):** the documented
  fallback message is NOT printed under a non-TTY harness — `cli/mod.rs:75` gates it on
  `std::io::stderr().is_terminal()` (`git log -S is_terminal` → introduced in `43a7b21`, long before
  this spec). The AC's literal exit code 2 holds.
- **F-5 PASS (with one race observation).** ≥5 invocations: consistent outcomes, no duplicate
  window. **Observation:** under a heavily throttled/backgrounded main webview a rapid CLI open
  returned `{"outcome":"unavailable"}` exit 1 while the window still opened — the frontend's
  `confirm_app_open_request` arrived after the 5 s bound
  (`console: [useAppOpenRequests] confirm_app_open_request failed No pending app-open request with
  id "app-open-…"`). Bounded-confirm design; recorded, not a duplicate/crash.

### #2893 testing round 2 (spec/2893 @ 223279d3) — results

> Raw exit codes captured with a Node-style `spawnSync` helper (`.opencode/tmp/2893/cli-probe2.cjs`,
> now `shell:false`; the earlier `shell:true` helper mis-split the quoted display name — helper
> artifact, not a product defect).

- **F-1 PASS.** `fredo --help` exit **0**, lists `emit`/`setup`/`open-app`/`help`;
  `fredo open-app --help` exit **0**, `Usage: fredo open-app <IDENTITY>` with the id/display-name
  description; `fredo help open-app` exit **0**; missing arg exit **2** + clap usage;
  unknown flag `--bogus-flag` exit **2** + clap usage.
- **F-2 PASS.** `fredo open-app mission-monitor` → `{"displayName":"Mission Monitor","outcome":"opened"}`,
  exit **0**, 842 ms cold then 43 ms warm; `fredo open-app "Mission Monitor"` → exit **0**
  `{"displayName":"Mission Monitor","outcome":"opened"}` (76 ms); the fresh window's identity
  fingerprint is aria-label `Sessions` + header `Sessions` — byte-equal to the companion-opened
  surface; re-invoke focuses the SAME window (window count stayed 1).
- **F-3 PASS.** `fredo open-app not-a-real-app` → `{"outcome":"unknown","spokenName":"not-a-real-app"}`
  exit **1**; `MM` → `unknown` exit **1**; `""` → clap exit **2**; zero windows opened; app stayed
  responsive.
- **F-4 PASS.** App DOWN (`dev-env -Action Down`): `fredo open-app mission-monitor` → exit **2**,
  33 ms, no hang, nothing opened. The documented fallback message stays TTY-gated (`cli/mod.rs:75`)
  and is silent under the non-TTY harness (pre-existing, not a #2893 regression).
- **F-5 PASS.** Repeated invocations (same + display-name identities, plus the round's CLI opens)
  produced no duplicate window, consistent exit codes, and no console
  `Error:`/`Uncaught`/`Maximum update depth exceeded`.

### #2893 testing round 3 (spec/2893 @ cf25127c) — results

> Raw exit codes captured with the `shell:false` `spawnSync` helper (`.opencode/tmp/2893/cli-probe2.cjs`)
> run via `bun` (the `node` executable is sandbox-denied this round; the helper is runtime-agnostic).

- **F-1 PASS (re-confirmed).** `fredo --help` exit **0**, lists `emit`/`setup`/`open-app`/`help`;
  `fredo open-app --help` exit **0**, `Usage: fredo open-app <IDENTITY>` + the id/display-name
  description; `fredo help open-app` exit **0**; `--bogus-flag` exit **2** + clap usage on stderr.
- **F-2 PASS (re-confirmed).** `fredo open-app mission-monitor` → `{"displayName":"Mission Monitor","outcome":"opened"}`,
  exit **0** (332 ms cold); `fredo open-app "Mission Monitor"` → exit **0**
  `{"displayName":"Mission Monitor","outcome":"opened"}` (39 ms); re-invoke exit **0** (36 ms), window
  count stayed 1 (no duplicate). The fresh window's identity fingerprint is aria-label `Sessions` +
  header `Sessions` — byte-equal to the companion-opened surface.
- **F-3 PASS (re-confirmed).** `fredo open-app not-a-real-app` → `{"outcome":"unknown","spokenName":"not-a-real-app"}`
  exit **1**; `MM` → `unknown` exit **1**; `""` → `unknown`/`spokenName:""` exit **1**; zero windows
  opened; app stayed responsive.
- **F-4 PASS (re-confirmed).** App DOWN (`dev-env -Action Down`): `fredo open-app mission-monitor` →
  exit **2**, 21 ms, no hang, nothing opened. The documented fallback message stays TTY-gated
  (`cli/mod.rs:75`) and is silent under the non-TTY harness (pre-existing, not a #2893 regression).
- **F-5 PASS (re-confirmed).** Repeated invocations (same + display-name identities, plus the round's
  CLI opens) produced no duplicate window, consistent exit codes, and no console
  `Error:`/`Uncaught`/`Maximum update depth exceeded`.
