# Release Artifact Gate — Functional

> Durable functional suite for **the committed release-gate harness** (Spec #3181): one PowerShell
> script that turns a produced `*-setup.exe` into a verdict + evidence, wired into
> `.github/workflows/release.yml` before the only `gh release create --draft`. Rows map 1:1 to
> `## QA Expert` in `.opencode/tmp/3181/triage.md` (REQ-1.1…5.2 + NF) and to the Architect's
> binding names block (§A–§J).
>
> **Verification policy: `live`.** Every binding AC is runtime behaviour of a produced installer.
> The release binary runs **no OTel producer** (`companion_probe.rs:3-9`) and ships **no MCP
> bridge** (`launch-artifact-probe.ps1:1-10`), so `telemetry_spans` and `tauri_webview_*` are
> unavailable. **The live receipt is the harness's own executed output**, quoted in the POSTED
> `## Tests Runs`: `receipt.json` + `gate.log` + `run-*/screenshot.png` (path/bytes/sha256) + the
> `SURFACE_RECT=` line emitted from a `getBoundingClientRect` measurement of the rendered app.
> The machine's verdict guard accepts a line containing `getBoundingClientRect`
> (`.opencode/scripts/pipeline-state.rs:3737-3740`) — **quote that line or the verdict is refused**.
>
> **Command notation.** `RC("<cmd>")` means
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"` — the committed wrapper
> (`.opencode/scripts/run-exitcode.ps1:34-38`) that prints the output and then `EXITCODE=<n>`.
> **Every gate invocation goes through the wrapper**: `opencode.json` carries the gate-script
> grants (`:462-465`), but they only take effect on the next opencode restart, so a direct
> `powershell -File .opencode/scripts/gate-release-artifact.ps1 …` may be refused by the running
> session. A refusal is a sandbox event, never a product FAIL. Non-git verbs
> (`Get-Item`, `Get-ChildItem`, `Get-FileHash`, `Select-String`) are not tester patterns — call
> them inside `RC(...)` or from a `.opencode/tmp/release-gate/<name>.ps1` script run with
> `RC("powershell -NoProfile -File .opencode/tmp/release-gate/<name>.ps1")`
> (`powershell -File .opencode/tmp/*` is allowlisted). No `..`, no `|`, no `;`, no `&`.
> **Where a row says "Read <file>", use the Read tool on that exact path** (the tester's `read`
> permission is unconditional) and quote the lines into the verdict; every *executing* step is an
> `RC(...)` command.
>
> **One canonical gate run.** The invocation in F-1 (OutDir `.opencode\tmp\release-gate\3181-gate`)
> is the SINGLE `-Mode gate` run that supplies F-1, F-3(a), F-5–F-13 and F-21. Do not re-run per
> row. Separately: the manual run (F-19/F-20), the three negative legs (F-14–F-16), the red run
> (F-22), and the **REQUIRED** CSP-revert bundle build + gate (F-15b, **last**).
>
> **Serving state:** the spec branch tip at the round's tested head SHA. Record `git rev-parse HEAD`
> with the evidence.
>
> **Round-1 coverage rows.** `F-28` (launch-seam port contract) and `F-29` (negative-leg instrument
> classification) were added from the round-1 tester verdict (`## Tests Runs`, round 1): the driver
> passed the probe ports as **one comma-joined string** to `[int[]]$Ports`
> (`launch-artifact-probe.ps1:236`), so every launch child exited 1 before the app ran, and the three
> negative legs misclassified that as `NEGATIVE_NOT_REPRODUCED` / `NEGATIVE_WRONG_ERROR`. They bind
> the Architect's round-1 fix plan and **add** coverage — no existing row, literal or binding name
> changes. `F-27` is likewise re-scoped below to **content** mutation (the round-1 red was a stat-only
> build touch of `apps/tauri/src-tauri/Cargo.toml`, `git diff` empty, identical blob).

## Constants (re-derived from the shipped tree — do not substitute)

| Constant | Value | Source |
|---|---|---|
| Harness (CI + manual) | `.opencode/scripts/gate-release-artifact.ps1` | Architect §A |
| Window hook | `.opencode/scripts/gate-artifact-window.ps1` | Architect §A |
| CDP client | `.opencode/scripts/fredo-cdp.psm1` | Architect §A |
| Default CDP port | `9333` (must be closed before launch) | Architect §G |
| App ports probed closed | `9223`, `16932`, `19631` | Architect §G, `env.rs:58` |
| Installer | `apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.4_x64-setup.exe` | `tauri.conf.json:3-4` |
| Exit codes | `0` PASS / `1` FAIL / `2` REFUSED / `3` orphans | Architect §C |
| Evidence root | `.opencode\tmp\release-gate\<stamp>` (gitignored) | Architect §D |
| Workflow steps | `Gate the produced installer (live assertions)` (`id: artifact-gate`), `Negative-control legs (fail-closed demonstrations)` (`id: negative-controls`), `Upload release-gate evidence` (`if: always()`) | Architect §F |
| Sanitised child PATH literal | `PATH_SANITISED=C:\Windows\System32;C:\Windows` | `launch-artifact-probe.ps1 -SanitizePath` |
| CSP-revert overlay (REQ-3.2b, committed) | `.opencode/scripts/tauri.csp-revert.json` = `{"app":{"security":{"dangerousDisableAssetCspModification":false}}}` | Architect REQ-3.2b; `false` = "asset CSP modification NOT disabled" (a `--config` overlay deep-merges, so it cannot delete a key) |
| Amended styled font criterion | body `fontFamily` non-empty **and** contains the first family of the authored `--font-family` (`Inter` on the locked `classic` base, `apps/ui/src/app/types/theme.ts:185`) — **never** `JetBrains Mono`/`Fira Mono` | UI/UX 5b; `ThemeProvider.tsx:253`, `:359`, `:411` |

---

## AC1 — wired before publishing

- [ ] **F-1 (REQ-1.1, the canonical run drives the PRODUCED installer).**
  `RC("powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Installer 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.4_x64-setup.exe' -Mode gate -OutDir '.opencode\tmp\release-gate\3181-gate'")`;
  then `RC("Get-Item -LiteralPath 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.4_x64-setup.exe'")`
  and `RC("Get-FileHash -Algorithm SHA256 -LiteralPath 'apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.4_x64-setup.exe'")`.
  - **Expected:** `EXITCODE=0`; `GATE_INSTALLER=` names that exact path; `receipt.installer.sha256`
    equals the `Get-FileHash` value, `receipt.installer.bytes` equals `Length`,
    `receipt.installer.version` = `0.2.4`, `receipt.installer.fileName` =
    `Fredo_0.2.4_x64-setup.exe`. No `target\debug\` path, no `pnpm dev:*` route in the receipt.
  - **Edge:** a `\debug\` path ⇒ exit 2 + `ERROR=DEBUG_ARTIFACT_REFUSED path=<p>`
    (`verify-installer-payload.ps1:454`) and `receipt.verdict=REFUSED` — never a PASS. A stale
    installer (`LastWriteTime` before this round's build start) ⇒ **FAIL** (G-425). A differing
    stem with the `0.2.4` version segment ⇒ record the stem, continue — do not fail on the stem.
  - **Evidence:** POSTED `## Tests Runs` quotes `bytes=`, `sha256=`, `mtime=`, `GATE_INSTALLER=`;
    `.opencode/tmp/release-gate/3181-gate/receipt.json`.

- [ ] **F-2 (REQ-1.2, the gate step sits after payload verify and before the only draft publish).**
  Five separate calls:
  `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'name: Verify installer payload'")`,
  `… -Pattern 'id: artifact-gate'`, `… -Pattern 'name: Gate the produced installer'`,
  `… -Pattern 'name: Create draft release'`, `… -Pattern 'gh release create'`.
  - **Expected:** strictly ordered line offsets — `Verify installer payload` <
    `Gate the produced installer (live assertions)` / `id: artifact-gate` < `Create draft release`;
    **exactly one** `gh release create` in the workflows directory and it carries `--draft`; the
    draft step keeps `if: success()`; the gate step is `shell: pwsh`, receives
    `INSTALLER: ${{ steps.locate.outputs.installer }}` and `OUT_DIR: .opencode/tmp/release-gate/ci`,
    and its run block ends `Write-Host "::error::RELEASE_GATE_FAILED exit=<n>"; exit <n>`.
  - **Edge:** gate step before payload verify ⇒ **FAIL**; a second `gh release create` or
    `--draft` dropped ⇒ **FAIL**; `if: success()` removed ⇒ **FAIL**. The `push: release/stable`
    trigger half is unproducible from this spec's PR ⇒ disclose
    `logic-verified, no discriminating run` for the trigger only (G-410).
  - **Evidence:** POSTED `## Tests Runs` quotes the five `path:line: text` hits.

- [ ] **F-3 (REQ-1.3, a gate failure fails the job and no draft is created).**
  (a) `RC("<gate> -Installer '<the F-22 broken artifact>' -Mode gate -OutDir '.opencode\tmp\release-gate\3181-red'")`
  ⇒ `EXITCODE=1`; (b) read the gate step and the draft step of `.github/workflows/release.yml`.
  - **Expected:** (a) non-zero exit with `receipt.verdict=FAIL`; (b) the gate step propagates its
    non-zero exit (no `continue-on-error`, no `if: always()` on the gate step), the draft step reads
    `if: success()`, and the cleanup step still reads
    `if: failure() && steps.draft.outcome == 'failure'`.
  - **Edge:** `continue-on-error: true` on the gate step ⇒ **FAIL**; a gate step that prints
    `::error::RELEASE_GATE_FAILED` but exits 0 ⇒ **FAIL**. The CI-execution half (an actually
    skipped draft on the runner) is unproducible ⇒ `logic-verified, no discriminating run`, with (a)
    as the executed fail-closed receipt.
  - **Evidence:** POSTED `## Tests Runs` quotes the red `EXITCODE=` + `verdict` and the two YAML
    condition lines.

- [ ] **F-4 (REQ-1.4, evidence uploads on a red run too).**
  `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'Upload release-gate evidence'")`,
  then `-Pattern 'actions/upload-artifact@'`, `-Pattern 'release-gate-evidence'`,
  `-Pattern 'if: always()'`; read the step block.
  - **Expected:** a step named `Upload release-gate evidence` with `if: always()`,
    `uses: actions/upload-artifact@<40-hex sha>` (**a resolved SHA, never `@v4`**),
    `with.name: release-gate-evidence`, `with.path: .opencode/tmp/release-gate`.
  - **Edge:** `@v4` tag ⇒ **FAIL**; upload gated on success only ⇒ **FAIL** (a red run loses its
    logs, receipt and screenshot); `path` = one file ⇒ **FAIL**.
  - **Evidence:** POSTED `## Tests Runs` quotes the step text with the resolved SHA.

## AC2 — the seven assertions in one pass

- [ ] **F-5 (REQ-2.0, one pass, one verdict, one receipt).** The F-1 run plus
  `RC("Get-ChildItem -LiteralPath '.opencode\tmp\release-gate\3181-gate' -File")`.
  - **Expected:** exactly **one** `VERDICT=PASS` line in `gate.log`; exactly one `receipt.json` in
    the OutDir root; `receipt.checks[].id` contains each of `REQ-2.1`…`REQ-2.7` exactly once, all
    `ok: true`; `receipt.mode="gate"`; `receipt.exitCode` equals `EXITCODE=`; `receipt.errors` empty
    or absent; `receipt.durationSeconds` present.
  - **Edge:** two receipts ⇒ **FAIL** (not one pass); exit 0 with `ok: false` ⇒ **FAIL**; exit 0
    with `verdict != PASS` ⇒ **FAIL**; a missing clause id ⇒ **FAIL**.
  - **Evidence:** POSTED `## Tests Runs` quotes `VERDICT=` + the seven `checks[]` entries.

- [ ] **F-6 (REQ-2.1, extraction with no elevation and no dev toolchain).** Read `gate.log` and
  `run-fresh/launch-report.log` from the F-1 run.
  - **Expected:** `EXTRACT_ROUTE=` present, its value naming a **non-NSIS** route (no `nsis`, no
    `elevat`); the delegated verifier prints `EXTRACT_ROOT=<path>` (`verify-installer-payload.ps1:519`)
    and `RESULT=PASS` (`:341`); `PATH_SANITISED=C:\Windows\System32;C:\Windows`; no
    `ERROR=EXTRACTOR_MISSING`, no `EXTRACT_FAILED`; `receipt.evidence.payloadWorkDir` =
    `installer-payload`.
  - **Edge:** no route ⇒ `EXTRACT_FAILED:<detail>` + exit 2 (**REFUSED** — not a FAIL, not a PASS);
    `-SevenZip` given but absent ⇒ `ERROR=EXTRACTOR_OVERRIDE_NOT_FOUND` + exit 2; NSIS/elevation-only
    route ⇒ **FAIL** (an unanswered elevation is never a pass). Local 7z lives outside the repo
    (`C:\Users\<user>\AppData\Local\Temp\opencode\sevenzip\…`): pass it via the **optional**
    `-SevenZip <path>`, never as a literal in a plan command (G-322).
  - **Evidence:** POSTED `## Tests Runs` quotes `EXTRACT_ROUTE=`, `EXTRACT_ROOT=`, `RESULT=PASS`,
    `PATH_SANITISED=`.

- [ ] **F-7 (REQ-2.2, the launch survives the window).** Read `run-fresh/launch-report.log`.
  - **Expected:** the probe reports `RESULT=PASS` with `HAS_EXITED=False` for the window;
    `ORPHANS_LEFT=0`; `gate.log` carries no `LAUNCH_EXIT:` and no `LAUNCH_NOT_RUNNING`; when the app
    does exit early the inner gate fails with `LAUNCH_EXIT:<code>` and exit 1.
  - **Edge:** `0xC0000135` ⇒ `LAUNCH_EXIT:-1073741515` (accept `3221225781`); no process at all ⇒
    `LAUNCH_NOT_RUNNING`; probe exit 3 (orphans) ⇒ harness exit 3 ⇒ **FAIL**.
  - **Evidence:** POSTED `## Tests Runs` quotes the probe report lines + `EXITCODE=`.

- [ ] **F-8 (REQ-2.3, styled UI + zero CSP violations + frame readiness).** Read the
  `CHECK REQ-2.3` line and `run-fresh/cdp.json`.
  - **Expected:** `CHECK REQ-2.3 PASS` with `detail` carrying `rules=<n> floor=<m> font=<v>
    accent=<v> violations=0`, and the tester asserts:
    (a) the injected `<style>` control yields exactly one CSS rule (`injectedRules=1`);
    (b) emotion sheets (`ownerNode[data-emotion]`) total rules **> 0**;
    (c) `n >= m >= 1` (the recorded floor);
    (d) `font` non-empty **and** containing the first family of the authored `--font-family`
    — `getComputedStyle(document.documentElement).getPropertyValue('--font-family')`, take the first
    comma-separated family, strip quotes (`Inter`), assert
    `getComputedStyle(document.body).fontFamily` contains it case-insensitively — **do NOT assert
    `JetBrains Mono` or `Fira Mono`**;
    (e) `--accent-primary` on `documentElement` non-empty (`ThemeProvider.tsx:340`);
    (f) `violations=0`;
    plus S1–S6 true in `cdp.json`'s `screenshot.criteria` (right document; `#root` + a div ≥ 90% of
    the viewport in both axes; an opaque computed `document.body` background; both launcher elements
    present with w ≥ 100 px and h ≥ 8 px intersecting the viewport; the LED dot's computed
    `backgroundColor` not transparent; `--accent-primary` non-empty);
    plus `screenshot.readyMs` ≤ 15000 and `screenshot.viewport{width,height}` recorded (S1–S5
    polled ≤ 15 s at 250 ms before capture), and the PNG's IHDR width/height (file bytes 16–23)
    equal `screenshot.viewport` — viewport-only capture: no `clip`, no `captureBeyondViewport`, no
    `Emulation` override;
    plus the `SURFACE_RECT=` line with `w > 0` and `h > 0`.
  - **Edge:** any failure ⇒ `UNSTYLED:<detail>` (frame failures as
    `UNSTYLED:screenshot-frame S<n>=<observed>`) and/or `CSP_VIOLATION:<detail>`, exit 1;
    `about:blank`/blank webview ⇒ S1 false ⇒ `UNSTYLED:screenshot-frame S1=…`; no target after the
    window ⇒ `CDP_UNAVAILABLE`; WebView2 absent ⇒ `WEBVIEW2_MISSING` + exit 2; CDP port pre-bound ⇒
    `CDP_PORT_IN_USE` + exit 2. **A receipt asserting the mono stack is a plan defect, not a product
    FAIL** (REQ-2.3(d) amended). Do **not** probe the Home root Box background (`Home.tsx:261`
    references an undefined `--bg-primary`); the painted ground is `document.body`
    (`ThemeProvider.tsx:409`, set as the `background` shorthand).
  - **Evidence:** POSTED `## Tests Runs` quotes the `CHECK REQ-2.3` line **and the `SURFACE_RECT=`
    line verbatim** (the live-receipt token); `run-fresh/cdp.json`.

