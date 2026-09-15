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

- [ ] F-15 (promoted from E-15, round 1): **Engine start with a size-VALID / content-invalid model must yield a named error, not a hang.** Replace the encoder with a byte-exact picture of garbage (same pinned size, invalid ONNX); call `stt_start`. Expected: a typed non-hanging error and the app stays responsive. **Round-2 expected code: `{started:false, code:"modelCorrupt", detail:"<encoder filename> failed SHA-256 verification (expected <pin>, got <actual>)"}`** — R-5.4 maps a SHA mismatch to `modelCorrupt` via the ST-7.1 content-integrity gate at the engine boundary; `engineStartFailed` stays reserved for `OnlineRecognizer::create()==None` / the start timeout.
  - **Test data:** a size-exact (71,083,163 B) but content-invalid encoder copy.
  - **Expected:** typed `modelCorrupt` (SHA gate) or `engineStartFailed` (native create), app responsive.
  - **Actual (round 1):** UNVERIFIED / FAIL-risk — the MCP bridge dropped (`Connection closed`), then every webview/IPC call timed out for ~12 min; the process kept the MCP port (:9223) and resisted `dev-env -Action Down` (same PID re-found on the next Down). Dev stderr captured a native abort (`fatal runtime error: Rust cannot catch foreign exceptions, aborting` / exit `0xc0000409 STATUS_STACK_BUFFER_OVERRUN`) from a `target\debug\fredo.exe` run coincident with the attempt (attribution: could not be isolated from a second-instance port-conflict abort; needs a developer repro). Never a typed code, never responsive → matches the QA "silent hang FAILs" rule.

## Run log — round 1 (2026-09-14, `spec/2876` @ `df47d4f`)

- **PASS:** F-1 (artifact), F-4 (capture/wiring), F-5 (provisioning), F-9 (transcript → bar, DOM-verified), F-10 (start/stop), F-11 (static local-only), F-12 (static STT-only), F-13 (clippy/TS build), F-3(b) fixture leg, F-7 partial (disabled/alreadyListening/modelMissing/modelCorrupt).
- **UNVERIFIED (named blocker, G-053):** F-2 RAM + partial-update-latency numbers (no memory channel; the `#[ignore]` leg does not print `latencyMs`; the real mic is silent); F-3(a) real-mic (default input is the virtual `Irión Webcam`, carries no audio); F-6 network-block (no firewall/adapter lever); F-7 (noDevice / permissionDenied — no OS lever; engine-start-failure — see F-15); F-8 branch (1) companion-away and branch (3)/carve-out live driving (only branch (2) driven; pure cascade unit-pinned).
- **PASS by hermetic pin (ST-6a):** all 7 failure codes (`noDevice`/`permissionDenied`/`modelMissing`/`modelCorrupt`/`engineStartFailed`/`alreadyListening`/`disabled`) + partial→partial→final + revision monotonicity (10/10 `voice::session::tests` green).

## Run log — round 2 (2026-09-14, `spec/2876` @ `84ff1ac`, fix `d9a9f8d`)

