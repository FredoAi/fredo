# Companion Embedded Engine — Functional

> Durable functional suite for the **in-process companion inference runtime** (`llama-cpp-4`)
> introduced by Spec #3141. One `- [ ]` case per requirement; rows map 1:1 to the QA Plan
> `R-17 … R-29` in `.opencode/tmp/3141/triage.md` `## QA Expert`.
>
> **Verification policy: live.** The ACs are runtime behaviours (a real generation, a streamed
> event sequence, a reported backend, an isolation check) plus a few static/absence legs.
> **Static/absence legs (R-17.2's "never from PATH/winget/a configured path", R-17.3's "no
> `llama-server` process", R-28 doc absence, R-29 notices presence, R-19.2/19.3 context config,
> R-22.2's no-log-parse, R-24.1's closed enum) are verified by Read/Grep on the committed
> tree/artifact** — each such row says so. Every other row is LIVE.
>
> **E-SPAN reality (read this before hunting for spans):** this feature emits **no OTLP producer
> of its own**. The live-policy receipt for #3141 is the **LIVE WEBVIEW receipt** — a
> `tauri_webview_dom_snapshot` / `tauri_webview_find_element` / `tauri_webview_screenshot` /
> `tauri_webview_execute_js` result, or a live `get_llama_server_status` result rendered in the
> webview — **not** a `telemetry_spans` query. A `telemetry_spans` query proves the pipeline is
> alive, not this feature; it is neither required nor sufficient here.
>
> **No out-of-repo asset (G-172).** The three GGUFs are acquired by the product's OWN download
> engine after its real readiness path; they are never committed. Rows that need weights say so
> and bind to the product's readiness path (`check_companion_readiness` → `download_model`).
>
> **Serving checkout:** `spec/3141` on a running Fredo desktop app (MCP driver `com.fredo.app`),
> or a `dev-env.ps1 -Action Up -Spec 3141` env. Record the tested SHA per round.

## Named in-repo levers (G-275 / G-300 / G-409)

| Lever | Status | Used by |
|---|---|---|
| `FREDO_COMPANION_FORCE_CPU` (env, inert by default) — forces the engine's typed device set to **CPU-only** | **NEW — must be ST-1's Work item** (constant + unit pin + inert-unset control). Mirrors `FREDO_COMPANION_FORCE_NOT_INSTALLED` (`applications/setup/commands.rs:1064`) / `FREDO_PG_FORCE_START_FAIL` (`pg_supervisor/mod.rs:183`) | F-10, F-11, F-12, F-13b, F-14, F-15, F-16 |
| `FREDO_COMPANION_FORCE_NOT_INSTALLED=1` — post-#3141 (ST-6) rewritten to force **`modelFiles` `Missing` only** | existing env, rewritten behaviour | F-3, F-13 (absent-control control leg), F-13b, and `fredo-health-led` F-15 |
| `save_setting` / `get_setting` seams: `llama_server_backend`, `llama_server_path`, `models_dir`, `model_manifest_path` | existing IPC control plane | F-3, F-4, F-13, F-14, F-15 |
| `stop_llama_server` / `launch_llama_server` (IPC names preserved) | existing commands | F-14, F-15, F-16 |
| `capture_screen_region` (xcap monitor capture) → `llm_chat_with_image` | shipped product image producer/consumer | F-8 |
| `FREDO_STT_FEED_WAV` = `.opencode/tests/voice-dictation/fixtures/dictation-phrase-16k-mono.wav` (16 kHz mono 16-bit PCM, **explicitly non-intelligible**) | committed fixture (confirmed present) | F-9 |
| Model files moved aside under the resolved `models_dir` | filesystem lever on the product's own path | F-16 |
| `.opencode/scripts/run-exitcode.ps1 -Command "..."` | committed wrapper (no shell chaining in the sandbox) | F-21 |

---

## R-17 — everything ships in the single installer; a fresh offline machine reaches ready

- [ ] **F-1 (R-17.1/R-17.3, LIVE).** On a fresh install with **no network**, no pre-existing
      llama.cpp, no winget package and no `llama_server_path`: open Settings → Companion, read
      `check_companion_readiness`, then acquire the model files through the product's own
      `Download model files` action and send a chat turn.
  - **Expected:** `prerequisites` contains **exactly one** entry, id `modelFiles` (no
    `llamaServer` id anywhere in the payload); `ready:false` before the download and `ready:true`
    after it; **no second installer / download-tool / toolchain affordance is offered** (the
    wizard renders no `companion-step-llama-server` card and no `Install llama.cpp` action); the
    chat turn streams `llm-token` deltas and settles with exactly one `llm-done`.
  - **Edge:** model files partially present → `modelFiles` `missing`, never ready; the offline
    machine must not attempt any acquisition if the files are already present.
- [ ] **F-2 (R-17.2/R-17.3, STATIC + one live process probe).** (a) Read `tauri.conf.json`
      `bundle.externalBin`; grep the production Rust tree for a spawn of a `llama-server`
      executable, for the deleted `resolve_llama_server`/`find_on_path`/`winget_links_shim`
      symbols, and for any runtime read of `llama_server_path`; (b) independently of the app,
      list the OS process table and probe `127.0.0.1:8080` **before**, **mid-stream** and
      **after** the F-1 chat turn.
  - **Expected:** `externalBin` is `[]`; **zero spawn sites** for a `llama-server` image in
    production Rust; **zero** live references to the resolver symbols / to
    `LLAMA_SERVER_PATH_KEY` on any runtime-resolution path; no `llama-server` process appears in
    the process table at any of the three samples and nothing LISTENs on the loopback port the
    old server used. *(G-430: this is a scoped "zero spawn sites / zero resolution reads", not a
    repo-wide literal zero — the token legitimately remains in docs, notices and the sys-crate
    build script.)*
  - **Edge:** the static scan must cover `apps/tauri/src-tauri/src/**` **and** `tauri.conf.json`;
    a comment mentioning `llama-server` is not a spawn site.
- [ ] **F-3 (R-17.4, LIVE + STATIC).** Persist `llama_server_path` = an existing unrelated
      executable via `save_setting`, relaunch, start the companion, complete a chat turn, then
      re-read the setting; and statically confirm the key is **not** in the runtime-resolution
      path and **not** in `SENSITIVE_PATH_SETTING_KEYS`.
  - **Expected:** the engine starts and answers from the manifest-resolved in-process runtime;
    `get_setting('llama_server_path')` still returns the exact persisted value (never deleted,
    never rewritten); `SENSITIVE_PATH_SETTING_KEYS` is length **3** and does not contain the key;
    no code path reads it for resolution.
  - **Edge:** a *stale/never-existing* path is equally inert; an empty/whitespace value does not
    crash; the value survives `stop_llama_server` + `launch_llama_server`.