- [ ] **F-9 (REQ-2.4 fresh, DB reaches `ready` in the bound).** Read `run-fresh/cdp.json`.
  - **Expected:** `db.state="ready"` within `-DbReadySecs` (180); `db.dataDir` is the fresh run's
    dir; `db.port` and `db.pid` present; no `DB_NOT_READY:fresh`.
  - **Edge:** `disabled`/`starting` at the bound ⇒ `DB_NOT_READY:fresh` + exit 1; a bound expiring
    is a named failure, never a hang.
  - **Evidence:** POSTED `## Tests Runs` quotes the `db` object + the REQ-2.4 check line.

- [ ] **F-10 (REQ-2.4 dirty, `ready` + `<cluster>.rejected-*` sibling).** Read `run-dirty/cdp.json`
  and the `QUARANTINE_EVIDENCE=` line.
  - **Expected:** `db.state="ready"` within the bound; a `<cluster>.rejected-<unix_ts>` sibling under
    `<DataDir>/postgres/` containing the seeded `start.log` (rename, never delete —
    `cluster_dir.rs:48-53`); no `DB_NOT_READY:dirty`.
  - **Edge:** ready but no sibling ⇒ `DB_QUARANTINE_MISSING`; residue deleted instead of renamed ⇒
    `DB_QUARANTINE_MISSING`; ready with no `QUARANTINE_EVIDENCE=` line ⇒ instrument gap (route to
    ST-3), not a product PASS.
  - **Evidence:** POSTED `## Tests Runs` quotes `QUARANTINE_EVIDENCE=<path>` + the dirty `db` object.

