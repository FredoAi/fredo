# Companion Artifact Payload — Smoke

> Quick checks that the packaging change is present and internally consistent. This is a
> **packaging/config + artifact** domain: the standard app-boots webview boilerplate does **not**
> apply (the installed release build registers no MCP bridge —
> `apps/tauri/src-tauri/src/lib.rs:197-207` — so `tauri_webview_*` cannot attach, and the tester's
> receipts are **text**, not screenshots: `gh image` is broken here with `uploadToken not found`).
> Verification policy: **static** (artifact + process-execution receipts).
>
> Command notation: `RC("<cmd>")` =
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"` (prints the output plus
> `EXITCODE=<n>`; the bash allowlist has no direct glob for the new scripts — `opencode.json:435`).
> `Get-Item`/`Get-ChildItem`/`Get-FileHash`/`Select-String` are **not** independent allowlisted verbs
> for the tester — call them **inside** `RC(...)`, and keep `;`/`|`/`&&` out of the `-Command` string
> (the deny rules at `opencode.json:437-445` are last-match-wins). A bare invocation is a sandbox
> refusal, never a product signal.

- [ ] **S-1 — The config declares the payload.** Read `apps/tauri/src-tauri/tauri.conf.json`.
      **Expected:** `bundle.resources` is exactly `{"engine-payload/": ""}` (a map, empty
      destination, no `*`); `bundle.externalBin` is still `[]`; `bundle.active: true`.

- [ ] **S-2 — The CI clear is gone.** Read `apps/tauri/src-tauri/build.rs`.
      **Expected:** no `Bundle resources cleared`, no `is_ci`, no `env::var("CI")`, no
      `get_mut("resources")`, no `tauri.conf.json.bak`; the staging dir is created before
      `tauri_build::try_build`.

- [ ] **S-3 — The staging script exists and its instrument is healthy.**
      `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -SelfTest")`.
      **Expected:** `EXITCODE=0`; all eleven `CONTROL n - <NAME>` lines present —
      `1 - POSITIVE`, `2 - MISSING-CORE`, `3 - MISSING-LOADER`, `4 - IMPORT-GAP`, `5 - NO-CUDA`,
      `6 - IDEMPOTENT`, `7 - SELF-REFERENCE` (unchanged) plus `8 - FORBIDDEN-IMPORT`,
      `9 - DELAY-IMPORT`, `10 - NON-ROOT-IMPORT-GAP`, `11 - IMPORT-SCAN-COMPLETE` — and `SELFTEST:
      PASS`; no `[FAIL]`.

- [ ] **S-4 — The artifact gate exists and refuses the wrong artifact.** Read
      `.opencode/scripts/verify-installer-payload.ps1` (Read tool);
      then `RC("powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -Installer 'apps\tauri\src-tauri\target\debug\fredo.exe'")`.
      **Expected:** the script's header declares `-Installer` / `-ExpectedPayload` / `-WorkDir`, a
      `\debug\` refusal and exit codes 0/1/2; the run **refuses** with `EXITCODE=2` (a `\debug\` path
      is refused). A run that proceeds to extract a debug path ⇒ **FAIL**.

- [ ] **S-5 — The release job runs the gate.**
      Four separate calls, no `|` in any `-Command` string (the sandbox's `*|*` deny rule at
      `opencode.json:442` can refuse it):
      `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'verify-installer-payload'")`,
      `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'PAYLOAD_INCOMPLETE_IN_ARTIFACT'")`,
      `RC("Select-String -Path '.opencode/scripts/test-scripts.ps1' -Pattern 'verify-installer-payload'")`,
      `RC("Select-String -Path '.opencode/scripts/test-scripts.ps1' -Pattern 'PAYLOAD_INCOMPLETE_IN_ARTIFACT'")`.
      **Expected:** all four return at least one match; the `release.yml` matches are in a step
      positioned **after** `tauri-apps/tauri-action`.

- [ ] **S-6 — The artifact under test is this round's.**
      `RC("Get-ChildItem -LiteralPath 'apps\tauri\src-tauri\target\release\bundle\nsis' -File")`.
      **Expected:** at least one `*-setup.exe` whose name carries `0.2.2` and whose `LastWriteTime`
      is at/after this round's build start. A lone `0.1.0` file is a **stale artifact** (the bundle dir
      currently holds `Fredo_0.1.0_x64-setup.exe`) — record it as such and route to F-1, not a PASS.

- [ ] **S-7 — Evidence capture (text).** The suite records, in the POSTED `## Tests Runs`, the
      commands run and their `RESULT=` / `EXITCODE=` / `PAYLOAD_*` / JSON tokens. **Expected:** a
      text receipt per row — no screenshot is required or available (the static policy's evidence
      form).

_Full DOM + visual execution methodology lives in the `dev-environment` skill but is **NOT
applicable** to this domain: the artifact under test is an installed release build with no webview
automation surface._
