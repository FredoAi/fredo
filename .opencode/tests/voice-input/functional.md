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

---

## #2878 extension — launcher voice-autosend commit + companion-origin commit

> Issue #2878 is the **reuse-first delta** on the #2877 ST-5/ST-6 surface: the **commit behavior** —
> `voiceAutosend` ON → the #2871 smart-Enter path (exact tile name → launch; else message to Fredo via
> `askActiveCompanion()`), OFF → input only — plus the AC1/AC3/AC5 pins. **Verification policy: live.**
> Serving checkout `spec/2878 @ 33cf86d5`. Rows F-39..F-61 map 1:1 to the QA-Plan REQ rows.
> **Test data:** real control plane (`stt_start`/`stt_stop`/`stt_cancel`/`stt_status`) + synthetic
> `stt:transcript`/`stt:state` over the real `adapterBridge.listen` channel (F-9 lever); real DOM;
> real `askActiveCompanion()` → entity `ask` → the local LLM. **No physical mic** (virtual devices only);
> the `FREDO_STT_TEST_WAV` `#[ignore]` leg still needs `cargo` (not in the tester allowlist).

- [x] **F-39 (REQ-1.1) — live partials land in the bar (live).** PASS. `stt_start {origin:"launcher"}` → `{started:true, "Micrófono (Iriun Webcam)", 48000}`; partial `revision:1` → bar `the quick brown`; partial `revision:2` → bar `the quick brown fox jumps`; `stt_status {listening:true, origin:"launcher"}`; no submit; revisions strictly increasing.
- [x] **F-40 (REQ-1.2) — listening cue present exactly while listening (live).** PASS. `launcher-command-listening` (6×6 dot), `launcher-command-listening-chip` "Listening", `launcher-command-listening-cancel` aria-label "Cancel dictation", `launcher-command-listening-stop` aria-label "Stop listening", placeholder `Listening…`; all cleared on stop. Exactly one indicator per origin.
- [x] **F-41 (REQ-1.3) — editable while listening + UX-2 suppression (live).** PASS. Input not `readonly`/`disabled`; typed chars landed; after a manual edit a subsequent partial was suppressed (`value` stayed `Z` after injecting `SUPPRESSED PARTIAL`) while a final appended (`Z final segment`).
- [x] **F-42 (REQ-2.1) — autosend ON + exact tile name → launch (live).** PASS. Autosend ON; final `Settings` + `stt_stop` → the Settings window opened with NO manual Enter.
- [x] **F-43 (REQ-2.2) — autosend ON + non-match + active companion → send (live).** PASS. Final `what is your name` + `stt_stop` → bar cleared; one `runGeneration`; reply "I'm Fredo." in `fredo-companion-live-region`.
- [x] **F-44 (REQ-2.3) — launch wins over chat (live).** PASS. The F-42 launch ran with the companion ACTIVE; no `runGeneration` for the utterance.
- [x] **F-45 (REQ-2.4) — inactive/away companion keeps today's behaviour (live).** PASS. `Fredo_companion_visible=false` + autosend ON: non-tile final → no dispatch/no launch, text retained; exact `Settings` → launched.
- [x] **F-46 (REQ-2.5) — busy is a global no-op / hard drop (live).** PASS. `companion.isInUse` (TicTacToe open) + final `BUSY GAME DROP PROBE` + `stt_stop` → text retained, still busy, zero `runGeneration`; Enter while busy → no-op. (The ~2–4 s generation window is shorter than a driver round-trip; the same `isInUse` primitive was held by the game — recorded, not fabricated.)
- [x] **F-47 (REQ-2.6) — autosend OFF → input only (live).** PASS. OFF: exact final → no launch + text retained; manual Enter → launched; non-tile final → no dispatch + text retained.
- [x] **F-48 (REQ-3.1) — cancel discards (live).** PASS. Draft typed → partial in the bar → Escape → `stt_status {listening:false, origin:null}`, partial discarded, zero `runGeneration`, no launch.
- [x] **F-49 (REQ-3.2) — pre-session text restored on cancel/empty finalize (live).** PASS. The same Escape restored the bar to `DRAFT BEFORE DICTATION`.
- [x] **F-50 (REQ-4.1) — dictated text reaches Fredo via `askActiveCompanion()` and streams (live).** PASS. Exactly one dispatch; reply streamed into the SpeechBubble + live region; busy cleared at `llm-done`.
- [x] **F-51 (REQ-4.2) — N finals + one stop = exactly ONE dispatch (live).** PASS. 3 final segments (`alpha part`/`beta part`/`gamma part`) → bar `alpha part beta part gamma part` → one `stt_stop` → filtered `runGeneration called` count = 1.
- [x] **F-52 (REQ-4.3) — companion-origin commit (live).** PASS (ON + OFF-as-documented). Companion-origin: bar cue absent (bubble owns the indicator); ON → one `runGeneration`; OFF → zero `runGeneration` + read-only `companion-listening-finalized-preview`.
- [x] **F-53 (REQ-5.1) — no speech recognized → no phantom send/launch (live).** **Round 1: FAIL — DEFECT; round 2 (fix `99144a1`): PASS.** After typing text, clicking the `—` Minimize control (`setQuery('')` without clearing `barTextRef` at `LauncherShell.tsx:514`), then a SILENT launcher session (`stt_start` → `stt_stop`, no `stt:transcript`, bar empty), the stale pre-Minimize text was DISPATCHED to Fredo: `[companion] runGeneration called` + the reply explicitly quoted it ("I see you are referring to the Stale Mirror Probe 4477"; second run "…find the proof."). See the `## #2878 round 1` run log + `## Tests Runs` Defect section. **Repro is deterministic.** **Round 2 — PASS (live, `spec/2878 @ 99144a19`, fix `99144a1`):** the identical repro (type `STALE MIRROR PROBE 4477` → Minimize (`value=""`) → `stt_start {origin:"launcher"}` → `stt_stop`, zero `stt:transcript`) left the bar EMPTY, **ZERO** `runGeneration`, **ZERO** windows; the console hook recorded `runGenerationCount=0`. Screenshot `r2-ac5-phantom-probe-final.jpeg`.
- [x] **F-62 (REQ-5.1 discriminator — prior-session, promoted from E-26) — a 2nd+ consecutive launcher session with no final must NOT dispatch (live).** PASS (round 2). One full launcher session completed (committed text `session one final`, origin persists `'launcher'`) → typed draft `draft I typed` → silent launcher session (`stt_start` → `stt_stop`, zero new `stt:transcript`) ⇒ bar value `draft I typed` (draft RESTORED), **ZERO** new `runGeneration`, zero windows. The pre-fix unit test could not catch this because `origin` only changed on the FIRST session; the fix's session-scoped `voice.committed` delta predicate closes it.
- [x] **F-63 (REQ-3.1/3.2 / E-1 partial-cancel, promoted from E-27) — a session ending with only a partial (no final) must NOT dispatch (live).** PASS (round 2). Pre-session text `PRE SESSION CANCEL 5151` → `stt_start {origin:"launcher"}` → partial `{isFinal:false, text:"e"}` (bar showed `e`) → real `stt_cancel` ⇒ bar RESTORED to `PRE SESSION CANCEL 5151`, **ZERO** `runGeneration`, zero windows. The fix guards on a committed FINAL only (`voice.committed` grew past the session baseline), so a partial cannot arm a dispatch.
- [x] **F-64 (REQ-5.1 / E-1 typed-error end, promoted from E-27) — an end carrying a typed error code is treated as a cancel (live).** PASS (round 2). Pre-session text `PRE SESSION CANCEL 5151` → `stt_start` → final `hello` (bar `hello`) → `stt:state {listening:false, code:"noDevice", detail:"microphone disappeared", origin:"launcher"}` ⇒ bar RESTORED to `PRE SESSION CANCEL 5151`, **ZERO** `runGeneration`, zero windows. `voice.errorCode !== null` at finalize takes the cancel branch (`LauncherShell.tsx` ST-1r).
- [x] **F-65 (REQ-2.5/commit timing — late final after the state event still commits, added round 2) — a final landing AFTER the `listening:false` state event commits exactly once (live).** PASS. `stt_start` → `stt:state {listening:false, origin:"launcher"}` FIRST (mid-check: zero windows, no dispatch — correctly stayed armed) → late final `Query Viewer` ⇒ Query Viewer window opened (1 surface), **ZERO** `runGeneration` (exact-name launch). Proves the finalize effect re-runs on the `voice.committed` dep and commits the late final exactly once.
- [x] **F-54 (REQ-5.2) — inactive-companion bar rendering unchanged (live).** PASS. `aria-busy` ABSENT (null, not "false"), `padding-inline-end: 0px`, zero `launcher-command-listening*` testids, input class identical to the idle baseline.
- [x] **F-55 (REQ-5.3) — announced/accessible, not colour/animation alone (live).** PASS. `voice-listening-announcer` "Listening" → "Stopped listening"; `voice-transcript-announcer` only the newest FINAL (a partial never announced); chip "Listening"; Stop aria-label; `aria-keyshortcuts="Control+Space"`.
- [x] **F-56 (REQ-ESC) — exactly ONE action per Escape (live).** PASS. Escape #1 cancels listening (launcher stays open); Escape #2 follows today's idle-collapse precedence.
- [x] **F-57 (REQ-CTRL.1 / REQ-CTRL.2) — Ctrl+Space cascade + no bar focus steal (live).** PASS. Away+chord → companion-origin session, bar cue absent, `activeElement` stayed BODY; bar-focused+chord → `launcher-listen`; default+chord → show/focus, `listening:false`.
- [x] **F-58 (REQ-NF1) — local-only (static pin PASS / live block undrivable).** `grep` of `infrastructure/voice/**` → zero `reqwest|ureq|hyper|TcpStream|UdpSocket|std::net|websocket`; only the setup-gated model-manifest URLs (+2 test `example.invalid`); `useVoiceDictation.ts` → zero network. Named blocker (G-053): no elevation/adapter lever for a live outbound block.
- [ ] **F-59 (REQ-NF2) — latency budget. UNVERIFIED (named blocker, G-053).** `stt:transcript.latencyMs` needs real audio; the host's only devices are virtual (Iriun Webcam / Steam Streaming Microphone) and carry none; the WAV leg needs `cargo` (absent). Residual pin: #2877 F-32 `p50=23 / p95=25 ms` (budget p50 ≤ 300 / p95 ≤ 600).
- [x] **F-60 (REQ-NF3) — reduced-motion (static pin PASS; matchMedia flip undrivable).** The listening dot computed `animation-name: none` / `animation-duration: 0s` → static; dot/chip/Stop/cancel all render. `matchMedia(...reduce)` = false and the driver cannot flip it (G-059/G-148).
- [x] **F-61 (REQ-NF4) — build hygiene / single dispatch path (live).** PASS. `pnpm --filter @fredo/ui build` clean; `test:run` → **80 files / 1079 tests / 0 failed**. Zero hardcoded `#hex`/`rgba(` and zero `var(--x)NN` alpha-append in the three changed files.

### Run log — #2878 round 1 (2026-09-15, `spec/2878` @ `33cf86d5`)

- **Verdict FAIL.** 22 PASS / 1 FAIL (F-53) / 1 UNVERIFIED (F-59) of 24 QA-Plan rows. The FAIL is the **phantom dispatch** above — a real, reproducible product defect, not a fixture artifact.
- **Promoted findings:** E-1 (`voice-input/exploratory.md`) — a backend-direct `stt_cancel` (no UI gesture) also commits the bar text; all three product cancel gestures set the suppression flag first, so it is not directly user-reachable, but a backend-initiated `launcher` session end (typed error / device loss) with non-empty bar text would auto-send. E-2 — the same stale-mirror class.
- **Live receipts:** `fredo emit --event-type chat|tool_use` (markers `tester-2878-chat`/`tester-2878-tool`) → both `{"queued":true}`; `tool_use_rows` marker row; `telemetry_spans` → **26786 rows**, newest `ingested_at` 2026-09-15T02:46:32.520Z (telemetry-query skill).
- **Console clean** across every leg (only the pre-existing `motion() is deprecated` WARN); no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- **Tooling note:** the MCP driver namespace (`window.__MCP__.resolveRef`) was absent at round start; a `driver_session` stop+start restored it (G-067) — tooling state, not a product defect. `tauri_manage_window action="list"` does NOT list own-kernel DOM feature windows (Settings opened correctly but never listed).

### Run log — #2878 round 2 (2026-09-15, `spec/2878 @ 99144a19`, fix `99144a1`) — F-53 re-verification

Re-test round for the ST-1r session-scoped-finalize-evidence fix (tester FAIL F-53 + E-1 + E-2).
Only the previously-failing rows + the fixed surface's regression were re-run; round-1 evidence stands
for the untouched rows and their round-2 spot re-confirmation is recorded in the issue's `## Tests Runs`.

- **F-53 PASS (live).** Exact round-1 repro → no dispatch, bar empty, zero `runGeneration`, zero windows.
- **F-62/F-63/F-64 PASS (live).** The prior-session discriminator, the partial-cancel, and the typed-error end each restore the pre-session text with ZERO dispatch. (Promoted from exploratory E-26/E-27.)
- **F-65 PASS (live).** Late-final commit timing: state event first, final after ⇒ exactly one commit.
- **Regression spot-check PASS (live):** F-39/F-40 (live partials + cue DOM: dot 6×6, chip "Listening" 64×24, cancel/Stop aria-labels, `Listening…`), F-42/F-44 (autosend ON exact `Settings` → window, zero `runGeneration`), F-43/F-50 (autosend ON `tell me about yourself` → one `runGeneration` + streamed reply), F-47 (autosend OFF: exact → no launch, non-tile → no send, manual Enter → send), F-45 (companion OFF: non-tile no-op, exact `Mission Monitor` → launch), F-46 (TicTacToe holds `isInUse` → hard drop, zero `runGeneration`; Enter busy → no-op), F-51 (3 finals + 1 stop = ONE dispatch), F-52 (companion-origin ON = ONE dispatch; bar cue absent), F-54 (`aria-busy` absent, `padding-inline-end: 0px`, zero cue testids), F-55 (announcers: "Listening" → "Stopped listening"; partials never announced), F-57 (cascade: away+chord → companion-origin + `activeElement` BODY; bar-focused → `launcher-listen`; second chord → `launcher-cancel`, launcher stays open; default → focus, `listening:false`).
- **Build (F-61) PASS:** `pnpm --filter @fredo/ui build` clean; `test:run` → **80 files / 1083 tests / 0 failed** (+4 ST-1r cases vs round 1).
- **Live receipts:** `telemetry_spans` → **27,231 rows**, newest `ingested_at` `2026-09-15T03:37:45.592892500Z` (telemetry-query skill); `fredo emit` chat/tool → `{"queued":true}` + `tool_use_rows` marker `tester-2878r2-tool | terminal | init`.
- **Console clean** (0 error-level lines; no `Maximum update depth exceeded` / `Uncaught`).
- **Environment note:** the app process exited once mid-round (right after a `stt_start {origin:"companion"}` attempt; no panic/abort in `dev-env -Action Logs`, only expected `[stt] audio stream error: buffer underrun` spam from the silent virtual mic). `dev-env -Action Up -Spec 2878` recovered it; the affected REQ-4.3 leg was re-run successfully against the recovered instance. Not reproducible; recorded as an environment event, not a product defect.
- **F-59 (REQ-NF2 latency) remains UNVERIFIED (named blocker, G-053):** no physical microphone (virtual devices only) and no `cargo` for the `FREDO_STT_TEST_WAV` leg. Residual pin: #2877 F-32 `p50=23 / p95=25 ms` (budget p50 ≤ 300 / p95 ≤ 600). Deliberately not attempted (per the Fix Plan).