- [ ] **F-27 (R-17.5, STATIC — the ARTIFACT payload; added by Spec #3158).** The engine ships as DLLs
      **beside `fredo.exe` inside the installer**, not only as cargo build output. Read
      `apps/tauri/src-tauri/tauri.conf.json`'s `bundle.resources`; then run the committed artifact
      gate through the wrapper:
      `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/verify-installer-payload.ps1 -Installer '<the produced 0.2.0 NSIS setup.exe>'"`;
      then enumerate the extracted install root with
      `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "Get-ChildItem -LiteralPath '<extracted root>' -File"`.
  - **Expected:** `bundle.resources` is exactly `{"engine-payload/": ""}` (a **map**, destination the
    empty string, **no `*`**) while `bundle.externalBin` **stays `[]`** — F-2's assertion above is
    retained **byte-identical** and is unaffected, because resources are not sidecar binaries. The
    gate prints `ARTIFACT=<path> sha256=<hex> bytes=<n>`, one `PAYLOAD_PRESENT=<name>` line for
    **each of the 8 core payload names** (`ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`,
    `ggml-vulkan.dll`, `llama.dll`, `llama-common.dll`, `mtmd.dll`, `vulkan-1.dll`), `RESULT=PASS`
    and `EXITCODE=0`. The install-root listing shows those 8 files **plus `fredo.exe`** (and
    `uninstall.exe` on a silent-install route), every one with a non-zero `Length`;
    `ggml-cuda.dll` and `fredo_lib.dll` are **ABSENT**.
  - **Where the rest of it lives:** the complete artifact verification is the durable suite
    `.opencode/tests/companion-artifact-payload/` — run its `functional.md` **F-1..F-28**
    (`A1-0`..`E-5`), `regression.md` **R-1..R-7**, `smoke.md` **S-1..S-7**, `exploratory.md`
    **E-1..E-10**. This row is the embedded-engine suite's pointer to it, not a replacement.
  - **Edge:** `bundle.resources` as a **glob** (`engine-payload/*`) ⇒ **FAIL** (`GlobPathNotFound`
    on a pristine/shared-target tree, `tauri-utils` `resources.rs:234-245`). `externalBin` changed to
    carry the DLLs ⇒ **FAIL** — that would invert F-2; the payload is resources, never sidecars. A
    payload file with `Length == 0` ⇒ **FAIL**. No installer obtainable this round ⇒ **NOT RUN** with
    the named blocker (producer = local build, else a `workflow_dispatch` run of `release.yml` —
    **never** a build log), not a FAIL.

## R-18 — the pinned model set is byte-identical

- [ ] **F-4 (R-18.1/R-18.2, STATIC + LIVE).** Read `infrastructure/companion/models.rs`'s
      compiled `DEFAULT_MANIFEST`; then read the live file set the engine loads.
  - **Expected:** exactly **three** specs — `model` =
    `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf` / **2,620,370,976**, `vision` = `mmproj-BF16.gguf` /
    **986,833,728**, `mtp` = `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf` / **59,235,648** — under
    revision `66a399f68ddd113b06dff02fca9523e55465d11d`, subdir `gemma-4-e2b-it-qat`; the live
    `check_model_files` reports all three `present` with `downloadedBytes == expectedBytes` equal
    to those pins and `relativePath` equal to those strings; the engine's loaded `model` /
    `mmproj` / `mtp` paths equal `file_path(models_dir, manifest, spec)` for those three specs.
  - **Edge:** a fourth file appears in the manifest, or any name/size/revision differs ⇒ FAIL;
    a renamed on-disk file the engine still resolves through a *different* path rule ⇒ FAIL.
    *(Byte-identity beyond size is pinned by the manifest's committed SHA-256, verified by the
    product's own `acquire_file` at download time; a per-launch re-hash is not a product
    behaviour — see the Discussion note.)*

## R-19 — MTP speculative decoding still works, from the separate draft GGUF

- [ ] **F-5 (R-19.1, LIVE).** Complete one live generation on a fully ready companion and read
      the MTP counters from Fredo's own loop surfaced on the status/log projection.
  - **Expected:** `draftsProposed > 0` **AND** `draftsAccepted > 0` from **Fredo's loop**
    (`MtpStats`), `n_draft_max == 2`, and the counters are **not** parsed from a log line
    (`print_stats()` output is log-only and is never the source).
  - **Edge:** a migration that drops speculative decoding shows `draftsProposed == 0` ⇒ **FAIL**
    (never an acceptable "no drafts this turn"); a short reply that proposes nothing ⇒ repeat
    with a longer prompt, never a PASS.
- [ ] **F-6 (R-19.2/R-19.3, STATIC).** Read `engine/mtp.rs` construction: context types,
      `n_rs_seq`, `n_draft_max`, and the draft model's path source.
  - **Expected:** the draft context is constructed with `LlamaContextType::Mtp`; `n_rs_seq >=
    n_draft_max` (= 2 — the plan's margin is `n_rs_seq = 4`); the draft `LlamaModel` is loaded
    from the manifest `mtp` spec (`MTP/mtp-gemma-4-E2B-it-Q4_0.gguf`), **never** a literal path
    or a settings override; `with_load_mtp(true)` is set.
  - **Edge:** a hardcoded `"MTP/…"` string instead of the manifest spec ⇒ FAIL (R-18.2 path
    rule); `n_rs_seq < 2` ⇒ FAIL.
- [ ] **F-7 (R-19.4/R-19.5, LIVE + CI-bound).** (a) Drive the ST-4 forced-rejection leg; (b)
      drive the typed-failure leg; (c) static Read that no non-speculative fallback branch
      exists.
  - **Expected:** after a rejected draft the **both** contexts are rolled back to the last
    accepted position and generation continues to a normal `llm-done`; a failed
    `MtpSession` construction produces the typed `MtpInitFailed` (never a silent
    non-speculative continue, never a raw library string as the primary copy).
  - **Edge:** the forced-rejection leg is **ST-4's committed artifact** (its `Work` item — the
    tester owns the row, the developer owns the test); where the tester's shell has no `cargo`,
    the record is the green CI `rust-validate` run on the tested PR head SHA **plus** the
    non-draft `## Developer ST-4 — verification` comment. Never a fabricated PASS.

## R-20 — vision still works through the projector

- [ ] **F-8 (R-20.1, LIVE).** Capture a real region of the running app whose visible text is
      known (e.g. the Settings → Companion heading) with `capture_screen_region`, then run the
      shipped image turn (`llm_chat_with_image`) with that base64.
  - **Expected:** the turn streams a reply that **reflects the captured content** (names the
    visible heading/text), the projector is the manifest `vision` file (`mmproj-BF16.gguf`)
    loaded through `mtmd`, and the turn settles with exactly one `llm-done`.
  - **Edge:** TicTacToe's image move still places a legal O (shipped consumer, cross-ref
    `regression.md` R-10); a reply that ignores the image ⇒ FAIL; an `mmproj` missing ⇒ typed
    `MmprojInitFailed`, never a text-only silent fallback.

## R-21 — audio still works

