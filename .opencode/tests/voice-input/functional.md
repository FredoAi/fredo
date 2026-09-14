# Voice Input — Functional

> Per-requirement test cases for the local-first streaming STT spike (#2876). One `F-<n>` per
> QA Plan REQ. **Verification policy: live** (this spike has no telemetry surface — every live
> leg uploads to `.opencode/evidence/2876/` and embeds the raw URL + a textual description in
> `## Tests Runs`; `tauri_webview_*`/`getBoundingClientRect` back the bar-input assertions).
>
> **Spike scope:** the POC is disposable and is replaced by #2877/#2878. **POC production
> quality is NOT judged.** What is judged: the RESEARCH ANSWERS (F-1/F-4/F-5) against the
> committed artifact + resolvable citations; FEASIBILITY on this host (F-2/F-3/F-6/F-7) via live
> legs; the binding POC contract (F-8/F-9/F-10); the hard NFRs (F-11/F-12). A non-drivable lever
> is a **named blocker (G-053) + unit/static pin** — never fabricated, never a PASS.
>
> **Feature tests:** voice-input. Runs on the running Fredo POC on `spec/2876`.

- [ ] F-1 (REQ-1 / AC1): **Comparison artifact ≥5 candidates × 9 dimensions, each cited, one binding recommendation.** Open the committed comparison artifact; count candidate rows and verify every candidate carries all 9 dimensions (offline/local-first, streaming partials, latency, model size/RAM, license, Windows x64, Rust/Tauri integration cost, project health); spot-check that each citation resolves to the claimed fact; assert exactly ONE `## Recommendation` naming one engine and a named strongest-rejected alternative with its loss reason.
  - **Test data:** the committed artifact path on `spec/2876`; network access to resolve URLs.
  - **Expected:** ≥5 candidates × 9 dimensions; every cell has a resolvable URL or `file:line`; exactly one recommendation; the rejected alternative is named with a loss reason tied to ≥1 dimension.
  - **Edge:** a citation that does not contain the claimed fact (repo home page cited for a license) FAILs that cell; "per docs" with no URL FAILs; two recommendations FAIL; a rejected alternative with no reason FAILs.

- [ ] F-2 (REQ-2 / AC2): **Proven on this host with measured numbers.** On this Windows x64 host, load the recommended engine + model and transcribe speech. Record: on-disk model size (bytes, sum all model files), SHA-256, RAM footprint (working-set delta pre-load → steady-state streaming, MB), partial-update latency (audio-chunk → bar-text mutation, p50 + max, ms) with the measurement method for each.
  - **Test data:** recommended model assets; real mic or fixture; Process Explorer / `Get-Process` working-set sampling.
  - **Expected:** five numeric outputs, each with its method; on-disk size + SHA equal the artifact's pins; the artifact's latency claim is corroborated or the divergence is explained. Adjectives instead of numbers = FAIL.
  - **Edge:** multi-file model dirs (encoder/decoder/joiner/tokens) — sum all files; single GGML file = one number; measure RAM after warm-up, not the first-token spike; a latency number with no method FAILs.

- [ ] F-3 (REQ-3 / AC3): **≥2 distinct live partial states before a final line.** (a) REAL-MIC leg: activate listening on the bar path, speak a sentence with a distinctive multi-word prefix, capture ≥2 PARTIAL states before any final line. (b) FIXTURE leg: feed the prerecorded WAV through the SAME capture path, assert ≥2 distinct partial strings before the final result.
  - **Test data:** real microphone (mandatory); prerecorded 16 kHz mono WAV fixture (secondary); screenshot/video capture; `.opencode/evidence/2876/` upload.
  - **Expected:** ≥2 captures showing DIFFERENT transcript strings WHILE the speaker is still talking, plus a textual description stating exactly what changed between partial 1 and partial 2, plus a timestamp/utterance-continues marker proving the partials preceded the final.
  - **Edge:** a partial identical to the previous partial is NOT distinct (count only differing strings); final-only (zero partials) FAILs; a screenshot with no description FAILs (AC3 requires the description). If the real mic is unavailable → named blocker (G-053) + unit/static pin on the partial-update path; the fixture leg does NOT substitute.

- [ ] F-4 (REQ-4 / AC4a): **Capture mechanism + exact wiring named.** Read the capture/wiring section: assert it names (a) the concrete path — webview: WebView2 `PermissionRequested` + the exact CSP directive, OR native: the named crate/sidecar; (b) the command/channel carrying PCM to the engine; (c) where partial text is written into the bar.
  - **Test data:** the committed artifact; MS Learn `CoreWebView2.PermissionRequested` reference for the webview path.
  - **Expected:** each item names a concrete crate/API/symbol and a file (or an explicit #2877 target); implementable with no further research — no "TBD".
  - **Edge:** a webview mechanism without the CSP/permission handling is incomplete; naming a library without the PCM transport FAILs; a prose handwave ("use WASM") FAILs.

- [ ] F-5 (REQ-5 / AC4b): **Concrete provisioning path.** Assert the provisioning section names reuse of Fredo's download+verify engine (`features/setup/model_download.rs` streaming + SHA-256 verify; pins in `infrastructure/companion/models.rs`) with the model file spec (url + expected size + sha256), OR a justified alternative with the same three properties.
  - **Test data:** the committed artifact; the cited Fredo source files.
  - **Expected:** a manifest-shaped spec (url, size, sha256) + the verify step + where it is invoked.
  - **Edge:** "download from HuggingFace" with no verify pins FAILs; reusing the engine but omitting size+sha256 pins FAILs; a justified alternative MUST name its verify mechanism.

- [ ] F-6 (REQ-6 / AC5a): **Local-first — transcribes with the network blocked.** Block networking, PROVE the block with a control fetch that fails, then run engine start → stream speech → stop and assert a transcript. Then block mid-session and assert transcription continues.
  - **Test data:** a process-scoped network block (Windows Firewall outbound rule for the POC binary, or adapter/airplane-mode disable); a control fetch.
  - **Expected:** a transcript produced while the block is proven effective; no outbound connection from the POC during transcription; the block method + its proof recorded.
  - **Edge:** a block that only affects the test harness but not the app FAILs (record the scope); control fetch succeeding = block not proven; mid-session block must not crash. If not drivable → named blocker (G-053) + static pin (no remote client on the audio→text path).

- [ ] F-7 (REQ-7 / AC5b): **Four failure modes + engine-start failure, no crash.** Drive each: (1) mic-permission denial; (2) no input device; (3) missing model; (4) corrupt model (SHA mismatch / truncated); (5) engine-start failure. For each, record the observed behavior + recommended handling.
  - **Test data:** the POC's own `PermissionRequested` handler forced to Deny; a disabled/absent capture device; an absent model path; a byte-truncated + SHA-mismatched model copy; a forced start failure (e.g. locked/read-only model file).
  - **Expected:** each mode yields a named error state (or documented handling), the process stays ALIVE, no panic, no unhandled console `Error:`/`Uncaught`; the app recovers between modes.
  - **Edge:** run all modes sequentially in ONE session — recovery between them is required; a silent hang FAILs; a crash/panic in ANY mode FAILs AC5.

- [ ] F-8 (REQ-8 / contract): **Context-dependent Ctrl+Space activation priorities.** (1) companion ACTIVE + AWAY FROM ITS SEAT → companion listening mode; (2) else bar input already focused → listening, transcript lands live IN the input; (3) else → show/focus the launcher bar (#2823 behavior). Verify the priority order is observable.
  - **Test data:** the three states set up in order; the launcher bar + companion seat surfaces.
  - **Expected:** the correct branch fires per state; setting up state (1) pre-empts (2); (3) fires only when neither holds.
  - **Edge:** rapid Ctrl+Space double-press; Escape cancel; companion active AND seated + bar focused MUST take branch (2), not (1). Real OS key may not land focus under automation (#2823 note) → drive branch selection via the notch/host path + unit-pin the selection logic; record the lever used.

- [ ] F-9 (REQ-9 / contract): **Transcript flows into the launcher command bar input.** While listening, assert `input[role="searchbox"]` (`LauncherCommandBar.tsx:133`) value changes incrementally and equals the live partial at each observation (`tauri_webview_find_element`/DOM snapshot + `getBoundingClientRect` presence). Assert NO autosend occurred and the grid did not navigate.
  - **Test data:** launcher bar rendered; DOM snapshot + `getBoundingClientRect`.
  - **Expected:** the bar's controlled value carries the live partial; autosend OFF (spike does NOT build the setting — do not test a settings section); no send/Enter side-effect.
  - **Edge:** bar empty vs pre-filled — the specified placement (insert vs replace) is verified against the actual; a transcript landing anywhere but the bar input FAILs.

- [ ] F-10 (REQ-10 / contract): **Start AND stop of the listening flow.** Demonstrate START, then an explicit STOP. After stop, assert no further partial mutations and the transcript remains in the input.
  - **Test data:** the activation lever (from F-8) + the stop lever.
  - **Expected:** both start and stop demonstrated; post-stop there are no further partials; text stays in the bar.
  - **Edge:** stop via Escape; stop via second Ctrl+Space; stop mid-utterance (the specified freeze/drop behavior is verified).

- [ ] F-11 (REQ-11 / NFR): **Local-only, no cloud fallback.** Static grep of the POC for remote clients (reqwest/http/websocket/remote `fetch`) on the audio→text path returns none; assert no cloud-fallback branch exists; record where any model-download call sits (setup vs transcription).
  - **Test data:** the POC source on `spec/2876`.
  - **Expected:** zero remote endpoints on the transcription path; no remote-fallback branch; any download is setup-gated.
  - **Edge:** an optional first-run download IS a remote call — record its location; a remote call in the transcription path FAILs.

- [ ] F-12 (REQ-12 / NFR): **STT-only.** Assert no TTS/voice-action surface was added: no synthesized audio playback, no speech-triggered command execution.
  - **Test data:** the POC source + running POC.
  - **Expected:** STT-only (no voice actions, no TTS).
  - **Edge:** any final-text-triggered action/command execution is out of scope — its presence FAILs.

- [ ] F-13 (REQ-13 / NFR): **Build hygiene / CI.** `cargo check`/`cargo clippy` on the POC → zero warnings; `pnpm --filter @fredo/ui build` if the UI is touched → TS clean; CI green on the spec PR.
  - **Test data:** the POC on `spec/2876`; CI run.
  - **Expected:** zero Rust warnings; clean TS build; CI green.
  - **Edge:** a POC-only `#[allow(...)]` FAILs (AGENTS.md zero-warnings); a pre-existing unrelated CI red is reported separately, not counted as a spike FAIL.

- [ ] F-14 (REQ-14 / evidence): **Live-policy evidence scheme.** Every live leg's capture is uploaded to `.opencode/evidence/2876/` and its raw URL embedded in `## Tests Runs` with a textual description; the `## Tests Runs` body references `.opencode/evidence/` and/or `tauri_webview_`/`getBoundingClientRect`.
  - **Test data:** captures under `.opencode/tmp/2876/e2e/`; `upload-evidence --issue 2876 --base spec/2876`.
  - **Expected:** the tests-runs body clears the live-policy guard; each URL carries a description of what it shows.
  - **Edge:** a screenshot-only leg with no description FAILs AC3's explicit requirement; a local path never uploaded is not evidence.

- [ ] F-15 (promoted from E-15, round 1): **Engine start with a size-VALID / content-invalid model must yield a named error, not a hang.** Replace the encoder with a byte-exact picture of garbage (same pinned size, invalid ONNX); call `stt_start`. Expected: `{started:false, code:"engineStartFailed"}` and the app stays responsive.
  - **Test data:** a size-exact (71,083,163 B) but content-invalid encoder copy.
  - **Expected:** typed `engineStartFailed`, app responsive.
  - **Actual (round 1):** UNVERIFIED / FAIL-risk — the MCP bridge dropped (`Connection closed`), then every webview/IPC call timed out for ~12 min; the process kept the MCP port (:9223) and resisted `dev-env -Action Down` (same PID re-found on the next Down). Dev stderr captured a native abort (`fatal runtime error: Rust cannot catch foreign exceptions, aborting` / exit `0xc0000409 STATUS_STACK_BUFFER_OVERRUN`) from a `target\debug\fredo.exe` run coincident with the attempt (attribution: could not be isolated from a second-instance port-conflict abort; needs a developer repro). Never a typed code, never responsive → matches the QA "silent hang FAILs" rule.

## Run log — round 1 (2026-09-14, `spec/2876` @ `df47d4f`)

- **PASS:** F-1 (artifact), F-4 (capture/wiring), F-5 (provisioning), F-9 (transcript → bar, DOM-verified), F-10 (start/stop), F-11 (static local-only), F-12 (static STT-only), F-13 (clippy/TS build), F-3(b) fixture leg, F-7 partial (disabled/alreadyListening/modelMissing/modelCorrupt).
- **UNVERIFIED (named blocker, G-053):** F-2 RAM + partial-update-latency numbers (no memory channel; the `#[ignore]` leg does not print `latencyMs`; the real mic is silent); F-3(a) real-mic (default input is the virtual `Irión Webcam`, carries no audio); F-6 network-block (no firewall/adapter lever); F-7 (noDevice / permissionDenied — no OS lever; engine-start-failure — see F-15); F-8 branch (1) companion-away and branch (3)/carve-out live driving (only branch (2) driven; pure cascade unit-pinned).
- **PASS by hermetic pin (ST-6a):** all 7 failure codes (`noDevice`/`permissionDenied`/`modelMissing`/`modelCorrupt`/`engineStartFailed`/`alreadyListening`/`disabled`) + partial→partial→final + revision monotonicity (10/10 `voice::session::tests` green).