- [ ] **F-11 (REQ-2.5, one companion turn answered THROUGH THE APP).** Read the `companion` object
  in `run-fresh/cdp.json`.
  - **Expected:** `companion.route` ∈ {`ui`, `ipc`} (`ipc` must be recorded in the receipt, never a
    silent fallback); `replyChars > 0` with non-empty reply text (`[data-testid="fredo-reply-surface"]`
    innerText on the `ui` route; `get_llama_server_status.mtpStats` + an `llm-done` listener on the
    `ipc` route); the companion setting was written **through the app**
    (`save_setting` for `Fredo_companion_visible`, then `Page.reload` — seeding localStorage is not
    sufficient, `CompanionContext.tsx:373-374`, `launcherEnterAction.ts:186-198`); no
    `COMPANION_NO_REPLY` / `COMPANION_ENGINE:`.
  - **Edge:** model set absent ⇒ `MODEL_SET_MISSING:<file>` + exit 2 ⇒ **NAMED BLOCKER (NOT RUN)** —
    never a PASS, never `-SkipCompanion` on this row; typed engine failure ⇒ `COMPANION_ENGINE:<code>`;
    `replyChars=0` ⇒ `COMPANION_NO_REPLY`; driving the `companion probe` CLI instead of the app ⇒
    **FAIL** (wrong route). Model trio: `{home}/fredo-models/gemma-4-e2b-it-qat/` —
    `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf`, `mmproj-BF16.gguf`, `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf`
    (`models.rs:40`, `:124-162`); **do not hand-resolve the path** — read the harness's
    `MODEL_SET_MISSING:<file>` line, which names the file it resolved.
  - **Evidence:** POSTED `## Tests Runs` quotes the `companion` object + route + a ≤ 200-char reply
    excerpt.