- [ ] **F-9 (R-21.1, LIVE mechanism + NAMED BLOCKER for acoustics).** Feed the committed
      non-intelligible WAV through the shipped voice path (`FREDO_STT_FEED_WAV` →
      `stt_start`/`stt_take_audio_clip` → the model-audio turn) and read the built turn's
      content parts + the event stream.
  - **Expected (mechanism, verifiable):** the turn carries **exactly one** `input_audio` content
    part (`format: "wav"`, base64 WAV bytes) and **no** fabricated transcript/text part; audio is
    handled by `mtmd` (`MtmdBitmap::from_*` + `tokenize_from_parts`); the turn streams a reply
    and settles with exactly one `llm-done`, no `llm-error`.
  - **Acoustic-intelligibility clause: NAMED BLOCKER (G-393).** The committed fixture
    (`dictation-phrase-16k-mono.wav`) is explicitly non-intelligible, so "the reply reflects the
    spoken words" is **not** assertable here — record it as a named blocker, never a FAIL. An
    UNSET-env control proves the feed is what produced the turn.
  - **Edge:** a second `input_audio` part, a text transcript part, or a `format` other than
    `"wav"` ⇒ FAIL; Doom-Mode active ⇒ the shipped suppression refusal (`disabled`) still emits
    one `llm-done` (cross-ref F-16 and `regression.md` R-10).

## R-22 — CUDA is the default backend; the loaded backend comes from ggml's enumeration

- [ ] **F-10 (R-22.1/R-22.2, LIVE discriminator + STATIC).** With **no** `llama_server_backend`
      persisted, start the engine **twice**: once plainly, once with `FREDO_COMPANION_FORCE_CPU=1`
      (paired unset control). Read `get_llama_server_status.backend` + `devices[]`.
  - **Expected:** no persisted setting ⇒ `backendMode:"auto"` and full-offload requested
    (`with_n_gpu_layers(u32::MAX)`); under the force-CPU seam the engine still starts and reports
    `backend:"cpu"` with a CPU-typed device — **while the requested mode was `auto` (full
    offload)**. That mismatch is the discriminator: a value echoed from the setting, or parsed
    from a log line, could not report `Cpu` for an `auto`/full-offload request.
  - Statically confirm the reported backend is built from `LlamaModel::devices()` /
    `LlamaBackendDeviceType` and that **no** engine path parses a log line or `print_stats()` for
    the backend.
  - **Edge:** `devices` empty before a model load is expected (`n_devices()` returns 0 until
    load) — the row reads devices only **after** load; the *physical CUDA presence* clause
    (`auto` on a real GPU reports a non-CPU name) is a **NAMED ENVIRONMENTAL BLOCKER** on a host
    without a CUDA GPU — record it as such, never a FAIL (the seam-proven typed-enumeration leg
    still passes).
- [ ] **F-11 (R-22.3, LIVE wire + rendered).** Read the serialized `get_llama_server_status`
      payload and the rendered `companion-backend-readout`.
  - **Expected (G-413, serialized payload — producer side):** the payload carries `backend`,
    `backendMode`, `devices[]` (`name`/`description`/`deviceType`/`memoryFreeBytes`/
    `memoryTotalBytes`), `lastErrorCode`, `modelId`; an **explicit present case** (engine loaded:
    `backend` and `modelId` present) and an **explicit absent-key case** (engine not started:
    the optional keys are ABSENT, never `null`); `port`/`pid` carry no live value; the
    `CompanionBackendKind` values are the camelCase wire names. The readout renders the reported
    backend + device names (text, not colour-only).
  - **Expected (consumer side):** the real wire value feeds `companionReadiness.ts`'s declared
    type and the readout renders it verbatim — a TS type that declares a field the Rust struct
    does not emit (or vice versa) FAILs.
  - **Edge:** a JSON `null` where the plan says absent-key ⇒ FAIL (NFR-9); a stale cached value
    after `stop_llama_server` ⇒ FAIL.

## R-23 — a machine with no usable GPU still reaches ready on CPU

