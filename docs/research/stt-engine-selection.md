# Local-First Streaming STT Engine Selection — Superseded Spike Record

> **Issue:** #2876 — `[Spike] Select a local-first streaming STT engine and prove live transcription in Fredo`.
> **Sub-task:** ST-1 of the #2876 Implementation Plan (`## Triage Plan`).
> **Status: SUPERSEDED (Spec #2914).** The whole decision in this document was reverted: **#2914 removed the `sherpa-onnx` on-device engine, its model manifest and resident engine, the STT model download/setup surface, and the `local` transcription mode.** There is exactly ONE speech path today — the captured clip is understood by the locally-managed multimodal model as an `input_audio` content part over loopback (see [`model-audio-feasibility.md`](model-audio-feasibility.md)). Nothing below describes shipped behaviour: there is no `sherpa-onnx` dependency, no `SHERPA_ONNX_LIB_DIR`, no STT model to download, and no `stt:transcript` event. The text is retained verbatim as the spike's historical record.
> **Also superseded earlier (Spec #2882, 2026-09-16):** #2882 retired the **contextual Ctrl+Space / 3-priority cascade** (§5.1), the Ctrl+Space constraints that followed from it (§5.2, §6's Ctrl+Space rows) and the two-surface transcript routing sketched in §3.1 — see the banner in §5.1.
> **Scope:** engine + capture path + provisioning path for the **English**, **local-first**, **streaming** use case on **Windows x64** with **Tauri v2** / **WebView2**.
> **Citation convention:** every external claim carries a URL; every in-repo claim carries `path:line` (spot-verified against the `spec/2876` tip).

---

## 0. The decision, in one line

**sherpa-onnx** 1.13.8 (`OnlineRecognizer`, streaming Zipformer EN int8, statically linked Windows x64) as the engine, **native `cpal` capture in Fredo's Rust** (no `getUserMedia`), provisioned through the **existing streamed model download + SHA-256 verify engine** (`download_missing_files`) behind a new **non-gating** `sttModel` step in `COMPANION_SETUP_STEPS`. The strongest rejected alternative is **Moonshine**, which lost on **Rust-binding maturity and packaging — not on merit**.

---

## 1. Candidate comparison (AC1)

### 1.1 Comparison matrix

Eight criteria (the AC1 list): offline/local-first, streaming partials, latency, model size/RAM, license, Windows x64, Rust/Tauri v2 integration cost, project health.

| Candidate | Offline / local-first | Streaming partials | Latency | Model size / RAM | License (engine / model) | Windows x64 | Rust/Tauri v2 integration cost | Project health |
|---|---|---|---|---|---|---|---|---|
| **sherpa-onnx** (Rust `OnlineRecognizer`) | ✅ onnxruntime, **no Internet** at decode | ✅ native `create_stream` / `decode` / `get_result` / `is_endpoint` | Streaming transducer emits a partial per decode step; number is **measured on this host by the POC** against the pinned budget p50 ≤ 300 ms / p95 ≤ 600 ms (R-2.2) | int8 EN set **72,654,782 B** (69.28 MiB); RAM measured by POC | Apache-2.0 / Apache-2.0 | ✅ prebuilt static-MSVC win-x64 lib | **1st-party crate in the engine repo**; ~70 MiB static native lib; build-time archive fetch | 14.7k ★, releases every few weeks (1.13.8 on 2026-09-11) |
| **Moonshine** (via `moonshine-rs`) | ✅ | ⚠️ documented in the crate README, listed as *not done* in the repo README | ~69 ms on Linux x86 vs whisper-tiny's ~1,141 ms | tiny-en ≈71 MB / 34M params | MIT OR Apache-2.0 / MIT (English) | ⚠️ prebuilt path dynamically linked (`onnxruntime.dll` next to the exe) | 3rd-party 0.x wrapper; needs Tauri bundle resources for the DLL | 275 total downloads, 13 releases in ~1 month, single maintainer; streaming status contradictory |
| **whisper.cpp** (`whisper-rs`) | ✅ | ❌ batch-only `WhisperState::full(params, &audio)` | Not natively streaming; the canonical real-time example steps 500 ms chunks (`--step 500`) | tiny 75 MiB → large 2.9 GiB | Unlicense (public domain) | ✅ | very mature bindings, but streaming needs a third-party VAD/LocalAgreement wrapper | 817,798 downloads; GitHub repo archived → moved to Codeberg |
| **Vosk** (`vosk` crate) | ✅ | ✅ streaming by design | Streaming by design (single-pass partials); no latency figure independently re-measured for this spike | `vosk-model-small-en-us-0.15` = 40 MB | Apache-2.0 / Apache-2.0 | ✅ (ships libvosk) | thin 361-line 3rd-party wrapper; ships a shared lib | crate **last published 2024-10-27** (stale); WER 9.85 vs zipformer-class |
| **Windows WinRT `SpeechRecognizer`** | ✅ (with a speech language pack) | ⚠️ `HypothesisGenerated` fragments, not a stable incremental transcript | Hypothesis fragments arrive during speech; guidance is to display as processing meanwhile | uses the OS model | OS API | ✅ (Windows-only) | heavy WinRT/WinSDK interop; OS-version + language-pack dependency | OS-maintained |
| **Web Speech API in WebView2** | ❌ Chrome impl is cloud-backed; Edge's is a no-op | ❌ | n/a — no results are ever returned in WebView2 | n/a | n/a | ⚠️ | trivial to call, impossible to satisfy local-only | Edge ships a do-nothing implementation |

### 1.2 Per-cell citations

- **sherpa-onnx** — decode-without-Internet (repo description, `api.github.com/repos/k2-fsa/sherpa-onnx`); `OnlineRecognizer::create` / `create_stream` / `decode` / `get_result` / `is_endpoint` (`docs.rs/sherpa-onnx/latest/sherpa_onnx/struct.OnlineRecognizer.html`); official `cpal` mic example (`rust-api-examples/examples/streaming_zipformer_microphone.rs`); prebuilt `sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib.tar.bz2` auto-fetched by `sherpa-onnx-sys/build.rs` (`rust-api-examples/for-advanced-users.md`); Windows x64 ✔ + Tauri prebuilt demos (docs.rs crate page); crate 1.13.8 Apache-2.0 + `default = ["static"]` (crates.io API `/crates/sherpa-onnx/1.13.8`); repo Apache-2.0, 14,718 ★, pushed 2026-09-14 (GitHub API); model files/sizes/SHA-256 (HuggingFace API `csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26?blobs=true`); model license `apache-2.0` (same API `tags`/`cardData`); archive 296.0 MB (GitHub release tag `asr-models`). *The latency cell is deliberately not an external figure: it is the POC's measured p50/p95 on this host (ST-3, R-2.2), reported against the plan's pinned budget; if unmeasurable it is reported as such per R-2.3, never as an adjective.*
- **Moonshine** — streaming model table + MIT English (`moonshine-voice.readthedocs.io/en/stable/models/available-models/`); tiny-en ≈71 MB (`ghchinoy/moonshine-rs` README); `TranscriberStream` / `OwnedTranscriberStream` and `stream.poll(false)` (crates.io readme `moonshine-rs/0.2.6`); ~69 ms vs whisper-tiny ~1,141 ms (Moonshine streaming-concepts docs); **contradiction** — the repo README's feature-status table lists "⏳ Real-time streaming API — tracked in the project issue tracker" while the published crate README documents it; Windows prebuilt = `moonshine.lib` + `onnxruntime.dll` (repo README platform table); crate 0.2.6, 275 downloads, 13 versions from 2026-07-25 (crates.io API).
- **whisper.cpp** — `WhisperState::full` batch API (docs.rs/whisper-rs; crate README example); real-time example default `--step 500` (https://github.com/ggml-org/whisper.cpp#real-time-audio-input-example); Unlicense; 817,798 downloads; repo archived on GitHub → Codeberg (`github.com/tazz4843/whisper-rs`); Windows-CPU-slowness + model sizes carried from the shared research entry (`docs/agentic-pipeline/playbooks/references.md:41`, not independently re-measured here).
- **Vosk** — models + sizes + licenses (`alphacephei.com/vosk/models`); `vosk-api` Apache-2.0 (`github.com/alphacep/vosk-api`); crate 0.3.1, last published 2024-10-27, 361 LOC (crates.io API).
- **WinRT** — `HypothesisGenerated` semantics and the "display as processing meanwhile" guidance (`learn.microsoft.com/windows/uwp/ui-input/enable-continuous-dictation`); "for PCs and laptops, only en-US is recognized" (same page); class surface (`learn.microsoft.com/uwp/api/windows.media.speechrecognition.speechrecognizer`).
- **Web Speech API** — "Edge does not actually support the SpeechRecognition Web Speech API … the implementation does nothing. No results are ever returned." (`mdn/browser-compat-data` issue #22126).

---

## 2. Binding recommendation (AC1 — exactly ONE)

### 2.1 The decision

| Layer | Binding choice |
|---|---|
| **Engine** | `sherpa-onnx` **1.13.8** Rust crate, `OnlineRecognizer` (streaming transducer), `provider = "cpu"`, `enable_endpoint = true`, `decoding_method = "greedy_search"` |
| **Model** | `sherpa-onnx-streaming-zipformer-en-2023-06-26`, **int8** set — 4 files, **72,654,782 bytes** total (manifest in §4) |
| **Capture** | native **`cpal`** input stream in Fredo's Rust (WASAPI on Windows) → mono-mix + resample to 16 kHz → 100 ms chunks → the recognizer |
| **Provisioning** | reuse `download_missing_files` (`apps/tauri/src-tauri/src/features/setup/model_download.rs:569`) + its streaming SHA-256 verify (`:376-385`) with a NEW `STT_DEFAULT_MANIFEST`, surfaced as a new **non-gating** `sttModel` step in `COMPANION_SETUP_STEPS` under Companion settings |

### 2.2 Strongest rejected alternative — Moonshine, and exactly why it lost

**Moonshine** (via a Rust binding) is the strongest rejected alternative. It genuinely **wins on raw latency and model size** — Tiny Streaming 34M / ≈71 MB, MIT for English, published figures of **~69 ms on Linux x86 vs whisper-tiny's ~1,141 ms** (Moonshine streaming-concepts docs) — and it is architecturally streaming-first.

**It lost on integration maturity and packaging, not on merit:**

1. **Rust-binding maturity.** The only Rust path is a third-party `0.x` crate — **275 total downloads, 13 releases in five weeks, a single maintainer** (crates.io API). Its published README documents a streaming API (`TranscriberStream`, `stream.poll(false)`), while its **own repository's feature-status table lists real-time streaming as not yet done** ("⏳ Real-time streaming API — tracked in the project issue tracker"). That unresolved contradiction cannot be settled without building it, which is not a foundation a binding engine decision can rest on.
2. **Packaging contradiction.** Its Windows prebuilt path is **dynamically linked** (`onnxruntime.dll` beside the exe), which would require new Tauri bundle-resource wiring — `apps/tauri/src-tauri/tauri.conf.json:53-54` currently declares `externalBin: []` and `resources: {}`, i.e. **no bundling slot exists for a sidecar/DLL today**.

sherpa-onnx instead offers a **first-party crate maintained in the engine's own repository**, **static Windows x64 prebuilds** (no runtime DLL to ship), and a **14.7k-★ project shipping every few weeks**. For a binding engine choice, the first-party path wins.

### 2.3 Rejected alternatives (one line each)

- **whisper.cpp / `whisper-rs`** — loses on the *core* requirement: it is **not natively streaming** (`WhisperState::full` is batch), and streaming requires bolting on a third-party VAD/LocalAgreement wrapper; the upstream repo also moved off GitHub to Codeberg.
- **Vosk (`vosk` crate)** — loses on **wrapper staleness** (crate last published 2024-10-27) and ships a **shared `libvosk`**, with lower accuracy (WER 9.85) than the zipformer class.
- **Windows WinRT `SpeechRecognizer`** — loses on **hypothesis semantics** (`HypothesisGenerated` fragments are not a stable incremental transcript) plus **OS-version and language-pack coupling** and heavy WinRT/WinSDK interop.
- **Web Speech API in WebView2** — loses **outright on the local-only HARD NFR**: the Chrome implementation is cloud-backed and Edge's is a no-op that returns no results.

### 2.4 Documented fallback model (NOT part of the binding recommendation)

`sherpa-onnx-streaming-zipformer-en-20M-2023-02-17` int8 — **43,649,301 bytes** (≈41.6 MiB): encoder `42,845,182 B` sha `3810755ce7c3ab26b42a8bcf39d191308fa27fb0f53358823ba46141d03b7eb3`, decoder `539,499 B` sha `21e2a2ac…`, joiner `259,572 B` sha `e085d73b…`, tokens `5,048 B`.

Switch to it **only if** the measured latency or RAM budgets in §5.2 are missed on this host. The trigger and the swap are a **one-constant change in the manifest**, not a design change.

---

## 3. Capture + integration path (AC4a)

### 3.1 Concrete PCM data flow — native, in Rust

```
mic
  → WASAPI input stream (cpal::default_host().default_input_device())
  → mono-mix (average channels) + linear resample → 16 000 Hz f32
  → 100 ms chunks (3 200 f32 samples)
  → std::sync::mpsc channel
  → recognition loop: accept_waveform → is_ready/decode → get_result / is_endpoint / reset
  → SttUpdate { text, isFinal, segmentId, latencyMs }
  → app.emit("stt:transcript", …)                      [CONTROL PLANE]
  → useVoiceDictation (DYNAMIC import of '@tauri-apps/api/event')
  → LauncherShell writes committed + partial into the EXISTING controlled `query`
    via handleQueryChange (apps/ui/src/features/home/components/launcher/LauncherShell.tsx:421)
  → LauncherCommandBar renders the live partial in its native Input role="searchbox"
    (apps/ui/src/features/home/components/launcher/LauncherCommandBar.tsx:240)
  → Enter then takes the EXISTING smart-Enter path (LauncherShell.tsx:469-500).
```

There is **no webview audio** anywhere in this path: no `getUserMedia`, no `MediaRecorder`, no `AudioContext`, no CSP change, no WebView2 COM permission handler.

### 3.2 Tauri commands (registered in `lib.rs` alongside the existing set)

```rust
// ── infrastructure/voice/state.rs — IPC wire types (camelCase; serde rename_all)
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SttErrorCode {
    NoDevice, PermissionDenied, ModelMissing, ModelCorrupt,
    EngineStartFailed, AlreadyListening, Disabled, Internal,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttStartResult {
    pub started: bool,
    pub code: Option<SttErrorCode>,
    pub detail: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,   // the DEVICE rate; the engine is fed 16_000 Hz
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttTranscriptEvent {
    pub session_id: String,
    pub revision: u64,     // monotonic per session; partials strictly increase
    pub segment_id: u32,   // increments on each endpoint
    pub text: String,      // CUMULATIVE text of the CURRENT segment
    pub is_final: bool,    // true on endpoint (segment closed)
    pub latency_ms: u64,   // last accept_waveform → this emit (monotonic)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttStateEvent {
    pub listening: bool,
    pub code: Option<SttErrorCode>,
    pub detail: Option<String>,
    pub origin: Option<String>, // "launcher" | "companion"
}

#[tauri::command] pub fn stt_check_model(app: AppHandle) -> SttModelStatus;              // per-file state, size-gated
#[tauri::command] pub fn stt_start(app: AppHandle, origin: String) -> SttStartResult;    // never panics; typed code on every failure
#[tauri::command] pub fn stt_stop(app: AppHandle) -> SttStateEvent;                      // commit final
#[tauri::command] pub fn stt_cancel(app: AppHandle) -> SttStateEvent;                    // discard current partial
#[tauri::command] pub fn stt_status(app: AppHandle) -> SttStateEvent;
// features/setup/commands.rs (reuses the streamed engine — do NOT duplicate it)
#[tauri::command] pub async fn download_stt_model(app: AppHandle) -> ModelDownloadResult;
```

### 3.3 Tauri events — CONTROL PLANE (`AppHandle::emit`, never `EventBus`)

```rust
// Precedent: features/setup/commands.rs:1013  `self.app.emit("setup:download-progress", &progress)`
// "stt:transcript"           → SttTranscriptEvent
// "stt:state"                → SttStateEvent
// "setup:download-progress"  → existing DownloadProgress wire,
//                              fileId ∈ { sttTokens, sttEncoder, sttDecoder, sttJoiner }
```

These are **control-plane events** (precedent `apps/tauri/src-tauri/src/features/setup/commands.rs:1013`). They do **not** go through `EventBus` / `emit_row_delivery_batch` (that channel carries RTDB rows only) and no `useEventRows` subscription is involved.

### 3.4 Webview `getUserMedia` path — considered and REJECTED

The alternative captured microphone audio in the WebView2 renderer via `getUserMedia`/`MediaRecorder`. It was rejected for three concrete reasons:

1. **It cannot satisfy the local-only HARD NFR on its own** — the recognizer must run in Rust anyway, so a webview capture path adds a transport hop and buys nothing.
2. **It needs a CSP widening.** `apps/tauri/src-tauri/tauri.conf.json:25-27` sets `default-src 'self'; …` with **no `media-src`**; any webview capture requires editing the CSP.
3. **It needs a WebView2 COM permission handler.** WebView2 silently denies `getUserMedia` unless a Rust-side COM `PermissionRequested` handler sets `COREWEBVIEW2_PERMISSION_KIND_MICROPHONE` (`COREWEBVIEW2_PERMISSION_STATE_ALLOW`) via `with_webview` (tauri-apps/tauri#4434 thread; precedent commit `cinny-desktop 838c69f4`). Tauri's first-party `on_permission_request` hook is an **open PR** (tauri-apps/tauri PR #14865, dependent on unreleased `wry#1654`) — so today this path costs new `webview2-com` + `windows` COM dependencies in Fredo's Rust *and* a CSP widening.

Native `cpal` capture needs **no capability change**: `apps/tauri/src-tauri/capabilities/default.json:6-19` grants window labels `["main","run-cli-terminal"]` and there is no audio permission to add for a native WASAPI stream.

### 3.5 Frontend consumer contract (POC)

```ts
// ── apps/ui/src/shared/hooks/useVoiceDictation.ts (new)
export interface VoiceDictation {
  listening: boolean;
  committed: string;            // finalized segments of this session, space-joined
  partial: string;              // current segment, cumulative
  liveText: string;             // `${committed}${committed && partial ? ' ' : ''}${partial}`
  errorCode: string | null;     // SttErrorCode
  origin: 'launcher' | 'companion' | null;
  start(origin: 'launcher' | 'companion'): Promise<void>;
  stop(): Promise<void>;        // commit
  cancel(): Promise<void>;
}
// Subscribes to "stt:transcript" / "stt:state" via a DYNAMIC import of
// '@tauri-apps/api/event' guarded by IS_TAURI (AGENTS.md: never a static import).
```

```ts
// ── Extended frontend wire vocab (ADDITIVE — existing ids never change)
export type ModelFileId =
  | 'model' | 'vision' | 'mtp'
  | 'sttTokens' | 'sttEncoder' | 'sttDecoder' | 'sttJoiner';   // companionReadiness.ts:54
export type PrerequisiteId =
  | 'llamaServer' | 'modelFiles' | 'serverLaunch' | 'sttModel'; // companionReadiness.ts:10
// New persisted preference (same pattern as CompanionContext.tsx:219-229):
//   key 'Fredo_companion_voice_enabled', boolean, DEFAULT false (opt-in / privacy-first)
```

---

## 4. Provisioning path (AC4b)

### 4.1 Model manifest — 4 files, 72,654,782 bytes total

New constant in `infrastructure/voice/manifest.rs`, reusing the **existing** `ModelFileSpec` / `ModelManifest` (`apps/tauri/src-tauri/src/infrastructure/companion/models.rs:63-98`):

```rust
pub const STT_SUBDIR: &str   = "sherpa-onnx-streaming-zipformer-en-2023-06-26";
pub const STT_REVISION: &str = "672fbf1b30579d6585301139bb363f42a0ad4a24"; // HF repo sha
// URL form: https://huggingface.co/csukuangfj/<STT_SUBDIR>/resolve/<STT_REVISION>/<path>
// Layout:   <models_dir>/<STT_SUBDIR>/<path>   (models_dir = resolve_models_dir(), models.rs:319-335)
```

| `id` | `path` | URL | `expectedBytes` | `sha256` |
|---|---|---|---|---|
| `sttTokens` | `tokens.txt` | `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/672fbf1b30579d6585301139bb363f42a0ad4a24/tokens.txt` | 5,048 | pinned by ST-0 (see note) |
| `sttEncoder` | `encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/672fbf1b30579d6585301139bb363f42a0ad4a24/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | 71,083,163 | `563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1` |
| `sttDecoder` | `decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/672fbf1b30579d6585301139bb363f42a0ad4a24/decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | 1,307,236 | `98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02` |
| `sttJoiner` | `joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/672fbf1b30579d6585301139bb363f42a0ad4a24/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | 259,335 | `d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297` |
| **TOTAL** | | | **72,654,782** (69.28 MiB) | |

> **`tokens.txt` SHA-256 note.** `tokens.txt` is a **plain git blob, not LFS**, so the HuggingFace API exposes no SHA-256 for it (the three `.onnx` values above are LFS SHA-256s from the HF API). Its SHA-256 is computed and pinned by **ST-0** (`.opencode/tmp/2876/st-0-verification.md`, the Phase-0 live-verification gate, G-128) before ST-2 consumes it. `expectedBytes = 5,048` is API-derived and pinned here.
>
> **Engine config (verified field names).** `model_config.transducer.{encoder, decoder, joiner}`, `model_config.tokens`, `model_config.provider = "cpu"`, and `OnlineRecognizerConfig { enable_endpoint: true, decoding_method: "greedy_search" }`. ST-0 confirms the endpoint-config field names for the 1.5–2.0 s trailing-silence target.

### 4.2 Reuse point — do NOT reinvent the download/verify engine

- `download_missing_files` — `apps/tauri/src-tauri/src/features/setup/model_download.rs:569` (per-file error isolation).
- Streaming SHA-256 verify — `apps/tauri/src-tauri/src/features/setup/model_download.rs:376-385` (mismatch ⇒ delete + `Fatal`).
- `acquire_file` — `:421-564` (skip-present-by-size, HTTP `Range` resume, bounded 5-attempt retry).
- Presence probe — `classify_file` exact-size `Present` gate, `apps/tauri/src-tauri/src/infrastructure/companion/models.rs:222-237`.
- Progress channel — `download_model` + `AppHandleProgressReporter` → `app.emit("setup:download-progress", …)`, `apps/tauri/src-tauri/src/features/setup/commands.rs:1006-1042`.
- Manifest resolution — `resolve_manifest` (`models.rs:340-355`), `resolve_models_dir` fallback `{home}/fredo-models` (`models.rs:319-335`).

`download_stt_model` delegates to `download_missing_files` with `STT_DEFAULT_MANIFEST`; it does **not** duplicate resume/retry/verify logic. `DEFAULT_MANIFEST` / `MODEL_SUBDIR` / `MODEL_REVISION` and the companion GGUF layout are **untouched**.

### 4.3 Where it is surfaced — Companion settings, explicitly NON-GATING

- The step is registered in `COMPANION_SETUP_STEPS` (`apps/ui/src/shared/components/companion/companionSetupSteps.ts:36-79`) as a new `sttModel` entry with a `download_stt_model` action, and rendered by `CompanionSetupWizard` as an **explicitly optional group excluded from the wizard's `installed/total` summary**.
- The enable/disable toggle lives inside **Companion settings** (`CompanionSettingsPanel`, `apps/ui/src/features/settings-app/components/SettingsSurface.tsx:111-124` renders the Companion section) — **no new nav item and no dedicated Voice section**.
- **Non-gating invariant:** installing the STT model must never be a precondition for companion chat. `CompanionReadiness.ready` keeps **exactly today's inputs** — `settled && backendReadiness.ready && serverState === 'healthy'` (`apps/ui/src/shared/components/companion/useCompanionReadiness.ts:523`). The not-ready gate (`CompanionSettingsPanel.tsx:94-133`) keeps rendering the wizard only, with the voice row additive.

---

## 5. Binding PO contract the recommendation must satisfy

### 5.1 Context-dependent Ctrl+Space model (3 priorities)

> **SUPERSEDED by Spec #2882 — the text below is preserved verbatim as the spike's history; do not implement against it.**
>
> The 3-priority cascade below and **every bullet in this §5.1** (together with §5.2's Ctrl+Space constraint and §6's Ctrl+Space rows) described the #2823/#2877/#2878 model. Since **#2882** the shipped behaviour is:
> - **Ctrl+Space only brings the launcher search bar to the front and focuses it** — it never starts or stops listening, never closes the bar, and the #2823 non-launcher-text-control pass-through carve-out is retained. **No keyboard gesture starts a companion-origin session**; that path and its listening bubble are retired.
> - **Dictation is hold-Space in the focused, empty launcher search bar**: listening runs only while Space is held, and release finalizes the recognized words into the bar as ordinary editable text. A sub-threshold tap (or a Space in a non-empty query, or with voice disabled / its model not installed) is an ordinary space — no capture and no error.
> - **A finalized transcript is always Fredo's** and never runs the app-open rule, even after the user edits it.

```text
document keydown, exact Ctrl+Space (#2823 matcher, LauncherShell.tsx:562)
  1. if (isTextControl(active) && !activeInLauncher) return;      // #2823 AC3 carve-out, UNCHANGED
  2. e.preventDefault(); e.stopPropagation();                     // only when we act (AC4 preserved)
  3. if (companionActive && companionAway) { startListening('companion'); return; }   // PO case 1 — NO bar focus
  4. if (activeInLauncher) { if (!listening) startListening('launcher'); else cancelListening(); return; } // case 2
  5. openOverlay();                                               // case 3 — today's #2823 behavior; does NOT start listening
```

- **Close gesture moves to Escape.** Escape (`LauncherShell.tsx:431-454`) cancels an active session FIRST; otherwise it keeps today's exact behavior (shortcut-open → `closeOverlay()` with `previousFocusRef` restore `:244-259`; non-shortcut → idle-collapse with the suppressed refocus `:441-452`).
- **Rapid double-press ⇒ one open + one listen.** Press 1 = step 5 (open, rAF focus); press 2 = step 4 (bar now focused) ⇒ `startListening`, idempotent. **Ctrl+Space NEVER closes the launcher.**
- **Focus-origin restore is untouched.** `previousFocusRef` is captured only in `openOverlay()` (`:226`) and restored only in `closeOverlay()` (`:247-257`). A launcher-origin session keeps focus in the bar throughout; a companion-origin session (case 1) touches no focus at all.
- **Ordering decided:** the carve-out runs before the case cascade — a focused non-launcher text control suppresses the chord in all three cases (this preserves the #2823 guard against hijacking unrelated in-app inputs; flagged for #2877 PO confirmation if case 1 should override — a one-line change).
- **IMPLEMENTATION CONSTRAINT (regression hazard).** The listener is mounted ONCE (`LauncherShell.tsx:595`) and never re-registered, so `companionActive` / `companionAway` / `listening` MUST be read from **refs** (mirroring `openRef` `:185`), never from captured closure state — otherwise the handler sees stale values forever.
- **In-window, not OS-global.** The chord stays the existing in-window `document` listener; `tauri-plugin-global-shortcut` is **rejected** (OS-wide Ctrl+Space is claimed by Windows IMEs and editors, is hostile for a focused-input feature, and adds a capability surface + plugin dep for zero AC gain). Stated limitation: dictation cannot *start* while Fredo is unfocused — accepted for the spike; #2877 may revisit an opt-in OS-wide trigger if a PO AC ever requires it.

### 5.2 Hard constraints

- **LOCAL-ONLY is a HARD NFR — no cloud fallback, ever.** The decode path is a statically-linked native library reading a local model directory; the only network-touching component is *model acquisition*. Evidence = transcription with networking unavailable.
- **STT-only.** No TTS/voice output, no voice-command/intent routing. Any final-text-triggered action/command execution is out of scope.
- **Autosend is owned by #2877.** The spike assumes **autosend OFF**: on stop/finalize the transcript stays in the input for review and is NOT auto-submitted (R-4.8).
- **No dedicated Voice settings section.** The control lives under Companion settings; the model step lives in the Companion setup wizard's registry.
- **Voice is opt-in:** `Fredo_companion_voice_enabled`, boolean, **DEFAULT false** (`usePersistedSetting` pattern, `CompanionContext.tsx:219-229`). WHEN voice input is disabled, Ctrl+Space SHALL NOT start listening. *(Superseded by #2882: Ctrl+Space never starts listening in any state — see the §5.1 banner. Dictation is hold-Space in the empty, focused launcher search bar.)*
- **Budgets (measured on this host, R-2.2/R-2.3):** model on disk = **72,654,782 bytes** (69.28 MiB) exactly; partial-update latency **p50 ≤ 300 ms and p95 ≤ 600 ms**. **Superseded by Spec #2887 — the engine is resident, not lazy:** the recognizer is loaded **once per process at setup** while voice input is enabled, retained for the process lifetime, and released on the voice-disabled edge (`stt_release`). It is engine-only, so it opens no device and starts no capture. The **steady-state** budget replaces the #2876 transient load delta: `RESIDENT_RSS_DELTA_MAX_MB` = **350 MB** (engine resident and idle) and `T_RESIDENT_IDLE_CPU_PCT_MAX` = **1 %** of one core over a **60 s** window. The #2887 latency constants are: `T_FIRST_CAPTURE_BUDGET_MS` p50 **250 ms** / p95 **300 ms** / max **320 ms** (keydown → capture-live, engine resident); `T_COLD_MAX_MS` **320 ms** (cold-idle, engine resident); `T_COLD_WARM_DELTA_MAX_MS` **50 ms**; `T_LAUNCH_WARM_MS` ≤ **5000 ms**; `T_LAUNCH_WINDOW_MS` ≤ **3500 ms** (retained, unsummed: the window in which a hold JOINS the in-flight setup warm); `T_LAUNCH_COLD_MAX_MS` **5320 ms** = `T_LAUNCH_WARM_MS.max` + `T_FIRST_CAPTURE_BUDGET_MS.max` (5000 + 320 — ONE model load plus the capture budget, for a hold taken while the engine is not resident; the physical residual, because capture cannot begin before the model is loaded); `T_MAX_STARTING_STATE_MS` **1000 ms**. If a metric is not measurable on this host, the artifact/tests state the metric and the reason explicitly — never an adjective.
- **English-only** for this spike; non-English models are out of scope.
- **Build hygiene (G-147):** `cargo check --locked`, `cargo test --locked`, `cargo clippy --locked -- -D warnings` (zero warnings), `pnpm --filter @fredo/ui build`, and the shipped Tauri webview build must all be green with the POC merged. Every POC file carries a `// SPIKE #2876 — THROWAWAY POC` header.

---

## 6. Failure-mode handling (AC5) — typed code + no crash

Every failure is a **typed `SttErrorCode`** returned by `stt_start` (and mirrored on `stt:state`); the app remains responsive and **no path panics** (R-5.6: no `unwrap()`, `expect()`, or `panic!` on the capture, engine, or failure paths).

| Failure mode | Trigger | Result | Recommended handling / surface |
|---|---|---|---|
| **Mic permission denied** | OS mic-privacy denies the app; native `cpal`/WASAPI device open fails with a permission error | `{ started:false, code:"permissionDenied" }` | Point at Companion settings / OS microphone privacy; app stays responsive (R-5.3) |
| **No input device** | `cpal::default_host().default_input_device() == None` | `{ started:false, code:"noDevice" }` | Informational copy; app stays responsive (R-5.2) |
| **Missing model** | `stt_check_model` reports file(s) absent | `{ started:false, code:"modelMissing" }` | Point at the Companion settings `sttModel` step (download); app stays responsive (R-5.4) |
| **Corrupt / oversize model** | size gate mismatch, or streamed SHA-256 mismatch ⇒ delete + `Fatal` (`model_download.rs:376-385`) | `{ started:false, code:"modelCorrupt" }` | Point at the `sttModel` step to re-download; app stays responsive (R-5.4) |
| **Engine start failure** | `OnlineRecognizer::create() == None` | `{ started:false, code:"engineStartFailed" }` | Report the code; app stays responsive (R-5.5) |
| **Already listening** | second `stt_start` while active | `{ started:false, code:"AlreadyListening" }` | Idempotent; no double session (contract) |
| **Voice disabled** | `Fredo_companion_voice_enabled === false` | `{ started:false, code:"Disabled" }` | Ctrl+Space does not start listening (R-5.7) — still true after #2882; dictation is hold-Space in the empty, focused launcher search bar (see the §5.1 banner) |

Device loss mid-session is also covered by the same contract: the session transitions to an error `stt:state` with a typed code and never panics. Every mode is exercised sequentially in one session; recovery between them is required (no silent hang, no unhandled `Error:`/`Uncaught`).

---

## 7. Licenses (permissive, redistribution-safe)

| Component | License | Primary source |
|---|---|---|
| **sherpa-onnx engine** (crate + native lib) | **Apache-2.0** | https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE ; crates.io API `/crates/sherpa-onnx/1.13.8` (`license = "Apache-2.0"`, `default = ["static"]`) |
| **STT model** (`sherpa-onnx-streaming-zipformer-en-2023-06-26`) | **Apache-2.0** | HuggingFace API `csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26?blobs=true` (`cardData`/`tags` = `apache-2.0`) |
| **`cpal` capture crate** | **Apache-2.0** | https://github.com/RustAudio/cpal (Apache-2.0); repo 3,932 ★, pushed 2026-09-11 (GitHub API `RustAudio/cpal`) |

Note for completeness: the rejected Moonshine path uses **MIT (English models)** / **MIT OR Apache-2.0 (crate)** — permissive, but it was rejected for the integration reasons in §2.2, not licensing. The engine and the model carry **separate** licenses; both are verified permissive here.

---

## 8. What #2877 / #2878 inherit

- `docs/research/stt-engine-selection.md` (this file) is the **committed** artifact on `spec/2876` that AC1 is verified against; the path is pinned in the plan's Deployment Notes.
- **Superseded by #2914:** the build-time native dependency (`sherpa-onnx-sys` fetching the prebuilt Windows x64 archive unless `SHERPA_ONNX_LIB_DIR` points at a local lib) is **gone** — no `sherpa-onnx` dependency remains and a default `cargo build` needs no `SHERPA_ONNX_LIB_DIR`. The paragraph above records what #2877/#2878 originally inherited, not a current requirement.
- The POC itself is **throwaway** and is expected to be replaced by #2877/#2878. The durable outputs of the spike are this document and the hermetic session pins (ST-6).