---

## #2882 extension — hold-Space dictation + "listening is always Fredo's" (G-136 reconciliation)

> Issue #2882 changes **how dictation is triggered** (hold Space in the focused empty search bar —
> the Ctrl+Space listening cascade is retired) and **where a transcript goes** (always to Fredo, never
> an app launch). Rows F-66..F-72 map 1:1 to the QA-Plan `REQ-3..REQ-6` + `REQ-12..REQ-14` of
> `.opencode/tmp/2882/triage.md` `## QA Expert`. **Verification policy: live** — `tauri_webview_keyboard`
> with REAL `down`/`up` pairs and a recorded hold duration, `tauri_webview_execute_js`, DOM snapshots,
> screenshots, `tauri_read_logs(console)`, plus the mandatory `telemetry_spans` receipt.
> **Serving checkout:** the `spec/2882` tip.
>
> **G-136 SUPERSESSION (historical PASS/FAIL records above are PRESERVED, never rewritten):**
> - **F-42 / F-44 / F-45 / F-47** pinned "autosend ON + exact tile name ⇒ LAUNCH" for a DICTATED
>   final (e.g. dictated `Settings` opened the Settings window) and "autosend OFF: manual Enter
>   L AUNCHES". **SUPERSEDED** by PO amendment 1 + the replacement for the last bullet of section B:
>   a dictated transcript is a **message to Fredo** — autosend ON sends on release, autosend OFF
>   waits in the bar and **Enter sends it to Fredo**. NO dictated phrase ever opens an app.
> - **F-52 / F-57 / F-62 / F-65** pinned the Ctrl+Space cascade (`companion-listen` when away,
>   `launcher-listen`/`launcher-cancel` when the bar is focused) and the companion-origin commit.
>   **SUPERSEDED** — Ctrl+Space never starts or stops listening; the direct
>   dictate-to-Fredo-when-he-is-away path is **retired**. Dictation is reachable ONLY through the bar
>   (Ctrl+Space → hold Space → speak → Enter/the autosend setting). The retired rows' PASS records
>   stand as history; do NOT re-run them as PASS or FAIL.
> - **F-39 / F-40 / F-41 / F-48 / F-49 / F-50 / F-51 / F-53 / F-63 / F-64 / F-55 / F-56** remain in
>   force where they describe the bar live-text landing, the visible cue, the cancel/restore
>   semantics, the exactly-once dispatch and the announcers — the new trigger must not break them.
> - **The host has NO physical microphone** (only the silent virtual `Iriun Webcam` /
>   `Steam Streaming Microphone`). The audible leg is a **NAMED BLOCKER**; the documented #2878
>   synthetic `stt:transcript` lever over the REAL `adapterBridge.listen` channel supplies transcript
>   CONTENT only — never the capture-lifecycle/cue evidence.

## F-66 (REQ-3 / AC2 + R-2.6/R-2.7) — Holding Space dictates; listening continues ONLY while Space is held

- [ ] F-66: Focus `input[role="searchbox"]` with an EMPTY value. `tauri_webview_keyboard(action="down",
      key=" ")` → wait 1500 ms → sample mid-hold → `action="up"`. Leg (b): while held, inject a
      synthetic `stt:transcript` partial then a final, then release. Leg (c): after the release,
      inject another transcript. Leg (d): a sub-threshold TAP (`down` → ~80 ms → `up`) with the
      engine NOT yet live. Leg (e): release at/above the 200 ms threshold while the engine never
      went live. Record the hold duration and the `stt:state` stream.
  **Expected:** (a) mid-hold `stt_status.listening === true` + the visible cue, and
      `listening === false` within ~300 ms of the `up`; (b) the finalized words sit in the bar as
      ORDINARY EDITABLE TEXT (input NOT `readonly`/`disabled`, `value` equals the final, and a
      subsequent real keystroke edits it); (c) after the `up` a later transcript mutates nothing and
      starts no session — listening continued ONLY while Space was held; **(d) the TAP lands exactly
      ONE ordinary space (`value === ' '`), ZERO `stt_start`, no `stt:state`, and the mic is never
      opened; (e) a hold that never went live lands exactly ONE ordinary space on the RISE-EDGE
      cancel (R-2.6) and the mic is released** — both bound by contract 4b (QA-7 CLOSED).
  - **Edge:** OS auto-repeat `keydown`s (`e.repeat === true`) must NOT restart/duplicate (exactly ONE
    `stt_start`); the TAP and the never-live hold are **LANDED SPACES, not defects** (only a LOST or
    CONVERTED space is a FAIL — G-158); a hold after clearing a dictated transcript back to empty;
    hold with a dictated transcript already in the bar.
  - **Test data:** voice enabled + model ready; the synthetic-transcript lever (no physical mic).

## F-67 (REQ-4 / AC3 + R-2.7) — Space in a NON-EMPTY query is an ordinary space character; the empty-bar TAP is one too