- [ ] **F-12 (REQ-2.6, the MCP bridge port is closed).** Read `run-fresh/launch-report.log`.
  - **Expected:** `PORT_9223=CLOSED`, `PORT_16932=CLOSED`, `PORT_19631=CLOSED` while the app runs;
    no `MCP_PORT_OPEN:<port>`; no `MCP_BRIDGE_LOG_LINE`; `9333` is not among `-Ports`.
  - **Edge:** an accepting port ⇒ `MCP_PORT_OPEN:<port>` + exit 1; `WebSocket server listening` in
    the app log ⇒ `MCP_BRIDGE_LOG_LINE`; a listener present **before** launch ⇒ probe
    `RESULT=REFUSED` exit 2 — record the owning image/PID as an environment blocker, never a product
    FAIL.
  - **Evidence:** POSTED `## Tests Runs` quotes the three `PORT_` lines.

- [ ] **F-13 (REQ-2.7, the evidence set, on pass AND fail).**
  `RC("Get-ChildItem -LiteralPath '.opencode\tmp\release-gate\3181-gate' -Recurse -File")`, then per
  PNG `RC("Get-Item -LiteralPath '<png>'")` and `RC("Get-FileHash -Algorithm SHA256 -LiteralPath '<png>'")`.
  - **Expected:** `gate.log`, `receipt.json`, `installer-payload/`,
    `run-fresh/{stdout.log,stderr.log,launch-report.log,cdp.json,screenshot.png}`,
    `run-dirty/{…same set}`; each PNG ≥ 8 bytes with first 8 bytes `89 50 4E 47 0D 0A 1A 0A`;
    `Length` + SHA-256 recorded; no `EVIDENCE_MISSING:`.
  - **Edge:** missing/zero-byte/non-PNG ⇒ `EVIDENCE_MISSING:screenshot` + exit 1; a PNG that is a
    white rectangle (S3 false) ⇒ `UNSTYLED:screenshot-frame S3=…` **and the PNG is still written**
    (the failure evidence); a missing `stdout.log` ⇒ `EVIDENCE_MISSING:stdout`.
  - **Evidence:** POSTED `## Tests Runs` quotes the recursive listing + each PNG's `bytes=`/`sha256=`.

## AC3 — fail-closed negative legs, demonstrated

- [ ] **F-14 (REQ-3.1, MissingDll).**
  `RC("powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Installer '<installer>' -Mode negative -Negative MissingDll -SkipCompanion -OutDir '.opencode\tmp\release-gate\3181-neg-dll'")`.
  - **Expected:** `NEGATIVE_EXPECTED=LAUNCH_EXIT:-1073741515`; `NEGATIVE_OBSERVED` contains
    `LAUNCH_EXIT:-1073741515` (accept `3221225781`); `GATE_EXIT=1`; outer `EXITCODE=0`;
    `negative-missing-dll/` evidence; the canonical `installer-payload/` tree byte-identical
    afterwards.
  - **Edge:** deleting from the ORIGINAL tree ⇒ **FAIL** (copies only); the gate still starting the
    app ⇒ `NEGATIVE_NOT_REPRODUCED`; a different code ⇒ `NEGATIVE_WRONG_ERROR`.
  - **Evidence:** POSTED `## Tests Runs` quotes the three literals + `EXITCODE=`.

- [ ] **F-15 (REQ-3.2a, Csp — the in-gate detector control; the CI-executable half of AC3).**
  `RC("… -Mode negative -Negative Csp -SkipCompanion -OutDir '.opencode\tmp\release-gate\3181-neg-csp'")`.
  - **Expected:** the leg induces the 0.2.3 condition in the live document (nonce-bearing `style-src`
    via `Page.addScriptToEvaluateOnNewDocument` + `Page.reload`); the inner gate emits **both**
    `CSP_VIOLATION:<detail>` **and** `UNSTYLED:<detail>` with `GATE_EXIT=1`; outer `EXITCODE=0`;
    `NEGATIVE_OBSERVED` contains both ids; `negative-csp/` evidence exists.
  - **Edge:** only `UNSTYLED` observed ⇒ the 0.2.3 mechanism was not reproduced ⇒
    `NEGATIVE_WRONG_ERROR` and the leg **FAILS**; a plain `<style>` with no nonce policy is **not**
    the condition; the shipped installer must be re-asserted unchanged (digest) after the leg.
  - **Evidence:** POSTED `## Tests Runs` quotes `NEGATIVE_EXPECTED=`, `NEGATIVE_OBSERVED=`,
    `GATE_EXIT=`, `EXITCODE=` and the inner `CSP_VIOLATION:`/`UNSTYLED:` lines.