- [ ] **F-12 (R-23.1/R-23.2, LIVE via seam).** With `FREDO_COMPANION_FORCE_CPU=1` and the mode
      left at `auto` (default), start the engine and serve a full chat turn; read the readout.
  - **Expected:** the launch does **not** fail; the engine initialises, a chat turn streams and
    settles once; `backend:"cpu"`; the UI **never claims a GPU backend** — the readout's backend
    *kind* is `CPU` (`data-backend="cpu"` and the kind word `CPU`), and no GPU-**claim** is
    rendered (no `GPU`/`CUDA` as a backend kind, nothing in the tooltip asserting a GPU backend).
    **ggml's real enumerated device NAME / description MAY appear** (`Vulkan0`, `NVIDIA GeForce
    RTX 3060`, …): the plan's UI/UX §2.6 composition rule requires surfacing the device the engine
    actually loaded, so the device identity is truthful hardware reporting, not a backend claim.
    *(Reconciled round 6 of #3141 — the previous wording banned the literal token `Vulkan`, which
    contradicted §2.6 and would fail a truthful readout. The assertion is narrowed to the AC's
    actual observable: "the UI SHALL NOT claim a GPU backend" while `backend:"cpu"`.)* Paired
    unset control: the lever removed restores the host's natural backend.
  - **Edge:** the *physical GPU-less host* leg is a **NAMED ENVIRONMENTAL BLOCKER** if the test
    host has a GPU — the seam proves the mapping/render, disclose that it is seam-proven.
    A readout that says "GPU" while `backend:"cpu"` ⇒ FAIL.

## R-24 — the backend switch persists and takes effect on the next launch

- [ ] **F-13 (R-24.1, LIVE UI + persist + STATIC enum).** In Settings → Companion (ready
      state), select each of `auto` / `gpu` / `cpu` via `data-testid="companion-backend-mode"`;
      read the persisted setting; then inject a free-form value via
      `save_setting('llama_server_backend', 'bogus')` and restart.
  - **Expected:** the control is a **segmented radiogroup (Chakra v3 `SegmentGroup` / Ark)** —
    **not** a `<select>` and **not** `NativeSelect`; the group root carries
    `data-testid="companion-backend-mode"`, its item `value`s are exactly `auto`, `gpu`, `cpu`,
    its `aria-label` is "Companion backend", and it points at `companion-backend-mode-help` via
    `aria-describedby` (plus the second description target `companion-backend-mode-error` for the
    save-error line — accepted in the Architect's C-1 names block);
    each selection persists under `llama_server_backend` and survives a restart; a free-form
    persisted value is coerced to `auto` on read (`backendMode:"auto"` in the status) and
    **never reaches engine configuration**.
  - **Edge:** each of `"GPU"`/`" cpu "`/`""`/a JSON value → coerced `auto`, no crash; the help
    text names what each mode does.
  - **Edge — reachability boundary (RE-KEYED to the UI/UX Expert §2.5 resolution; AC-25 depends
    on it).** The control **IS present and operable in the not-ready state whenever the
    `modelFiles` prerequisite is `installed`** — the engine group renders immediately **below**
    the `CompanionSetupWizard`, because `isReady` requires `serverLaunch.state === 'healthy'` and
    that is `false` in AC-25's `gpuUnavailable` case (so a gate-only control would be unreachable
    exactly when the user must recover). **Assert it** (see F-13b). The control is **absent only
    when model files are missing** (the pre-download screen holds exactly one decision:
    download). Absent-with-files-installed ⇒ FAIL; present-with-files-missing ⇒ FAIL.
- [ ] **F-13b (R-24.1b, LIVE — AC-25 recovery reachability).** With the model files `installed`,
      `FREDO_COMPANION_FORCE_CPU=1` and `llama_server_backend="gpu"`: restart, `launch_llama_server`
      (fails typed), then read the DOM **without leaving Settings → Companion**.
  - **Expected:** with model files installed and `gpu` unsatisfiable,
    `data-testid="companion-backend-mode"` is **PRESENT** and enabled (not `aria-busy`, not
    `disabled`), showing `gpu` selected; the `companion-engine-error` row
    (`data-engine-code="gpuUnavailable"` — accepted additive attribute on the failure row) and the mode control are **in the same view**, with the
    control one `Shift+Tab` from the focused error group. Switching the group to `cpu` (or
    `auto`) and pressing `Start companion engine` succeeds (`success:true`) — F-15's R-25.3
    recovery leg is then driven end-to-end through the UI.
  - **Typed-code fallback when the force-CPU seam is UNSET (documented, not a weakened
    assertion).** This row's *reachability* observable — the mode control is present, enabled,
    and co-located with a typed engine-failure row, and recovery through it succeeds — is
    independent of WHICH typed failure produced that state. When `FREDO_COMPANION_FORCE_CPU` is
    **unset** in the served env the `gpuUnavailable` code is structurally unproducible (no
    CPU-only forced enumeration exists to refuse), so the reachability leg is driven with any
    OTHER real, typed start failure the env can produce (e.g. `mtpInitFailed` via the
    `model_manifest_path` override, or `modelMissing`), and the row records:
    (a) the typed code actually rendered in `data-engine-code`, (b) the seam's state read from
    the live process environment, and (c) the `gpuUnavailable`-specific leg as covered by the
    committed CI pins (`gpu_mode_refuses_when_the_forced_enumeration_is_cpu_only`,
    `gpu_mode_refuses_a_forced_cpu_enumeration`) — never claimed as driven live. The
    `gpuUnavailable` code specifically is only required when the seam is ACTIVE.
  - **Edge:** control present but disabled ⇒ FAIL (recovery unreachable); control reachable only
    after the engine becomes healthy ⇒ **FAIL — circular** (the dead end this row exists to
    prevent). Seam-proven, not physically GPU-less: disclose.
- [ ] **F-14 (R-24.2/R-24.3, LIVE + CI-bound).** Persist `cpu`, restart, `stop_llama_server` +
      `launch_llama_server`, read the status; repeat for `auto` and `gpu`.
  - **Expected:** `cpu` requests **zero GPU offload**; `auto` and `gpu` request **full** offload
    (the mode→`with_n_gpu_layers` mapping); the reported backend matches the selected mode
    **whenever that mode is satisfiable** (`cpu` ⇒ `Cpu` on any host; `auto`/`gpu` ⇒ non-CPU
    only on a GPU host).
  - **Edge (pre-authorized split):** the cpu-vs-full **offload-request** discriminator is proven
    by ST-1's committed rust test that constructs the engine twice (full-offload and
    zero-offload) — its record is the green CI `rust-validate` run on the tested head SHA plus
    the non-draft `## Developer ST-1 — verification` comment. The `auto`/`gpu` ⇒ non-CPU
    *reported backend* leg needs a CUDA host — **NAMED ENVIRONMENTAL BLOCKER**, never a FAIL.
    On a non-GPU host `cpu` and `auto` both report Cpu; that is not a FAIL and is not evidence
    for the offload request.

## R-25 — `gpu` mode fails typed and loud with no usable GPU

- [ ] **F-15 (R-25.1/R-25.2/R-25.3, LIVE via seam).** With `FREDO_COMPANION_FORCE_CPU=1` and
      `llama_server_backend="gpu"`: restart, `launch_llama_server`, read the result + the
      rendered error surface + the persisted setting; then switch to `auto` and `cpu` and
      relaunch.
  - **Expected:** the start returns the **typed** `GpuUnavailable` code (`code:"gpuUnavailable"`,
    `success:false`) — **not** a silent CPU degradation and **not** a generic error string —
    surfaced through `data-testid="companion-engine-error"` with the code-specific copy; the
    persisted `llama_server_backend` is **still `"gpu"`** (never overwritten); switching to
    `auto` or `cpu` and relaunching succeeds (`success:true`). The switch must be reachable
    **in the not-ready `gpuUnavailable` state** when model files are installed — F-13b drives
    that path; "recovery only after the engine is healthy" is a FAIL (circular).
  - **Edge:** the *physical* GPU-less host leg is a **NAMED ENVIRONMENTAL BLOCKER** where the
    seam stands in (disclose seam-proven); an error surface that shows a raw library string as
    the primary copy ⇒ FAIL; a launch that hangs instead of returning ⇒ FAIL (NFR-3 bounded).

## R-26 — the frontend event contract is byte-compatible; every path settles with one `llm-done`

