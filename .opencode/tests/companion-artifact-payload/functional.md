# Companion Artifact Payload — Functional

> Durable functional suite for **shipping the in-process companion engine runtime inside the
> installer artifact** (Spec #3158, revising #3141/#3147). One `- [ ]` case per requirement; rows
> map to the QA Plan `A1-*` / `A2-*` / `A3-*` / `A4-*` / `A5-*` / `NF*` / `E-*` in
> `.opencode/tmp/3158/triage.md` `## QA Expert`.
>
> **Verification policy: static.** Every criterion is an **artifact + process-execution** receipt —
> the committed scripts' `PAYLOAD_*` / `RESULT=` / `EXITCODE=` lines, the probe's JSON stdout,
> directory enumerations with per-file byte counts, and the artifact's SHA-256. The shipped release
> build has **no MCP bridge** (registered only under `#[cfg(debug_assertions)]`,
> `apps/tauri/src-tauri/src/lib.rs:197-207`), so `tauri_webview_*` **cannot attach to an installed
> artifact** and no `telemetry_spans` receipt can exist for a fresh install. **`static` describes
> the receipt form, not a claim that nothing runs** — the tester DOES run the installed artifact.
> Screenshot attachments are unavailable here (`gh image` → `uploadToken not found`); text receipts
> are the evidence form, and they are also the only honest form: the failure this suite exists to
> catch (`0xc0000135`) happens before any window can be captured.
>
> **Command notation (used by every row).**
> `RC("<cmd>")` means
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"`
> — the committed wrapper (`.opencode/scripts/run-exitcode.ps1:34-38`), which prints the command's
> output and then a machine-readable `EXITCODE=<n>` line. Use it for **every** row: the tester's
> bash allowlist has no direct glob for the new scripts, only
> `powershell -File .opencode/scripts/run-exitcode.ps1*` (`opencode.json:435`), and an exit code is
> otherwise unreachable without shell chaining (which the sandbox forbids at the caller: `*;*`,
> `*|*`, `*&&*` are deny rules at `opencode.json:437-445`).
>
> **All non-git verbs go INSIDE the wrapper.** `Get-Item`, `Get-ChildItem`, `Get-FileHash`,
> `Select-String`, `New-Item`, `Copy-Item`, `Remove-Item` are **not** independent bash patterns for
> the tester (`Test-Path*` is the sole exception, `opencode.json:412`; `Remove-Item` is granted only
> for `.opencode/*`, `:416`). Call them as `RC("Get-ChildItem -LiteralPath '<path>' -File")`, or
> author a small script under `.opencode/tmp/3158/` and run it with
> `powershell -NoProfile -File .opencode/tmp/3158/<name>.ps1` (allowlisted, `opencode.json:453`).
> **A bare `Get-ChildItem …` is a sandbox refusal — never a product FAIL, never a blocker; rewrite it
> through `RC(...)` and re-run.** Every multi-statement leg (the probe harness, the fixture build)
> lives in a tmp script for exactly this reason. No `..` path segments anywhere (denied).
>
> **Serving checkout:** `spec/3158` at the round's tested head SHA. Record the SHA with the evidence.
> Record which **artifact producer** answered: a local `pnpm --filter @fredo/tauri build`, or a
> `workflow_dispatch` run of `.github/workflows/release.yml` on the release line (draft installer
> downloaded). **Never** a build log.

## Constants (re-derived from the shipped source — do not substitute)

| Constant | Value | Source |
|---|---|---|
| Core payload names (required) | `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-vulkan.dll`, `llama.dll`, `llama-common.dll`, `mtmd.dll`, `vulkan-1.dll` | Architect §API Contracts 2 allowlist (binding) |
| Tool-module names (listed, non-required) | `llama-batched-bench-impl.dll`, `llama-bench-impl.dll`, `llama-completion-impl.dll`, `llama-fit-params-impl.dll`, `llama-perplexity-impl.dll`, `llama-quantize-impl.dll` | Architect §API Contracts 2; present in `target/debug` |
| Explicitly excluded | `ggml-cuda.dll`, `fredo_lib.dll` | `Cargo.toml:127-136` (CUDA is not compiled) |
| Max staged files | `14` (8 core + 6 tool) — a **ceiling**, never an equality | arithmetic over the lists above |
| `deviceType` / `backend` tokens | `cpu`, `gpu`, `integratedGpu`, `accel`, `meta` | `engine/mod.rs:113-120` (`rename_all = "camelCase"`) |
| `backendMode` tokens | `auto`, `gpu`, `cpu` | `engine/mod.rs:80-90` (`rename_all = "lowercase"`); probe starts in `auto` |
| `gpuLayers` on the CPU arm | `0` | `engine/device.rs:219-224`, `:245-251` |
| `gpuLayers` on the full-offload arm | `4294967295` = `u32::MAX` ("every layer" — **expected, not a defect**) | `engine/device.rs:221`; `thread.rs:626-631` (same rule, NFR-6) |
| Probe exit codes | `0` success / `1` typed engine failure / `2` usage-precondition | Architect §API Contracts 7 |
| Staging exit codes | `0` pass / `1` named payload failure / `2` refused precondition / `3` `-SelfTest` control failed | Architect §API Contracts 3 |
| Artifact-gate exit codes | `0` PASS / `1` FAIL / `2` refused precondition | Architect §API Contracts 4 |
| Pre-fix install-**tree** bytes (context only — NOT an installer floor) | `45,646,403` (`fredo.exe` 45,566,976 + `uninstall.exe` 79,427, uncompressed) | the published `app-v0.2.0` defect baseline (issue #3158). The NSIS installer is LZMA-compressed; its `Length` is NOT comparable to this sum (measured: 18,853,619 B installer for a 111,806,850 B tree). |
| Installer name | carries `0.2.2` | `tauri.conf.json:4` + `release.yml:62` (`app-v__VERSION__`) |

> **Stale-artifact hazard (G-425).** `apps/tauri/src-tauri/target/release/bundle/nsis/` currently
> holds `Fredo_0.1.0_x64-setup.exe` — a previous version. Every artifact row asserts BOTH the
> `0.2.2` filename AND an mtime at/after this round's build start. A `0.1.0` file or a pre-build
> mtime is a **stale-artifact FAIL**, never a PASS.
>
> **Display-name note.** `"Fredo_0.1.0_x64-setup.exe"` uses the productName+version form; if this
> build emits a different stem, take the stem from A1-0's own listing and record it — do **not**
> fail on the stem while the version segment is `0.2.2`.

## AC1 — a clean install is complete and works

- [ ] **F-1 (A1-0, artifact identity — precondition for every artifact row).**
      `RC("Test-Path 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.2_x64-setup.exe'")`;
      then `RC("Get-Item -LiteralPath 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.2_x64-setup.exe'")`
      and
      `RC("Get-FileHash -Algorithm SHA256 -LiteralPath 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.2_x64-setup.exe'")`.
  - **Expected:** `True`; the file **name** carries `0.2.2`; `LastWriteTime` at/after this round's
    build start; `Length` and SHA-256 **recorded as measurements — no size threshold**. Completeness
    is NOT asserted here: it is F-2's extracted-tree enumeration (and F-10's `PAYLOAD_PRESENT=`
    lines). Evidence: the size + hash lines quoted in the POSTED `## Tests Runs`.
  - **Edge:** a `0.1.0` filename or a pre-build mtime ⇒ **FAIL (stale artifact)** — do not retry a
    different file and call it this round's. No installer at all ⇒ NOT RUN with the AC4 blocker
    phrasing (see `exploratory.md` E-6). If the stem differs but the version segment reads `0.2.2`,
    record the stem from the listing and continue. A `Length` **smaller** than `45,646,403` B is
    **EXPECTED, never a FAIL** — that figure is an *uncompressed two-file install-tree* sum, while
    the installer is LZMA-compressed (measured: 18,853,619 B installer / 111,806,850 B tree). A
    `Length` of `0` or an unreadable file ⇒ FAIL.

- [ ] **F-1b (A1-0b, the committed producer hook resolves its script from both documented build
      cwds).**
  - **(1) Static:** read `apps/tauri/src-tauri/tauri.conf.json:9` — the `-File` argument is exactly
    `../../.opencode/scripts/stage-engine-payload.ps1` (two `../`).
  - **(2) Hook-cwd control (ST-6's proven recipe):** author
    `.opencode/tmp/3158/probe-config.json` = `{"build":{"beforeBundleCommand":"echo PROBE_HOOK_CWD=%CD%"}}`
    and `.opencode/tmp/3158/hook-cwd-probe.ps1` taking `-Dir <app dir>`:
    `Set-Location -LiteralPath <repo>\<Dir>` then
    `& <repo>\apps\tauri\node_modules\.bin\tauri.cmd build --config <repo>\.opencode\tmp\3158\probe-config.json --bundles nsis`.
    Run it twice through `RC("powershell -NoProfile -File .opencode\tmp\3158\hook-cwd-probe.ps1 -Dir apps\tauri")`
    and `-Dir apps\tauri\src-tauri`; record `PROBE_HOOK_CWD=`.
  - **(3) Real producer:** `$env:CI='true'`, `RC("pnpm --filter @fredo/tauri build")`; read the log.
  - **Expected:** (1) exactly `../../`; (2) **both** probe runs print
    `PROBE_HOOK_CWD=<repo>\apps\tauri`; (3) `Running beforeBundleCommand …` is followed by
    `PAYLOAD_SOURCE=<repo>\apps\tauri\src-tauri\target\release` and `RESULT=PASS`, and the build ends
    with an NSIS `*-setup.exe` (no `… does not exist`, no `beforeBundleCommand … failed`).
  - **Edge:** a `--config` override (or a hand-staged `engine-payload/`) used as the *producer* is
    **NOT** a PASS. A probe printing a cwd other than `apps\tauri` ⇒ the documented rule changed ⇒
    **FAIL** (re-derive before editing the hook). A (3) run that reuses a pre-built installer
    without executing the hook ⇒ **NOT** a PASS.

- [ ] **F-2 (A1-1, install-directory enumeration — the AC's named evidence).**
      `RC("powershell -File .opencode/scripts/verify-installer-payload.ps1 -Installer 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.2_x64-setup.exe' -WorkDir '.opencode\tmp\3158\artifact'")`
      then `RC("Get-ChildItem -LiteralPath '.opencode\tmp\3158\artifact' -File")`.
  - **Expected:** the listing carries at least **9** file rows — `fredo.exe` plus **all 8 core
    payload names** — each with `Length` strictly `> 0`. That is the "payload files present — not
    just `fredo.exe` + `uninstall.exe`" clause. Evidence: the full listing quoted in the POSTED
    `## Tests Runs`.
  - **Edge:** a missing core name, or any `Length` of `0` ⇒ **FAIL**. `uninstall.exe` is asserted on
    the silent-install route (F-3) only; on a 7z-extract route its absence is **reported, not a
    FAIL** (an NSIS extract's `$INSTDIR` fidelity is the disclosed caveat). Record which route
    produced the tree.

- [ ] **F-3 (A1-1b, silent-install route — the user-identical route, when elevated).**
      `RC("powershell -File .opencode/scripts/verify-installer-payload.ps1 -Installer 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.2_x64-setup.exe' -WorkDir '.opencode\tmp\3158\installed'")`
      then enumerate `.opencode\tmp\3158\installed` exactly as in F-2.
  - **Expected:** the same 9 names **plus `uninstall.exe`** (the real `$INSTDIR` layout) and the
    gate's `RESULT=PASS` / `EXITCODE=0`.
  - **Edge:** `installMode: perMachine` (`tauri.conf.json:43`) writes HKLM `PATH` and needs
    elevation. A non-elevated shell **falls back to the extract route and says so** — never a FAIL
    and never a claimed `$INSTDIR`. An extractor-free host with no elevation ⇒ `EXITCODE=2`
    `ERROR=EXTRACTOR_MISSING` ⇒ the E-1 named blocker.

- [ ] **F-4 (A1-2, the installed artifact answers a turn).** Author
      `.opencode/tmp/3158/probe-sanitised.ps1` per F-14's contract, then
      `RC("powershell -NoProfile -File .opencode\tmp\3158\probe-sanitised.ps1 -InstallDir '<tree from F-2/F-3>' -Out '.opencode\tmp\3158\probe-turn.json'")`.
  - **Expected:** `.opencode\tmp\3158\probe-turn.json` parses as **one** JSON object with
    `"success": true`, `"replyChars"` an integer **> 0**, `"modelId"` a non-empty string,
    `"detail"` a string; `PROBE_EXITCODE=0`. Evidence: the JSON verbatim in the POSTED
    `## Tests Runs`.
  - **Edge:** `"success": false` with a typed `code` ⇒ classify: `modelMissing` /
    `mmprojInitFailed` / `mtpInitFailed` = **precondition blocker** (E-2 — the GGUF trio is out of
    scope), any other code = **FAIL**. `"success": true` with `replyChars: 0` ⇒ **FAIL**.

- [ ] **F-5 (A1-3, positive control — the payload really resolves from the install dir).** Same
      script, same run, same disposable tree: `RC("Remove-Item -LiteralPath '<tree>\ggml-base.dll'")`,
      re-run, record the exit code; then restore the file from the extracted copy and re-run.
  - **Expected:** the deletion run writes **no JSON** (no parseable object) and exits
    **`-1073741515`** (the signed form of `0xC0000135`; `3221225781` unsigned is the same value —
    accept either). The restored run returns `"success": true` again.
  - **Edge:** destructive controls act **only** on the disposable `.opencode/tmp/3158/` tree, never
    a real Program Files install — and this is also a **sandbox requirement**, not just hygiene: the
    tester's `Remove-Item` grant covers `.opencode/*` paths only (`opencode.json:416`), so a control
    aimed at `C:\Program Files\…` is a refusal. A non-zero exit that *does* print a JSON body is a
    **different** failure — classify it, do not credit the loader control.

- [ ] **F-6 (A1-4, excluded modules are absent).** `RC("Test-Path '<tree>\ggml-cuda.dll'")` and
      `RC("Test-Path '<tree>\fredo_lib.dll'")`; then read F-18's staging transcript and confirm it
      carries **no** `PAYLOAD_COMPONENT=ggml-cuda.dll` line.
  - **Expected:** both `False`; zero `ggml-cuda` / `fredo_lib` component lines.
  - **Edge:** `ggml-cuda.dll` present ⇒ **FAIL** (a stale backend in a Vulkan-only release).
    `fredo_lib.dll` present ⇒ **FAIL** (our own cdylib is not a dependency).

## AC2 — the CPU path is verified with a named observable

- [ ] **F-7 (A2-1, the CPU path with all three assertions).** In `probe-sanitised.ps1`, launch the
      probe from the install tree with `GGML_VK_VISIBLE_DEVICES` **present and empty**.
  - **Expected:** `"success": true`; `"backend": "cpu"`; `"gpuLayers": 0`; `"devices"` contains
    **no** entry whose `deviceType` is other than `"cpu"` — the readout enumerates **no Vulkan GPU**
    (`"devices": []` is the shipped no-accelerator readout: ggml's model split set is empty when no
    accelerator is selected, `engine/device.rs:170-174`); no device `name` reads `Vulkan0`. Evidence:
    the JSON verbatim in the POSTED `## Tests Runs`.
  - **Edge (load-bearing):** **`$env:GGML_VK_VISIBLE_DEVICES = ""` on PowerShell 5.1 DELETES the
    variable** — that would silently make this the no-lever control and pass F-7 by coincidence.
    The script MUST pass the child its environment via
    `[System.Diagnostics.ProcessStartInfo]` with `UseShellExecute = $false` and
    `.EnvironmentVariables["GGML_VK_VISIBLE_DEVICES"] = ""`, and MUST print
    `VK_ENV_VALUE=<empty-present>` to prove the value was present-but-empty. Any **non-CPU**
    `deviceType` (or Vulkan GPU name) ⇒ **FAIL**; a **zero-length** `devices` array is **correct, not
    a failure**. Do **not** use `FREDO_COMPANION_FORCE_CPU` (the only producer of a one-entry `CPU`
    list; it coerces the set *after* the model loaded with `u32::MAX` layers — `thread.rs:695` then
    `:708` — so it proves reporting, not CPU execution).

- [ ] **F-8 (A2-2, discriminating control — the same run WITHOUT the variable).** Same script, same
      install tree, the variable **absent** from the child environment.
  - **Expected:** `devices` contains **at least one** entry whose `deviceType` is not `"cpu"`, **and**
    `"gpuLayers"` > 0 (on the `auto` full-offload arm the literal is **`4294967295`** = `u32::MAX` —
    expected).
  - **Edge:** if this host enumerates **no** non-CPU device even without the lever, the control is a
    **NAMED BLOCKER, never a substitution and never a FAIL of F-7**. Record
    `CONTROL=unproducible: host enumerated zero non-CPU devices`, and disclose the honest residual:
    F-7's CPU result was not shown attributable to the lever. Never substitute
    `FREDO_COMPANION_FORCE_CPU`.

- [ ] **F-9 (A2-3, the two runs differ).** Compare F-7's and F-8's recorded JSON objects.
  - **Expected:** `backend`, `gpuLayers` and the non-CPU entry count differ between the two runs (or
    F-8 is the recorded blocker).
  - **Edge:** two byte-identical CPU-only readouts ⇒ **FAIL** — the empty value was dropped, i.e.
    F-7's edge bit.

## AC3 — a release build can no longer strip the payload

- [ ] **F-10 (A3-1, the produced installer carries the whole payload — by extraction).**
      `RC("powershell -File .opencode/scripts/verify-installer-payload.ps1 -Installer 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.2_x64-setup.exe'")`.
  - **Expected:** `ARTIFACT=<path> sha256=<hex> bytes=<n>`; one `PAYLOAD_PRESENT=<name>` line for
    **each of the 8 core names**; `RESULT=PASS`; `EXITCODE=0`. Evidence: the whole transcript in the
    POSTED `## Tests Runs`.
  - **Edge:** any `PAYLOAD_MISSING=` line ⇒ **FAIL** (list them). `EXITCODE=2` with
    `ERROR=EXTRACTOR_MISSING` ⇒ E-1 blocker — **never** a build-log substitute.

- [ ] **F-11 (A3-2, the shipped config declares the payload).** Read
      `apps/tauri/src-tauri/tauri.conf.json`.
  - **Expected:** `bundle.resources` is exactly `{"engine-payload/": ""}` — a **map**, destination
    the empty string, **no `*` anywhere**; `bundle.externalBin` still `[]`; `bundle.active`,
    `bundle.targets`, `bundle.windows.nsis.installMode`, `bundle.macOS` unchanged from `:31-54`.
  - **Edge:** a glob (`engine-payload/*`) ⇒ **FAIL** (`GlobPathNotFound` on a pristine/shared-target
    tree, `resources.rs:234-245`). A list instead of a map ⇒ **FAIL** (the destination-prefix
    contract is lost).

- [ ] **F-12 (A3-3, no `CI` conditional can empty `bundle.resources`).** Read
      `apps/tauri/src-tauri/build.rs` in full (Read tool); Grep it for `Bundle resources cleared`,
      `is_ci`, `env::var("CI")`, `get_mut("resources")`, `tauri.conf.json.bak`; then
      `RC("Test-Path 'apps\tauri\src-tauri\tauri.conf.json.bak'")`.
  - **Expected:** **zero** occurrences of every token above; `build.rs` **does** create the staging
    dir (`fs::create_dir_all` on `engine-payload`) before `tauri_build::try_build`; the
    rename/restore mechanism is gone; `Test-Path` ⇒ `False` after a build.
  - **Edge:** a surviving `cargo:warning=Bundle resources cleared (CI build)` or any config rewrite
    ⇒ **FAIL** (a build killed mid-rewrite leaves a mutated config + a stray `.bak`). A
    `cargo:rerun-if-changed=engine-payload` line ⇒ **FAIL** (it would re-run the build script on
    every bundle).

- [ ] **F-13 (A3-4, a `CI=true` build produces a payload-bearing installer — R-3.2's discriminator).**
      Produce an installer with `CI=true` in the build environment (`$env:CI='true'`, then the
      release build) and run F-10 against it; otherwise run F-10 against the CI-produced draft
      artifact and record its provenance (`release.yml` run id).
  - **Expected:** F-10's `RESULT=PASS` on an installer whose build ran with `CI=true`, with the
    provenance line recorded.
  - **Edge:** the **workflow-triggered** leg (`push` to `release/stable`, `workflow_dispatch`) is not
    producible from this spec's PR — record the literal disclosure
    **`logic-verified, no discriminating run`** for the trigger itself, with F-12 + F-13 as the
    residual. A local build with `CI` **unset** does **not** satisfy R-3.2 alone — say which you ran.

## AC4 — evidence is from the artifact a user downloads

- [ ] **F-14 (A4-1, from the artifact in a sanitised environment).** `probe-sanitised.ps1` MUST:
      (a) set the child `PATH` to exactly `<install dir>;C:\Windows\System32;C:\Windows`;
      (b) set the child cwd to a fresh `%TEMP%` dir it creates;
      (c) UNSET `VULKAN_SDK`, `INCLUDE`, `LIB`, `LIBPATH`, `LIBCLANG_PATH`, every `CARGO_*` and
      `RUSTUP_*`, and `FREDO_COMPANION_FORCE_CPU`; set `FREDO_DATA_DIR` to a fresh dir;
      (d) launch
      `<install dir>\fredo.exe companion probe --prompt "Reply with one short sentence about the color blue."`
      with **`-RedirectStandardOutput <file> -RedirectStandardError <file> -Wait -PassThru`**
      (mandatory: the release binary is `windows_subsystem = "windows"`, `src/main.rs:2`, so an
      un-redirected stdout is unreadable);
      (e) print `SANITISED_PATH=`, `CWD=`, `UNSET_CONFIRMED=`, `PROBE_EXITCODE=`, `PROBE_JSON=`.
      Then `RC("powershell -NoProfile -File .opencode\tmp\3158\probe-sanitised.ps1 -InstallDir '<tree>' -Out '.opencode\tmp\3158\probe-ac4.json'")`.
  - **Expected:** all five lines printed; `SANITISED_PATH` has exactly the three entries and contains
    **no** `target\` segment; the JSON holds `"success": true` with non-zero `replyChars`;
    `PROBE_EXITCODE=0`.
  - **Edge:** the residual gap is a **NAMED LIMITATION** — this host still has the Cargo target dir
    on disk and a Vulkan SDK installed. **No row may claim a "fresh machine".** A `PATH` or cwd
    containing `apps\tauri\src-tauri\target\<profile>` invalidates the row (the rejected-evidence
    class).

- [ ] **F-15 (A4-2, the provenance control under the sanitised env).** Delete `ggml-base.dll` from the
      disposable tree, re-run F-14, restore, re-run.
  - **Expected:** no JSON; exit `-1073741515` / `3221225781`; then `"success": true` again.
  - **Edge:** if the sanitised run **survives** the deletion, the payload resolved from somewhere
    else — **FAIL**, and a serious finding: record the inherited source.

- [ ] **F-16 (A4-3, the negative exclusion is recorded verbatim).** Confirm the POSTED evidence quotes
      the rejection list and that no cited artifact receipt traces to a rejected route.
  - **Expected:** the verdict quotes, verbatim: `cargo run`, `pnpm dev:tauri`,
    `pnpm dev:tauri:release`; any run whose cwd is or whose `PATH` contains
    `apps/tauri/src-tauri/target/<profile>`; a build-log line; `target/release/fredo.exe` run in
    place with the DLLs beside it in the profile dir.
  - **Edge:** any artifact-leg receipt traceable to a rejected route ⇒ the **whole** artifact
    verdict is invalid ⇒ **FAIL**. Accepted routes: `7z x` of the installer, or NSIS
    `/S /D=<fresh dir>`; the receipt names which produced the tree.

## AC5 — an incomplete payload fails instead of shipping

- [ ] **F-17 (A5-1, negative leg — build side: a named error, no installer).** Build the partial
      fixture in **one tmp script** `.opencode/tmp/3158/build-partial-payload.ps1` containing
      `New-Item -ItemType Directory '.opencode\tmp\3158\partial-payload' -Force`;
      `Copy-Item -Path 'apps\tauri\src-tauri\target\debug\*.dll' -Destination '.opencode\tmp\3158\partial-payload'`;
      `Remove-Item -LiteralPath '.opencode\tmp\3158\partial-payload\llama.dll'`; run it with
      `RC("powershell -NoProfile -File .opencode\tmp\3158\build-partial-payload.ps1")`.
      Snapshot the installer dir first
      (`RC("Get-ChildItem -LiteralPath 'apps\tauri\src-tauri\target\release\bundle\nsis' -File")`),
      then
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -Profile release -SourceDir '.opencode\tmp\3158\partial-payload'")`,
      then snapshot again.
  - **Expected:** `RESULT=FAIL`; **`ERROR=PAYLOAD_INCOMPLETE missing=llama.dll`**; `EXITCODE=1`; the
    `*-setup.exe` set is **unchanged** (same names, same `LastWriteTime`).
  - **Edge:** `RESULT=PASS` on the partial set ⇒ **FAIL** (the gate does not gate). A new/updated
    installer appearing ⇒ **FAIL**. `EXITCODE=2` ⇒ refused precondition (bad `-SourceDir`) — fix the
    fixture and re-run; never record 2 as a named payload failure.
  - **Fixture source — measured, not assumed.** `apps/tauri/src-tauri/target/release` currently holds
    **no payload DLLs at all** (only `fredo_lib.dll`/`.lib`/`.pdb` and `fredo.exe`), while
    `target/debug` holds the full allowlist (Architect §Domain Model 1h: `ggml*.dll`, `llama*.dll`,
    `mtmd.dll`, `ggml-cuda.dll`, `fredo_lib.dll`, the six tool modules). The fixture therefore copies
    from `target\debug`; `-SourceDir` overrides the profile dir entirely, so the negative leg needs
    **no release build** and is fully drivable even before one exists. If `target\debug` has been
    cleaned, `cargo build --manifest-path apps/tauri/src-tauri/Cargo.toml` regenerates it — report
    which happened.
  - **Drivability:** the fixture steps MUST be a tmp script — `New-Item`/`Copy-Item` are not
    allowlisted verbs and `Remove-Item` is granted only under `.opencode/*`
    (`opencode.json:412-416`); the tmp-script route is allowlisted at `:453`. A `Copy-Item` of
    `target\debug\*.dll` into `C:\…` would be a refusal.

- [ ] **F-18 (A5-2, positive leg — build side: the complete set passes).** Try
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -Profile release")`
      **after a release build exists**; if no release profile has been built on this host, use
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -Profile debug")`
      and record which profile answered.
  - **Expected:** `RESULT=PASS`; `PAYLOAD_SOURCE=<profile dir>`;
    `PAYLOAD_VULKAN_LOADER=<path> status=found`; one `PAYLOAD_COMPONENT=<name> status=staged bytes=<n>`
    line for **each of the 8 core names** with `bytes > 0`; `PAYLOAD_TOTAL_BYTES=<n>`;
    `PAYLOAD_COUNT=<n>`; `EXITCODE=0`.
  - **Edge (measured precondition, not an assumption):** `apps/tauri/src-tauri/target/release`
    currently holds **no payload DLLs at all** (only `fredo_lib.dll` and `fredo.exe`), so a
    `-Profile release` run on an unbuilt release tree cannot pass — and that is **not a product
    FAIL**. Record `PAYLOAD_SOURCE=` from the transcript and re-run on `-Profile debug` (or after the
    release build), naming the profile that answered. `-Profile` only selects the source dir; the
    completeness contract is identical.
  - **Edge:** `PAYLOAD_COUNT` is asserted for **self-consistency**, not against an invented literal:
    it must equal the number of `status=staged` lines in the same transcript and must be `<= 14`. A
    listed **tool module** reported `status=MISSING` is a **report line, not a FAIL** (the
    non-required tier). An absent **core** name is the F-17 FAIL.

- [ ] **F-19 (A5-3, artifact-gate FAIL — the gate runs the negative leg too).** Stage the incomplete
      set into the bundle source dir:
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -Profile release -SourceDir '.opencode\tmp\3158\partial-payload' -AllowIncomplete -OutDir 'apps\tauri\src-tauri\engine-payload'")`
      (expect `EXITCODE=0`); re-bundle (`pnpm --filter @fredo/tauri tauri bundle`, or a full
      `tauri build` if the standalone bundler cannot run here) into a **re-bundled copy**; then
      `RC("powershell -File .opencode/scripts/verify-installer-payload.ps1 -Installer '<incomplete setup.exe>'")`.
  - **Expected:** `PAYLOAD_MISSING=llama.dll`; `RESULT=FAIL`; **`EXITCODE=1`**;
    `ERROR=PAYLOAD_INCOMPLETE_IN_ARTIFACT missing=llama.dll`.
  - **Edge:** the **required** form is a→c on a re-bundled *copy* — never the shipped installer
    hand-edited. If re-bundling is impossible here, the reduced "delete `llama.dll` from the
    extracted copy and re-run" form is acceptable **only** when the receipt labels it
    `comparator control, not an end-to-end negative leg`, and the round discloses that the full form
    was not run.

- [ ] **F-20 (A5-4, artifact-gate PASS on the complete artifact).** Re-stage the complete set
      (F-18) and re-run F-10 on the resulting installer.
  - **Expected:** `RESULT=PASS`; `EXITCODE=0`; a `PAYLOAD_PRESENT=` line for each of the 8 core
    names.
  - **Edge:** a PASS leg that only ran on the *incomplete* installer ⇒ the FAIL/PASS pair is invalid;
    both legs run against the **same** gate.

- [ ] **F-21 (A5-5, the instrument's deterministic control set).**
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -SelfTest")`.
  - **Expected:** `EXITCODE=0`; all eleven control lines present — `CONTROL 1 - POSITIVE`,
    `CONTROL 2 - MISSING-CORE`, `CONTROL 3 - MISSING-LOADER`, `CONTROL 4 - IMPORT-GAP`,
    `CONTROL 5 - NO-CUDA`, `CONTROL 6 - IDEMPOTENT`, `CONTROL 7 - SELF-REFERENCE`,
    `CONTROL 8 - FORBIDDEN-IMPORT`, `CONTROL 9 - DELAY-IMPORT`,
    `CONTROL 10 - NON-ROOT-IMPORT-GAP`, `CONTROL 11 - IMPORT-SCAN-COMPLETE` — and **no
    `[FAIL]`** anywhere.
  - **Edge:** `EXITCODE=3` = a control failed ⇒ **FAIL** of the instrument. A missing control line ⇒
    **FAIL** (the eleven are the contract; a six- or ten-control transcript is a plan-level gap, not a
    PASS). Controls 1–7 keep their names and assertions unchanged (their extension is additive).

- [ ] **F-22 (A5-6, the guard has a runner and the release job runs it).** Read
      `.github/workflows/release.yml` and `.opencode/scripts/test-scripts.ps1` (Read tool); then
      `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'verify-installer-payload'")`
      and `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'PAYLOAD_INCOMPLETE_IN_ARTIFACT'")`
      and
      `RC("Select-String -Path '.opencode/scripts/test-scripts.ps1' -Pattern 'verify-installer-payload'")`
      (three calls, not one — a `|` inside a single `-Command` string can trip the sandbox's `*|*`
      deny rule, `opencode.json:442`).
  - **Expected:** `release.yml` carries, strictly **after** the SHA-pinned `tauri-apps/tauri-action`
    step, a **locate** step for the newest
    `apps/tauri/src-tauri/target/release/bundle/nsis/*-setup.exe` (taken from
    `steps.tauri.outputs.artifactPaths`, newest-by-mtime directory fallback) and exactly **one gate**
    step that invokes `verify-installer-payload.ps1` and fails the job with
    `::error::PAYLOAD_INCOMPLETE_IN_ARTIFACT`; the `tauri-apps/tauri-action` step itself carries **no**
    `tagName`, `releaseName`, `releaseBody`, `releaseDraft` or `releaseId` (build-only ⇒ no release
    call), and the workflow's **only** publish step is a later
    `gh release create "app-v<version>" <installer> --draft` guarded by `if: success()`;
    `test-scripts.ps1` carries a leg that names the gate script.
  - **Edge:** A `tagName`/`releaseName`/`releaseBody`/`releaseDraft`/`releaseId` present on the
    `tauri-action` step ⇒ **FAIL** (that is the `app-v0.2.0` mode: the draft is created inside the build
    step, before any gate). A gate step placed **before** `tauri-action` ⇒ **FAIL** (nothing to gate
    yet). YAML text with no `test-scripts.ps1` leg ⇒ **FAIL** (G-406 — an unexecuted guard is not a
    guard).

## Non-functional

- [ ] **F-23 (NF1, zero warnings — local CI parity).**
      `RC("cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings")`
      (the `--manifest-path` form because `run-exitcode.ps1` does not inherit the caller's cwd; it is
      the same form `validate.yml:194` uses).
  - **Expected:** `EXITCODE=0`, zero `warning:` lines, no new `#[allow(...)]` in the touched files.
  - **Edge:** do **NOT** run `--all-targets` — it is base-RED on untouched files in this tree. A red
    `--all-targets` sweep is **not** a FAIL of this spec, and must not be reported as a clean sweep
    either.

- [ ] **F-24 (NF2, test targets compile).**
      `RC("cargo build --manifest-path apps/tauri/src-tauri/Cargo.toml --locked --tests -j 2")`.
  - **Expected:** `EXITCODE=0`; every test target compiled.
  - **Edge (drivability):** `cargo nextest` is **NOT on the tester's bash allowlist** — the block
    grants only `cargo check*` (`opencode.json:431`), `cargo clippy*` (`:432`), `cargo test*`
    (`:433`), `cargo build*` (`:436`), `cargo run*` (`:446`), with **no `nextest`** pattern. `--tests`
    compiles the same target set, so use it — a `nextest` invocation would be a sandbox **refusal**,
    not a product signal. `cargo test --lib` is **NOT usable** (false
    `BackendAlreadyInitialized` in `llm_server::engine::integration`) — if run and red, that is a
    known-seam artifact, not a FAIL of this spec. `-j 2` is required (higher parallelism OOMs the
    linker on this tree). The CI `rust-validate` nextest run is the CI-parity corroboration, not this
    row's ground.

- [ ] **F-25 (NF3, pipeline harness green).**
      `RC("powershell -NoProfile -File .opencode/scripts/test-scripts.ps1")`.
  - **Expected:** `EXITCODE=0`; the summary prints `Failed: 0` and
    `All pipeline scripts validated.` (`.opencode/scripts/test-scripts.ps1:4974-4987`); the run
    includes the new gate leg (F-22).
  - **Edge:** an unrelated failing leg is still a FAIL of this row — quote the failing leg verbatim
    so the Orchestrator can attribute it.

- [ ] **F-26 (NF4, payload size measured — NO numeric threshold).** Record `PAYLOAD_TOTAL_BYTES`
      (F-18), the per-file `bytes=` lines, and the installer `Length` (F-1) as **measurements**. The
      delta vs the `45,646,403` B pre-fix figure is context only: the installer is LZMA-compressed,
      so a **negative** delta is expected (measured: 18,853,619 B installer / 111,806,850 B tree)
      and is never a FAIL.
  - **Expected:** the numbers recorded in the POSTED `## Tests Runs`.
  - **Edge:** a row that invents a size ceiling ⇒ plan defect. A payload file with `bytes=0` ⇒ the
    F-2/F-18 FAIL.

- [ ] **F-27 (NF5, an empty `engine-payload/` still builds).** Empty the staged dir from a tmp script
      (the tester's `Remove-Item` grant covers `.opencode/*` only, `opencode.json:416`, so a direct
      delete of `apps/tauri/…` is a sandbox refusal): author
      `.opencode/tmp/3158/empty-payload-dir.ps1` containing
      `Get-ChildItem -LiteralPath 'apps\tauri\src-tauri\engine-payload' -File | Remove-Item -Force`
      and run `RC("powershell -NoProfile -File .opencode\tmp\3158\empty-payload-dir.ps1")`; then
      `RC("cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked")`.
  - **Expected:** `EXITCODE=0` — an existing **empty** directory is a legal resource no-op
    (`tauri-utils` `resources.rs:246-266`), and no `GlobPathNotFound` / `ResourcePathNotFound` is
    raised on a pristine or shared-target tree.
  - **Edge:** a red with `GlobPathNotFound` ⇒ **FAIL** (the trap the directory exists to avoid). A
    **missing** directory reds with `ResourcePathNotFound`: create it and re-run, and record that
    `build.rs` must create it.

- [ ] **F-28 (NF6, one machine-readable payload source).** Read
      `.opencode/scripts/payload-manifest.json` and check both scripts reference it.
  - **Expected:** the manifest carries all 8 core names + the 6 tool-module names + the two excluded
    names, with `ggml-cuda.dll` in no "required" array;
    `verify-installer-payload.ps1`'s `-ExpectedPayload` **defaults** to that exact path and
    `stage-engine-payload.ps1` reads the same file; **no second hardcoded DLL list** exists in either
    script.
  - **Edge:** two lists ⇒ **FAIL** (they drift). `ggml-cuda.dll` marked required ⇒ unconditional
    **FAIL** (`Cargo.toml:127-136`).

## #3172 — OpenSSL-free build + total import scan (new contract rows)

Each row below binds to the #3172 QA Plan (`## QA Expert` rows `R-1.2` … `R-5.3`) and to the exact
script literals; the enumerations above stay the #3158 history. `fredo.exe` is **outside** the scan
universe — its load proof is AC4 (F-39), and no row here asserts on its own imports.

- [ ] **F-29 (R-1.4, stager control 8 — a load-time forbidden import fails staging).**
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -SelfTest")`.
  - **Expected:** the transcript carries `CONTROL 8 - FORBIDDEN-IMPORT` then `[PASS]`; the control
    drives `PAYLOAD_FORBIDDEN_IMPORT=libssl-3-x64.dll imported_by=ggml.dll kind=import` and
    `ERROR=PAYLOAD_FORBIDDEN_IMPORT dll=ggml.dll module=libssl-3-x64.dll kind=import` with exit 1,
    and its pre-seeded `sentinel.txt` in `-OutDir` survives; `SELFTEST: PASS`, `EXITCODE=0`.
  - **Edge:** `libssl-3-x64.dll` derives from `importClosure.forbiddenImportPrefixes[0]`
    (`"libssl"`), and the importer is the manifest-derived anchor core name (today `ggml.dll`); a
    control asserting only "no crash" (not the named literal) ⇒ instrument **FAIL**. `kind=parse`
    belongs to the PE-gap class, not this row.

- [ ] **F-30 (R-1.3 + R-1.4, stager control 9 — a delay-load forbidden import fails staging).**
      Same `-SelfTest` run.
  - **Expected:** `CONTROL 9 - DELAY-IMPORT` then `[PASS]`; it drives
    `PAYLOAD_FORBIDDEN_IMPORT=libcrypto-3-x64.dll imported_by=ggml.dll kind=delay-import` and
    `ERROR=PAYLOAD_FORBIDDEN_IMPORT dll=ggml.dll module=libcrypto-3-x64.dll kind=delay-import`,
    exit 1, sentinel survives. This is the discriminator for the delay-import directory
    (`DataDirectory[13]`) — a reader of `DataDirectory[1]` alone cannot see it.
  - **Edge:** `libcrypto-3-x64.dll` derives from `forbiddenImportPrefixes[1]` (`"libcrypto"`); a
    `kind=import` line from control 8 does not satisfy this row (the two kinds are distinct literals).

- [ ] **F-31 (R-2.2, stager control 10 — a NON-ROOT tool module's import gap fails staging).**
      Same `-SelfTest` run.
  - **Expected:** `CONTROL 10 - NON-ROOT-IMPORT-GAP` then `[PASS]`; the importer is the first
    `toolModules` entry (today `llama-batched-bench-impl.dll`), the missing module is
    `fixture-absent-dependency.dll`, and the control drives
    `PAYLOAD_IMPORT_MISS=fixture-absent-dependency.dll imported_by=llama-batched-bench-impl.dll kind=import`
    and
    `ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=llama-batched-bench-impl.dll -> fixture-absent-dependency.dll kind=import`,
    exit 1, sentinel survives. This is the AC2 discriminator: a roots-only gate passes control 4 and
    fails this one.
  - **Edge:** a fixture whose importer is a core/root DLL does not exercise this row; a `kind=parse`
    error is a different class.

- [ ] **F-32 (R-2.1, stager control 11 — an incomplete import scan fails closed).**
      Same `-SelfTest` run.
  - **Expected:** `CONTROL 11 - IMPORT-SCAN-COMPLETE` then `[PASS]`; the control deliberately skips
    one staged DLL and drives `ERROR=PAYLOAD_IMPORT_SCAN_INCOMPLETE scanned=<n> staged=<n>` with
    `scanned = staged - 1`, `staged = 14` (8 core + 6 tool modules), and exactly `staged - 1`
    `PAYLOAD_IMPORT_SCAN=<dll> imports=<n> delay=<n>` lines; exit 1, sentinel survives.
  - **Edge:** a count mismatch with no named error ⇒ control-11 defect; a 14-scan-line transcript in
    the failing leg means the deliberate skip did not take effect.

- [ ] **F-33 (R-2.3, the manifest is total by construction — and the refusal is drivable).**
      Read `.opencode/scripts/payload-manifest.json`; then drive the `-ManifestPath` seam from a tmp
      copy (never mutate the committed manifest): author
      `.opencode/tmp/3172/manifest-subset.json` with `"roots": "subset"` and
      `.opencode/tmp/3172/manifest-blank-prefix.json` with `"forbiddenImportPrefixes": [""]`, then
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -ManifestPath '.opencode\tmp\3172\manifest-subset.json'")`
      and the same call with the blank-prefix copy.
  - **Expected:** the committed manifest reads `"schemaVersion": 2` and
    `importClosure.roots` = `"all-staged"`, its `forbiddenImportPrefixes` are exactly `libssl` and
    `libcrypto`, and it carries **no** `rootExact` / `rootPrefix` key; the subset copy exits `2` with
    `ERROR=PAYLOAD_MANIFEST_INVALID path=<abs path> reason=import-closure-not-total value=subset`;
    the blank-prefix copy exits `2` with
    `ERROR=PAYLOAD_MANIFEST_INVALID path=<abs path> reason=missing-forbidden-prefixes`.
  - **Edge:** a default staging run (`-ManifestPath` omitted) must read the manifest beside the
    script — a caller-supplied path is never read by default (`stage-engine-payload.ps1:83-88`,
    `:148-154`). Never edit the committed manifest mid-round; if the seam is absent, record the
    refusal literal as `logic-verified, no discriminating run` — never a PASS from the committed
    value alone.

- [ ] **F-34 (R-1.2 + R-2.1, a real staging run reports one import scan per staged DLL).**
      On a profile tree holding the full payload (F-18's precondition),
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -Profile release")`
      (or `-Profile debug`, naming the profile that answered).
  - **Expected:** `RESULT=PASS`; `PAYLOAD_COUNT=14`; exactly **14** lines
    `PAYLOAD_IMPORT_SCAN=<dll> imports=<n> delay=<n>` (one per staged DLL, each with a `delay=`
    field — proof `DataDirectory[13]` is read); **zero** `PAYLOAD_FORBIDDEN_IMPORT=` and zero
    `PAYLOAD_IMPORT_MISS=` lines; no `ERROR=PAYLOAD_IMPORT_SCAN_INCOMPLETE`.
  - **Edge:** fewer scan lines than staged DLLs ⇒ `ERROR=PAYLOAD_IMPORT_SCAN_INCOMPLETE
    scanned=<n> staged=<n>` (R-2.1); on a tree where a listed tool module is absent the scan-line
    count equals `PAYLOAD_COUNT` (self-consistency), while 14 is the complete-set expectation — a
    stale cached `llama-common.dll` is caught HERE, not from a build log.

- [ ] **F-35 (R-5.1, the artifact gate scans every payload DLL it extracts).**
      `RC("powershell -File .opencode/scripts/verify-installer-payload.ps1 -Installer 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.2_x64-setup.exe'")`.
  - **Expected:** `ARTIFACT_PAYLOAD_SCANNED=14 of=14`; `IMPORT_SCAN=PASS dlls=14`;
    `RESULT=PASS`; `EXITCODE=0`; **zero** `ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT`,
    `ERROR=PAYLOAD_IMPORT_UNRESOLVED_IN_ARTIFACT` and
    `ERROR=PAYLOAD_IMPORT_PARSE_FAIL_IN_ARTIFACT` lines; a tool module absent from the extract is
    reported `PAYLOAD_ABSENT_OPTIONAL=<name>` (a report, never a FAIL) and both counts drop together.
  - **Edge:** a presence-only gate (pre-#3172) emits no `ARTIFACT_PAYLOAD_SCANNED=` / `IMPORT_SCAN=`
    line ⇒ **FAIL**; `fredo.exe` and `uninstall.exe` are outside the scan universe.

- [ ] **F-36 (R-5.1, verifier controls 6/7 — the artifact gate's forbidden-import legs).**
      `RC("powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -SelfTest")`.
  - **Expected:** `CONTROL 6 - ARTIFACT-FORBIDDEN-IMPORT` and `CONTROL 7 - ARTIFACT-DELAY-IMPORT`
    each print `[PASS]`; control 6 drives
    `ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT dll=llama-common.dll module=libssl-3-x64.dll kind=import`,
    control 7 drives
    `ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT dll=llama-common.dll module=libcrypto-3-x64.dll kind=delay-import`;
    each run also prints `IMPORT_SCAN=FAIL` and exits 1.
  - **Edge:** `llama-common.dll` is the preferred scan target (the DLL whose real OpenSSL import
    motivated this spec); a manifest without it falls back to the first core name — record the
    actual `dll=` value. Both fixtures are synthetic PEs (a text stub would now be a parse failure) —
    strictly stricter with the control names unchanged.

- [ ] **F-37 (R-5.3, verifier control 8 — an unresolved import in the artifact fails the gate).**
      Same `-SelfTest` run.
  - **Expected:** `CONTROL 8 - ARTIFACT-IMPORT-GAP` then `[PASS]`; it drives
    `ERROR=PAYLOAD_IMPORT_UNRESOLVED_IN_ARTIFACT edge=llama-common.dll -> mystery-unresolved-dependency.dll kind=import`,
    `IMPORT_SCAN=FAIL`, exit 1.
  - **Edge:** the full poisoned-installer form would re-bundle over the measured artifact (G-446) ⇒
    cite-not-execute; the synthetic control is the demonstrated leg and the disclosure is
    `logic-verified on the instrument; no re-bundled poisoned artifact`.

- [ ] **F-38 (R-5.2, the verifier's instrument contract is eight controls).**
      `RC("powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -SelfTest")`.
  - **Expected:** `EXITCODE=0`; `SELFTEST: PASS`; all eight control lines present —
    `CONTROL 1 - PASS-ON-COMPLETE`, `CONTROL 2 - FAIL-ON-MISSING`,
    `CONTROL 3 - REFUSE-DEBUG-PATH`, `CONTROL 4 - REFUSE-NO-EXTRACTOR`,
    `CONTROL 5 - SELF-REFERENCE`, `CONTROL 6 - ARTIFACT-FORBIDDEN-IMPORT`,
    `CONTROL 7 - ARTIFACT-DELAY-IMPORT`, `CONTROL 8 - ARTIFACT-IMPORT-GAP`; **no `[FAIL]`**.
  - **Edge:** controls 1–5 keep their names and assertions (their fixtures moved from text stubs to
    synthetic PEs — stricter, not a rename); `EXITCODE=3` ⇒ a control failed ⇒ **FAIL**; a missing
    control line ⇒ **FAIL** (the eight are the contract).

- [ ] **F-39 (R-4.1–R-4.3, the AC4 probe literals — sanitised PATH, version, probe, remove-one-DLL).**
      Decide the extraction route (7z on `PATH` → `%ProgramFiles%\7-Zip\7z.exe` → NSIS `/S /D=`),
      name it in the receipt, then
      `RC("powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe '<install>\fredo.exe' -Ports <n> -SanitizePath -CompanionProbe -RemoveDll llama-common.dll")`.
  - **Expected:** `PATH_SANITISED=C:\Windows\System32;C:\Windows`; `VERSION_EXIT=0`;
    `VERSION_STDOUT=fredo 0.2.2`; `PROBE_EXIT=0`; `PROBE_SUCCESS=true`; one `PROBE_JSON=` object
    with `"success":true` (record the loaded `modelId`); `CONTROL_REMOVED_DLL=llama-common.dll`;
    `CONTROL_EXIT=-1073741515`; `CONTROL_EXPECTED_EXIT=-1073741515` (accept `3221225781` unsigned).
  - **Edge:** any receipt whose `PATH`/cwd contains `apps\tauri\src-tauri\target\<profile>` (or
    traceable to `cargo run` / `pnpm dev:tauri` / `pnpm dev:tauri:release` / `target/release/fredo.exe`
    run in place) is **REJECTED evidence** and invalidates the artifact verdict (F-16). `-RemoveDll`
    deletes only from its `.opencode/tmp/3172/` copy — the install tree is never touched. If
    `PROBE_SUCCESS=false` with `modelMissing` / `mmprojInitFailed` / `mtpInitFailed`, record the
    **precondition blocker** (E-2), never a product FAIL.

_Evidence convention: pass cases keep `- [x]` and append the recorded transcript/JSON tokens plus the
`EXITCODE=` value; fail cases leave `- [ ]` and mark `FAIL` with expected-vs-actual + repro. Rows whose
precondition is absent (no installer, no models, no extractor, no elevation, no GPU for F-8) are
`NOT RUN` with the named blocker — never a PASS, never a product FAIL._