- [ ] **F-15b (REQ-3.2b — bundle-level CSP revert; REQUIRED per the owner directive; runs LAST).**
  In this order: **(1)** copy the installer of record aside to
  `.opencode\tmp\release-gate\installer-of-record\` and record its SHA-256 (this copy **is** the
  artifact of record); **(2)** run the committed overlay build from a tmp script —
  `RC("powershell -NoProfile -File .opencode/tmp/release-gate/csp-revert-build.ps1")` — whose body
  sets location to `apps\tauri` and runs
  `& .\node_modules\.bin\tauri.cmd build --config <absolute path to .opencode/scripts/tauri.csp-revert.json> --bundles nsis`
  (absolute paths only — a `..` segment is sandbox-denied). The overlay is the **committed**
  `.opencode/scripts/tauri.csp-revert.json` =
  `{"app":{"security":{"dangerousDisableAssetCspModification":false}}}`; **(3)** copy the newly
  produced installer to `.opencode\tmp\release-gate\csp-revert-installer\`; **(4)**
  `RC("… -Installer '.opencode\tmp\release-gate\csp-revert-installer\<setup.exe>' -Mode gate -OutDir '.opencode\tmp\release-gate\3181-csp-revert'")`.
  - **Expected:** the reverted installer's gate run **exits non-zero** and names
    `CSP_VIOLATION:<detail>` and/or `UNSTYLED:<detail>`; `receipt.verdict=FAIL` with those ids in
    `errors[]`; the receipt/skill records the **technical equivalence** — a `--config` overlay
    deep-merges and cannot delete a key, so `dangerousDisableAssetCspModification: false` means
    "asset CSP modification is NOT disabled" → Tauri re-injects the nonce into `style-src` → the
    0.2.3 mechanism exactly; the installer-of-record copy's SHA-256 is **unchanged** at the end.
  - **Edge:** **not running this row ⇒ FAIL of F-15b** (no `NOT RUN`/disclosure branch; G-435). It
    re-bundles over the shared bundle path (G-446) ⇒ forbidden before F-1…F-22 complete; the bundle
    path then holds the reverted build and the record copy is the artifact of record — say so. The
    gate must never invoke `tauri`/`pnpm` (NF-2): the build is a tester step **outside** the harness.
    An overlay changing any key other than `app.security.dangerousDisableAssetCspModification` ⇒
    **FAIL** (gate relaxation). A receipt claiming a literal **key deletion** ⇒ **FAIL** (the
    overlay can only deep-merge).
  - **Evidence:** POSTED `## Tests Runs` quotes the overlay's content, the build's exit line, the
    reverted run's `verdict` + `errors[]`, and the unchanged installer-of-record digest.

- [ ] **F-16 (REQ-3.3, Database).**
  `RC("… -Mode negative -Negative Database -SkipCompanion -OutDir '.opencode\tmp\release-gate\3181-neg-db'")`.
  - **Expected:** the leg seeds `<DataDir>/postgres/cluster/start.log` and sets
    `FREDO_PG_CLUSTER_QUARANTINE_FAIL=1` (`cluster_dir.rs:57`, read at `:266-271`); the inner gate
    emits `DB_NOT_READY:dirty` within the bound with `GATE_EXIT=1`; outer `EXITCODE=0`;
    `NEGATIVE_OBSERVED` contains `DB_NOT_READY:dirty`.
  - **Edge:** seam not set ⇒ residue quarantined ⇒ gate passes ⇒ `NEGATIVE_NOT_REPRODUCED` (leg
    FAIL); observed `DB_QUARANTINE_MISSING` ⇒ wrong id; writing into a shared cluster dir ⇒ **FAIL**
    (per-run `-DataDir` only).
  - **Evidence:** POSTED `## Tests Runs` quotes the seam line + `NEGATIVE_EXPECTED=`/
    `NEGATIVE_OBSERVED=`/`GATE_EXIT=`/`EXITCODE=`.

- [ ] **F-17 (REQ-3.4, negative-mode literals and exit semantics; one class, one id).** Read the
  three receipts from F-14/F-15/F-16 plus
  `RC("powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -SelfTest")`.
  - **Expected:** each leg prints `NEGATIVE_EXPECTED=`, `NEGATIVE_OBSERVED=`, `GATE_EXIT=<n != 0>` and
    exits **0**; the three observed id sets are disjoint (`LAUNCH_EXIT:*`;
    `CSP_VIOLATION:`+`UNSTYLED:`; `DB_NOT_READY:dirty`); `-SelfTest` carries a control proving
    `NEGATIVE_NOT_REPRODUCED` and one proving `NEGATIVE_WRONG_ERROR` (both exit-1 paths).
  - **Edge:** a leg printing the clean-input token `RESULT=PASS` ⇒ **failed drive** (G-447), never a
    PASS; a leg exiting 0 with `GATE_EXIT=0` ⇒ **FAIL**; identical observed sets across two legs ⇒
    **FAIL** (one id reused across classes).
  - **Evidence:** POSTED `## Tests Runs` quotes the three literal blocks + the two self-test control
    lines.

- [ ] **F-18 (REQ-3.5, the release job runs all three negative legs before the draft).**
  `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'negative-controls'")`, then
  `-Pattern 'Negative MissingDll'`, `-Pattern 'Negative Csp'`, `-Pattern 'Negative Database'`,
  `-Pattern 'NEGATIVE_CONTROL_FAILED'`, and `-Pattern 'name: Create draft release'`.
  - **Expected:** a step `Negative-control legs (fail-closed demonstrations)` (`id:
    negative-controls`) after the artifact gate and before `Create draft release`; all three
    invocations present with `-SkipCompanion` and the same `OUT_DIR`; each failure prints
    `::error::NEGATIVE_CONTROL_FAILED leg=<leg> exit=<n>`.
  - **Edge:** one or two legs ⇒ **FAIL**; a leg after the draft step ⇒ **FAIL**; a leg without
    `-SkipCompanion` ⇒ **FAIL** (a model-less runner would refuse and the leg would be vacuous).
    Runner execution is unproducible ⇒ `logic-verified, no discriminating run` for the CI execution,
    with F-14–F-16 as the executed legs.
  - **Evidence:** POSTED `## Tests Runs` quotes the ordered hits + the three invocation lines.

## AC4 — manual entry

- [ ] **F-19 (REQ-4.1, the manual entry runs the identical assertion set).**
  `RC("powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Installer '<installer>' -Mode gate -Manual -OutDir '.opencode\tmp\release-gate\3181-manual'")`.
  - **Expected:** `MANUAL_ENTRY=true`; `EXITCODE=0`; `receipt.manual=true`; `receipt.checks[].id`
    set identical to the canonical run's; `receipt.verdict` identical (`PASS`); top-level key set
    `schemaVersion, mode, manual, startedUtc, durationSeconds, installer, verdict, exitCode, checks,
    errors?, cdp, evidence` with unset optionals **absent** (never `null`).
  - **Edge:** a `{messages,data}`-wrapped or different-shape receipt ⇒ **FAIL**; `manual=false` in
    the `-Manual` receipt ⇒ **FAIL**; a differing check-id set ⇒ **FAIL** (weaker manual entry).
  - **Evidence:** POSTED `## Tests Runs` quotes `MANUAL_ENTRY=true` and both receipts' `verdict` +
    check-id lists.