- [ ] **F-16 (R-26.1/R-26.2, LIVE).** Attach a listener to the four channels **before** each
      turn (the shipped listeners already register before the invoke), then drive every
      terminating path and record the ordered event stream: success, early stop
      (`stop_llama_server` mid-stream), engine error (a model file moved aside ⇒ typed
      `ModelMissing`), mode refusal (F-15), vision (F-8), audio (F-9), tool/skill turn (F-17).
  - **Expected:** exactly **one** `llm-done` per path and it is **last**; `llm-token` payload is
    a string, `llm-done` empty, `llm-error` a string, `llm-status` a string — names and payload
    shapes unchanged; no path hangs (each either settles or returns a typed failure within the
    engine's bounded budget).
  - **Edge:** a path that emits two `llm-done`, none, or anything after `llm-done` ⇒ FAIL; an
    early stop that leaves the reply surface "streaming" forever ⇒ FAIL. The mechanical 7-path
    count is **ST-3's committed terminal-settle artifact** (its `Work` item); where the tester
    cannot run `cargo`, the record is the green CI run on the tested head SHA.
- [ ] **F-17 (R-26.3, LIVE + STATIC).** Send a prompt that selects a real shipped skill (e.g.
      the companion open-app skill) on the ready engine; capture the stream; statically Read the
      single-call contract.
  - **Expected:** `tools` + `tool_choice` are honoured, a single tool call is selected
    (`parallel_tool_calls:false` semantics enforced by the terminal plan — it has no header),
    **raw tool-call JSON is never forwarded as `llm-token`**, and `llm-skill-call` is emitted
    **only** for a validated selection (`{skill, arguments}` shape unchanged).
  - **Edge:** an invalid/unavailable skill ⇒ no `llm-skill-call`, one terminal `llm-done`;
    cross-ref `.opencode/tests/companion-audio-skill-parity/` F-1/F-2 (offer parity + exactly
    one skill-call) — parity is unchanged and must not be weakened.
- [ ] **F-18 (R-26.4, LIVE + CI-bound).** Drive a schema-constrained turn (the shipped Doom
      decision body already uses `response_format: json_schema`), read the reply stream.
  - **Expected:** generation is constrained to the supplied schema and the turn rides the
    **same** event contract (no new channel); the reply text is extracted by the shipped
    `ReplyEnvelopeExtractor`, so **no raw JSON envelope** reaches `llm-token`.
  - **Edge:** an extra key in the object is rejected by the grammar (ST-2's committed schema
    test — its record is the green CI run); a raw `{"reply":…}` envelope in `llm-token` ⇒ FAIL.

## R-27 — per-environment isolation still holds

- [ ] **F-19 (R-27.1/R-27.2, LIVE).** Start two isolated envs, each with its own
      `FREDO_LLAMA_SERVER_COMPANION_DIR` and its own `llama_server_backend` — e.g. A `cpu`,
      B `auto`; start each env's engine; read each env's own `get_llama_server_status`.
  - **Recipe (drivable form — reconciled round 6 of #3141).** `dev-env.ps1` enforces ONE
    environment per issue (R-3.4: a live same-issue lease fails a second `Up` closed), so the
    original "two `-EnvId`s against one `-Spec`" form is structurally unDrivable from a tester
    dispatch. Use **two DISTINCT spec ids**, each with its own serving checkout — the drivable
    equivalent:
    ```
    # env A (the round's primary env, spec 3141) — repo root checkout
    powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3141 -EnvId <A> -EnvSlot <nA> -RequireIsolation -TimeoutSecs 3600
    # env B — its own spec id AND its own checkout (a worktree at the same tip)
    powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec <distinct> -EnvId <B> -EnvSlot <nB> -ServingCheckout .serve/<B> -RequireIsolation -TimeoutSecs 3600
    ```
    **Known machine constraint — the shared Cargo target dir.** All worktrees of this repo share
    ONE `target-dir` (the repo-root untracked `.cargo/config.toml`, deliberate: it keeps
    `llama-cpp-sys-4`'s expensive CMake cache hash stable). While env A's `fredo.exe` is running,
    env B's `cargo run` cannot relink it (`error: failed to remove file …\target\debug\fredo.exe
    / Access is denied (os error 5)`), so **two app processes may not both be freshly built in
    the same target dir**. A SEQUENCED proof (bring B up, capture its state, `Down` B, bring A
    up, capture its state) is therefore an acceptable substitute for concurrency — disclose the
    sequencing explicitly. A genuinely concurrent run needs a distinct `CARGO_TARGET_DIR` (or a
    prebuilt binary per env); use it if available and say how.
  - **Expected:** each env runs its **own** engine instance with its own companion directory and
    its own model/backend selection; neither env observes the other's engine state
    or reported backend (each status names only its own `backend`/`devices`/`modelId`, and each
    env's `llama_server_companion_dir` resolves inside its OWN env root).
  - **Edge:** reversed start order; restart one env mid-run — its engine returns on its own
    companion dir/backend, the other untouched; the removed `FREDO_LLAMA_SERVER_PORT` leaves no
    dangling consumer (`env.rs` parse, `companion_env_overrides`, the startup log line, tests);
    `verify-env-isolation.ps1` exits 0 over both envs and no `ports.llama` entry exists; no
    global image kill. Cross-ref `.opencode/tests/multi-env-isolation/` F-1/F-2, `env-isolation/`.

## R-28 — the engineering rule is amended in the same spec

- [ ] **F-20 (R-28.1/R-28.2, STATIC).** Read `docs/ENGINEERING_RULES.md:50` and grep the four
      derived docs.
  - **Expected:** `:50` states the **in-process `llama-cpp-4` runtime** with the wording the plan
    proposed (the architect's replacement paragraph, quoted in the triage Discussion) and no
    longer claims an out-of-process `llama-server` sidecar; `ARCHITECTURE.md`, `SETUP.md`,
    `FAQ.md`, `SECURITY.md` contain **no** description of an out-of-process companion (no
    "managed `llama-server` sidecar", no "spawned child process", no loopback-endpoint
    instructions).
  - **Edge:** `SECURITY.md`'s path-key list must drop `llama_server_path`; a remaining
    "install llama.cpp / winget" instruction anywhere is a FAIL (AC-17 contradicts it).

## R-29 — third-party notices record the runtime

- [ ] **F-21 (R-29.1, STATIC + built-artifact leg).** Read `docs/THIRD_PARTY_NOTICES.md`; then
      list the runtime redistributables actually shipped by the release build's bundle output.
  - **Expected:** the notices record **linked `llama.cpp`** and **`llama-cpp-4`** (both
    `MIT OR Apache-2.0`) and no longer claim the Doom game data is the only distributed
    third-party component (the `:8-10` claim is replaced); the CUDA/Vulkan runtime
    redistributables the installer actually bundles are named **with their terms**.
  - **Edge (G-425):** the bundle-contents leg reads the installer output produced by this
    round's release build — state that build as the precondition; if no installer artifact was
    produced in the round, record `UNVERIFIED — bundle artifact not built`, never a PASS. A
    notice naming a redistributable that is not in the bundle, or a bundled redistributable
    missing from the notices, ⇒ FAIL.

## Repeat-turn survival + settings write parity (added round 2 of #3141 — the two defects the round-1 suite could not see)

- [ ] **F-23 (repeat-turn engine survival, LIVE).** On one loaded engine, send **three**
      consecutive chat turns in the same session (no restart, no `stop_llama_server` between
      them), then read `get_llama_server_status` once.
  - **Expected:** each of the three turns settles with exactly one `llm-done` and at least one
    `llm-token`; there is **no** `llm-error` on any of them; after turn 3 the status payload still
    reports `running:true` / `healthy:true` with `lastErrorCode` absent (the engine thread
    survived), and it is the SAME engine instance (no lazy restart between turns).
  - **Why it exists:** round 1 of #3141 passed the first-turn legs and FAILED here — the engine
    thread panicked on turn ~3 (`Unexpected empty grammar stack after accepting piece: <turn|>`)
    and every later turn returned "the companion engine stopped". A single-turn row cannot detect
    that class; this row is the survival receipt.
  - **Edge:** a vision turn (`llm_chat_with_image`) followed by two text turns is the same class —
    the vision path panicked on its FIRST turn in round 1; it must also leave a surviving engine.

- [ ] **F-24 (`save_setting` ⇄ `get_control_setting` parity, LIVE).** With a stale cache value
      present for `llama_server_backend`, write a different value through the shipped
      **`save_setting`** path (the one the Settings → Companion control calls), then read the
      same key through **both** readers.
  - **Expected:** `save_setting('llama_server_backend', 'cpu')` → `get_setting` returns `cpu`
    **AND** `get_control_setting` returns `cpu` (the cache plane the engine's `backend_mode()`
    reads), and `get_llama_server_status.backendMode` reflects the same value. The reverse
    direction (`gpu` over a `cpu` cache) holds too.
  - **Why it exists:** round 1 of #3141 FAILED a data-plane/cache-plane split — `save_setting`
    wrote PostgreSQL only while `get_control_setting` and the engine read the cache, so the
    shipped control never reached the engine and the AC-25 recovery drill looped on
    `gpuUnavailable`. Same-plane parity is the discriminator.
  - **Edge:** a free-form value (`bogus`) is still rejected by the closed enum and writes
    **nothing** on either plane; `""`/whitespace clears **both** planes; a non-enumerated key
    round-trips unchanged on both planes.

## Engine restart + hidden-reasoning containment (added round 3 of #3141 — the two defects round-2 live testing exposed)

> Round-3 serving tip: **`63f16e4`** on `spec/3141`. Record the tested SHA with this round's
> evidence; a suite commit landed after the live capture invalidates the served-commit env
> evidence (G-357), so these two rows are committed **before** the drive.
>
> Both rows are LIVE on the **LIVE WEBVIEW / status-command receipt**: a
> `tauri_webview_execute_js` / `tauri_webview_dom_snapshot` result plus a live
> `get_llama_server_status` result — never a `telemetry_spans` query (this feature emits no OTLP
> producer of its own). Neither is evidence that the fix passed; they are the cases that must be
> driven.

- [ ] **F-25 (engine restart after stop, LIVE).** On one running Fredo process, in this order:
      `launch_llama_server` (wait for `success:true`), `stop_llama_server`, poll
      `get_llama_server_status` until it converges to released, then `launch_llama_server`
      **again**, then send one `llm_chat` turn, then read `get_llama_server_status` once more.
      Do **not** restart the app between the stop and the second launch — the whole point is the
      SAME process and the SAME engine thread.
  - **Expected:** both launches return `success:true` (each with a `backend`); after
    `stop_llama_server` the status converges to **released** — `running:false`, `healthy:false`,
    `devices:[]` and the optional `backend`/`modelId` keys **absent** (not `null` — NFR-9), with
    `port`/`pid` still `null`; the second launch converges to **healthy** — `running:true`,
    `healthy:true`, `devices` non-empty, `backend` present, `lastErrorCode` absent; and the turn
    after the restart streams at least one `llm-token`, emits **no** `llm-error`, and settles with
    **exactly one** `llm-done`, last.
  - **Negative control (the pre-fix behaviour).** The defect this row exists to catch: the engine
    thread ENDED on the first `stop_llama_server`, so the second `launch_llama_server` failed with
    the typed `startTimeout` (or `backendInitFailed`) and only an app restart recovered. A second
    launch that returns `success:false` with `code` `startTimeout` / `backendInitFailed`, or a
    post-restart turn that settles `llm-error`, is a **FAIL** — not an environmental blocker.
  - **Edge:** a second and third launch cycle must also succeed (repeat start → stop → start at
    least twice, then serve the turn); `stop_llama_server` twice in a row, and `stop_llama_server`
    before any launch, are idempotent no-ops (no crash, status still released). Allow a **bounded**
    poll for the released snapshot (a deadline, e.g. 30 s, re-reading
    `get_llama_server_status`) — `stop_llama_server` only enqueues the stop, so a single immediate
    read is not a FAIL; a run that never converges within the deadline is.
  - **Why it exists:** round-2 live testing found `stop_llama_server` was a **one-way door**
    (fix D1) — `Stop` used to end the engine loop with `break`, killing the ONE thread. Round 1's
    first-turn rows could not see it because none of them stopped and restarted in-process.

- [ ] **F-26 (the hidden reasoning channel never reaches `llm-token`, LIVE).** Drive a small set of
      **reasoning-eliciting, multi-token** prompts through the shipped chat path (`llm_chat`, the
      same command `TauriAdapter` invokes) and record the ordered event stream with a listener
      attached to the five shipped channels **before** each invoke. Use prompts that both make the
      model open its hidden reasoning channel and then answer over several tokens — e.g. "Think
      briefly, then explain in one sentence why the sky appears blue." / "Reason in one short
      sentence, then explain what a compiler does in one sentence." / "Compute 17 times 23. Reason
      briefly, then give the answer in a sentence." Run each with a distinct turn; then run the
      paired plain-prompt control. *(A single-word target such as "Reply with the single word:
      yes." does elicit the span, but cannot satisfy the ≥2-delta clause below — so use it only as
      an extra span-eliciting trial alongside the multi-token prompts, never as the sole trial.)*
  - **Expected (per reasoning-eliciting trial):**
    (a) the visible reply streams as **≥2** `llm-token` deltas (a single withheld blob is the
    pre-fix bug — the whole reply collapsed into ONE token event);
    (b) **no** `llm-token` payload contains `<|channel>` or `<channel|>`, and no payload contains a
    control token (`<|`) at all — `llm-token` carries user-visible prose only;
    (c) the hidden span is **not** surfaced on any `llm-*` channel — the wire vocabulary stays the
    five shipped names (`llm-token`, `llm-status`, `llm-skill-call`, `llm-error`, `llm-done`), and
    a listener for a reasoning channel receives nothing because **no such channel is shipped** (see
    the disclosure below);
    (d) **exactly one** `llm-done` per trial, and it is **last**; no `llm-error`.
    Paired **plain-prompt control:** a prompt with no reasoning elicitation (e.g. "Name three
    primary colours in one short sentence.") still streams **≥2** `llm-token` deltas, contains no
    `<|channel>` / `<channel|>`, and settles with exactly one trailing `llm-done` — so the fix
    did not simply suppress streaming everywhere.
  - **Disclosure — where the reasoning span IS observable, and where it is not (do not FAIL leg
    (c) for a missing webview channel).** In the served tree the span is recovered on the engine's
    typed event stream as `EngineEvent::Reasoning` and is deliberately **never forwarded to the
    webview** (`WireEvent`/`AppSink` has no reasoning variant; `stream_skill_turn` consumes only
    `frame.events` and `frame.finish_reason`). There is **no `llm-reasoning` channel** — a grep of
    the tree for `llm-reasoning` returns nothing. The "surfaced separately, not as a token" clause
    is therefore satisfied and recorded **on the engine side**, by the committed integration pin
    `a_reasoning_first_generation_streams_and_never_leaks_the_span`
    (`apps/tauri/src-tauri/src/applications/llm_server/engine/integration.rs`), whose record is the
    green CI `rust-validate` run on the tested head SHA. Leg (c) at the webview is an **absence**
    assertion — the span appears on no channel and no fifth channel exists — and it is proven by an
    instrument independent of the absent channel: `tauri_webview_execute_js` attaching listeners to
    the five shipped names plus a probe name, then grepping the committed Rust/TS trees. Writing
    this row as "expect an `llm-reasoning` event" would be a false FAIL against a channel nobody
    ships; a NEW fifth channel appearing in the stream is a FAIL (R-26.1 byte-compatibility).
  - **Edge:** whether a *specific* prompt elicits a reasoning span is model sampling, not a product
    invariant — so require the ≥2-delta and no-marker clauses on **every** trial, and record the
    span observation (engine-side pin / CI run) separately; a run where no trial produced a span
    does **not** pass leg (c) by default — re-run with another reason-eliciting prompt and say so in
    the evidence. A pre-fix reply shows ONE 716-char `llm-token` beginning `<|channel>thought` ⇒
    **FAIL** on (a) and (b) together. Do **not** assert the bare word `thought` is absent from a
    `llm-token` payload on the live row (it is legitimate English in a reply; the engine-side pin
    makes the stricter assertion) — assert the markers themselves. A turn that ends with no
    `llm-token` at all, or two `llm-done`, is a FAIL.
  - **Why it exists:** round-2 live testing found the content gate withheld everything from the
    first `<|` occurrence, so a reasoning-FIRST reply leaked `<|channel>thought … <channel|>` into
    `llm-token` as one blob (fix D2). A first-turn happy-path row could not see it; this row drives
    the reasoning-first shape explicitly.

## Non-functional

- [ ] **F-22 (NF, STATIC/build).** Gates: `cargo check --locked` and
      `cargo clippy --locked -- -D warnings` zero warnings, no `#[allow(...)]` added for this
      work, no `unwrap()`/`expect()` on a fallible engine path; `pnpm --filter @fredo/ui build`;
      `cargo nextest run --locked`; and the **EXECUTED** CUDA/Vulkan build (G-314 — the built
      artifact loads on this machine and on the GPU-less seam path).
  - **Expected:** all gates green in CI `rust-validate` on the tested PR head SHA (the tester's
    shell has no `cargo` — the record is the CI check run plus `## Developer ST-n — verification`);
    `externalBin` still `[]`; no `tokio::spawn` (only `tauri::async_runtime::spawn` for
    adapters); one generation at a time (a concurrent turn is queued or refused typed `Busy`,
    NFR-2); engine start is bounded (NFR-3).
  - **Edge:** a green build script that never ran is not evidence (G-314); a suppressed warning
      is a FAIL; `native` enabled in a release build ⇒ FAIL.

---

## Spec #3180 — launch auto-start, in-flight `starting`, first-use turn, typed start failure

> Feature issue **#3180**. Adds FR-28…FR-33 for the launch trigger + the honest in-flight state.
> Verification policy: **LIVE** on the LIVE WEBVIEW / status-command receipt
> (`tauri_webview_dom_snapshot` / `find_element` / `execute_js` results plus a live
> `get_llama_server_status`). This feature emits **no OTLP producer of its own** — a
> `telemetry_spans` query is neither required nor sufficient (E-SPAN is a NAMED BLOCKER, never a
> FAIL). Evidence frames are named without image extensions (G-104).
>
> **Re-scope, not a new expectation:** `regression.md` R-3 (`engine idle ⇒ down / "Not running"` +
> overall `degraded`) is SUPERSEDED by this spec — see the re-scope block appended there. The
> `fredo-health-led` F-15 row that asserts the same old truth is likewise superseded.

## Named in-repo levers for #3180 (G-275 / G-300 / G-409)

| Lever | Status | Used by |
|---|---|---|
| **Launch auto-start** (`start_companion_engine_on_launch`, called from `lib.rs` right after the engine state is managed) | **NEW — ST-2(f)/(g)** | FR-28, FR-29, FR-30, FR-31 |
| `LlamaServerStatus.starting` (always-present bool) + the `llama-server-status` push (`EventBus::emit_global`) | **NEW — ST-2(a-d)** | FR-28, FR-29, FR-30 |
| `FREDO_COMPANION_FORCE_CPU=1` (existing, `engine/device.rs:44`) + persisted `llama_server_backend="gpu"` | existing seam, existing setting | FR-32 |
| `save_setting('models_dir', <empty dir under .opencode/tmp/3180/>)` | existing IPC control plane (FS-3 pattern) | FR-28 edge |
| Model-files precondition gate: the product's OWN `check_companion_readiness` → `modelFiles` `installed` | shipped probe (**never** read/glob the model dir) | FR-28, FR-30, FR-31 |
| `tauri_webview_execute_js` → `__TAURI__.core.invoke(...)` (the dev env's `tauri.env.conf.json` sets `withGlobalTauri = true`) | shipped dev-env config | all rows |
| `run-exitcode.ps1 -Command "Get-Process …"` | committed wrapper (no shell chaining in the sandbox) | FR-33 |

## Cases

- [ ] **FR-28 (AC-1.2 / R-1.2, LIVE) — the engine starts at LAUNCH, bounded, without blocking the shell.**
  - **Data/precondition:** `check_companion_readiness` reports the `modelFiles` prerequisite
    `installed` in the served env (the product's own probe). If it reports `missing` and the host
    has no network to run the product's own `Download model files`, the engine legs are a **NAMED
    BLOCKER** (never a PASS) — record it and still execute every non-engine row.
  - **Steps:** cold boot (`dev-env.ps1 -Action Up -Spec 3180 …`); from the FIRST painted frame,
    sample `__TAURI__.core.invoke('get_llama_server_status')` and the LED row every ~2 s, recording
    an ordered sample log; **never** invoke `start_companion_engine` / `launch_llama_server` and
    never open Settings → Companion.
  - **Expected:** `running:true, healthy:true` within `DEFAULT_START_BUDGET` (120 s); `backend`
    present; `modelId` = `gemma-4-E2B-it-qat-UD-Q4_K_XL`; `health-line-llamaServer`
    `data-health-state="healthy"` with detail `Running` (the state word is `Healthy`); the row's
    label still reads `Companion engine`; **`starting:true` appears in at least one pre-healthy
    sample and `starting:false` once healthy** (the always-present key — an ABSENT key is a FAIL:
    G-413); the shell rendered a non-empty `<body>` BEFORE the engine became healthy (boot never
    blocked — R-1.2); the sample log contains ZERO `down`/`Not running` samples (→ FR-29).
  - **Edge (mandatory, no-start control):** persist `save_setting('models_dir','<scratch>/no-models')`
    (an empty dir), relaunch ⇒ the launch start SKIPS (no engine start; log line says so), both
    companion lines read `notSetUp` / `Not set up`, the overall stays neutral-not-degraded by them,
    and a later user turn still starts the engine through the lazy path (FR-33).
  - **FAIL:** never healthy within the budget; a manual start needed; `starting` absent from the
    payload; a blocked/blinking shell until the engine loads.

- [ ] **FR-29 (AC-4.2 / R-4.2, LIVE) — an in-flight load is NEUTRAL, an idle engine is NEUTRAL; `down` is reserved for a typed failure.**
  - **Leg (a) in-flight:** while the launch start is loading (FR-28's sample log), every
    `health-line-llamaServer` sample is `data-health-state="unknown"` with detail `Starting` (state
    word `Checking`) — ZERO `down` / `Not running` samples and zero overall `Degraded` attributable
    to this line.
  - **Leg (b) idle:** on a healthy engine, invoke `__TAURI__.core.invoke('stop_llama_server')` and
    poll `get_llama_server_status` for a bounded ≤30 s until it converges; then read the row.
    Expected `data-health-state="unknown"`, detail `Idle` (state word `Checking`; never `down`), and
    the launch start does NOT restart it (the process-once guard): after a further ~20 s the status
    is still `running:false` / `starting:false`.
  - **Edge:** `stop_llama_server` twice in a row ⇒ still `Idle`, no crash, no restart; a second
    `stop` after no start is a no-op.
  - **FAIL:** any `down` during loading; `down` in the idle state; an auto-restart after a manual
    stop (that would be a launch loop).

- [ ] **FR-30 (AC-4.1 / R-4.1, LIVE) — first use: open the companion, send a message, get a reply, with the engine healthy at the reply and NO setup step.**
  - **Data:** a fresh app-data profile (`FREDO_DATA_DIR=<scratch>/fresh-data`, the PG override
    UNSET via the empty `-EnvVar "FREDO_PG_DATA_DIR="` form, `FREDO_PG_INSTALL_DIR=<env-root>/postgres-install`),
    model files present per FR-28.
  - **Steps:** wait for (or drive through, per FR-31) the engine to become healthy; if the
    companion renders the away seat (`aria-label="Fredo is away"`), place it with the shipped
    seat gesture (Ctrl+right-click on the desktop) — placement, not a setup step; then focus
    `[data-testid="launcher-command-input"]`, type one short sentence (e.g. `In one short sentence,
    say hello.`), press Enter; then read `[data-testid="fredo-reply-surface"]` and
    `[data-testid="fredo-companion-live-region"]`.
  - **Expected:** a NON-EMPTY reply renders (bubble text differs from the pre-send state; not the
    idle copy); the reply is not a raw error string; **at the moment the reply is rendered**
    `get_llama_server_status` reports `running:true, healthy:true` and `health-line-llamaServer` is
    `healthy` / `Running`; exactly one `llm-done` and no `llm-error` in the ordered event stream
    (listeners attached via `execute_js` BEFORE the Enter). The drive transcript contains **no
    Settings → Companion visit and no Start/Retry click**.
  - **FAIL:** the reply requires a setup step; the reply arrives while the status is not healthy;
    no reply / an error surface; two `llm-done`.

- [ ] **FR-31 (AC-4.3 / R-4.3, LIVE) — a first turn sent WHILE the engine is loading is kept alive to the bounded budget.**
  - **Data:** FR-30's profile, but send at the first painted frame (the status reports
    `starting:true`).
  - **Expected:** the turn does NOT fail; a reply renders within the start budget plus normal turn
    time; no `llm-error`; no "still loading" error copy on the reply surface; exactly one
    `llm-done`; the concurrent user turn does NOT spawn a second engine — one stable `modelId` and
    one `get_llama_server_status` identity across the load (the channel's FIFO orders the turn
    after the start).
  - **Edge:** a second message sent while the first reply streams ⇒ the shipped queue/disposition
    behaviour is unchanged, no duplicate `llm-done`.
  - **FAIL:** a turn that errors or is dropped because the engine was loading; two engine starts;
    an unbounded wait past the budget.

- [ ] **FR-32 (AC-5.2 / R-5.2 + R-5.3, LIVE) — a typed start failure names cause, remedy and the engine's `code`/`lastError`.**
  - **Data:** persist `save_setting('llama_server_backend','gpu')` (confirm with `get_setting`),
    then relaunch with `-EnvVar "FREDO_COMPANION_FORCE_CPU=1"` — the shipped `gpuUnavailable` seam
    (`engine/device.rs:44`).
  - **Steps:** read `get_llama_server_status`, then read the rows with the plan's ONE-SHOT recipe
    (focus `[data-testid="desktop-status-led"]` in an `execute_js` call, wait ~300 ms, read
    `[data-testid="health-line-llamaServer"]` + the trigger `aria-label`) — focus, not a bare
    hover, so the tooltip stays open across the tool call.
  - **Expected:** `lastErrorCode:"gpuUnavailable"` and a non-empty `lastError`;
    `health-line-llamaServer` `data-health-state="down"` with detail `Could not start` (state word
    `Down`); the row carries (a) a non-empty **remedy** containing the shipped
    `engineFailureCopy('gpuUnavailable')` sentence (it names switching the backend to Automatic or
    CPU, then Start — substring match, not full-string equality; a trailing location clause such as
    `Open Settings → Companion.` is additive and does not break this assertion) and (b) a **technical
    detail** node (mono, single line, ellipsised) whose text contains BOTH the typed code
    (`gpuUnavailable`) and the raw `lastError` text, and whose native `title` equals its text
    content (UI/UX §11 hook 3); the persisted `llama_server_backend` is STILL `gpu` (never
    overwritten). The composed trigger `aria-label` carries the remedy but NOT the technical detail
    (UI/UX §8).
  - **Edge (mandatory control):** the same boot WITHOUT `FREDO_COMPANION_FORCE_CPU` ⇒ the launch
    start succeeds and the row reads `Running` — the discriminator that the seam produced the
    failure.
  - **FAIL:** bare `Not running` with no next step; the typed code absent from the row; the mode
    silently rewritten; a hang instead of a typed failure.

- [ ] **FR-33 (regression — the lazy path, one thread, no child process, unchanged budget).**
  - **Steps:** with the engine healthy from the launch start, `stop_llama_server`, then send one
    turn; read the ordered stream and the status.
  - **Expected:** the lazy `Chat` path starts the engine and the turn settles with exactly ONE
    `llm-done` and ≥1 `llm-token`, no `llm-error` (the fallback survives the new launch trigger);
    `DEFAULT_START_BUDGET` is unchanged at 120 s (static read of
    `engine/handle.rs` — `pub const DEFAULT_START_BUDGET: Duration = Duration::from_secs(120)`);
    **no `llama-server` process exists** at any sample
    (`run-exitcode.ps1 -Command "Get-Process -Name llama-server"` ⇒ not found); ONE engine thread
    for the whole process (the `modelId` after the lazy start equals the launch-start one).
  - **FAIL:** the lazy turn fails after a manual stop; a `llama-server` process appears; two engine
    instances; the budget changed.