- **F-15 PASS (live, the round's primary).** Size-exact garbage encoder (71,083,163 B of zeros via `.opencode/tmp/2876/model-lever.mjs garbage`) → `stt_check_model` still reported `ready:true` (the size gate is blind by design — `classify_file` is size-only) → `stt_start {origin:"launcher"}` returned in **2073 ms**: `{started:false, code:"modelCorrupt", detail:"encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx failed SHA-256 verification (expected 563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1, got 3cf3777ca4d297391904f8e3a8fffd496bc0b68b7cb67c9f10672821bad383d3)"}`. A second `stt_check_model` (`ready:true`) followed immediately by a second `stt_start` both responded (2046 ms, same typed code) — app responsive; console clean; dev stderr (`dev-env-stderr-20260914-164122.log`) had **zero** hits for `Rust cannot catch foreign exceptions` / `0xc0000409` / `STATUS_STACK_BUFFER_OVERRUN` / `panicked`. Restored encoder → `ready:true` + a normal `stt_start` (`started:true`, device `Micrófono (Iriun Webcam)`, 48000 Hz, 4898 ms) + `stt_stop` (`listening:false`). Evidence: `.opencode/evidence/2876/f15-modelcorrupt-responsive.jpeg`.
- **F-2 PASS (numbers).** Latency (ST-7.3 leg over the in-repo `jfk.wav`): `latency: n=21 p50=23 p95=25 max=25` — within the pinned budget p50 ≤ 300 / p95 ≤ 600; 9 distinct pre-final partials. RAM (ST-7.5 sampler on `fredo.exe` pid 4352): baseline **76.9 MB** → engine-loaded steady **198.0 MB** → **Δ 121.1 MB** (budget ≤ 350 MB); falls back to 79.4 MB on `stt_stop`. Model bytes 72,654,782 (4 files); SHA pins verified by the content gate (the garbage run's expected/got pair proves the gate hashes against the manifest pins).
- **F-7 PASS (typed codes, regression).** `disabled` (`"Voice input is disabled in Companion settings."`), `alreadyListening` (`"A listening session is already active."`), `modelMissing` (`"tokens.txt is missing — …"`), size-`modelCorrupt` (`"…is incomplete (100 of 71083163 bytes)"`) — each exact and each followed by a responsive `stt_check_model`.
- **F-9 PASS (regression).** Synthetic `stt:transcript` over the real control-plane channel drove the bar: `"the quick brown"` → `"the quick brown fox jumps"` → final `"the quick brown fox jumps over the lazy dog"`; no submit. Evidence: `.opencode/evidence/2876/ac3-bar-live.jpeg`.
- **F-10 PASS (regression).** `stt_start` → listening; `stt_stop` / `stt_cancel` → `listening:false`; cue removed (`placeholder="search or command"`).
- **F-3(a) UNVERIFIED (G-053)** — real mic: the only input device is the silent virtual `Micrófono (Iriun Webcam)`; the bar stayed `""` across the listening sessions. Do NOT read the fixture leg as a substitute.
- **F-1/F-4/F-5/F-11/F-12 PASS (static re-confirm).** `git diff df47d4f 84ff1ac` touches only `voice/{engine,manifest,session}.rs` + evidence + suites — the AC1 artifact and AC4 wiring/provisioning sources are unchanged from the round-1 PASS.
- **F-13 PASS (regression).** `cargo test --locked` → **502 passed / 0 failed / 1 ignored** (was 499/1; +3 ST-7.1 tests); `voice::session::tests` 10/10; `cargo clippy --locked -- -D warnings` → zero warnings.

---

## #2877 extension — local STT foundation (enable/persist, verified model setup, on-device transcription, lifecycle, edge/NFR)

> Issue #2877 production-hardens the #2876 spike into Fredo's local STT foundation. Rows F-16..F-37
> map 1:1 to the QA Plan `REQ-1.1..REQ-NF6` in `.opencode/tmp/2877/triage.md` `## QA Expert`.
> **Verification policy: live** — native capture, settings/WebView2 rendering, and a real ~69 MiB
> model transfer are only provable on a running app. Evidence per case: `tauri_webview_dom_snapshot`
> / `tauri_webview_find_element` / `tauri_webview_execute_js` / `tauri_webview_screenshot` /
> `tauri_ipc_monitor` + `tauri_read_logs(source="console")`, plus the mandatory LIVE receipt
> (F-37: `telemetry_spans` + rendered-webview receipts). A static-only PASS is a FALSE PASS.
>
> **SUPERSESSION (from #2877):** the spike-era phrasing that pins "NO voice/STT/autosend section in
> the Settings surface" (this file's F-11 context, `regression.md` R-8, `smoke.md` S-4) is
> **SUPERSEDED** by the PO amendment — voice/STT (and the autosend setting) now live **inside the
> Companion settings section**, hosted in the Settings app window. Historical PASS/FAIL records
> above are preserved; do NOT re-run the old "no voice section" assertion as a FAIL.
> **MOVED to #2878:** F-8 (context-dependent Ctrl+Space branch cascade live-driving) and F-9/F-10
> (transcript → launcher bar input / start-stop surface) are #2878's surface wiring. This spec keeps
> only the disabled-chord gate (F-18). Do NOT re-run the moved rows as FAIL here.
>
> **Test data:** pinned manifest revision `672fbf1b30579d6585301139bb363f42a0ad4a24` (4 files,
> 72,654,782 B: encoder 71,083,163 B; decoder 1,307,236 B; joiner 259,335 B; tokens 5,048 B);
> states MS-V0..MS-V5 (plan's G-138 matrix); the deterministic 16 kHz mono WAV fixture (ST-6); a
> process-scoped network block + control fetch. **NEVER reference `C:\Users\pktro\fredo-models` —
> it does not exist.**

- [ ] F-16 (REQ-1.1 / AC1): **Master enable control + engine/model status under Companion; no dedicated Voice section.** Open the Settings app window → Companion; DOM snapshot + `find_element` for the voice enable control and the engine/model status row; enumerate every settings nav item and section title.
  - **Expected:** a master voice enable control AND a current engine/model status (engine name + model state `missing`/`ready` + resolved location) render INSIDE the Companion section; ZERO nav item or section titled "Voice"; receipt = DOM snapshot + screenshot.
  - **Edge:** the wizard-only not-ready state still shows the voice status additively (non-gating, F-23); second settings window open; both themes.

- [ ] F-17 (REQ-1.2 / AC1): **Default OFF + persists across an app restart.** Fresh profile → read the control + `Fredo_companion_voice_enabled` via `get_setting`/localStorage; toggle ON; re-read; restart the app; reopen Companion and re-read.
  - **Expected:** fresh default is OFF/false (opt-in); the toggled value persists byte-exactly across the restart; the control reflects the persisted value.
  - **Edge:** seeded legacy/malformed values (`"yes"`, `"1"`, `""`, `null`) heal to false with no crash; toggle then kill the app while listening; webview reload instead of full restart.

- [ ] F-18 (REQ-1.3 / AC1, PO): **Disabled voice never starts listening.** With voice DISABLED press Ctrl+Space in the launcher context; then invoke `stt_start` directly.
  - **Expected:** no listening state and no `stt:transcript`; the #2823 show/focus behavior still fires; the direct invoke returns `{started:false, code:"disabled"}`; no capture handle created.
  - **Edge:** synthetic Ctrl+Space may not land focus under automation (`launcher` F-19 / `desktop-chrome` R-12) → fallback lever = direct `stt_start` invoke + the unit-pinned chord selection; record which lever was used. Disable WHILE listening must stop + release (F-28).

- [ ] F-19 (REQ-1.4 / PO, setting-only): **Autosend setting present + persisted (send behavior is #2878).** Companion settings → locate the autosend control; read default; toggle; restart; re-read.
  - **Expected:** an autosend control exists under Companion and its value persists across restart. This row exercises SETTING presence + persistence ONLY — transcript→bar / auto-send behavior is a #2878 non-goal and is NOT claimed here.
  - **Edge:** the default value must match the PO decision (Architect to bind it); a missing control is a FAIL against the PO decision, never a silent drop.

- [ ] F-20 (REQ-2.1 / AC2): **One-action verified model setup.** Model-absent state MS-V0 → Companion; locate the `sttModel` step; click its single acquire action; `tauri_ipc_monitor` the `download_stt_model` invoke.
  - **Expected:** exactly ONE user action acquires the model; `download_stt_model` is invoked and delegates to `download_missing_files`; the 4 pinned files land; zero manual CLI steps; the step is registered in `COMPANION_SETUP_STEPS` and EXCLUDED from the gating `installed/total` summary.
  - **Edge:** 2-of-4 partial state; double-click does not fire concurrent downloads; action absent when already ready; click while a companion GGUF download is running.

- [ ] F-21 (REQ-2.2 / AC2): **Skip-present by exact size + streamed SHA-256 verify + progress + ready/location state.** Real pull from the pinned HF revision; sample `setup:download-progress`; read the terminal state and the resolved location.
  - **Expected:** skip-present by EXACT pinned size; each file's streamed SHA-256 verified (mismatch ⇒ delete + error); total 72,654,782 B; determinate progress events; the ready state names the resolved absolute model directory; a mismatch/truncation NEVER reports ready.
  - **Edge:** present-but-truncated re-downloads; size-exact/content-invalid file yields an error, not a hang; path containing spaces; partially-populated model dir.

- [ ] F-22 (REQ-2.3 / AC2, G-130 — real transfer class): **(a) real full transfer + (b) deliberately idle/slow resume at a realistic offset.** (a) Real transfer of the full pinned 4-file set, 72,654,782 B, from the pinned revision. (b) Deliver the encoder (71,083,163 B of the 72.6 MB set) to ~35,000,000 B on disk, then deliver ZERO bytes for >= 20 s (deliberate idle), then resume via HTTP `Range` from the persisted offset to 100%.
  - **Expected:** (a) delivered bytes = 72,654,782, wall clock recorded, per-file SHA matches the pins. (b) the resume's first progress event carries the exact on-disk partial offset; the transfer completes in-session to the exact byte count with an in-place SHA match; states observed are `downloading`/`present`/`skipped` with no `error`. A fast KB-scale stub alone is NOT evidence.
  - **Edge:** partial at the EXACT pinned size but wrong content (the size gate is blind by design — the SHA gate must catch it); interrupt immediately before completion; bounded retry across a mid-stream reset.

- [ ] F-23 (REQ-2.4 / AC2 non-gating): **STT model never gates companion readiness (counts stay GGUF-only).** With the STT model absent, exercise companion chat + readiness; compare the `CompanionReadiness.ready` inputs to the pre-spec definition.
  - **Expected:** `ready` keeps exactly today's inputs (`settled && backendReadiness.ready && serverState === 'healthy'`); companion chat remains usable with the STT model absent; the wizard's gating counts cover only the GGUF prerequisites (n of 3), never `sttModel`.
  - **Edge:** STT present vs absent changes nothing in chat readiness; the not-ready gate still renders the wizard ONLY with the optional `sttModel` row additive. Cross-ref `.opencode/tests/llama-setup/` R-30.

- [ ] F-24 (REQ-3.1 / AC3): **On-device transcription: >= 2 distinct partials then a final.** Enable voice, `stt_start`, speak a distinctive multi-word phrase, sample `stt:transcript`.
  - **Expected:** >= 2 DISTINCT cumulative partial strings observed while the utterance continues, then an endpoint with `is_final: true` carrying the full segment text; `revision` strictly monotonic; `latencyMs` present; receipt = captures + a description of what changed between partials.
  - **Edge:** fixture WAV leg through the SAME capture path; silent input (no partials, no crash); multiple segments; very short utterance; a partial identical to the previous one is NOT distinct.

- [ ] F-25 (REQ-3.2 / AC3 hard NFR, G-148): **Local-only — transcribe with the network blocked + static/unit pin.** (live) Apply a process-scoped outbound block, PROVE it with a control fetch that FAILS, then transcribe; block mid-session. (static/unit) Grep `infrastructure/voice/**` + the stt setup path for remote clients.
  - **Expected:** a transcript is produced while the block is proven; no outbound connection during transcription; ZERO remote endpoints and ZERO cloud-fallback branches on the audio→text path; the ONLY network use is model acquisition, setup-gated (`voice_local_only_no_remote_clients` pin).
  - **Edge:** block mid-session must not crash. If the live block is undrivable (firewall rule needs elevation; adapter disable unavailable) → a NAMED blocker recorded ALONGSIDE the pin — never the pin alone as a PASS, never fabricated.

- [ ] F-26 (REQ-3.3 / AC3 real-mic leg): **Explicit real-mic attempt, with the ST-6 WAV pin as the named fallback (never a substitute).** Attempt the REAL-MIC leg live through the product path (start listening → speak → capture transcript). If the host mic is silent/absent, run the deterministic ST-6 WAV session pin.
  - **Expected:** the real-mic attempt is recorded with the resolved device name + sample rate, and a real transcript is the primary evidence. If the host mic is silent → a NAMED blocker naming the device (the host's only input is the virtual `Iriun Webcam` mic) PLUS the ST-6 pin PASS; the fixture leg is NEVER recorded as a substitute.
  - **Edge:** device switch mid-session; 48 kHz device resampled to 16 kHz; no default input device.

- [ ] F-27 (REQ-4.1 / AC4): **Idempotent start/stop.** Call start twice; call stop when not listening; call stop twice; rapid start/stop x5.
  - **Expected:** 2nd start returns `{started:false, code:"alreadyListening"}` with no second session; stop when idle is a no-op with no error; after stop `listening:false`; no leaked handle.
  - **Edge:** start during the engine-start window; stop from an error state; start/stop across window focus changes.

- [ ] F-28 (REQ-4.2 / AC4): **Microphone released on stop or voice-disable.** Start → stop; start → disable voice; observe release and a subsequent re-open; unit-pin the session/capture handle.
  - **Expected:** no capture stream remains after stop or voice-disable (the OS microphone-in-use indicator clears); a subsequent start re-opens cleanly; the session/capture handle is dropped.
  - **Edge:** stop while the engine is still starting; disable during an error state; 10 cycles show no handle or thread leak.

- [ ] F-29 (REQ-4.3 / AC4): **Five typed failure modes, one session, no crash / no leaked handle.** Drive, in ONE session and sequentially: missing model, corrupt model, vanished device, permission denied, engine-start failure; read each code/detail; then re-check responsiveness and `stt_status`.
  - **Expected:** each returns a typed code (`modelMissing` / `modelCorrupt` / `noDevice` / `permissionDenied` / `engineStartFailed`) with an actionable detail; the process stays alive and responsive; no panic/abort; no unhandled console `Error:`; recovery between modes; no leaked capture handle.
  - **Edge:** size-exact/content-invalid encoder (71,083,163 B of garbage) → typed `modelCorrupt` via the SHA gate and MUST NOT hang or native-abort (the spike's round-1 `STATUS_STACK_BUFFER_OVERRUN` / `0xc0000409` regression must stay dead — cross-ref prior F-15/R-9); `OnlineRecognizer::create() == None` → `engineStartFailed`; device unplugged mid-session.

- [ ] F-30 (REQ-5.1 / AC5): **Permission denied / no device → non-blocking actionable, voice stays disabled, app usable.** Construct permission-denied and no-input-device states; attempt to enable/listen; then use the launcher, settings, and companion chat.
  - **Expected:** an inline NON-BLOCKING actionable state names the cause + next step; the persisted voice preference stays false (never silently flipped to enabled); no modal trap; launcher/settings/chat stay fully usable.
  - **Edge:** denial while enabled + listening → typed state, no crash; recovery after granting permission; no device at boot.

- [ ] F-31 (REQ-5.2 / AC5): **No silent capture — visible active-capture indicator.** Start listening → DOM probe for a visible active-capture indicator; stop → re-probe.
  - **Expected:** a visible indicator exists exactly while `listening: true` and is absent when not; no capture runs without the indicator; receipt = DOM snapshot + measured geometry.
  - **Edge:** indicator across window/theme; the sub-second on/off transient at the start/stop boundary (G-140) requires <= 50 ms sampling.

- [ ] F-32 (REQ-NF1 / budgets, G-148): **Measured budgets.** Measure partial-update latency (audio-chunk → emit) p50/p95 over >= 20 partials; sample fredo working set pre-engine and at steady state; sample idle CPU while NOT listening; run the `stt_engine_created_lazily` pin.
  - **Expected:** p50 <= 300 ms AND p95 <= 600 ms; RAM delta on model load <= 350 MB; no measurable idle CPU while not listening (recognizer created on first `stt_start`, never at launch). Every number carries its method; adjectives instead of numbers FAIL.
  - **Edge:** measure after warm-up, not the first-token spike; a metric not measurable on this host → named blocker + the unit pin; note host sleep/foreign load.

- [ ] F-33 (REQ-NF2 / STT-only): **No TTS / no voice-command routing.** Static + live: assert no TTS/audio playback surface and no voice-command/intent routing was added.
  - **Expected:** STT-only — no synthesized audio, no final-text-triggered action or command execution.
  - **Edge:** any voice action/intent router present FAILs.

- [ ] F-34 (REQ-NF3 / build hygiene + POC removal): **Build gates green + the POC is gone (no dual paths).** `cargo check --locked`, `cargo test --locked`, `cargo clippy --locked -- -D warnings`; `pnpm --filter @fredo/ui build`; grep for POC remnants.
  - **Expected:** zero Rust warnings/errors; UI TS clean; CI green; ZERO `// SPIKE #2876 — THROWAWAY POC` remnants and no dual poc+prod paths (deleted or replaced, never coexisting).
  - **Edge:** pre-existing unrelated CI red reported separately; a POC-only allow attribute FAILs.

- [ ] F-35 (REQ-NF4 / ST-6 pins ported, regression): **Hermetic session pins live in production and stay green.** Run the ported session-pin suite at its production path.
  - **Expected:** the 7 typed failure codes, partial→partial→final, and revision monotonicity are all green AND live in the production module (ported, not deleted with the POC); counts recorded.
  - **Edge:** the POC module is removed — the pins MUST exist at the new production path; a deleted pin is a FAIL. (Supersedes the spike's "PASS by hermetic pin (ST-6a)" location note.)

- [ ] F-36 (REQ-NF5 / no-panic pin, G-148): **No panic on the capture/engine/failure paths.** Grep those paths for `unwrap()` / `expect()` / `panic!` / `unreachable!`; run the `stt_start` failure-path unit tests.
  - **Expected:** zero panic-capable calls on those paths; `stt_start` returns a typed result on every failure; no path panics.
  - **Edge:** `?` propagation and `unwrap_or*` are fine; a panic on a `Drop`/thread-join path FAILs.

- [ ] F-37 (REQ-NF6 / LIVE-EVIDENCE LEG, G-108): **Mandatory live receipts (telemetry + rendered webview), same run as F-16..F-36.** `fredo emit --event-type chat` + `--event-type tool_use` with distinct session ids; query the RTDB row tables + `telemetry_spans`; upload each UI capture.
  - **Expected:** both events return `{"queued":true}` and classify into their row tables; `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)`; every UI leg's capture is uploaded to `.opencode/evidence/2877/` with its raw URL + a textual description embedded in `## Tests Runs`. A static-only PASS is a FALSE PASS.
  - **Edge:** re-run on the tested tip; a screenshot-only leg with no description is not evidence; a local path never uploaded is not evidence.

- [x] F-38 (promoted from exploratory E-25, #2877 round 1; **FIXED + re-verified live in round 2**): **A duplicate `stt_start` (`alreadyListening`) must not report the session as stopped while capture continues.** With a live session active (launcher- or companion-origin), invoke `stt_start` again (or press Ctrl+Space again while the companion is away — `selectCtrlSpaceAction` returns `companion-listen` regardless of `listening`).
  - **Expected:** after the duplicate start the visible active-capture indicator is STILL shown for the live session (R-5.3/AC5: "the system SHALL never capture audio without a visible active indicator"), and `stt_status.listening` agrees with the UI.
  - **Actual (live, 2026-09-15, `spec/2877` @ `dbb3843`):** the duplicate start correctly returned `{started:false, code:"alreadyListening", detail:"A listening session is already active."}` in 12–21 ms with no second session, BUT `session.rs::start` emits `stt:state {listening:false, code:"alreadyListening", origin}` for that path while `stt_status` still reports `listening:true`. The frontend `useVoiceDictation` therefore flips `listening:false`: the launcher bar cue (dot/chip/Stop) disappears (bar placeholder reverts to `search or command`); for a companion-origin session the bubble switches to its ERROR variant ("Voice input didn't start" / "Voice input is already listening.") with NO Stop control, dot or preview — while the backend keeps capturing.
  - **Repro:** `stt_start{origin:'companion'}` → bubble present; `stt_start{origin:'companion'}` again → `{code:'alreadyListening'}`; `stt_status` → `{listening:true, origin:'companion'}` while `document.querySelector('[data-testid="companion-listening-bubble"]')` carries `companion-listening-error` and no `companion-listening-stop`.
  - **Suggested fix (Architect to confirm):** the `alreadyListening` branch must not emit `listening:false` — emit the true state (`listening:true` with the active origin) or emit no state event; the frontend `start()` must not clear `listening` on `alreadyListening`.
  - **Round 2 result — PASS (live, both origins + cascade).** ST-1 (`session.rs`: `listening_state` + `already_listening_outcome`, single builder shared by `status()` and the duplicate path) and ST-3 (`useVoiceDictation.start()` treats `alreadyListening` as an idempotent no-op) fixed. A raw `stt:state` subscription across the whole round recorded **19 events, ZERO with `listening:false` + a non-null `code`** — the false-idle emission is gone. Launcher: 2nd `stt_start{origin:'launcher'}` → `{started:false, code:'alreadyListening', detail:'A listening session is already active.'}`, emitted `{listening:true, origin:'launcher'}`, `stt_status` agreed, cue (dot/chip/Stop) + `Listening…` placeholder stayed, no `role="alert"`. Companion: 2nd `stt_start{origin:'companion'}` → same result, emitted `{listening:true, origin:'companion'}`, bubble kept dot + Stop, never rendered `companion-listening-error`. Origin non-adoption proven both ways (launcher-live + request `companion` ⇒ emitted/stayed `launcher`; companion-live + request `launcher` ⇒ emitted/stayed `companion`). Cascade: companion teleported away → Ctrl+Space started a companion session → 2nd Ctrl+Space (away context) kept the bubble. Escape cancelled (`listening:false`, both indicators cleared). Evidence: `r2-f38-launcher-after-duplicate.jpeg`, `r2-f38-companion-after-duplicate.jpeg`, `r2-f38-cascade-away-after-duplicate.jpeg` under `.opencode/evidence/2877/`.
  - **Test data:** voice enabled + model ready + any device. Independent of audio.

## Run log — #2877 round 1 (2026-09-15, `spec/2877` @ `dbb3843`)

- **F-16 PASS (live, DOM + screenshot).** Voice controls render INSIDE Companion (`data-testid="companion-controls"`): enable switch (`aria-label="Enable voice input"`, label `Dictate with Ctrl+Space`), engine status (`companion-voice-engine-status`), model row (`companion-voice-model-row`, ready + resolved location), device select (`companion-voice-device-select`, System default + 2 devices), autosend (`companion-voice-autosend`), settings announcer. Settings nav = Companion / Appearance / Fredo Setup / Telemetry / Features(My Work Items, Infrastructure Diagram, Model Storage, Run CLI) — **ZERO "Voice" nav item/section**. Evidence: `ac1-companion-voice-controls.png` + structure snapshot.
- **F-17 PASS (live).** Persisted `Fredo_companion_voice_enabled`; malformed `"yes"` heals to unchecked/false with no crash; toggle ON → `"true"`; **full app restart** (dev-env Down→Up) → reopen Companion → control `checked` and key `"true"`. Evidence: `ac1-post-restart-persistence.png`; static pin `frontend_voice_defaults_are_false` / `DEFAULT_VOICE_ENABLED=false`.
- **F-18 PASS (live, both levers).** Disabled (key `false`): live Ctrl+Space opened/focused the bar (case 3) with `stt_status {listening:false}` and no cue; direct `stt_start` → `{started:false, code:"disabled", detail:"Voice input is disabled in Companion settings."}` in 21 ms, no capture handle.
- **F-19 PASS (live).** Autosend control present (`companion-voice-autosend`), default unchecked (`get_setting` null), toggle → `"true"` + caption flips to the no-review sentence; survives the restart checked. Setting-only — #2878 owns dispatch.
- **F-20 PASS (live UI).** MS-V0 (empty scratch `models_dir`) → wizard `companion-step-stt-model` = "0 of 4 present" + a single "Download voice model" action; one click acquired all 4 files (step flips to "4 of 4 present"); `sttModel` is in the `companion-setup-optional` group and is EXCLUDED from the gating summary.
- **F-21 PASS (live).** Present set → `download_stt_model` reported all 4 files `skipped` (exact pinned sizes), `ready:true`, location `C:\Code\fredo\models\sherpa-onnx-streaming-zipformer-en-2023-06-26`; total bytes 5,048 + 71,083,163 + 1,307,236 + 259,335 = **72,654,782**.
- **F-22 PASS (live, real transfer class).** (a) Real full transfer of the pinned 4-file set from the pinned HF revision into a fresh scratch `models_dir`: 72,654,782 B, wall clock **4,774 ms**, per-file SHA-256 verified by the engine (success requires the digest match). (b) Resume: encoder truncated to a genuine **35,000,000 B** partial; ≥ **25,944 ms** zero-byte idle (measured: truncation epoch 1789434372954 → resume-fire epoch 1789434398898); first progress event carried `downloaded:35000000`; Range-resumed to 71,083,163 and verified in place in 3,698 ms.
- **F-23 PASS (live).** Companion readiness gate renders the wizard ONLY with `sttModel` additive: gating summary "2 of 3 prerequisites ready" / model files "0 of 3 present" while the Optional group showed "Voice input model 4 of 4 present"; `useCompanionReadiness` `ready` inputs unchanged (`sttModel` never contributes). Evidence: `ac2-non-gating-optional-step.png`.
- **F-24 UNVERIFIED (named blocker).** Streaming partials + final from the real engine: the host has NO physical mic — devices are `Micrófono (Iriun Webcam)` (default, 48000 Hz) and `Micrófono (Steam Streaming Microphone)`, both virtual. A 30 s live session on the default device produced **zero** partials (bar `""`, transcript announcer empty) — silent. The deterministic real-engine WAV leg (`voice::engine::tests::real_engine_wav_fixture_emits_partials_then_final`, `#[ignore]`) is **not runnable by the tester** (`cargo` is not in the tester sandbox allowlist — `cargo --version` denied; no 16 kHz mono WAV fixture is committed). Hermetic session pins (`voice::session::tests` partial→partial→final + revision monotonicity) are green in CI rust-validate.
- **F-25 UNVERIFIED (named blocker live) / PASS (static pin).** No elevation/adapter lever in the sandbox for a process-scoped outbound block (Windows Firewall rule needs elevation; adapter disable unavailable), so the live "transcribe under a proven block" leg could not be driven. Static: `grep reqwest|ureq|hyper|TcpStream|UdpSocket|std::net|Command` over `infrastructure/voice/**` production regions → **zero** hits; the ST-9 invariant `voice_decode_path_has_no_network_or_process_symbols` + its positive control `model_acquisition_remains_the_only_network_capable_component` are green in CI rust-validate.
- **F-26 UNVERIFIED (named blocker) / real-mic attempt recorded.** The REAL-MIC leg was attempted live through the product path: `stt_start {origin:"launcher"}` → `started:true`, device `Micrófono (Iriun Webcam)`, sampleRate `48000`; the session ran 30 s and the bar/announcer stayed empty → the virtual device carries no audio. Named blocker: **the host has no physical input device** (default = virtual `Iriun Webcam`); the ST-6 WAV fixture leg was not runnable (same `cargo` gap). The fixture leg is NOT recorded as the real-mic leg.
- **F-27 PASS (live).** Duplicate start → `{code:"alreadyListening"}`, no second session; stop when idle → `{listening:false}` no error; stop/cancel twice → idle; 3 start/stop cycles each re-opened cleanly (device reported each time). **Edge FAIL recorded as F-38** (alreadyListening emits `listening:false` for the live session).
- **F-28 PASS (live, measured).** Start → WS 182.6 MB; `stt_stop` → WS falls to 79.5 MB (engine + `cpal::Stream` released); a subsequent start re-opens cleanly. Disable-while-listening via the enable switch stopped the session (`stt_status` idle) and cleared the cue. Method: `Get-Process -Name fredo | Select WorkingSet64` sampled by a read-only harness (`.opencode/tmp/2877/measure.mjs`).
- **F-29 PASS (live).** Missing model → `modelMissing` ("tokens.txt is missing …"); truncated tokens (13 B) → `modelCorrupt` ("tokens.txt is incomplete (13 of 5048 bytes)"); **size-exact garbage encoder (71,083,163 B, MS-V3)** → `modelCorrupt` via the SHA-256 content gate ("… failed SHA-256 verification (expected 563fde43…, got 3cf3777c…)") in 2,196 ms, app responsive (two consecutive calls + `stt_check_model` answered); vanished device → `noDevice` naming it; `permissionDenied` not constructible (named blocker: no OS lever). The spike's `0xc0000409` native-abort regression did NOT reproduce (dev stderr has no `STATUS_STACK_BUFFER_OVERRUN` / `Rust cannot catch foreign exceptions`).
- **F-30 PASS (live, partial) / UNVERIFIED (permission-denied, named blocker).** Vanished-selection `noDevice` is typed, actionable and non-blocking (launcher/settings/chat remained usable; preference not flipped). `permissionDenied` could not be constructed (no OS lever).
- **F-31 PASS (live, DOM + measured geometry).** Launcher-origin: `launcher-command-listening` dot present, chip "Listening" (63.5×24 px), Stop (24×24), placeholder `Listening…`, announcer "Listening"; stop → all absent, placeholder `search or command`, announcer "Stopped listening". Companion-origin: `companion-listening-bubble` present with dot + "Listening…" + the 6 s hearing-nothing hint + Stop, bar cue ABSENT (exactly one indicator per session, routed by `stt.origin`). Evidence: `ac5-listening-indicator.png`, `ac5-companion-listening-bubble.png`.
- **F-32 PASS (RAM + idle CPU measured) / UNVERIFIED (partial latency, named blocker).** RAM: baseline WS 56.8 MB → engine-loaded steady WS 182.6 MB → **Δ 125.8 MB** (budget ≤ 350 MB). Idle CPU while NOT listening: CPU delta 0.078 s over 10.296 s = **0.76 %** (no engine constructed — lazy-creation pin `voice_state_holds_no_engine_and_the_worker_is_the_only_construction_site` green in CI). Partial-update latency p50/p95: **not measurable** (no audio input on this host; the `#[ignore]` WAV leg needs `cargo`, denied to the tester). Method for all numbers: read-only `measure.mjs` sampling `Get-Process WorkingSet64`/`CPU`.
- **F-33 PASS (static).** No TTS / no voice-command routing: no `speechSynthesis`/audio-playback surface and no final-text-triggered action were added (grep of `apps/ui/src` + the Rust voice module).
- **F-34 PASS (live).** ZERO `// SPIKE #2876 — THROWAWAY POC` remnants in `apps/` (only the test asserting their absence); `pnpm --filter @fredo/ui build` (tsc + vite) clean; `pnpm --filter @fredo/ui test:run` 79 files / 1036 tests passed; `pnpm --filter @fredo/tauri build:webview` clean; CI `rust-validate` PASS (check + nextest + clippy -D warnings). CI `ui-validate` FAIL is the known `FredoCompanion.seatTeleport.test.tsx` flake (G-156) — that file and the whole suite pass locally.
- **F-35 PASS.** The hermetic session pins live at the production path (`infrastructure/voice/session.rs` + `engine.rs` test regions; 7 typed codes, partial→partial→final, revision monotonicity); green in CI rust-validate. `voice_invariants.rs` (ST-9) green in CI.
- **F-36 PASS (static + CI).** Panic-symbol scan of the voice module: every `unwrap()`/`expect(`/`panic!`/`unreachable!` hit is inside a `#[cfg(test)]` region; the shipped regions have none; `voice_production_region_has_no_panic_capable_calls` green in CI. `stt_start` returned a typed result on every live failure.
- **F-37 PASS (live receipts).** (a) `fredo emit --event-type chat --session-id tester-2877-chat` and `--event-type tool_use --tool-name terminal --session-id tester-2877-tool` → both `{"queued": true}`; `chat_rows` (session `tester-2877-chat`, state `init`, user_message marker) and `tool_use_rows` (session `tester-2877-tool`, tool `terminal`, state `error`) each returned the marker row; `telemetry_spans` → **25,549 rows**, `max(ingested_at)` recent. (b) 7 rendered-webview captures uploaded to `.opencode/evidence/2877/` with raw URLs + textual descriptions.

## Run log — #2877 round 2 (2026-09-15, `spec/2877` @ `1920ae43`, fix `e3cbd98` + `83a7068`)

Re-verification round for the F-38 fix (launcher + companion origins + the companion-away Ctrl+Space cascade) plus a spot regression of the rows the fix could touch. The full round-1 matrix was NOT re-run (round-1 evidence stands for the untouched rows).

- **F-38 PASS (live, both origins).** A raw `stt:state` subscription recorded 19 events across the round: **zero** carried `listening:false` with a non-null `code` (the defect signature). Launcher: 2nd start → `{started:false, code:"alreadyListening", detail:"A listening session is already active."}` in 3 ms, emitted `{listening:true, code:null, detail:null, origin:"launcher"}`, `stt_status` agreed, cue dot/chip/Stop + `Listening…` placeholder stayed, no `role="alert"`. Companion: 2nd start → same result, emitted `{listening:true, origin:"companion"}`, `companion-listening-bubble` kept `companion-listening-dot` + `companion-listening-stop`, `companion-listening-error` absent. Origin non-adoption proven both directions. Evidence: `r2-f38-launcher-after-duplicate.jpeg`, `r2-f38-companion-after-duplicate.jpeg`, `r2-f38-cascade-away-after-duplicate.jpeg`.
- **F-27 / REQ-4.1 PASS (live, regression).** Duplicate start stays idempotent (`alreadyListening`, no 2nd session — `stt_status` kept one origin session); `stt_stop`/`stt_cancel` with no session → `{listening:false}` no error; a start→stop cycle re-opened cleanly; Stop/cancel remain the only clears.
- **F-31 / REQ-5.2 PASS (live, regression).** Launcher-origin: exactly one visible indicator (bar cue), companion cue absent. Companion-origin: exactly one indicator (bubble dot + Stop), bar cue absent. Idle: neither present. Screenshot + scoped structure snapshots captured.
- **REQ-1.1/1.2 + REQ-2.2 PASS (live, spot regression).** Settings app → Companion ready branch rendered `companion-controls` with the voice group: `Enable voice input` checked (persisted `Fredo_companion_voice_enabled=true`), `companion-voice-autosend` checked, engine status "Streaming Zipformer (English, on-device) is idle — not listening.", model "Voice input model installed." + resolved location `C:\Code\fredo\models\sherpa-onnx-streaming-zipformer-en-2023-06-26`, device select present. Evidence: `r2-regression-voice-settings.jpeg`.
- **F-28 / REQ-4.2 PASS (live, measured regression).** fredo WS: idle 87.2 MB → listening 208.9 MB (Δ 121.7 MB) → `stt_stop` → 88.0 MB — engine + `cpal::Stream` released, return to the idle baseline; subsequent starts re-opened cleanly (4+ cycles this round). Method: read-only `measure.mjs` sampling `Get-Process ... WorkingSet64`.
- **Real-mic leg (F-26 / REQ-3.3) — UNVERIFIED (named blocker).** Only input devices are the virtual `Micrófono (Iriun Webcam)` (default) and `Micrófono (Steam Streaming Microphone)` (`stt_list_devices`). A live `stt_start{origin:"launcher"}` on the default device ran >18 s with `Listening…` + the cue visible and **zero** `stt:transcript` events / empty bar — the device carries no audio. The deterministic `#[ignore]` WAV leg still needs `cargo` (not in the tester allowlist). NOT recorded as a PASS; the fixture leg is never the real-mic leg.
- **F-37 PASS (live receipts, round 2).** `fredo emit --event-type chat --session-id tester-2877-r2-chat` and `--event-type tool_use --tool-name terminal --session-id tester-2877-r2-tool` → both `{"queued":true}`; `tool_use_rows` marker row `tester-2877-r2-tool | terminal | error`; `chat_rows` row `tester-2877-r2-chat | init`; `telemetry_spans` → **26,070 rows**, latest `ingested_at` 2026-09-15T01:43:45Z.
- **Console / environment clean.** `tauri_read_logs(console)` after every interaction → no `Error:`/`Uncaught`/`Maximum update depth exceeded` (only the pre-existing `motion() is deprecated` WARN). Dev stderr shows a clean build/run with no native-abort signature.