- [ ] **F-20 (REQ-4.2, the same evidence artifact set under the same sub-directory names).**
  `RC("powershell -NoProfile -File .opencode/tmp/release-gate/compare-evidence.ps1")` — a tmp script
  printing the sorted relative-path sets of both OutDirs and `EVIDENCE_SET=EQUAL` / `DIFF=<list>`.
  - **Expected:** identical relative paths for `gate.log`, `receipt.json`, `installer-payload/`,
    `run-fresh/{stdout.log,stderr.log,launch-report.log,cdp.json,screenshot.png}`,
    `run-dirty/{…same}`; extra files allowed (additive).
  - **Edge:** a missing `run-dirty/` ⇒ **FAIL**; a `-Manual` run writing differently named
    sub-directories ⇒ **FAIL**.
  - **Evidence:** POSTED `## Tests Runs` quotes both path lists and `EVIDENCE_SET=EQUAL`.

## AC5 — no false green

- [ ] **F-21 (REQ-5.1, the produced 0.2.4 passes all seven clauses).** The canonical run (F-1/F-5) —
  **no re-run**; provenance `RC("git rev-parse HEAD")` + the F-1 identity triple.
  - **Expected:** `EXITCODE=0`; `receipt.verdict=PASS`; all seven checks `ok: true`; REQ-2.4's
    **dirty** clause green (that clause is what proves the #3180 first-run fix); `receipt.errors`
    empty; the installer's mtime ≥ this round's build start at the recorded HEAD.
  - **Edge:** a PASS carried by a `-SkipCompanion` run ⇒ **not** F-21; a stale pre-fix installer ⇒
    the dirty clause reddens (fix the fixture, never weaken the row); models absent ⇒ **NAMED
    BLOCKER** (`MODEL_SET_MISSING`), disclosed — never a PASS.
  - **Evidence:** POSTED `## Tests Runs` quotes `VERDICT=PASS`, the seven checks, the HEAD sha and
    the installer digest.

- [ ] **F-22 (REQ-5.2, a known-broken artifact fails and names the property).**
  PRIMARY red artifact = the published `app-v0.2.4` (cut before #3180):
  `RC("gh release download app-v0.2.4 --pattern '*-setup.exe' --dir '.opencode\tmp\release-gate\broken-0.2.4'")`,
  then `RC("<gate> -Installer '.opencode\tmp\release-gate\broken-0.2.4\<setup.exe>' -Mode gate -OutDir '.opencode\tmp\release-gate\3181-red'")`
  (add `-SkipCompanion` **only** when the model set is absent, and disclose it).
  - **Expected:** non-zero gate exit; `receipt.verdict=FAIL`; at least one §B named error naming the
    broken property — expected `DB_NOT_READY:dirty` (the 0.2.4 pre-#3180 first-run class); the actual
    id recorded **verbatim**. PASS criterion = non-zero exit **and** a §B id present;
    `DB_NOT_READY:dirty` is the expected literal, not a stricter gate.
  - **Edge:** **if `gh release download` is refused/unavailable, the THREE negative legs
    (F-14/F-15/F-16) ARE the known-broken set** — record
    `known-broken artifact not yet fetched; the three negative legs are the known-broken set`, and
    the row is PASS only if all three reproduced. A downloaded artifact that PASSES ⇒ **FAIL** (false
    green). Exit 2 (REFUSED) is **not** a valid red demonstration. Optional extras if the download
    works: `app-v0.2.0` → `PAYLOAD_MISSING:<dll>`, `app-v0.2.2` → `UNSTYLED:<detail>`,
    `app-v0.2.3` → `CSP_VIOLATION:<detail>`.
  - **Evidence:** POSTED `## Tests Runs` quotes the download provenance (tag, file name, sha256) and
    the red receipt's `verdict` + `errors[]`.

## Wiring + instrument

- [ ] **F-23 (the guard has a runner).**
  `RC("powershell -NoProfile -File .opencode/scripts/test-scripts.ps1")`; then
  `RC("Select-String -Path '.opencode/scripts/test-scripts.ps1' -Pattern 'gate-release-artifact'")`
  and `-Pattern 'gate-artifact-window'`.
  - **Expected:** `EXITCODE=0`; `Failed: 0`; all **seven** Architect §H legs present verbatim
    (`gate-release-artifact.ps1: -SelfTest passes all controls`;
    `… every named error id is emitted by its own control`;
    `… -Mode negative exits 0 only when the expected id fires`;
    `release.yml: the gate step sits after payload verify and before gh release create --draft`;
    `release.yml: the negative-control legs run before gh release create --draft`;
    `release.yml: the evidence upload is if: always() and SHA-pinned`;
    `release-gate skill documents the harness, both entries and the named errors`);
    the `$scripts` registry carries `gate-release-artifact.ps1` and `gate-artifact-window.ps1`.
  - **Edge:** an unrelated failing leg ⇒ still a **FAIL** of this row — quote it verbatim for
    attribution; a leg asserting prose instead of step-offset ordering ⇒ **FAIL**.
  - **Evidence:** POSTED `## Tests Runs` quotes the summary + the seven leg names.

- [ ] **F-24 (the harness self-tests green, hermetic, one control per named error id).**
  `RC("powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -SelfTest")` — no
  installer, no model, no GUI, no network.
  - **Expected:** `EXITCODE=0`; `SELFTEST: PASS`; a control line for **every** Architect §B id —
    `EXTRACT_FAILED`, `PAYLOAD_MISSING`, `LAUNCH_EXIT`, `LAUNCH_NOT_RUNNING`, `UNSTYLED`,
    `CSP_VIOLATION`, `DB_NOT_READY`, `DB_QUARANTINE_MISSING`, `COMPANION_NO_REPLY`,
    `COMPANION_ENGINE`, `MCP_PORT_OPEN`, `MCP_BRIDGE_LOG_LINE`, `EVIDENCE_MISSING`, `CDP_UNAVAILABLE`,
    `WEBVIEW2_MISSING`, `MODEL_SET_MISSING`, `CDP_PORT_IN_USE`, `NEGATIVE_NOT_REPRODUCED`,
    `NEGATIVE_WRONG_ERROR` — each driving exit 1 with its own id; no `[FAIL]`.
  - **Edge:** `EXITCODE=3` ⇒ a control failed ⇒ instrument **FAIL**; a §B id with no control ⇒
    **FAIL**; a control that passes without emitting its id ⇒ **FAIL** (vacuous).
  - **Evidence:** POSTED `## Tests Runs` quotes `SELFTEST: PASS` + the control lines.

## Non-functional

- [ ] **F-25 (NF-bounded wall-clock, never a hang).** Read `receipt.durationSeconds` + per-clause
  timings.
  - **Expected:** ≤ 2400 s total; launch ≤ 300 s; DB ≤ 180 s/profile; companion ≤ 600 s; no clause
    exceeded its bound silently.
  - **Edge:** a bound expiring is that clause's named failure; a run that hangs with no
    `receipt.json` is a harness **FAIL** — quote its last log line.
  - **Evidence:** POSTED `## Tests Runs` quotes `durationSeconds` + the bound lines.

- [ ] **F-26 (NF-stdlib only, no new dependencies).** Read the three gate files; search them for
  `Install-Module`, `Install-Package`, `npm `, `pnpm `, `npx `, `pip `, `bun `, `Invoke-RestMethod http`.
  - **Expected:** zero hits; only `Invoke-WebRequest`, `ClientWebSocket`, `Add-Type`, `Stopwatch`
    and filesystem cmdlets; no module install, no package manager, no remote fetch.
  - **Edge:** a module import outside the stdlib set ⇒ **FAIL**; a component downloaded at run time
    ⇒ **FAIL** (the harness must be offline-capable).
  - **Evidence:** POSTED `## Tests Runs` quotes the zero-hit search + the file list.

- [ ] **F-27 (NF-repo hygiene: the harness must not mutate repo CONTENT).**
  Before and after **each** harness invocation (canonical, manual, the three negative legs, the red
  run, the CSP-revert gate): `RC("git diff --exit-code")` and `RC("git diff --cached --exit-code")`;
  plus `RC("git status --porcelain=v2")` recorded verbatim.
  - **Expected:** both `git diff` calls print `EXITCODE=0` before and after every run — no tracked
    file's **content** changes, staged or unstaged; the `--porcelain=v2` listing contains no entry
    whose `hH` (HEAD/index) and `hI` (worktree) blob hashes differ; every untracked path sits under
    the gitignored `.opencode/tmp/`; the harness's artifacts all live under `-OutDir`.
  - **Edge (disclose — do NOT FAIL):** the release **build** stat-touches
    `apps/tauri/src-tauri/Cargo.toml`, so `--porcelain=v2` may show ` M` while `git diff --exit-code`
    is `0` and `hH == hI` (round 1 observed `1d98bdb5…` on both sides). Record
    `STAT_ONLY_TOUCH=apps/tauri/src-tauri/Cargo.toml hH=hI=<sha>` and keep the row **PASS** — that is a
    build-filesystem artifact, not harness mutation. **FAIL** if the blob hash changes or
    `git diff --exit-code` is non-zero (content rewritten), on any tracked file whose content changes,
    or on an untracked non-gitignored path (record it). A row that reds on a stat-only touch is the
    plan defect this re-scope fixes.
  - **Evidence:** POSTED `## Tests Runs` quotes both before/after `EXITCODE=0` diff results, the
    `--porcelain=v2` listing, and the `STAT_ONLY_TOUCH=` disclosure when present.

- [ ] **F-28 (launch seam — the driver's port list must BIND on `-Ports`; the round-1 defect).**
  Three legs; (a)/(b) need **no installer, no GUI, no build** — run them first.
  - **(a) positive control, single int:**
    `RC("powershell -NoProfile -File .opencode/scripts/launch-artifact-probe.ps1 -Exe 'C:\nonexistent\fredo.exe' -Ports 9223")`
    ⇒ `RESULT=REFUSED` and `EXITCODE=2` (the missing-exe typed refusal).
  - **(b) the driver's real list form, same exe:**
    `RC("powershell -NoProfile -File .opencode/scripts/launch-artifact-probe.ps1 -Exe 'C:\nonexistent\fredo.exe' -Ports 9223,16932,19631")`
    ⇒ the **same** typed refusal: `RESULT=REFUSED`, `EXITCODE=2`.
  - **(c) the driver path:** on the canonical `-Mode gate` run (F-1), `gate.log` carries **no**
    `ParameterArgumentTransformationError`, **no** `Cannot convert value`, **no**
    `Cannot convert value … System.Int32[]`; every `CHILD launch-*` line is followed by probe output
    (`HAS_EXITED=` / `PORT_9223=`), and the three negative legs' children likewise.
  - **Expected:** (a) and (b) both bind and refuse with exit 2 — a binder-class failure
    (`EXITCODE=1`, `ParameterArgumentTransformationError`, `Cannot convert value "9223,16932,19631"
    to type "System.Int32[]"`, no probe output) is a **FAIL** of this row; (c) no binder error
    anywhere and probe output present for the fresh, dirty and negative children.
  - **Edge:** a "fix" that drops the list and passes `-Ports 9223` only ⇒ **FAIL** of **F-12** (the
    other two ports are never probed) — record which form the driver passes. A wider parameter type
    (`[string]`/`[string[]]` split by the probe) is acceptable **iff** all three ints are still probed
    and F-12's three `PORT_` lines appear. Running (b) through `run-exitcode.ps1` is the required
    form: the defect is exactly the native `-File` argument boundary, so a test that only binds the
    array in-process does not cover it.
  - **Why:** 23 `-SelfTest` controls and 178 `test-scripts.ps1` legs were green while this seam was
    broken, because none invoked the probe with the driver's port list (round-1 verdict).

- [ ] **F-29 (negative-leg instrument classification — an unrunnable instrument is a NAMED
  INSTRUMENT FAILURE, never `NEGATIVE_NOT_REPRODUCED`/`NEGATIVE_WRONG_ERROR`).**
  A negative leg proves a **gate** property only if its instrument ran. Three legs:
  - **(A) hermetic control:** `RC("powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -SelfTest")`
    ⇒ a control drives a child that cannot start (binder/child-failure class) and asserts
    `NEGATIVE_INSTRUMENT_FAILURE:<detail>` (the fix plan's binding id; `GATE_REFUSED` is the accepted
    synonym — record the literal the harness emits) with **no**
    `NEGATIVE_NOT_REPRODUCED`/`NEGATIVE_WRONG_ERROR` in that control's transcript.
  - **(B) live induction (no GUI):** write a 16-byte non-PE file
    `.opencode/tmp/release-gate/not-an-installer.exe` from a tmp script, then
    `RC("… -Mode negative -Negative Database -SkipCompanion -Installer '.opencode\tmp\release-gate\not-an-installer.exe' -OutDir '.opencode\tmp\release-gate\3181-neg-instrument'")`
    ⇒ non-zero exit with the instrument-failure class (`NEGATIVE_INSTRUMENT_FAILURE:<detail>` /
    `GATE_REFUSED`), **never** `NEGATIVE_NOT_REPRODUCED`/`NEGATIVE_WRONG_ERROR`.
  - **(C) round-1 regression:** the canonical `gate.log` must not classify a child that never ran as
    an observation — a `CHILD … EXIT=1` carrying a binder/stderr diagnostic must not be followed by
    `NEGATIVE_LEG_LOAD=survived` (the round-1 misread) or by `NEGATIVE_OBSERVED=none` treated as
    `NEGATIVE_WRONG_ERROR`.
  - **Expected:** (A) control `[PASS]` with the id; (B) instrument-failure class + non-zero exit;
    (C) no misclassification on a child that could not run.
  - **Edge:** `NEGATIVE_OBSERVED=none` **with** a non-zero `GATE_EXIT` and **no** inner named error is
    an **instrument failure**, never `NEGATIVE_WRONG_ERROR` (round 1 misclassified exactly this). A
    leg that silently skips the instrument ⇒ **FAIL** (G-435). A leg that ignores the `-Installer` it
    was handed and re-derives its artifact from a previous run's OutDir ⇒ **FAIL** (it must not
    substitute a different artifact); record which artifact it used.
  - **Owner (G-409):** the round-1 fix plan's item touching
    `.opencode/scripts/gate-artifact-negative.psm1` — the classification funnel **and** the (A)
    self-test control are that item's deliverable; the row cannot pass on a harness with no control
    for the class.
  - **Evidence:** POSTED quotes (A)'s control line, (B)'s classification lines + `EXITCODE=`, and the
    canonical child/classification lines from `gate.log`.

- [ ] **F-30 (G-450 — a gate-owned child runner returns to a pipe-capturing caller; the
  "agent got stuck with no output" class).** Four hermetic legs (no installer, no GUI, no network).
  - **(a) the harness self-test carries the spawn control:**
    `RC("powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -SelfTest")`
    ⇒ `SELFTEST: PASS`, a control line
    `CONTROL CHILD-RUNNER-NO-INHERIT - the child runner returns with the grandchild still alive (no inherited handles)`
    (source section **25**; the harness prints named controls without ordinals, so assert the NAME),
    its `[PASS]`, and the stdout facts `RUNNER_RETURN_SECONDS=<s>` with `<s>` ≤ 5,
    `RUNNER_CHILD_ALIVE=True`, and a non-zero `RUNNER_CHILD_PID=`. The child is **never killed** — a
    kill would mask a leaked handle.
  - **(b) the inline, pipe-captured, bounded wrapper leg — the human's exact symptom:**
    `RC("powershell -NoProfile -File .opencode/scripts/run-exitcode.ps1 -Command \"powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -SelfTest\"")`
    ⇒ the **full** self-test transcript is printed **and** the wrapper prints `EXITCODE=0`; no
    `TIMEOUT=`. (This is the leg that used to print nothing and never return.)
  - **(c) the harness leg carries its own inline 15 s bound:**
    `RC("powershell -NoProfile -File .opencode/scripts/test-scripts.ps1")` ⇒ `Total == Passed`,
    `Failed: 0`, `Skipped: 0`; record the total (180 expected — baseline 179 at `ad1426e`).
  - **(d) no inheriting spawn survives in a gate-owned launch path:**
    `RC("Select-String -Path '.opencode/scripts/gate-release-artifact.ps1','.opencode/scripts/gate-artifact-negative.psm1','.opencode/scripts/launch-artifact-probe.ps1','.opencode/scripts/run-exitcode.ps1' -Pattern 'NoNewWindow' -SimpleMatch")`
    ⇒ **zero hits**.
  - **Expected:** all four legs green: the control present and `[PASS]`, the elapsed/`alive`/`pid`
    facts recorded, the wrapper returning a full transcript plus `EXITCODE=0` well inside its bound,
    the harness summary with zero failures, and zero `-NoNewWindow` occurrences in any gate-owned
    script.
  - **Edge (fail-closed — the row must be able to go RED):** the **elapsed bound** and the
    **grandchild-still-alive** assertion are the discriminating elements: a reverted inheriting spawn
    makes the inline leg stall to the grandchild's 20 s lifetime (elapsed > 15 s) instead of failing
    fast, and a spawn that kills its grandchild reports `RUNNER_CHILD_ALIVE=False`. Either, or a
    missing `CHILD-RUNNER-NO-INHERIT` control, or an `-NoNewWindow` + redirect hit ⇒ **FAIL**. A row
    that reports only "the self-test exits 0" without the elapsed/alive facts ⇒ **FAIL** (not
    discriminating).
  - **Evidence:** POSTED quotes the `CONTROL 25 …` line with `[PASS]`, the three `RUNNER_*=` facts,
    the wrapper's `EXITCODE=` (with the line count / tail of the transcript it returned), the
    `test-scripts.ps1` summary block, and the zero-hit `Select-String`.

---

_Evidence convention: pass cases keep `- [x]` and append the quoted literals plus `EXITCODE=`; fail
cases leave `- [ ]` and mark `FAIL` with expected-vs-actual + repro. A **REFUSED** (exit 2) run is
recorded as `NOT RUN — named precondition (<id>)`, never a PASS. Forbidden substitutions:
`-SkipCompanion` on F-11/F-21; the `companion probe` CLI in place of the through-the-app turn; the
payload verifier in place of the harness; a static-only receipt for a live row; **skipping F-15b —
it is REQUIRED, so a skip is a FAIL** (G-435)._

## Ordering (binding)

`F-28(a)(b) → build → self-test → canonical → manual → negatives → F-29 → red → CSP-revert bundle build + gate (LAST)`

`F-28(a)/(b)` are probe-only (no installer, no GUI) and run **before** the build so a broken launch
seam is caught in seconds instead of after a 20-minute bundle. `F-29(B)` is independent (no GUI);
`F-29(A)` reads `-SelfTest`, `F-29(C)` reads the canonical `gate.log` — so F-29 runs after the
canonical run and the three negative legs. `F-27`'s `git diff --exit-code` pair brackets **every**
invocation in the sequence.

The CSP-revert bundle re-bundles over the shared bundle path (G-446): every artifact-identity row
(F-1…F-22) completes first, the installer of record is copied to
`.opencode/tmp/release-gate/installer-of-record/` **before** the build, and that copy's SHA-256 is
re-asserted at the end. The bundle build is a **tester** step outside the harness (NF-2), driven by
the committed overlay `.opencode/scripts/tauri.csp-revert.json` — never a scratch json, and the
shipped `tauri.conf.json` is never edited.