- [ ] F-67: Type `ab`, then press Space (real keydown). Repeat at 1 char and at 20 chars, and with an
      app-matching query (`set` → Space). Separately, with an EMPTY armed bar, TAP Space
      (`down` → ~80 ms → `up`). Count `stt_start` invocations and read the value.
  **Expected:** every Space lands as a LITERAL character (`ab `, `s` → `s `, `set `) with ZERO
      `stt_start`, no cue and `listening === false` — a space typed into a non-empty query is never
      converted into capture (the AC's headline "zero lost spaces"); the EMPTY-bar TAP also lands
      **exactly one ordinary space** with ZERO `stt_start` and the mic never opened (R-2.7, QA-7
      CLOSED).
  - **Edge:** a burst with 3 internal spaces; a query exactly equal to an app name; the
    delete-back-to-empty boundary (a subsequent HOLD there is F-66's gesture); **a tap must never
    LOSE or convert its space — the landed space COUNTS as a landed space (G-158)**; a tap right
    after a cleared dictated transcript.

## F-68 (REQ-5 / R-3.2/R-3.3 + R-2.6) — Voice disabled / model not installed: no capture, no error, and the space LANDS

- [ ] F-68: Leg (i) `Fredo_companion_voice_enabled=false`; leg (ii) voice enabled + model absent
      (`stt_check_model` → `ready:false`, fail-closed arming gate). For each: focus the EMPTY bar →
      hold Space 1500 ms → release → read `input[role="searchbox"]`.value. Then press Ctrl+Space.
  **Expected:** ZERO capture — no capture handle, no session, **no `stt_start` invocation at all**
      (the gate never arms), no listening cue, NO error dialog and no `role="alert"`; **`value`
      contains exactly one ordinary space character** — for a hold that never went live the space
      lands **on the RELEASE** (`value === ' '`), which is the declared behaviour, NOT a defect
      (R-3.2/R-3.3 + R-2.6; QA-2/QA-7 CLOSED); Ctrl+Space still shows/focuses the bar with
      `listening === false`. With readiness UNKNOWN the bar is NOT armed — Space is never
      intercepted and its native default is observed verbatim.
  - **Edge:** disable voice WHILE holding (session stops, mic released, no phantom dispatch); the
    model removed between the probe and the hold (the release still lands one space, no error);
    voice re-enabled mid-hold; a model that goes missing mid-session; `engineStartFailed`.

## F-69 (REQ-6 / AC4 + PO amendment 1) — A transcript ALWAYS goes to Fredo and NEVER opens an app

- [ ] F-69: Autosend ON + companion present: hold Space → synthetic final `Settings` → release.
      Autosend OFF (shipped default): the same, then a manual Enter. Repeat with the companion AWAY,
      OFF, and mid-reply. Count `runGeneration` and opened windows.
  **Expected:** (a) ON → exactly ONE dispatch to Fredo and ZERO windows; (b) OFF → the text WAITS in
      the bar with ZERO dispatch and ZERO windows, then Enter → ONE dispatch to Fredo and STILL zero
      windows; (c) AWAY/OFF → no window ever opens, and with no active companion the transcript is
      simply not delivered; (d) mid-reply → no window opens. **No dictated phrase opens an app.**
  - **Edge:** dictated `set` / `Settings` / `Miss` / `s` (all app-matching — none may launch);
    dictated then cleared; dictated text edited by the user ⇒ still Fredo (see F-70/the launcher
    suite's dictated-then-edited row).

## F-70 (REQ-10 / clarification #2) — A dictated-then-EDITED transcript is still Fredo's

- [ ] F-70: Autosend OFF; hold Space; synthetic final `set`; release (text waits in the bar). Edit
      the bar to `Settings` with REAL keystrokes; press Enter. CONTROL: clear the bar fully, type
      `Settings` from scratch, press Enter.
  **Expected:** Leg 1 → ONE dispatch to Fredo carrying `Settings`, ZERO windows. CONTROL → the
      Settings window OPENS. The two legs MUST differ — only text typed from scratch is typed query
      text.
  - **Edge:** appended-space edit (`Settings `) ⇒ still Fredo; full `Ctrl+A` + retype ⇒ record the
    observed classification and report expected-vs-actual (QA Discussion QA-4).

## F-71 (REQ-12 / NFR privacy) — Visible for the WHOLE hold; the mic is released on release/cancel

- [ ] F-71: Sample the visible listening indicator at ≤50 ms cadence from the Space `down` through
      `up` + 500 ms; sample the fredo working set (the #2877 F-28 `measure.mjs` method) at idle /
      mid-hold / post-release; repeat with a cancel mid-hold. Static pin: grep `infrastructure/voice/**`
      for remote clients.
  **Expected:** the indicator is present for the WHOLE capture and cleared on release/cancel with NO
      gap while capturing; the mic is RELEASED the moment Space is released or the utterance is
      cancelled (working set back to the idle baseline, `listening === false`, no leaked capture
      handle); enabling voice alone never captures; ZERO remote endpoints on the audio→text path.
  - **Edge:** release-and-re-hold ≤3 cycles (no leak, exactly one indicator per session); a silent
    hold still releases; the live outbound network block stays a NAMED BLOCKER (no elevation lever).

## F-72 (REQ-13/REQ-14 / NFR a11y + scope) — Text-conveyed, keyboard-only, and scoped to the bar

- [ ] F-72: (a) Read the listening/Enter TEXT in every state (chip, `Listening…` placeholder,
      `voice-listening-announcer`, `#fredo-command-hint` mirror) and perform every F-66..F-70 action
      KEYBOARD-ONLY (no mouse); re-read with the listening animation suppressed. (b) Hold Space
      1500 ms in a settings field (`#companion-idle-timeout-seconds`) and in a feature-window
      textarea/`contenteditable`; then hold on the launcher bar (contrast leg).
  **Expected:** (a) every state is conveyed as TEXT — never by colour or animation alone — and every
      behaviour is completable with the keyboard alone; reduced motion leaves the state readable
      (static pin + a NAMED BLOCKER for the `matchMedia` flip). (b) an ordinary space lands in every
      NON-launcher-bar field with ZERO `stt_start`/cue/session, while the hold on the launcher bar
      dictates — hold-Space applies ONLY to the focused launcher search box.
  - **Edge:** a focused launcher TILE — Space keeps its current meaning ([#2823] `LauncherShell.tsx:887`)
    and must NOT dictate; the cancel/Stop control focused; `contenteditable`; hint-text contrast in a
    light preset AND the dark base.
  - **Test data:** the shipped `ThemePresetSelector` for the light/dark legs; the companion idle-timeout
    input as the non-launcher field.

## F-73 (REQ-18 / R-2.3/R-2.5/R-2.6/R-2.7) — The microphone is never left hot, and blur KEEPS the words

- [ ] F-73: (a) Release Space BEFORE the backend confirms the start (threshold crossed, engine not yet
      live) at several offsets (0/50/150/400 ms), then subscribe to `stt:state`; (b) let a hold go
      LIVE, then blur the input / fire a `window` blur mid-hold with autosend ON; (c) cancel mid-hold
      with Escape; (d) cancel mid-hold with the visible `×`; (e) a sub-threshold TAP. After each,
      read `stt_status`, the bar `value`, and the fredo working set.
  **Expected:** after EVERY leg `stt_status.listening === false` and the working set is back at the
      idle baseline (no capture handle) — the mic is never left hot. (a) the session that later
      reports `listening:true` is cancelled on its rise edge and **exactly one ordinary space lands**
      (R-2.6). (b) the capture **STOPS**, the **recognized words are KEPT in the bar as a dictated
      transcript**, the **autosend commit is SUPPRESSED** (ZERO dispatch even with autosend ON) and
      the mic is released — R-2.5 as BOUND (QA-9 CLOSED; this is NOT a discard + restore). (c)/(d)
      the utterance IS discarded and the pre-session text restored. (e) the mic was **never opened**
      and exactly one space lands.
  - **Edge:** release at exactly the 200 ms threshold; blur vs `window` blur vs minimise; cancel in
    the same tick as the `up`; the blur path with autosend ON (the suppression must hold); 3 repeated
    (a) cycles to expose a leak or a mic-left-open; a TAP (assert the mic was never opened, not
    merely "released"); a blur on a cancelled hold.
  - **Test data:** voice enabled + model ready; the synthetic-transcript lever;
    `Fredo_companion_voice_autosend=true` for leg (b); the #2877 F-28 working-set measurement method.

### #2882 binding addendum (read before executing F-66..F-73)

- **R-2.4 evidence shape:** the bar must indicate listening for the WHOLE capture — frozen 6px dot +
  `Listening` chip + `Listening…` placeholder + a tinted border — with the word `Listening`
  carrying the meaning (the dot is redundant only) and the start/stop announced as text on the
  polite live region (finals only, never partials — the #2877 announcer contract is unchanged).
- **TAP vs HOLD — BOUND (QA-7 CLOSED; contract 4b + R-2.1/R-2.2/R-2.6/R-2.7).** The ARMED empty bar
  consumes the Space keydown and starts a **bounded 200 ms hold**. Release **below** the threshold =
  TAP → **exactly ONE ordinary space** (`input.value === ' '`), **no capture attempted, no
  `stt_start`, the mic never opened**, no `stt:state` event. Release **at/above** the threshold with
  the engine **never live** → the session is cancelled on its rise edge and **exactly ONE ordinary
  space** lands (declared timing, NOT a defect). Release **while live** → finalize, no space.
  Assert these bound outcomes; a **lost or converted** space is a FAIL (G-158). The accepted
  trade-off (an elapsed hold that never goes live yields a space; the first ~200 ms of a hold is not
  captured) is declared behaviour, not a defect.
- **Unarmed ⇒ natively ordinary (contract 4c, fail-closed).** Arming requires
  `voiceEnabled && sttModelReady` (ST-3's probe). Readiness-unknown means NOT armed — Space is never
  intercepted and its default (auto-repeat included) is observed verbatim; there is no third
  placeholder state.
- **Mid-hold blur — BOUND (QA-9 CLOSED; R-2.5 as revised).** Blur / `window` blur mid-hold is a
  **STOP**: capture stops, **mic released**, **recognized words KEPT in the bar as a dictated
  transcript**, **autosend commit SUPPRESSED** (zero dispatch even with autosend ON). Discard +
  restore applies ONLY to an explicit cancel (Escape / the visible `×`).
- **R-2.6 (mic never left hot) is a PRIVACY invariant — a confirmed violation is a FAIL of the row
  even if every other row passes (G-158).** `stt_stop` with no active session returns without error
  (`session.rs:357-388`), so a release that lands before the pending start completes needs an
  explicit rise-edge cancel guard; drive it as **F-66 leg (e)** / **F-73 leg (a)** with several
  release offsets, and assert `stt_status.listening === false` afterwards.
- **Exact dictated chip copy:** `↵ send transcript to Fredo` (including after the user edits the
  transcript). Never promise an app launch for dictated content.

### #2882 round 1 — tester run record (`spec/2882 @ f076fa08`, live)

**Rows F-66..F-73 PASS** (F-71's working-set leg and F-72's reduced-motion leg are NAMED BLOCKERS).
Verdict + per-REQ values: the `## Tests Runs (round 1)` comment on #2882. Key receipts:
- Hold `down`→`up` with recorded durations **30,226 ms / 9,610 ms / 8,967 ms**; a **0 ms tap** lands
  `value === " "` with ZERO `stt:state` and the mic never opened.
- Release-while-live ⇒ `stt_status.listening:false` + `stt:state listening:false` (mic released),
  no space. Autosend ON ⇒ exactly ONE `[companion] calling adapterBridge.llmChat`, ZERO windows
  (the reply echoed the transcript); autosend OFF ⇒ the transcript WAITS as editable text
  (`readOnly=false`, `disabled=false`) with chip `↵ send transcript to Fredo`.
- Escape mid-hold ⇒ discard + pre-session text restored + **no** space on the trailing keyup.
  Blur mid-hold with autosend ON ⇒ STOP: mic released, words KEPT (`value==="blur keeps these
  words"`), **0** dispatch. NOTE: a blur-stop whose only recognition was a *partial* restores the
  pre-session text (the committed-final evidence rule) — seed a **final** before blurring, as a
  real `stt_stop` would.
- Voice-disabled hold (9,610 ms): placeholder stays `search or command` (unarmed), ZERO capture
  attempt, NO `role="alert"`, keydown NOT consumed.

**Lever notes:** the plan's hold lever works as specified, but `keyboard(press)` performs no native
text insertion — the literal `value===" "` for the voice-off/model-missing row is a NAMED BLOCKER
(assert the app's `defaultPrevented:false` + the `type`-inserted burst instead). The host still has
no physical mic: `stt:transcript` content came from the documented synthetic lever; the capture
  lifecycle/indicator/mic-release legs ran on the real control plane. Taps land because the app
  writes the space itself.

---

## #2887 extension — instant hold-to-dictate: first-capture latency, indicator honesty, cold ≈ warm

> Issue #2887 removes the ~3–5 s "not yet listening" wait on the hold-Space dictation (worst on the
> cold first dictation after launch/idle), keeps the **#2882 hold-to-dictate contract unchanged**,
> and makes the listening indicator honest. **The chosen route** (PO amendment 1) keeps the
> recognizer **ready/resident while Fredo is idle**. Rows F-74..F-82 map 1:1 to
> `.opencode/tmp/2887/triage.md` `## QA Expert` REQ-1..REQ-4 + REQ-6..REQ-10 (REQ-5 is the
> regression set in `regression.md` R-21).
> **Verification policy: live** — `tauri_webview_keyboard`/`execute_js` timestamped markers,
> `tauri_webview_dom_snapshot`/`getBoundingClientRect`, `tauri_read_logs`, the #2877 F-28
> `measure.mjs` working-set/CPU method, and the mandatory `telemetry_spans` receipt (F-81).
> A static-only PASS is a FALSE PASS.
>
> **Budget binding (architect to amend):** warm p50 ≤ 250 ms / p95 ≤ 500 ms / max ≤ 750 ms; cold max
> ≤ 900 ms; `cold − warm` ≤ 250 ms; no non-capturing start/prepare state > 300 ms; idle CPU
> ≤ 1 %/10 s; resident working-set Δ ≤ 350 MB. **Quote raw numbers — never an adjective (G-171).**
>
> **Measurement contract:** press marker = `performance.now()`/`Date.now()` in the SAME
> `execute_js` task that dispatches the Space `keydown` (`{key:' ',code:'Space'}`; the MCP
> `keyboard(press, key=" ", Control)` lever emits the wrong `code` — see the #2882 lever notes) +
> a `fredo emit` marker row; capture-active marker = the FIRST of {`stt:state{listening:true}`,
> the audio-stream-open app-log line (device + rate), the first cue frame} — **record which**.
>
> **Test data:** voice enabled + model ready; a reproducible cold fixture (fresh `dev-env` Down→Up;
> the declared idle window; a resident-kill lever); a committed 16 kHz mono WAV whose first word
> starts at sample 0; the synthetic `stt:transcript` lever (content only); the #2882 space/tap/cancel
> levers. **The host has NO physical mic** (silent virtual devices only) — the real-mic leg is a
> NAMED BLOCKER.

- [ ] F-74 (REQ-1 / AC1): **Warm press→capture-active latency.** Running app, voice enabled + model
      ready, `input[role="searchbox"]` focused and EMPTY. For ≥10 holds: emit the press marker in the
      dispatch task, hold 1500 ms, release; record `T = t_capture_active − t_press` per hold.
  **Expected:** warm `p50 ≤ 250 ms`, `p95 ≤ 500 ms`, `max ≤ 750 ms` (the architect's
      `T_FIRST_CAPTURE_BUDGET_MS` governs); raw per-hold numbers quoted; the lever + clock domain
      named; exactly ONE `stt_start` per hold; no "not yet listening" interval beyond the bound.
  - **Edge:** OS auto-repeat keydowns; a hold right after a release; device enumeration in flight;
    synthetic keydown failing to focus → record the lever; a pre-measurement/fallback frame →
    disclose raw (G-171).
  - **Receipt:** the 10 raw `T` values + p50/p95/max + the marker timestamps + the lever used.

- [ ] F-75 (REQ-2 / AC2): **No lost opening words.** Feed the deterministic 16 kHz mono WAV whose
      FIRST marker word starts at sample 0 in the SAME tick as the Space `down` through the SAME
      capture path; hold ≥4 s; release; read the finalized transcript + bar. Repeat 10×; plus a
      real-mic leg (`alpha bravo charlie`, starting on the press) where a mic exists.
  **Expected:** the opening word is present in the finalized transcript/bar 10/10 (fixture) and 3/3
      (mic); nothing uttered during the hold is dropped while the system readies; one commit.
  - **Edge:** speaking during the pre-active readiness window; a word straddling the boundary; a hold
    whose ONLY word is the opening one; pre-existing bar text. **If the only available lever is the
    synthetic `stt:transcript` injection → NAMED BLOCKER for the real capture read; never a PASS**
    (the synthetic lever proves only the finalize wiring).
  - **Receipt:** the transcript verbatim + the marker timestamps + the WAV fixture hash + the lever.

- [ ] F-76 (REQ-3 / AC3): **Indicator honesty.** Subscribe to every `stt:state`/`stt:started`
      emission with timestamps; sample the cue (`launcher-command-listening` dot/chip/placeholder +
      `voice-listening-announcer`) at ≤50 ms from press through release + 500 ms. Repeat ≥10 holds.
  **Expected:** the cue is present in ZERO samples BEFORE the capture-active marker; no interval
      > 300 ms (the architect's `T_MAX_STARTING_STATE_MS`) shows a start/prepare state while capture
      is NOT active; every state is text-conveyed (never colour/animation alone); once active the cue
      is continuous until release.
  - **Edge:** a hold that never becomes active → NO cue + one ordinary space; a typed error is a text
    state, not a stall; rapid re-arm; reduced motion is a static CSS pin + a NAMED BLOCKER for the
    live `matchMedia` flip. **Do NOT assert a specific readying affordance or threshold — only the
    observable guarantees (open items (a)/(b)).**
  - **Receipt:** the sample timeline (frame time, cue present?, state text) + the `stt:state` stream.

- [ ] F-77 (REQ-4 / AC4): **Cold ≈ warm.** Force the cold fixture — (1) fresh `dev-env` Down→Up,
      FIRST dictation with no prior `stt_start` in the process; (2) the declared idle window with the
      app untouched; (3) a resident-kill lever. Run the F-74 measurement cold and compare with the
      SAME session's warm numbers; re-check F-75 on the cold run.
  **Expected:** cold `T ≤ 900 ms` (`T_COLD_MAX_MS`) AND `cold − warm ≤ 250 ms`
      (`T_COLD_WARM_DELTA_MAX_MS`) — "not noticeably worse"; no opening word lost on the cold run.
  - **Edge:** OS/model caches evicted (record the lever); cold after a resident kill; a second app
    instance; a cold run whose resident warm-up is still in flight (must recover, not stall). Repeat
    cold ≥3× and quote every number.
  - **Receipt:** the cold/warm pairs + the lever that produced each + the F-75 cold transcript.

- [ ] F-78 (REQ-6 / AC5): **Transcript routing + exactly-once send (unchanged).** Autosend ON/OFF;
      dictate `Settings` / `set` / `Miss`; companion ACTIVE / AWAY / OFF; dictate then EDIT the bar to
      `Settings`; multiple finals + one release; a final landing after the `listening:false` event.
  **Expected:** NO dictated phrase opens an app (zero windows); exactly ONE dispatch per dictated
      turn (one `runGeneration`); autosend OFF leaves the text waiting/editable with the hint
      `↵ send transcript to Fredo`; a dictated-then-EDITED transcript still goes to Fredo.
  - **Edge:** a second dictation while the first reply streams; dictated then cleared and retyped;
    dictated `set`/`Settings`/`Miss`/`s`. Reference F-66..F-70 + F-51/F-52/F-53.
  - **Receipt:** per leg — the hint text, the dispatch count, the window count.

- [ ] F-79 (REQ-7 / AC5): **Whole-capture indicator + mic release (privacy invariant).** Sample the
      indicator ≤50 ms over the whole hold; measure the fredo working set (the #2877 F-28 method) at
      idle / mid-hold / post-release; cancel mid-hold (Escape + the visible `×`); static-grep
      `infrastructure/voice/**` for remote clients.
  **Expected:** the indicator is present for the WHOLE capture with NO gap; the mic is released the
      moment the hold ends or is cancelled (`stt_status.listening === false`, working set back to the
      resident-idle baseline, no leaked handle); **the resident-ready idle state opens NO capture**;
      enabling voice alone never captures; ZERO remote endpoints on the audio→text path.
  - **Edge:** 3 release-and-re-hold cycles; a silent hold still releases; a never-live hold → the mic
    was NEVER opened; the resident-ready app left idle for the idle window still opens no capture.
  - **Receipt:** the working-set triples + the cue timeline + the `stt_status` reads.

- [ ] F-80 (REQ-8 / NFR, G-123): **Resident-ready lifecycle is measured and recoverable.** With the
      resident active and the app never dictating: sample idle CPU (Get-Process CPU delta over ≥10 s)
      + working set at t0 and at the END of the declared idle window; close/reopen the bar; kill the
      resident mid-idle and hold again; enumerate persisted keys.
  **Expected:** idle CPU ≤ the bound (default ≤ 1 % avg / 10 s); working set within the resident
      budget (default Δ ≤ 350 MB); NO capture handle at idle; the resident survives a bar
      close/reopen and the idle window; after a resident kill the next hold RECOVERS (bounded start,
      typed state, no stuck cue, no error); only declared persisted keys.
  - **Edge:** machine sleep/resume; a second app instance; a resident-start failure; long idle then a
    hold.
  - **Receipt:** both CPU/WS samples + the recovery timeline + the key list.

- [ ] F-81 (REQ-9 / NFR, G-171): **Markers exist, are correct and are live-receipted.** Verify the
      press/capture-active markers are emitted with timestamps and classify; `fredo emit --event-type
      chat` marker rows; query `telemetry_spans` + the row tables; re-run the measurement on the
      tested tip.
  **Expected:** `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)`; the
      marker rows are present and ordered; every latency number carries its method (lever + tool +
      clock domain); a pre-measurement/fallback frame is disclosed with raw numbers.
  - **Edge:** a marker lost / not classified → FAIL or a NAMED BLOCKER with a fallback method named;
    clock skew recorded; re-run on the tip.
  - **Receipt:** the emit output verbatim + the query result + each number's method line.

- [ ] F-82 (REQ-10 / stability): **Back-to-back + cancelled holds.** ≥5 consecutive hold→release
      cycles with the resident armed, ≥3 cancelled mid-hold (Escape / `×`), and a re-hold immediately
      after a cancel; measure latency each cycle and the working set after the last.
  **Expected:** no latency degradation (last ≤ first + the warm p95), no lost opening word, no stuck
      cue, exactly one indicator per cycle, mic released every time, working set back to the
      resident-idle baseline — no handle/thread leak.
  - **Edge:** cancel in the same tick as the release; cancel before capture goes live; a cancel on a
    never-live hold; 3 rapid press/release churns.
  - **Receipt:** the per-cycle latency series + the final working set + the cue states.

> **Cross-reference (not a case):** the bar-instrumented press→active bound and the bar-level honesty
> timeline are owned by `.opencode/tests/launcher/functional.md` F-82..F-84; run both suites in the
> same round.

### Run log — #2887 round 1 (`spec/2887 @ 706fcd9d`, 2026-09-17, live)

**Verdict FAIL** — 5 PASS / 2 FAIL / 1 UNVERIFIED of 8 rows. Screenshots + raw URLs: `## Tests Runs (round 1)` on #2887.

- **F-74 PASS (warm).** 10 holds, `engineResident:true` 10/10. `T` = the `stt:state{listening:true}` receipt minus the capture-phase `keydown` `performance.now()` (one webview clock domain; lever `tauri_webview_keyboard(action="down"/"up", key=" ")` on `textarea[data-testid="launcher-command-input"]`): **275.3 / 226.4 / 230.5 / 231.5 / 231.4 / 230.4 / 225.4 / 225.5 / 233.7 / 223.0 ms** ⇒ p50 **230.5** / p95 **275.3** / max **275.3** vs the PLAN's `T_FIRST_CAPTURE_BUDGET_MS` (250/300/320) → PASS. Backend `readyMs` 51→14 (B2 ≤100 p95) PASS. Exactly one `stt_start` per hold. The 275.3 outlier is the first hold and is INCLUDED (G-171, no frame dropped).
- **F-75 UNVERIFIED (named blocker, G-053).** The real-capture opening-word read needs the ST-9 `FREDO_STT_FEED_WAV` seam; the tester cannot set the process env var (no `dev-env.ps1` passthrough; fresh shell per invocation) and the real mic is the silent virtual `Iriun Webcam`. The synthetic `stt:transcript` lever on the real channel PASSED the content clause: bar `alpha bravo` (partial) → `alpha bravo charlie` (final), one commit, and with autosend OFF the text waited with the hint `↵ send transcript to Fredo` (0 `runGeneration`). Per this row's own rule the synthetic lever is NOT a PASS for the capture read.
- **F-76 PASS.** 13 holds, 25 ms in-page cue sampler + `stt:state` subscription: **0** dot/chip samples before the capture-active marker; first cue frame **+15.0 / +17.6 / +23.5 ms AFTER** the live event; `launcher-command-listening-pending` **0/12** on resident holds; every state conveyed as TEXT (placeholder `Hold to dictate…` → `Listening…`, chip `Listening`, announcer `Listening` / `Starting voice input` / `Stopped listening` / `Dictation cancelled`). 0.991–1.0 dot fraction while live.
- **F-77 FAIL (B) / PASS (A).** (A) cold-idle: 324 248 ms idle + `engineResident:true` ⇒ T **243.5 ms** ≤ 320, delta vs warm p50 **+13.05 ms** ≤ 50. (B) not-resident (resident-kill lever, sanctioned by the round brief): T **5019.1 ms** > `T_LAUNCH_COLD_MAX_MS` **3820**, `readyMs` 4816, `engineResident:false`, chip `starting voice input…` 4626.1 ms then the truthfully-live cue, engine re-parked, no error. `T_LAUNCH_WARM_MS` **4606 ms**. `T_LAUNCH_WINDOW_MS` UNVERIFIED (post-relaunch bridge wedge; first probe at `performance.now()=32388 ms`). Repro: `stt_release` → immediate Space hold.
- **F-78 PASS (partial scope).** Autosend ON: dictated final `alpha bravo charlie` ⇒ exactly ONE `[companion] runGeneration called`, ZERO windows. Autosend OFF (persisted key + frontend key): the same final WAITED as editable text (`readOnly:false`, `disabled:false`) with the hint `↵ send transcript to Fredo`, ZERO `runGeneration`. The dictated-then-EDITED sub-leg was not re-driven this round (durable #2882 F-70 record stands).
- **F-79 PASS.** Indicator present for the whole capture (dot fraction 1.000 in 11/12 holds, 0.991 in one — a single release-boundary frame); mic released on every release/cancel (`stt_status.listening:false`); resident-idle opened NO capture across 324 248 ms; static grep of `infrastructure/voice/**` → ZERO remote clients (only the setup-gated manifest URLs + 2 `example.invalid` test URLs).
- **F-80 FAIL (idle-CPU clause) / PASS (rest).** Idle CPU with the engine resident: **1.27 %** and **1.166 %** of one core over two 60 s windows (+1.087 % over 40 s) vs the plan's 1 % bound → FAIL. The engine-NOT-resident baseline is **1.218 %** ⇒ the resident engine adds ≈0 CPU; the app's background (continuous `OTLP metrics persisted inserted=1423` every ~5 s) sits above the constant. PASS: working set resident-idle 194.2 MB vs released 82.0 MB ⇒ delta **112.2 MB** ≤ 350; no capture handle at idle; residency survived 324 248 ms idle + a bar re-summon (next hold `engineResident:true`, `readyMs` 38); resident-kill recovery honest and typed (`starting voice input…`, no error).
- **F-81 PASS.** `telemetry_spans` → **4 363 rows @ start / 4 519 rows @ end**, newest `ingested_at` 2026-09-17T23:42:04.914Z. `fredo emit` chat/tool ⇒ `{"queued":true}`; marker rows `chat_rows.tester-2887-chat|init`, `chat_rows.tester-2887-warm|response`, `tool_use_rows.tester-2887-tool|terminal|response`. Every latency number carries its lever + clock domain.
- **F-82 PASS.** 10 back-to-back cycles (first 275.3 → last 223.0, no degradation); **3** Escape cancels mid-hold (each ⇒ `listening:false`, value `""`, announcer `Dictation cancelled`); mic released every time; one indicator per cycle.
- **AC5 regression spot (F-66/F-67/F-68 equivalents) PASS.** 80 ms TAP ⇒ one space `" "`, ZERO `stt:state`, mic never opened. Space in a non-empty query ⇒ keydown NOT consumed, ZERO `stt:state`. Release-after-live with no committed final ⇒ exactly one space on 12/12 holds (R-5e `no-words-space`). Voice disabled (persisted + frontend) ⇒ no promise placeholder, gesture produces ZERO `stt:state`, typed `{code:"disabled"}` on a direct probe.
- **Suite divergence (reported, NOT adopted):** this file's F-74/F-76/F-77/F-80 placeholder budgets (p95 500 / max 750 / cold 900 / delta 250 / starting-state 300 / 10 s CPU window) were superseded by the plan's named constants and were NOT used for scoring; the bar selector `input[role="searchbox"]` is stale (live: `textarea[data-testid="launcher-command-input"]`, `role="searchbox"`). No file was edited to match the placeholders.

---

## #2888 extension — ordinary written casing + the name "Fredo" in the dictated transcript

> Issue #2888: dictated text into the launcher command bar must land in **sentence case** with
> **intentional capitals surviving**, and saying **"Fredo"** must yield `Fredo` in the transcript.
> Rows F-83..F-101 map 1:1 to the QA-Plan `REQ-1..REQ-9` + `NFR-1..NFR-3` + `DOC`/`EV` in
> `.opencode/tmp/2888/triage.md` `## QA Expert` (`REQ-1` sentence case; `REQ-2` live parity;
> `REQ-3` content integrity; `REQ-4` the name; `REQ-5` intentional capitals; `REQ-6` the user's edit
> wins; `REQ-7` voice-off/model-missing; `REQ-8` Fredo-bound routing; `REQ-9` the unchanged
> #2882/#2887 contract).
> **Verification policy: live.** Evidence: the running launcher bar (`value`), the real control
> plane, DOM snapshots/screenshots, `tauri_read_logs(console)`, the UI unit pins the tester can run
> (`pnpm --filter @fredo/ui test:run`), and the mandatory `telemetry_spans` receipt (F-99).
> A static-only PASS is a FALSE PASS.
>
> **The three sanctioned levers (there is no fourth):**
> - **L1 REAL gesture:** `tauri_webview_keyboard(action="down"/"up", key=" ")` on the focused EMPTY
>   `textarea[data-testid="launcher-command-input"][role="searchbox"]`; record the hold duration.
> - **L2 REAL control plane:** `stt_start{origin:"launcher"}` / `stt_stop` / `stt_cancel` /
>   `stt_status` / `stt_check_model` / `stt_list_devices` via `tauri_ipc_execute_command`.
> - **L3 SYNTHETIC CONTENT (the REAL channel):** `tauri_ipc_emit_event(eventName="stt:transcript",
>   payload={sessionId, revision, segmentId, text, isFinal, latencyMs})` — the exact event
>   `useVoiceDictation` subscribes to via `adapterBridge.listen` (`useVoiceDictation.ts:172`).
>   **Content ONLY — never lifecycle/cue/mic-release evidence.**
>
> **FORBIDDEN:** any recorded-speech WAV fixture or out-of-repo asset. None exists under
> `C:\Code\fredo`; hunting for one is a documented failure mode (G-172/G-009). The acoustic
> reliability bar is a NAMED BLOCKER (F-89) — never fabricated, never substituted by L3.

- [ ] F-83 (REQ-1): **Sentence-case opening.** Hold Space on the empty bar (L1, ≥ 400 ms) → inject a
      final on L3 with raw text `DEPLOY THE BUILD TONIGHT` → release → read `value`.
  **Expected:** the bar is **exactly** `Deploy the build tonight` (opening capitalised, ordinary words
      lowercased, nothing else changed).
  - **Edge:** an already-cased raw is idempotent; a one-word utterance (`TONIGHT` → `Tonight`); an
    empty/whitespace final leaves the bar as before with no crash and no `undefined`; a leading space
    is not double-counted.
  - **Receipt:** the raw injected text, the observed `value` verbatim, and the session id.

- [ ] F-84 (REQ-5): **Intentional capitals survive (the AC1-vs-AC2 crux).** Inject the final
      `EXPORT THE API SPEC AND RUN SQL`; also inject the merged-tip string `CALL THE API FREDO`; read
      `value`.
  **Expected:** the bar is **exactly** `Export the API spec and run SQL` — `API` and `SQL` emitted by
      the declared `PRESERVED_TOKENS` table while `spec`/`and`/`run` are lowercased and the opening is
      capitalised — and the second string is **exactly** `Call the API Fredo`. A silent `api`/`sql`, or
      a `FREDO` left shouted, is a **FAIL** of this row.
  - **Edge:** `SQL` mid-sentence and at the end; `API` as the FIRST word (`API RETURNS SQL` →
    `API returns SQL`); the preserved `I` token (`I TOLD FREDO` → `I told Fredo`); an ordinary all-caps
    word (`BUILD` → `build`) must NOT be preserved; a **declared non-member** (`NASA`, `iPhone`, a
    generic proper name — the Architect's documented boundary) renders lowercased: report it as the
    declared boundary, not as a defect.
  - **Receipt:** the raw text, the observed `value` verbatim, and the declared tables' names alongside
    the two.

- [ ] F-85 (REQ-3): **Casing is the ONLY change.** Inject a long unpunctuated final (§F-95 scale) and
      diff the bar `value` against the injected raw text **case-insensitively**.
  **Expected:** the case-insensitive diff is **empty** EXCEPT for tokens the declared
      `FREDO_CONFUSABLES` mapping rewrites to `Fredo` (the ONE declared non-case change) — no other
      word added, dropped, reordered, re-spelled, punctuated or summarised; no added terminator.
  - **Edge:** hyphenated tokens (`WELL-KNOWN`), apostrophes (`DON'T` → `Don't`, `I'M` → `I'm`), digits
    (`VERSION 2.0`), `SNAKE_CASE`, interior double spaces (not collapsed); **multi-segment turn**
    (`joinSegments`, `useVoiceDictation.ts:126`): `HELLO` then `WORLD` ⇒ **`Hello world`** (the
    Architect's `atUtteranceStart` — the opening capital is derived ONCE per session; a continuation
    segment must NOT manufacture a mid-sentence capital); idempotence
    (`normalize(normalize(x)) === normalize(x)`); non-ASCII pass-through.
  - **Receipt:** the raw text, the observed `value`, and the case-insensitive diff result.

- [ ] F-86 (REQ-4): **The name alone.** Hold → inject final `FREDO` → release → read `value`.
  **Expected:** the bar is exactly `Fredo` — never `FREDO`, never `fredo`.
  - **Edge:** a trailing/leading space in the raw; the name as the only word after a cleared
    transcript; the name immediately after a previous session's transcript (no stale casing).
  - **Receipt:** the raw text + the observed `value` verbatim.

- [ ] F-87 (REQ-4): **The name embedded.** Inject `ASK FREDO TO OPEN THE LOGS` (and one confusable
      spelling, e.g. `ASK FRITO TO OPEN THE LOGS` — see F-89); read `value`.
  **Expected:** `Ask Fredo to open the logs` — `Fredo` capitalised mid-sentence, everything else
      sentence-case; the confusable leg (`ASK FRITO TO OPEN THE LOGS`) renders the **same** string
      (`Ask Fredo to open the logs`) — the closed spelling mapping and the sentence case in one pass.
  - **Edge:** name at position 1; name as the last token; `FREDO,` with punctuation; the name after an
    acronym (`THE API FREDO MADE`); the name adjacent to a hyphen.
  - **Receipt:** the raw text + the observed `value` verbatim.

- [ ] F-88 (REQ-4): **The name repeated.** Inject `TELL FREDO THAT FREDO SAID YES`; then
      `FREDO FREDO ARE YOU THERE`.
  **Expected:** `Tell Fredo that Fredo said yes` / `Fredo Fredo are you there` — **every** occurrence
      capitalised, none dropped or merged.
  - **Edge:** three or more occurrences; the repeated name split across two final segments of ONE turn;
    the name adjacent to itself with punctuation.
  - **Receipt:** both raw texts + both observed `value`s.

- [ ] F-89 (REQ-4): **Reliability sample (~9/10-class).** **Sampling unit = one utterance = one
      dictation session**: focus the EMPTY bar → hold Space (L1, ≥ 400 ms) → inject that utterance's
      final on L3 → release → read `value`. **N = 20**, positions fixed in advance: 7 alone, 7
      embedded (mid-sentence), 6 repeated; vary the surrounding words (no copied template) and include
      one occurrence at the very start and one at the very end of an utterance. **Spellings are drawn
      from the declared closed set `FREDO ∪ FREDO_CONFUSABLES`** — the dominant confusion `FRITO` is
      mandatory; include at least `FRITO`, `FREITO`, `FREDA`, `FREDDO`, `FREDO`.
  **Expected:** **≥ 18/20 (90 %)** render the token exactly `Fredo` (capital F, lowercase rest) at
      **every** occurrence; the raw count, the per-position breakdown, the per-spelling breakdown and
      **every miss with its raw injected spelling + observed `value`** are disclosed. A bare "PASS" or
      a "9/10" with no raw numbers is not a result (G-171). The report MUST state the scope: this
      samples the app's **closed-table spelling canonicalisation + capital preservation**, NOT ASR
      accuracy (L3 bypasses the acoustic model).
  - **Edge:** an engine spelling OUTSIDE the closed set (a two-token split `FRED … O`, a novel
    misspelling) is the Architect's declared **boundary** — report it verbatim, do not count it as a
    sampled unit and do not silently widen the table to make it pass.
  - **Edge / NAMED BLOCKER:** the **acoustic** 9/10 (the recognizer actually hearing `Fredo`) is
    unverifiable on this host — no physical microphone (only the silent virtual `Iriun Webcam` /
    `Steam Streaming Microphone`), **no WAV asset under the repo**, no `cargo` in the tester sandbox,
    and the `FREDO_STT_FEED_WAV` seam needs a process env var the tester cannot set. Record it as a
    NAMED BLOCKER with the closed-table pin as its residual — **a real-mic/spoken-attempt PASS claimed
    without a real-audio capture is a FALSE PASS** (this restates ST-3's "10 spoken attempts" leg).
    A miss must never be re-run until it passes or averaged away.
  - **Receipt:** the 20 raw/observed pairs, the counts (total + per position + per spelling), the
    misses, and the scope paragraph.

- [ ] F-90 (REQ-9 / REQ-7): **The hold/release/tap contract is intact.** (a) hold 1500 ms on the empty
      focused bar then release; (b) an ~80 ms TAP with the engine not yet live; (c) a release at/above
      the 200 ms threshold while the engine never went live. Record the durations + the `stt:state`
      stream.
  **Expected:** (a) `stt_status.listening === true` mid-hold with the visible cue, and `false` within
      ~300 ms of the `up`; the finalized words land as ORDINARY EDITABLE text; (b) the TAP lands
      **exactly one ordinary space** (`value === " "`), ZERO `stt_start`, no `stt:state`, the mic never
      opened; (c) one ordinary space on the rise-edge cancel + the mic released.
  - **Edge:** OS auto-repeat `keydown`s ⇒ exactly ONE `stt_start`; a hold with a dictated transcript
    already in the bar; a hold right after a cancel. **A lost or converted space FAILs the round (G-158).**
  - **Test data:** voice enabled + model ready; the L3 lever for content.

- [ ] F-91 (REQ-9 / REQ-7): **Typing safety — no lost or converted space.** Type `ab`, press Space (real
      keydown); repeat at 1 char, 20 chars and with an app-matching query (`set` → Space); separately
      TAP Space on the empty bar.
  **Expected:** every Space in a NON-EMPTY field lands as a literal character (`ab `, `s `, `set `)
      with ZERO `stt_start`, no cue and `listening === false`; the empty-bar TAP is exactly one
      ordinary space.
  - **Edge:** a burst with 3 internal spaces; delete-back-to-empty then hold; a tap right after a
    cleared dictated transcript. If native insertion is not observable with a synthetic key lever,
    assert `defaultPrevented === false` and record the lever (#2882 lever note) — never a silent PASS.

- [ ] F-92 (REQ-7): **Voice off / model missing ⇒ ordinary space, no capture, no error.** Leg (i)
      `Fredo_companion_voice_enabled=false`; leg (ii) voice enabled + model absent
      (`stt_check_model` → `ready:false`). For each: hold Space ≥ 1500 ms on the empty bar, release;
      then press Ctrl+Space.
  **Expected:** ZERO capture — no `stt_start` invocation at all, no cue, no capture handle; NO error
      dialog and no `role="alert"`; the hold lands exactly one ordinary space; Ctrl+Space still
      shows/focuses the bar with `listening === false`.
  - **Edge:** voice disabled MID-hold; the model removed between the probe and the hold; readiness
    UNKNOWN ⇒ the bar is unarmed and Space keeps its native default verbatim.

- [ ] F-93 (REQ-9): **Cue for the WHOLE capture + the mic released.** Sample the listening indicator
      at ≤ 50 ms from the `down` through `up` + 500 ms; measure the fredo working set (idle / mid-hold /
      post-release, the #2877 F-28 `measure.mjs` method); cancel mid-hold with Escape and with the
      visible `×`.
  **Expected:** the cue (dot/chip/Stop + `Listening…` + announcer `Listening`) is present for the
      WHOLE live capture with NO gap and absent whenever capture is not live; cleared on
      release/cancel; `stt_status.listening === false` after every leg; the working set returns to the
      idle baseline (no leaked handle); exactly one indicator per session.
  - **Edge:** release at exactly the 200 ms threshold; a never-live hold (mic NEVER opened — not merely
    released); 3 release-and-re-hold cycles; a silent hold still releases. **A capture without a
    visible indicator FAILs the round (G-158).**

- [ ] F-94 (REQ-8): **A "Fredo"-bearing transcript always routes to Fredo, never an app; exactly
      once.** Autosend ON: hold → inject final `FREDO` (also `SET`, `SETTINGS`, `MISS`) → release.
      Autosend OFF: the same, then Enter. Edit legs: dictate `Fredo` → edit the bar to `Settings` with
      REAL keystrokes → Enter; and dictate `set` → edit to `Fredo` → Enter. CONTROL: clear the bar,
      type `Settings` from scratch, Enter. Count `runGeneration` calls and opened windows.
  **Expected:** Autosend ON ⇒ exactly ONE dispatch to Fredo (`runGeneration` = 1) and ZERO windows.
      Autosend OFF ⇒ the text waits editable with the hint `↵ send transcript to Fredo`, ZERO dispatch,
      then Enter ⇒ exactly ONE dispatch and ZERO windows. Dictated-then-EDITED ⇒ still Fredo, ZERO
      windows. CONTROL (typed from scratch) ⇒ the Settings window OPENS — the two legs MUST differ.
      N finals + one release = ONE dispatch; no phantom dispatch on a silent session.
  - **Edge:** a final landing after the `listening:false` state event (late-final commit, exactly once);
    a prior-session draft that must NOT dispatch; a typed-error end (`stt:state` with a code) treated as
    a cancel; an edited-in trailing space (`Fredo `); `Ctrl+A` retype (record the observed
    classification, expected-vs-actual). Assert the keep-out against a PRESENT element (the visible app
    grid tiles + the window/dispatch count in the same state) — never by hiding the grid (G-170).

- [ ] F-95 (NFR-1): **The normalization adds no perceptible delay and is bounded on long input.**
      Over ≥ 10 injected finals (L3), measure `t(bar value visibly updated) − t(inject)` in ONE clock
      domain; separately inject a ~120-word final and report its interval.
  **Expected:** raw per-sample numbers + p50/max disclosed; p50 ≤ 50 ms and max ≤ 150 ms (far inside
      the shipped partial-latency budget p50 ≤ 300 / p95 ≤ 600 ms); the interval does not grow
      unboundedly with length; each number names its lever + clock domain (G-171).
  - **Edge:** a long repeated-token utterance (memory/CPU creep); measure after warm-up; a metric not
    measurable on this host ⇒ named blocker + the unit pin — never an adjective.

- [ ] F-96 (NFR-2): **Local-only, no always-on listening, no wake word, no voice commands,
      STT-only.** With the app idle (nothing dictated), subscribe to `stt:state` for ≥ 60 s and watch
      for any capture start / mic-in-use / working-set rise; static-grep the changed modules for remote
      clients (`reqwest|ureq|hyper|TcpStream|UdpSocket|std::net|Command`) and for
      TTS/`speechSynthesis`/intent routing.
  **Expected:** ZERO capture at idle (resident at most — never capturing); ZERO remote endpoints on the
      transcription/normalization path (the only network use stays the setup-gated model acquisition);
      no listening trigger derived from transcript content; no wake word; no voice-command surface; no
      synthesized audio.
  - **Edge:** **a capture without a visible indicator FAILs the round.** The live outbound block is a
    NAMED BLOCKER (no elevation/adapter lever — G-053) with the static pin recorded ALONGSIDE it —
    never as a substitute.

- [ ] F-97 (NFR-3): **A11y / console / build gates + the transform oracle.** Re-read the
      listening/transcript states as TEXT (chip, placeholder, `voice-listening-announcer`,
      `voice-transcript-announcer` — finals only, never partials); run `pnpm --filter @fredo/ui build`
      and `pnpm --filter @fredo/ui test:run`; read the console across every leg.
  **Expected:** every state conveyed as text (never colour/animation alone); the announcer contract
      unchanged; UI build + suite green with the new normalization pins present and NO existing
      assertion weakened/disabled/deleted (G-125); console clean of `Error:`/`Uncaught`/`Maximum update
      depth exceeded`; zero true colour literals / no `var(--x)NN` alpha-append in the changed files.
  - **Edge:** reduced motion is a static CSS pin + a NAMED BLOCKER for the `matchMedia` flip; the Rust
    gates are CI (`rust-validate`: check + nextest + clippy `-D warnings`) evidenced because `cargo` is
    absent from the tester sandbox (named, not skipped silently); a moved/renamed frozen hook is
    refreshed in the same scope and named.

- [ ] F-98 (DOC): **The documented observable matches the shipped one.** Read
      `docs/ARCHITECTURE.md` (companion command-bar bullet, ~613-614) and `docs/FAQ.md` (~142): the
      dictation paragraphs must describe **sentence case with intentional capitals preserved** and the
      **`Fredo` name behaviour**, including the honest scope (dictation-only; no wake word).
  **Expected:** both docs state the shipped observable and every claim matches what F-83..F-94 verified
      this round — no doc claim beyond the implementation (e.g. a blanket "all acronyms and names
      preserved" when only the named exemplars are). Doc-sync authoring is SI-owned: report a
      doc/code mismatch, do not silently fix it here.
  - **Edge:** the doc sentence and the FAQ answer must agree with each other; the `Fredo` scope must
    read as dictation-only; a doc that still says the transcript arrives as the engine emitted it FAILs.

- [ ] F-99 (EV): **Mandatory LIVE receipts, same round (`telemetry_spans`).** `fredo emit
      --event-type chat --session-id <marker>` + `--event-type tool_use` per leg group; query the row
      tables and `telemetry_spans` via the telemetry-query skill
      (`.opencode/skills/telemetry-query/telemetry-query.ps1`); upload every capture with
      `upload-evidence --issue 2888 --base spec/2888` and embed the raw URLs + a textual description in
      `## Tests Runs`.
  **Expected:** `fredo emit` ⇒ `{"queued":true}` and the marker rows classify into `chat_rows` /
      `tool_use_rows`; **`telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)`**
      and the literal token `telemetry_spans` appears in the Evidence (the live-policy guard).
      **Scope it honestly:** `telemetry_spans` evidences APP LIVENESS only — `stt:transcript` is
      control plane and never reaches it (Architect risk note 5), so there is no dictation span to
      query; the dictation oracle stays the bar `value` + the app's own decisions, with the round's
      `fredo emit` markers as the live anchor. Every UI leg's capture is uploaded with a raw URL +
      description; every latency number carries its
      method line. A static-only PASS is a FALSE PASS.
  - **Edge:** a local path never uploaded is not evidence; a screenshot with no description is not
    evidence; re-run on the tested tip — a stale round's receipt does not clear the round-aware guard.

- [ ] F-100 (REQ-2): **Live parity — no ALL-CAPS is ever visible during a capture, and the casing is
      stable.** Hold Space (L1, ≥ 400 ms) → inject a PARTIAL on L3
      (`{text:"CALL THE API FREDO", isFinal:false}`) → sample the bar mid-hold → inject the matching
      FINAL (`isFinal:true`) → sample again → release. Repeat with a second final in the SAME session
      (a continuation segment).
  **Expected:** the bar `value` reads **exactly** `Call the API Fredo` at the PARTIAL sample (never the
      raw `CALL THE API FREDO`) and is byte-identical after the final — no partial/final re-casing
      churn and no window in which uppercase engine text is visible; the continuation segment appends
      WITHOUT a mid-sentence capital (`HELLO` then `WORLD` ⇒ `Hello world`, per `atUtteranceStart`);
      the `voice-transcript-announcer` carries the SAME normalised final string.
  - **Edge:** partial→final→partial churn; a partial that is a prefix of the final; a mid-capture user
    keystroke (the user's edit wins — F-101); release before the first partial (no text, no crash); a
    typed-clear in the bar during the capture.
  - **Receipt:** the per-sample `value` + the announcer string + the injected payloads verbatim.

- [ ] F-101 (REQ-6): **The user's edit wins — engine text is never re-cased after a manual edit.**
      During a live capture, type real keystrokes into the bar (lowercase, then an all-caps run, then
      an app name); then let a further PARTIAL and a FINAL arrive; then release and re-read `value`.
      Also edit AFTER the capture (dictate → release → retype the whole value in the user's own casing).
  **Expected:** text the user typed is preserved **byte-exactly** — no re-casing, no re-normalisation,
      no re-application of the projection on the next segment or at finalize; only the engine's own
      emitted segments are normalised.
  - **Edge:** a user edit that lowers the opening capital (`Hello` → `hello`); an all-caps user edit
    (`HELLO` stays `HELLO`, never re-normalised to `Hello`); an edit during a live segment (partial
    writes stop, per UX-2) followed by a final; a full `Ctrl+A` retype; the dictated-provenance
    hint/label still reads `↵ send transcript to Fredo` after the edit (REQ-8).
  - **Receipt:** the typed string, the observed `value` after the next segment, and the hint text.

### #2888 run log — testing round 1

- [ ] _(pending — the Tester appends per-row PASS/FAIL/UNVERIFIED with raw numbers, the levers used,
      and every miss disclosed; do not pre-fill)_

---

## #2897 extension — speech-handling mode: local transcription vs model audio

> Issue #2897 lets the user choose whether speech is transcribed locally (today's behavior — words
> shown as produced) or handed to the local model as audio (no transcript shown; a "Fredo is
> listening" state instead). Rows **F-102..F-110** map to the Software Architect's EARS set
> (`REQ-1..REQ-8`; backlog AC1→REQ-1, AC2→REQ-2, AC3→REQ-3+REQ-4, AC4→REQ-5+REQ-6, AC5→REQ-7,
> plus the continuous REQ-8) in `.opencode/tmp/2897/triage.md` `## QA Expert`: F-102 REQ-1,
> F-103 REQ-2, F-104 REQ-3+REQ-4, F-105 REQ-5, F-106 REQ-6, F-107 REQ-7, F-108 REQ-8, F-109
> NFR-3 + live receipts, F-110 the ST-0 receipt gate. **Verification policy: live.** Evidence: the
> running bar (`value`), the real control plane, DOM snapshots/screenshots, `tauri_read_logs`,
> `pnpm --filter @fredo/ui test:run`, the uploaded captures, and the mandatory `telemetry_spans`
> receipt (F-109). A static-only PASS is a FALSE PASS. **F-105/F-106 are CONDITIONAL on ST-0**
> (F-110): if the spike is negative they are BLOCKED — not FAIL, not PASS — the spec loops back to
> Phase 2 / a PO amendment, and F-107 (the degradation path) is scored instead.
>
> **The sanctioned levers (there is no fifth):**
> - **L1 REAL gesture:** `keyboard(action="down"/"up", key=" ")` on the focused EMPTY
>   `textarea[data-testid="launcher-command-input"][role="searchbox"]`.
> - **L2 REAL control plane:** `stt_start` / `stt_stop` / `stt_cancel` / `stt_status` /
>   `stt_check_model` / `stt_list_devices` via `tauri_ipc_execute_command`, plus the #2897
>   additive commands `stt_take_audio_clip` (pull the bounded clip) / `llm_chat_with_audio`
>   (deliver) / `stt_audio_capability` (readiness).
> - **L3 SYNTHETIC CONTENT (the REAL channel):** `tauri_ipc_emit_event(eventName="stt:transcript"|"stt:state", …)`
>   — **content only, never audio-delivery/cue/mic-release evidence.**
> - **L4 DETERMINISTIC CAPTURE FEED:** `FREDO_STT_FEED_WAV=<abs in-repo WAV>` set with
>   `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2897 -EnvVars @{ FREDO_STT_FEED_WAV = "C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav" }`.
>   Generator: `node .opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs`
>   (deterministic 16 kHz mono PCM, 1.6 s, paced 1× real time, opens NO `cpal` device). The
>   over-limit row needs the parameterised `>30 s` variant. **Always pair L4 with an UNSET-env
>   control run.**
>
> **FORBIDDEN:** any recorded-speech WAV or out-of-repo asset. None exists under `C:\Code\fredo`;
> hunting for one is a documented failure mode (G-172/G-009). The over-limit (`> 30 s`) clip is
> ST-9's parameterised variant of the sanctioned generator; the **lever itself** is verified by
> `.opencode/tests/voice-dictation/functional.md` F-1..F-4 — run that suite in the same round.

- [ ] F-102 (REQ-1 / AC1): **Mode setting selects local vs model audio; persists; applies to the NEXT utterance (no restart).** Open the Settings app window → Companion → voice group; enumerate `companion-voice-handling-select`'s options; select `Model audio` (stored `'model'`); read `Fredo_companion_voice_handling`; then hold Space and record which mode the NEXT session runs; full restart (`dev-env Down` → `Up -Spec 2897`) and re-read.
  **Expected:** exactly two modes render INSIDE the Companion voice group; the default is `local`; the chosen value persists byte-exactly across the restart; the next utterance (no app restart) runs the newly selected mode.
  - **Edge:** malformed/legacy persisted value heals to `local` with no crash; toggle while idle then dictate; toggle while listening (defined, non-crashing); mode control present on the ready branch and additive on the not-ready gate.
  - **Receipt:** control options + selected value, the persisted key/value before and after restart, and the mode observed on the next utterance.

- [ ] F-103 (REQ-2 / AC2): **Local mode preserves today's dictation.** With mode=`local`, hold Space (L1) on the empty focused bar; sample ≥2 partials + the final; read `value`; release; then cancel via Escape and via `stt_cancel`.
  **Expected:** ≥2 DISTINCT partials appear as produced and land in / feed the bar input; release finalizes; Escape and `stt_cancel` discard + clear; exactly ONE dispatch on Enter; provenance hint `↵ send transcript to Fredo`.
  - **Edge:** sub-threshold tap lands one ordinary space; voice-off/model-absent still lands a space; cancel mid-utterance; re-hold after cancel; no partial/final re-casing churn (#2888 unchanged).
  - **Receipt:** per-sample `value` + the `stt:transcript`/`stt:state` events + the dispatch count.

- [ ] F-104 (REQ-3 + REQ-4 / AC3 — continuous-state test): **Model-audio listening states; transcript absent; cancel/stop.** With mode=`model audio`, hold Space; sample the UI + `stt:state` across `stopped → listening → processing → error`; DOM/`execute_js`-scan the bar, both announcers and the reply for ANY transcript text; then cancel/stop.
  **Expected:** a clear "Fredo is listening" indicator with DISTINCT stopped / listening / processing / error states, each conveyed as text (never colour alone); **ZERO** dictated words/transcript anywhere; cancel/stop works and clears the indicator.
  - **Edge:** server down mid-listen → error state; cancel during processing; rapid stop→start; the indicator held across the 30 s bound; a silent feed shows no words.
  - **Receipt:** the state sequence + the text-scan result (0 transcript nodes) + the indicator geometry.

- [ ] F-105 (REQ-5 / AC4) — **CONDITIONAL on ST-0 (F-110)**: **Captured audio is the turn's input; the model's reply appears.** Feed the deterministic WAV through the real capture path (L4); run one model-audio turn; call `stt_take_audio_clip` after stop and assert the clip was delivered via `llm_chat_with_audio` as the LAST user message's `input_audio` part (NO transcript text); assert the model's response streams through the normal conversation experience. Pair with an UNSET-env control.
  **Expected:** the turn request carries the captured audio (CI/unit pin on the payload build — audio content part + the clip's sample count); the reply appears via the normal conversation path exactly once; the unset-env control produces no audio turn (non-vacuous).
  - **Edge:** exactly at the bound; empty/silent feed; server unavailable at submit; a second turn in the same session.
  - **Receipt:** the payload pin result + the reply marker + the control-run observation.

- [ ] F-106 (REQ-6 / AC4) — **CONDITIONAL on ST-0 (F-110) + ST-9**: **Over-limit is surfaced AND non-lossy (auto-stop + FULL clip — deliberately NOT segmentation).** Feed the ST-9 `>30 s` WAV via L4; observe the auto-stop and the visible `launcher-command-model-limit-status` notice; compare the captured duration/sample count against the clip handed back by `stt_take_audio_clip` (`durationMs` / `base64` length).
  **Expected:** capture AUTO-STOPS at the single pinned `MAX_AUDIO_CLIP_MS` (read from source — never hardcode 30 s), `stt:state.limitReached===true`, the visible limit notice is present, and the delivered clip is the ENTIRE capture (`at_limit:true`, `truncated:false`, `durationMs == captured duration`). The auto-stop is a normal terminal capture (warning treatment), NOT an error state. A silent 30 s truncation or a dropped tail is a **FAIL**.
  - **Edge:** exactly-at-bound; 2× the bound; re-listen immediately after (E-55: no stale clip, buffer reset); cancel mid-`processing`; the constant read from source, not assumed. **If the parameterised long-WAV generator is not shipped → NAMED BLOCKER + the unit/CI non-lossy pin (`at_limit:true`, `truncated:false`, duration == captured duration) — never an out-of-repo WAV.**
  - **Receipt:** the surfaced message + `limitReached` + the captured/delivered durations + the generator invocation.

- [ ] F-107 (REQ-7 / AC5): **Unsupported / unavailable → clearly told + one-action fallback; never a transcript while mode=model.** Probe `stt_audio_capability`, then construct (a) `unsupported` (a model without audio support) and (b) `serverUnavailable` (the managed server stopped); select model audio; read the readiness row; attempt to listen/submit; read the user-facing message; take the offered fallback to local and confirm the switch persists.
  **Expected:** the user is clearly told WHY (unsupported / server unavailable) with an actionable next step; a one-action fallback to local transcription is offered and works; in NEITHER mode does any audio or transcript leave the machine.
  - **Edge:** server killed mid-listen; capability checked at selection vs at submit; fallback mid-turn; model swapped between selection and use.
  - **Receipt:** the exact message, the fallback action's effect, and the loopback/static local-only evidence.

- [ ] F-108 (REQ-8 / NFR-1 — continuous-state test): **All-local hard requirement (3 legs).** (1) static/CI: scan the audio→text→model path for remote clients and cloud-fallback branches; (2) loopback: read the managed `llama-server` bind and the turn request URL; (3) live: process-scoped outbound block proven by a FAILING control fetch, then a full model-audio turn.
  **Expected:** zero remote clients on the path; the server listens on `127.0.0.1` only and the turn targets loopback; with the block proven the turn still completes. The CI pin runs in `rust-validate` (the tester shell has no `cargo`).
  - **Edge:** block mid-session; loopback assertion for BOTH modes; the ONLY network use is setup-gated model acquisition. If the live block is undrivable → NAMED BLOCKER alongside legs (1)+(2), never a substitute.
  - **Receipt:** the static scan result, the bind/URL, and the block + control-fetch outcome.

- [ ] F-109 (NFR-3 + LIVE): **No regression + mandatory live receipts.** Re-run the `#2882`/`#2887`/`#2888` hold/release/indicator/latency rows; read the console across every leg; run `pnpm --filter @fredo/ui build` + `test:run`; `fredo emit` marker rows + `telemetry_spans` query via the telemetry-query skill; upload every capture with `upload-evidence --issue 2897`.
  **Expected:** responsiveness, indicator honesty, mic release, routing and the latency budgets unchanged; console clean; UI build + suite green; `telemetry_spans` NON-ZERO with a recent `max(ingested_at)` and the literal token in Evidence; every capture uploaded with a raw URL + description. **A static-only PASS is a FALSE PASS.**
  - **Edge:** mode switch between utterances; resident engine across a mode switch; no leaked key, no effect loop (AGENTS.md #523); a stale round's receipt does not clear the round-aware guard.
  - **Receipt:** the regression rows' outcomes + the `telemetry_spans` count/timestamp + the uploaded URLs.

- [ ] F-110 (ST-0 gate — enabling, not a product AC): **Feasibility receipts on the PINNED `-qat-` revision.** Capture the ST-0 receipts against `unsloth/gemma-4-E2B-it-qat-GGUF` @ `66a399f6…`: the managed server's `/props` + `/v1/models` output, a **live `input_audio` request receipt**, the **measured per-input ceiling**, and the observed model behaviour (answers directly vs. transcribes internally); read `stt_audio_capability`.
  **Expected:** the receipts exist, name the measured ceiling (which then sets `MAX_AUDIO_CLIP_MS`), and are recorded in-repo; `stt_audio_capability` returns `ready` / `unsupported` / `serverUnavailable` consistently with them and never infers capability from a model name. **A NEGATIVE result ⇒ F-105/F-106 are BLOCKED (not FAIL, not PASS), the spec loops back to Phase 2 / a PO amendment, and F-107 (the degradation path) is scored instead — never a fabricated delivery PASS.**
  - **Edge:** the server is unreachable → `serverUnavailable` (not a crash); the capability probe must not open the microphone and must not touch `infrastructure/voice/` (egress confinement); a model swapped after the probe; the pinned revision differs from the backlog's cited repo (a manifest change would need a PO amendment, not a silent substitution).
  - **Receipt:** the raw `/props` + `/v1/models` output, the `input_audio` request/response receipt, the measured ceiling, and the observed behaviour.

### #2897 run log — testing round 1 (`spec/2897 @ b2b2e4df`, 2026-09-19, live)

**Verdict FAIL** — 7 PASS / **1 FAIL (F-104)** / 1 UNVERIFIED (F-107 `unsupported`) of the 9 functional rows.
Serving root `spec/2897 @ b2b2e4df`; host mic is virtual-only → L4 feed (`FREDO_STT_FEED_WAV`) for audio,
L3 for local transcript content; managed `llama-server` up (pinned `unsloth/gemma-4-E2B-it-qat-GGUF`).

- **F-102 PASS.** `companion-voice-handling-select` = native `<select>`, exactly two options (`local`→`Local transcription`, `model`→`Model audio`), default `local`; selecting `Model audio` persisted `Fredo_companion_voice_handling="model"` + flipped help/announcer + C0r row `data-state="ready"` (`Gemma-4-E2B can interpret audio. Recordings stay on this machine.`); survived a full restart; the NEXT session ran model.
- **F-103 PASS.** mode=`local`: `stt:state {listening:true, phase:null, limitMs:null, engineResident:true}`, placeholder `Listening…`; L3 partials `The quick brown` → `The quick brown fox jumps` in the bar, final committed; Escape cancel → bar `''` + `Dictation cancelled` + no dispatch.
- **F-104 FAIL (the round's blocker).** Listening (`Fredo is listening` chip, dot+Stop+Cancel, 0 transcript) and processing (`Fredo is processing your speech…`, no Stop/Cancel, 0 transcript) PASS; cancel PASS. **The `stopped` state is unreachable:** after the reply completed (`llm-token`…`llm-done`), `voice.modelAudioPhase` stayed `'processing'` and the processing chip kept rendering until the next session (observed ~48 s; reproduced twice). `deriveModelAudioPhase` (`LauncherCommandBar.tsx:306`) has no turn-complete clear and `useVoiceDictation.ts:281` only updates from a later `stt:state`.
- **F-105 PASS** (ST-0 positive). L4 1.6 s feed → `stt_take_audio_clip` `{format:"wav", sampleRate:16000, durationMs:1600, base64Len:68328, truncated:false}` == the fed fixture; reply streamed once (`llm-token`…`llm-done`); no transcript. UNSET-env control produced a hold-length virtual-mic clip (non-vacuous).
- **F-106 PASS** (ST-0 + ST-9). 31 s feed → auto-stop `{phase:"processing", limitReached:true, limitMs:30000}`; visible `That's the 30-second limit — Fredo has your recording and is responding.` (no `role="alert"`) + announcer; clip `durationMs:30000, atLimit:true, truncated:false, base64Len:1280060` = the entire 30 s capture (`MAX_AUDIO_CLIP_MS=30_000` from source). Measured server ceiling ≥120 s → the constant was not re-pinned from R4 (flagged, not a row FAIL).
- **F-107 PASS (reactive) / `unsupported` UNVERIFIED (named).** `serverUnavailable` → capability `{state:"serverUnavailable", code:"modelAudioUnavailable"}`, `stt_start` blocked `{started:false, code:"modelAudioUnavailable"}` before any capture; `role="alert"` `The local model server isn't running, so Fredo couldn't interpret that. Start it, or switch to Local transcription.` + working one-click `Use local transcription` → persisted `local`. Swapping to a non-audio model is a manifest change (forbidden) → `unsupported` covered by `probe.rs` unit pins only. The proactive C0r row is unreachable while the server is down (gate renders the wizard).
- **F-108 PASS legs 1+2 / leg 3 NAMED BLOCKER.** `infrastructure/voice/**` has zero network/process symbols; managed host `127.0.0.1`, live bind `127.0.0.1:8080`, turn URL `http://127.0.0.1:8080/v1/chat/completions`. A process-scoped outbound block needs elevation → named blocker.
- **F-109 PASS.** Console clean; `pnpm build` exit 0; `test:run` 102/1686; `fredo emit` queued; `telemetry_spans` **13,700** rows, `max(ingested_at)` `2026-09-19T11:26:31.278557800+00:00`; 8 captures uploaded.
- **F-110 PASS — FEASIBLE.** `/props` 200, `/v1/models` 200 (`Gemma-4-E2B`, `completion,multimodal`), text control 200, `input_audio` POST `format:"wav"` **200** at 1.6 s / 31 s / 60 s / 120 s (SSE → `[DONE]`); `stt_audio_capability` `ready`. `MAX_AUDIO_CLIP_MS` NOT set from R4 (flagged).
- **Captures (all uploaded):** f102 selector default; f102 model-selected ready; f103 local partials; f104 listening chip; f104 processing; f105 reply model turn; f106 limit notice; f107 server-unavailable alert.

### #2897 run log — testing round 2 (`spec/2897 @ be4d3a73`, 2026-09-19, live)

**Verdict PASS** — 9/9 functional rows (F-107 `unsupported` leg + F-108 leg 3 carry-forward named).
Serving root `spec/2897 @ be4d3a73`; the round-2 fix `f3394e5` (R2-1 `deriveModelAudioPhase` `turnSettled`)
is live. Host mic is virtual-only → L4 feed for audio; L3 for local transcript content.

- **F-104 PASS — the round-1 FAIL is fixed (live, 2 sessions + cancel).** 100 ms DOM sampler + real
  `stt:state`/`llm-token`/`llm-done` listeners: session 1 `capturing` (t=15313, chip `Fredo is listening…`,
  dot+Stop) → `processing` (t=25109, chip `Fredo is processing…`, no Stop) → held while the reply streamed
  (`Fredo is replying…`, t=25213) → `llm-done` t=27911 → **chip/indicator gone at t=28012, resting
  placeholder, no next `stt_start`**; reply rendered (`Hello! I'm Fredo, … How can I help you today?`,
  `inBody:true`); **`stt:transcript` = 0**; bar `value=""`. Session 2 (re-arm): new capture showed the
  listening chip (not pre-settled), chip cleared on its `llm-done` at t=3606. Cancel: `phase:null`, chip
  cleared, no dispatch. Failure-dispatch leg: the shield alert rendered and the processing overlay cleared.
- **F-105 PASS (fed regression).** L4 `stt-feed`/16 kHz; clip `{durationMs:1600, base64Len:68328,
  truncated:false}` == the 1.6 s fixture; reply streamed once + `inBody`; a post-turn manual
  `stt_take_audio_clip` → `{clip:null}` (exactly-once destructive take). UNSET-env control = virtual mic
  48 kHz with a reply.
- **F-106 PASS (fed regression).** 31 s feed → auto-stop `{phase:"processing", limitReached:true,
  limitMs:30000}` + visible `launcher-command-model-limit-status` (warning, not `role=alert`, still
  visible after `llm-done`); clip `{durationMs:30000, atLimit:true, truncated:false, base64Len:1280060}`
  = the ENTIRE bounded capture; reply rendered; 0 transcript.
- **F-107 PASS (reactive).** `stop_llama_server` → capability `{state:"serverUnavailable",
  code:"modelAudioUnavailable"}`; `stt_start` blocked `{started:false, code:"modelAudioUnavailable"}`;
  `role="alert"` curated copy + `Use local transcription` → persisted `local`. `unsupported` UNVERIFIED
  (model swap = manifest change) — unit-pinned.
- **F-108 PASS legs 1+2.** Zero network/process symbols in `infrastructure/voice/**`; managed host
  `127.0.0.1`, turn URL `http://127.0.0.1:8080/v1/chat/completions`, live probe target
  `http://127.0.0.1:8080/props`. Leg 3 named blocker.
- **F-109 PASS.** Console clean; UI build exit 0; `test:run` 102/1690; `telemetry_spans` 14,296 rows,
  `max(ingested_at)` `2026-09-19T12:06:42.903606400+00:00`; 5 captures uploaded.
- **F-110 PASS (carried).** Same pinned model, `stt_audio_capability → ready (Gemma-4-E2B)`; `MAX_AUDIO_CLIP_MS`
  now the DECIDED 30,000 (R2-2).
- **F-102/F-103 PASS (F-103 re-run; selector persistence re-checked in S-20).**
- **Captures (round 2):** f104 listening; f104 processing+limit; f104 idle-after-reply; f105/f104 model
  reply; f107 server-unavailable alert.

---

## #2903 extension — model-audio app open/close must PERFORM the action (revises #2897)

> Issue #2903 fixes a **performed-action** gap: in model-audio mode a spoken open/close app request is
> answered as text only ("I can certainly open settings for you.") but no window opens or closes, while
> the typed/companion path performs these. Rows **F-111..F-126** map 1:1 to the QA-Plan
> `R-1..R-5` + `NFR-1`/`NFR-2` + `REG-1` in `.opencode/tmp/2903/triage.md` `## QA Expert`.
> **Close is IN SCOPE** — the PO amendment approved `close_app` in the ONE shared registry + dispatch
> hook via `windowStore.closeWindow` (13 points, ST-3 retained); **no row treats close as out of scope,
> conditional, or TBD.**
> **Verification policy: live.** Evidence: the running bar/window DOM (`tauri_webview_find_element` /
> `execute_js` / `dom_snapshot`), the real control plane, `tauri_ipc_emit_event`, screenshots,
> `tauri_read_logs(console)`, the CI check result (`rust-validate` + `pnpm --filter @fredo/ui test:run`),
> and the mandatory `telemetry_spans` receipt (F-125). A static-only PASS is a FALSE PASS.
>
> **Root cause under test (confirmed by the Architect's Domain Model):** the model-audio path never
> offers the skill registry — `build_audio_request_body` (`features/llm_server/chat.rs:330-335`) sends no
> `tools`/`tool_choice`/`parallel_tool_calls`, `run_audio_chat` (`chat.rs:418-442`) uses the plain
> content stream (no `ToolCallAccumulator`/`plan_terminal_events`), and the frontend audio branch calls
> `llmChatWithAudio(..., onToken, onDone, onError)` with NO `onSkillCall`
> (`CompanionEntity.tsx:883-895`). The typed/companion path is `llmChatWithSkills` →
> `llm-skill-call` → `useAppOpenRequests` → `run_open_app_cli` (`app_open.rs:312`).
>
> **Sanctioned levers (there is no sixth):**
> - **L1 REAL gesture:** `keyboard(action="down"/"up", key=" ")` on the focused EMPTY
>   `textarea[data-testid="launcher-command-input"][role="searchbox"]`.
> - **L2 REAL control plane:** `stt_start` / `stt_stop` / `stt_cancel` / `stt_status` /
>   `stt_take_audio_clip` / `llm_chat_with_audio` / `stt_audio_capability` / `run_open_app_cli` /
>   `confirm_app_open_request` and `fredo open-app <identity>`.
> - **L3 SYNTHETIC MODEL SELECTION on the REAL channel:** `tauri_ipc_emit_event(eventName="llm-skill-call",
>   payload={skill:"open_app"|"close_app", arguments:{app:"<name>"}})` — the exact event
>   `useAppOpenRequests` subscribes to (`useAppOpenRequests.ts:226`) — and `app-open-request` for the CLI
>   branch. **Selection content ONLY — it never evidences that the model heard anything.**
> - **L4 DETERMINISTIC CAPTURE FEED (audio lifecycle only):** `dev-env.ps1 -Action Up -Spec 2903 -EnvVar
>   "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"`;
>   the fixture is **explicitly non-intelligible** (`generate-dictation-phrase.mjs:14-23`) — liveness,
>   never content. Always pair with an UNSET-env control (`.opencode/tests/voice-dictation/` F-3/F-4).
> - **L5 CI/unit pins (developer-executed, `CI rust-validate` + `pnpm --filter @fredo/ui test:run`).**
>   Cite the Architect's named identifiers verbatim in `## Tests Runs` (see F-113/F-119/F-123).
>
> **FORBIDDEN:** any recorded-speech WAV or out-of-repo asset — none exists under `C:\Code\fredo`;
> hunting for one is a documented failure mode (G-172/G-009). The acoustic leg is a NAMED BLOCKER.

- [ ] F-111 (REQ-1 / AC1): **Model-audio skill selection OPENS the window (L3 + L2).** Mode=`model`
      (`Fredo_companion_voice_handling`), managed server healthy; `stt_start{origin:"launcher"}` so the
      audio turn dispatches; while the model-audio turn is in flight (chip
      `launcher-command-model-processing-chip`), emit `llm-skill-call {skill:"open_app",
      arguments:{app:"Settings"}}` on the real channel.
  **Expected:** the Settings window ACTUALLY opens — `.fredo-window__surface[role="group"]` with
      `aria-label="Settings"` present and the kernel singleton id `settings`; the companion surface +
      `fredo-companion-live-region` carry exactly `Opening Settings`; the bar's model chip returns to
      rest; raw tool JSON (`open_app`/`arguments`) is never rendered; no transcript appears.
  - **Edge:** Settings already open → exactly ONE window (raised, not duplicated — `SettingsFeature`
    `isMultiWindow=false`); an injection before/after the turn's `llm-done` → the stale push is dropped
    (no stale reply, no second window); two injections → one window; a second app opened after Settings
    leaves both windows present.
  - **Receipt:** the emitted payload, the window-count delta, the reply string verbatim, the session id.
  - **FAIL:** a prose reply with no window (the reported bug), or a window with no deterministic reply.

- [ ] F-112 (REQ-1 / AC1): **The real control plane/CLI seam opens the window (L2).** Invoke
      `run_open_app_cli {identity:"settings"}`; separately run `fredo open-app settings` and confirm the
      `app-open-request` → `confirm_app_open_request` round trip.
  **Expected:** `run_open_app_cli` → `{exitCode:0, outcome:"opened"}` AND the Settings window opens;
      the CLI child round-trips through the SAME single kernel opener (`openFeatureWindow`).
  - **Edge:** `identity:"Narnia"` → `{exitCode:1, outcome:"unknown"}` + ZERO windows; a leading verb
    (`open Settings`) resolves; `identity:"monitor"` (ambiguous) → `{outcome:"ambiguous"}` + ZERO
    windows; managed server down → bounded 5 s confirm / 10 s child, never a hang.
  - **Receipt:** each result verbatim + the window-count delta.

- [ ] F-113 (REQ-1 / AC1, **executor: CI developer** — no `cargo` in the tester sandbox): **Root-cause
      pins for the audio→skill route (L5).** Assert the audio request body offers the SAME registry
      (`tools` = the `open_app` schema, `tool_choice:"auto"`, `parallel_tool_calls:false`) and that the
      audio stream routes a `tool_calls` finish through the SAME `plan_terminal_events` →
      `llm-skill-call`; assert the audio turn forwards an `onSkillCall` consumer.
  **Expected:** a named unit/integration pin exists for each; a malformed/rejected selection is
      fail-closed (readable `llm-error`, NO `llm-skill-call`, `llm-done` last); the audio body is the
      skill body modulo the audio part (ONE registry — no fork). Record the CI check result.
  - **Edge:** transport failure → `llm-error`+`llm-done`, never a hang; a `tool_calls` turn producing no
    call → typed error, never a phantom action.

- [ ] F-114 (REQ-1 / AC1): **NAMED BLOCKER — the acoustic end-to-end.** A genuinely spoken "open
      settings" through ASR → model → skill.
  **Expected:** **BLOCKED — not PASS, not FAIL.** No intelligible-speech asset exists under
      `C:\Code\fredo`: the committed `dictation-phrase-16k-mono.wav` is explicitly non-intelligible by
      its own provenance header, and the host has no physical mic (the only devices are the virtual
      `Iriun Webcam` / `Steam Streaming Microphone`). If the Architect requires this leg live, post a
      `block` naming the missing asset (a committed intelligible 16 kHz WAV, e.g.
      `.opencode/tests/voice-dictation/fixtures/open-settings-16k-mono.wav`); otherwise the residual is
      F-111 + F-112 + F-113.
  - **Edge / FAIL:** recording an L3 injection or the L4 feed as the acoustic PASS; hunting media
    outside the repo (`~`, `%USERPROFILE%`, `node_modules`, `C:\Windows\Media`, the STT model dir).

- [ ] F-115 (REQ-2 / AC2): **Model-audio skill selection CLOSES the window — ACTIVE (the PO amendment is
      APPROVED; 13 points, ST-3 retained).** Drive `close_app` (ONE shared registry, same `{ app }`
      shape) on the model-audio channel (F-111's lever) and on the typed/companion baseline. The close
      MECHANISM is `windowStore.closeWindow(id)` with the open-check via `getWindowSnapshot()`
      (`windowStore.ts:37,116-124`). The reply is deterministic, char-for-char (the ONE copy source
      `appOpenReply.ts`): close success `appCloseSuccessReply(displayName)` → `Closing {displayName}`;
      target NOT open `appCloseNotOpenReply(displayName)` → `{displayName} isn't open`;
      unrecognized/unsupported close REUSES `appOpenUnknownReply(spokenName)` → `I couldn't find
      "{spokenName}"`. **There is NO `appCloseFailedReply`** (G-198 — `closeWindow` is
      synchronous/idempotent/`void`, so no user-reachable close-failure path exists; do NOT assert one).
  **Expected:** `.fredo-window__surface[aria-label="Settings"]` count 1→0, the kernel entry absent from
      `getWindowSnapshot()`, and the reply EXACTLY the declared close string; the SAME request on both
      paths → the SAME outcome.
  - **Edge:** close an app that is NOT open → no action + exactly `Settings isn't open`; an unrecognized
    close name → zero actions + `I couldn't find "<spoken>"`; a minimized target; the last window; two
    closes → idempotent (`closeWindow` is re-entrancy-guarded — no double-remove, no console error);
    NEVER a `Closing …` claim when no window disappeared.
  - **Receipt:** the window-count delta via `getWindowSnapshot()` + the reply verbatim on BOTH paths.

- [ ] F-116 (REQ-2 / AC2): **Present-state audit — CONTEXT, not a scored row (the finding is CLOSED by the
      approved amendment).** Before the amendment no close capability existed on either path
      (`SkillRegistry::with_open_app()` was the sole registry — `infrastructure/companion/skills.rs:96`;
      `useAppOpenRequests` executed `open_app` only, `useAppOpenRequests.ts:158,193`; `normalizeAppQuery`
      stripped only `open/launch/show/start` — `appIdentity.ts:45`).
  **Expected:** the amendment adds `close_app` to the ONE shared registry (`infrastructure/companion/skills.rs`)
      + the ONE shared dispatch hook (`useAppOpenRequests`) via `windowStore.closeWindow` — no parallel
      action system. Assert the shipped state: `close_app` registered with the same `{ app }` shape; both
      paths dispatch through the ONE hook; no forked dispatcher/resolver. This row is NOT scored as a
      separate PASS/FAIL.
  - **Edge:** a `close_app` implementation that forks a second registry/hook or renames the declared names
    FAILs (G-187); the pre-amendment "no close" state must never be re-run as a PASS.

- [ ] F-117 (REQ-2 / AC2): **INACTIVE — PO-decline branch record (do NOT execute as an alternative required
      path; no third branch).** Retained only as the pre-amendment fallback note.
  **Expected:** INACTIVE — the approved amendment makes F-115 the required path. If the amendment were ever
      reverted, a close-sounding model-audio turn must run NO action and must not claim one.
  - **Edge:** do not score this row; it may never be used to soften or substitute for a failing F-115.

- [ ] F-118 (REQ-3 / AC3): **Parity matrix — model-audio vs typed/companion.** For each request record
      the window-count delta + the reply read char-for-char on BOTH paths: `Settings` (resolved open),
      `Settings` (resolved close), `Narnia` (unknown), a ≥2-match name (ambiguous), a re-request of an
      already-open app, a non-showable id, an unrecognized close name.
  **Expected:** the SAME supported-app set, the SAME window outcome, and a byte-identical reply on both
      paths: `Opening Settings` / `Closing Settings` / `Settings isn't open` / `I couldn't find "Narnia"` /
      `I found more than one app matching "<spoken>". Which one did you mean: A or B?` / `I couldn't open
      Settings. Try again from the launcher grid.` Enumerate the sets and assert equality — not wider,
      not narrower — for BOTH intents.
  - **Edge:** leading verb (`open settings`), quotes, case, kebab id `settings`; duplicate feature ids
    dedupe; a minimized target; an already-focused target.
  - **Receipt:** the per-request pair table (window delta + reply) for both paths.

- [ ] F-119 (REQ-3 / AC3): **The typed/companion path's WIRING and existing pins are UNCHANGED.** Re-run
      a live typed `open settings` + Enter; record the results of the existing `useAppOpenRequests` /
      `skillSettle` / `CompanionEntity.dispatch` pins.
  **Expected:** the window opens and the reply reads exactly as before #2903; the existing pins stay
      green with NO assertion weakened, disabled or deleted (G-125). The approved amendment makes the
      typed path GAIN the close intent through the SAME shared layer — that shared-layer increment is
      expected (it is what makes AC3 parity true by construction); a FORKED registry/resolver/dispatcher
      is a FAIL, and the new `close_app` declaration must not alter the shipped `open_app` declaration.
  - **Edge:** `llm_chat`/vision paths keep NO tools unless the Architect declares otherwise.

- [ ] F-120 (REQ-4 / AC4): **Outcome-accurate reply.** Drive success, unknown, CLI-failure, unavailable,
      close-success, close-not-open and unrecognized-close outcomes through the model-audio path; read
      the settled bubble + live region.
  **Expected:** each settle carries EXACTLY the deterministic string for its outcome: open success
      `Opening Settings`; close success `Closing Settings`; unknown (incl. unrecognized close)
      `I couldn't find "Narnia"`; close-not-open `Settings isn't open`; open failure `I couldn't open
      Settings. Try again from the launcher grid.`; unavailable the curated `modelAudioUnavailable`
      copy — never freeform prose, never raw tool JSON. The action text is never model-authored.
      **No close-failure string is asserted — none exists (G-198).**
  - **Edge:** the success/close `happy` beat vs the idle hold is observable (close-not-open settles idle,
    never happy); a raw IPC string surfaced verbatim is a FAIL.

- [ ] F-121 (REQ-4 / AC4): **Prose-vs-action honesty.** Where the model streams prose before selecting
      the skill, the deterministic reply REPLACES it.
  **Expected:** the settled bubble never ends with "I can certainly open settings for you." when a
      window opened — and never when none opened; no claim of an action without the corresponding
      window mutation; no window mutation without a reply. This is the exact reported bug class
      (performed → told performed; not performed → does not claim success).
  - **Edge:** prose and NO selection → no window + no success claim; a watchdog settle after a dropped
    reply; a late final after `llm-done`.
  - **Receipt:** the streamed prose (if any) + the settled reply + the window delta.

- [ ] F-122 (REQ-5 / AC5): **Unsupported/unrecognized app name performs nothing and says so.** Emit
      `llm-skill-call {skill:"open_app", arguments:{app:"Narnia"}}`; separately
      `{skill:"close_app", arguments:{app:"Narnia"}}`; and type `Narnia` + Enter.
  **Expected:** ZERO windows — assert the PRESENT app grid + the window count are UNCHANGED (G-170,
      never by hiding the grid) — and the user is told exactly `I couldn't find "Narnia"` (the
      unresolved name echoed verbatim) for BOTH intents; no false success.
  - **Edge:** blank/whitespace app; a name matching zero addressable features; an app that exists but is
    not `showable`; a close request for an app that is not open (→ `Settings isn't open`, not the
    unknown copy).

- [ ] F-123 (REQ-5 / AC5): **Fail-closed on a malformed/rejected selection.** Inject an unknown skill
      name, a missing/blank `app`, and non-object arguments on the real channel; plus the CI pin.
  **Expected:** ZERO windows + a readable `llm-error`; the user is told nothing was executed;
      `llm-skill-call` is NEVER emitted for an invalid selection (`skills.rs:249-286`); `llm-done` is
      always last (never a hang). Record the CI check result for the unit pin.
  - **Edge:** a transport error mid-stream; a tool-call turn with no call; `arguments` absent.

- [ ] F-124 (NFR-1): **All-local under the new route.** Static-scan `infrastructure/voice/**` +
      `features/llm_server/**` for `reqwest/ureq/hyper/TcpStream/UdpSocket/std::net/websocket`; read the
      managed host + the turn URL; watch for new outbound connections during a model-audio turn.
  **Expected:** ZERO remote clients on the audio→text→model path; the managed host is `127.0.0.1` and
      the turn URL targets loopback; the fix adds NO remote client; audio/transcripts never leave the
      machine. The live process-scoped outbound block is a NAMED BLOCKER (no elevation lever) recorded
      ALONGSIDE the static pin — never as a substitute.
  - **Edge:** a block mid-session must not crash; a new cloud/fallback branch FAILs.

- [ ] F-125 (NFR-2 + LIVE): **No model-audio responsiveness regression + live receipts.** Re-run
      F-104 (the `capturing→processing→settled` state machine clearing on `llm-done`) and the #2897
      F-109 rows on the #2903 tip; sample the press→capture and reply-settle timings; `fredo emit`
      marker rows + `telemetry_spans` via the telemetry-query skill; upload every capture with
      `upload-evidence --issue 2903`.
  **Expected:** the model-audio chip states, the limit notice and the reply-settle timing are unchanged
      (within the #2897 envelope); console clean of `Error:`/`Uncaught`/`Maximum update depth
      exceeded`; no new polling/effect loop (AGENTS.md #523); `telemetry_spans` returns a NON-ZERO count
      with a recent `max(ingested_at)` and the literal token appears in Evidence; every capture
      uploaded with a raw URL + description. **A static-only PASS is a FALSE PASS.**
  - **Edge:** the L4 feed is non-intelligible (liveness only); every number carries its lever + clock
    domain (G-171); a stale round's receipt does not clear the round-aware guard.

- [ ] F-126 (REQ-4 / AC4, R-4.3): **No-selection negative leg (the residual the deterministic-copy
      override cannot cover).** Make an explicit open/close-shaped request in a model-audio turn that
      yields NO `open_app`/`close_app` selection — deliberately DO NOT fire the L3 lever.
  **Expected:** ZERO windows and a settled reply that does NOT claim the action (the generation settles
      on the model's own prose, or the watchdog — never a fabricated skill reply); no `llm-skill-call`
      is observed on the channel; the model-audio chip settles normally.
  - **Edge:** prose that merely *mentions* opening/closing; a selection arriving on a LATER turn; the
    turn settling via `llm-error`; the L4 feed present with no selection. Reference UI/UX's residual
    note (`.opencode/tests/companion/exploratory.md` ~line 320).
  - **Receipt:** the channel observation (zero `llm-skill-call`) + the settled reply + the window delta.

### #2903 testing round 1 — result (`spec/2903 @ 813b0060`, 2026-09-20, live)

**Verdict PASS** — 30 PASS / 0 FAIL / 2 BLOCKED (R-1.4 acoustic; NFR-1 live outbound block) / 3 named UNVERIFIED (voice-dictation E-5; E-61; E-64). Full report: `## Tests Runs (round 1)` on #2903.

- **F-111 PASS (live, L3 + DOM).** Live model-audio turn (console `runGeneration called — … withSkills: true withAudio: true`), emitted `{open_app,{app:"Settings"}}` → live region + bubble `Opening Settings` at t≈1161 ms; `.fredo-window__surface[role="group"][aria-label="Settings"]` appeared at t≈1932 ms (labels `[]`→`["Settings"]`). Screenshot `f111-open-settings.jpeg`.
- **F-112 PASS (live, L2).** `run_open_app_cli {identity:"settings"}` → `{exitCode:0, outcome:"opened"}` + window; `Narnia` → `{exitCode:1, outcome:"unknown"}` + zero windows; `s` → `{exitCode:1, outcome:"ambiguous"}`; `fredo open-app settings` → `{displayName:"Settings", outcome:"opened"}`.
- **F-113 PASS (CI, pins cited verbatim).** `rust-validate` PASS (16m52s) + the named Rust/TS pins (see R-1.3 in `## Tests Runs`).
- **F-114 BLOCKED (named).** No intelligible in-repo WAV + no physical mic; missing asset named; residual = F-111+F-112+F-113.
- **F-115 PASS (live).** Live turn + `{close_app,{app:"Settings"}}` → window `["Settings"]`→`[]`, live `Closing Settings`. Close-not-open → `Settings isn't open`, zero windows. No `appCloseFailedReply` exists.
- **F-116 CONTEXT (not scored).** `close_app` in the ONE registry + the ONE hook; no forked dispatcher.
- **F-117 INACTIVE (not scored).**
- **F-118 PASS (live).** open/close/unknown/ambiguous/not-open produce the SAME outcome + byte-identical replies on both paths.
- **F-119 PASS (live).** Typed `open settings`+Enter → real model selected `open_app` → window + `Opening Settings`; `close settings`+Enter → `Closing Settings`. `pnpm --filter @fredo/ui test:run` 107 files / 1745 tests / 0 failed.
- **F-120 PASS (live).** `Opening Settings` / `Closing Settings` / `Settings isn't open` / `I couldn't find "Narnia"` / ambiguous copy / blank-app `I couldn't find ""` — all char-for-char; no raw JSON.
- **F-121 PASS (live, with disclosure).** The settled bubble is the deterministic reply (prose replaced). Synthetic-lever artifact: the un-terminated stream's later tokens can append (see E-62); the REAL `finish_reason:"tool_calls"` path stops before any post-settle token.
- **F-122 PASS (live).** `open_app Narnia` + `close_app Narnia` → ZERO windows, `I couldn't find "Narnia"`, app grid present (G-170). Screenshot `f122-unknown-narnia.jpeg`.
- **F-123 PASS (live + CI).** blank app → `I couldn't find ""`, zero windows; non-app skill ignored; fail-closed CI pins green.
- **F-124 PASS (static).** `infrastructure/voice/**` zero network symbols; `features/llm_server/**` loopback only.
- **F-125 PASS (live receipts).** `telemetry_spans` 16,401 rows, newest `2026-09-20T02:00:18.633Z`; chip clears on `llm-done`; console clean. Live outbound block BLOCKED (no lever).
- **F-126 PASS (live).** No-selection turn → zero `llm-skill-call`, window set unchanged, model prose settle.

---

## #2904 extension — mode-parity clean render of the dictation indicator

> Issue #2904 fixes a stray vertically-stacked `Fredo…` string in the launcher search bar while
> dictating. The mode-specific copy is `voice-input` territory: mode=`local` → the shipped
> `Listening` chip (`launcher-command-listening-chip`) + `Listening…` placeholder + `release Space to
> finish` hint chip (UNCHANGED); mode=`model` → the `Fredo is listening` chip
> (`launcher-command-model-listening-chip`) is the sole listening claim and the hint chip is suppressed
> (the instruction relocates into the `release Space to finish` placeholder) [AC2 resolution = Architect
> contract, see `.opencode/tmp/2904/triage.md`]. Both must render HORIZONTALLY and be the ONLY listening-related text. The launcher
> `functional.md` F-101..F-107 owns the render matrix; this row owns the MODE PARITY. **Verification
> policy: live.** No row is retired.

- [ ] F-127 (REQ-4 / AC4): **Mode parity — both speech-handling modes render the indicator on ONE
      line, with no stray/stacked text and no overlap.** For mode=`local` then mode=`model`
      (`companion-voice-handling-select`; the mode applies to the NEXT session), focus the empty
      `[data-testid="launcher-command-input"]` and drive a live launcher-origin capture (the
      `FREDO_STT_FEED_WAV` in-repo feed, or the synthetic `stt:state
      {listening:true, phase:"capturing", origin:"launcher"}` fallback). Per mode, run the
      `launcher/functional.md` `#2904` **Shared probe** + screenshot; enumerate every visible text
      node matching `/listening|Fredo/i` and its line count; repeat with a LIGHT preset
      (`light-default` via the shipped `select[aria-label="Theme presets"]`) and the DARK base.
  **Expected:** in EACH mode — exactly ONE visible listening indicator with `whiteSpace:nowrap` and
      line count = 1; the copy (`Listening` + `Listening…` + `release Space to finish` hint in local;
      `Fredo is listening` chip + `release Space to finish` placeholder, hint chip suppressed, in model
      — the #2904 AC2 relocation); ZERO `verticalWrap`/`narrow` node and
      an empty `overlapField`; **`fieldContentW ≥ 140`** (model mode — the decisive collapse signal,
      since the placeholder is not in `textContent`); the field renders cleanly. In EACH theme —
      identical geometry, token-native colours. The `processing` window renders
      `Fredo is processing your speech…` on ONE line (model only).
  - **Edge:** a mid-capture mode switch is OUT of scope (the mode is read per `stt_start`) — the
    parity leg is run across two sessions; the countdown copy `Fredo is listening · 10s left`; a
    non-empty query present; the managed server unavailable → the model leg is a NAMED BLOCKER
    (G-053) + the synthetic-`stt:state` receipt, never a real-audio PASS.
  - **Receipt:** per mode/theme — the probe JSON + the quoted indicator copy + the screenshot +
    `telemetry_spans` (the live-policy receipt).
