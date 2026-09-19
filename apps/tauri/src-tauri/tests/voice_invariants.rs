//! ST-9 — continuous voice invariants pinned as static, executable guards
//! (G-148/G-123): the `WHILE` conditions that a discrete transition test cannot
//! cover.
//!
//! This target reads the shipped voice sources as TEXT (`env!("CARGO_MANIFEST_DIR")`)
//! — it imports no crate, opens no device, loads no model, and measures nothing.
//! It pins:
//!
//! - **R-3.3 LOCAL-ONLY** — the capture/engine/session decode path references no
//!   network client, socket, or process-spawn symbol; the feature's only
//!   network-capable component is model acquisition (outside `voice/`).
//! - **R-4.6 NO IDLE RESOURCE** — no recognizer and no `cpal` stream is held
//!   idle: the recognizer is DEFINED once (`engine.rs`) and BUILT only by the
//!   two sanctioned loaders — the process-resident warm (`resident.rs`, added by
//!   Spec #2887 ST-1/ST-2) and the session worker's cold-load fallback
//!   (`session.rs`) — while the `cpal` stream is still constructed ONLY inside
//!   the session worker (`worker_main`). `VoiceState` holds neither, and the mic
//!   is never opened by the resident warm (the residency is ENGINE-ONLY).
//! - **R-5.4 OPT-IN** — the frontend voice defaults are `false` and are the
//!   values actually handed to `usePersistedSetting`.
//! - **REQ-NF5 NO-PANIC** — the shipped voice region contains no `unwrap()` /
//!   `expect(` / `panic!` / `unreachable!`.
//! - **G-128 MANIFEST PINS** — `STT_TOTAL_BYTES` and the four pinned STT files
//!   (ids, paths, sizes, SHA-256) are the verified #2876 values.
//! - **REQ-8 MODEL-AUDIO LOOPBACK-ONLY** (Spec #2897 ST-8) — a `WHILE`
//!   invariant: the captured clip crosses the IPC boundary only (captured and
//!   taken inside `infrastructure/voice/`; the model transport names never appear
//!   there), and the managed delivery target is the loopback host
//!   (`DEFAULT_LLAMA_SERVER_HOST` = `127.0.0.1`, the launch-config default, and
//!   the ONE chat URL shell that templates the resolved host). ST-2/ST-3 add the
//!   names this pins; until they land those legs are trivially green and become
//!   real coverage the moment the surfaces appear — the pin is never weakened.
//! - **REQ-2 LOCAL TRANSCRIPTION PRESERVED** (Spec #2897 ST-7) — the shipped
//!   dictation path is unchanged when the persisted method is `'local'` (the
//!   absent-key upgraded install included): the local worker still acquires the
//!   engine, opens the same capture and runs `run_recognition` over the same
//!   sink; local maps to no phase/ceiling and is never gated by the model-audio
//!   capability probe; no clip is stashed or taken on that path; and the
//!   frontend transcript merge + launcher rendering are untouched. ADD-ONLY:
//!   every existing invariant and allowlist above stays green.
//!
//! These are STATIC/STRUCTURAL pins only. The measured idle-CPU / no-egress
//! live observations belong to the tester (QA REQ-NF1 / REQ-3.2); when a live
//! leg is undrivable it is recorded as a NAMED blocker alongside the pin — the
//! pin is never offered as a substitute for the live leg (G-148).

use std::path::{Path, PathBuf};

/// The attribute that opens a source file's test module.
const TEST_ATTR: &str = "#[cfg(test)]";

/// Symbols that can reach the network or spawn a process. R-3.3 confines every
/// such symbol to model acquisition, which lives outside `infrastructure/voice/`.
const EGRESS_SYMBOLS: &[&str] = &[
    "reqwest",
    "ureq",
    "hyper",
    "TcpStream",
    "UdpSocket",
    "std::net",
    "Command",
];

/// Calls that must not exist on any shipped path of the voice module
/// (QA REQ-NF5). `?`, `unwrap_or`, and `unwrap_or_else` are the sanctioned
/// alternatives and do not match these literals.
const PANIC_SYMBOLS: &[&str] = &["unwrap()", "expect(", "panic!", "unreachable!"];

/// `apps/tauri/src-tauri` — the crate root, resolved by Cargo.
fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `<crate>/src/infrastructure/voice`.
fn voice_dir() -> PathBuf {
    crate_root().join("src").join("infrastructure").join("voice")
}

fn read_source(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// Blank every comment and string literal, preserving byte offsets, so the scans
/// below match CODE symbols only: a doc comment that merely *mentions* a
/// forbidden word is not a violation, and a `//` inside a URL literal is never
/// mistaken for a comment. Char literals are not masked — none in the voice
/// module contain a brace or quote (verified by the pins themselves staying
/// green), and treating `'` as a char-literal start would mis-handle lifetimes.
fn mask(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = vec![b' '; bytes.len()];
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len()
                    && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            b'"' => {
                index += 1;
                while index < bytes.len() {
                    match bytes[index] {
                        b'\\' => index += 2,
                        b'"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
            }
            byte => {
                out[index] = byte;
                index += 1;
            }
        }
    }
    String::from_utf8(out).expect("masked source stays valid UTF-8")
}

/// The shipped (non-`#[cfg(test)]`) region of a source file: everything before
/// the test-module attribute. Test-only `unwrap()`/`panic!` are legitimate and
/// must not fail the no-panic pin.
fn production_region(source: &str) -> &str {
    match mask(source).find(TEST_ATTR) {
        Some(index) => &source[..index],
        None => source,
    }
}

/// The text of the item whose signature contains `signature`, delimited by brace
/// matching over already-masked source (so braces inside strings/comments cannot
/// skew the depth).
fn item_span<'source>(masked: &'source str, signature: &str) -> &'source str {
    let start = masked
        .find(signature)
        .unwrap_or_else(|| panic!("`{signature}` not found in the masked source"));
    let bytes = masked.as_bytes();
    let mut depth: i32 = 0;
    let mut index = start;
    let mut opened = false;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                depth += 1;
                opened = true;
            }
            b'}' => {
                depth -= 1;
                if opened && depth == 0 {
                    return &masked[start..=index];
                }
            }
            _ => {}
        }
        index += 1;
    }
    panic!("unbalanced braces while scanning from `{signature}`");
}

fn occurrences(haystack: &str, needle: &str) -> usize {
    haystack.match_indices(needle).count()
}

/// The slice of `haystack` between the first `start` and the next `end` after
/// it, over already-masked source. Used to isolate ONE match arm / branch so a
/// pin can assert what that arm does (and does NOT) contain.
fn between<'source>(haystack: &'source str, start: &str, end: &str) -> &'source str {
    let from = haystack
        .find(start)
        .unwrap_or_else(|| panic!("`{start}` not found while slicing"));
    let rest = &haystack[from..];
    let to = rest
        .find(end)
        .unwrap_or_else(|| panic!("`{end}` not found after `{start}`"));
    &rest[..to]
}

/// The raw source text of one UI file, relative to `apps/ui/src`.
fn ui_source(relative: &str) -> String {
    let path = crate_root()
        .join("..")
        .join("..")
        .join("..")
        .join("apps")
        .join("ui")
        .join("src")
        .join(relative);
    read_source(&path)
}

/// `(file name, shipped source)` for every Rust file in `infrastructure/voice`.
fn voice_production_sources() -> Vec<(String, String)> {
    let dir = voice_dir();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("cannot list {}: {error}", dir.display()))
        .map(|entry| entry.expect("readable voice dir entry").path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("rs"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let source = read_source(&path);
            let production = production_region(&source).to_string();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("<unknown>")
                .to_string();
            (name, production)
        })
        .collect()
}

/// `(path relative to src/, shipped source)` for every Rust file under `src/`,
/// path-sorted for deterministic allowlist assertions.
fn crate_production_sources() -> Vec<(String, String)> {
    let root = crate_root().join("src");
    let mut out = Vec::new();
    collect_production_sources(&root, &root, &mut out);
    out.sort_by_key(|(name, _)| name.clone());
    out
}

fn collect_production_sources(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let entries = std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("cannot list {}: {error}", dir.display()));
    for entry in entries {
        let path = entry.expect("readable source dir entry").path();
        if path.is_dir() {
            collect_production_sources(root, &path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            let source = read_source(&path);
            let production = production_region(&source).to_string();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((relative, production));
        }
    }
}

/// R-3.3 — no audio or audio-derived payload may be transmitted: the entire
/// shipped voice module is on-device.
#[test]
fn voice_decode_path_has_no_network_or_process_symbols() {
    for (file, production) in voice_production_sources() {
        let code = mask(&production);
        for &symbol in EGRESS_SYMBOLS {
            assert!(
                !code.contains(symbol),
                "{file} shipped code must not reference `{symbol}` (R-3.3 local-only)"
            );
        }
    }
}

/// Positive control for the pin above: the acquisition transport DOES carry a
/// network client, so a green no-egress scan proves confinement — not a scanner
/// that matches nothing.
#[test]
fn model_acquisition_remains_the_only_network_capable_component() {
    let acquisition = crate_root()
        .join("src")
        .join("features")
        .join("setup")
        .join("model_download.rs");
    let code = mask(production_region(&read_source(&acquisition)));
    assert!(
        EGRESS_SYMBOLS.iter().any(|symbol| code.contains(*symbol)),
        "the STT acquisition transport must remain the network-capable component (R-3.3)"
    );
}

/// R-4.6 — the recognizer and the capture stream are owned by the session
/// worker alone; the app holds nothing while idle.
#[test]
fn voice_state_holds_no_engine_and_the_worker_is_the_only_construction_site() {
    let source = read_source(&voice_dir().join("session.rs"));
    let code = mask(production_region(&source));

    let state = item_span(&code, "struct VoiceState");
    assert!(
        state.contains("Mutex<Option<ActiveSession>>"),
        "VoiceState must hold only the active-session slot: {state}"
    );
    for forbidden in [
        "Recognizer",
        "OnlineRecognizer",
        "SherpaRecognizer",
        "cpal",
        "Stream",
    ] {
        assert!(
            !state.contains(forbidden),
            "VoiceState must not hold `{forbidden}` (R-4.6 lazy engine)"
        );
    }

    let session = item_span(&code, "struct ActiveSession");
    for forbidden in [
        "Recognizer",
        "OnlineRecognizer",
        "SherpaRecognizer",
        "cpal",
        "Stream",
    ] {
        assert!(
            !session.contains(forbidden),
            "ActiveSession must not hold `{forbidden}` (R-4.6)"
        );
    }

    let constructor = item_span(&code, "impl VoiceState");
    assert!(
        constructor.contains("Mutex::new(None)"),
        "VoiceState must start empty — no eager engine"
    );
    assert!(
        !constructor.contains("load_recognizer"),
        "VoiceState::new must never construct the recognizer"
    );

    let worker = item_span(&code, "fn worker_main(");
    assert!(
        worker.contains("engine::load_recognizer("),
        "worker_main is the engine's construction site (R-4.6)"
    );
    assert!(
        worker.contains("capture::start_capture("),
        "worker_main is capture's construction site (R-4.6)"
    );
    assert_eq!(
        occurrences(&code, "load_recognizer("),
        1,
        "session.rs must construct the engine in exactly one place — the worker"
    );
    assert_eq!(
        occurrences(&code, "capture::start_capture("),
        1,
        "session.rs must open capture in exactly one place — the worker"
    );
}

/// R-4.6 crate-wide: the recognizer is defined once and built only by the two
/// sanctioned loaders — the process-resident warm (`resident.rs`, Spec #2887
/// ST-1/ST-2) and the session worker's cold-load fallback (`session.rs`) — and
/// nothing outside the session worker opens a device. Spec #2887 moves the
/// ENGINE load to app setup, but the MICROPHONE is still opened only by the
/// session worker: `resident.rs` must therefore never appear in the capture or
/// cpal sets below. A cold app holds no recognizer-in-flight and no microphone.
#[test]
fn engine_and_capture_construction_is_confined_crate_wide() {
    let mut engine_files = Vec::new();
    let mut capture_files = Vec::new();
    let mut cpal_files = Vec::new();
    for (file, production) in crate_production_sources() {
        let code = mask(&production);
        if code.contains("load_recognizer(") {
            engine_files.push(file.clone());
        }
        if code.contains("start_capture(") {
            capture_files.push(file.clone());
        }
        if code.contains("cpal::") {
            cpal_files.push(file.clone());
        }
    }

    assert_eq!(
        engine_files,
        vec![
            "infrastructure/voice/engine.rs",
            "infrastructure/voice/resident.rs",
            "infrastructure/voice/session.rs"
        ],
        "the recognizer may only be defined in engine.rs and built by the resident warm or the session worker (R-4.6)"
    );
    assert_eq!(
        capture_files,
        vec![
            "infrastructure/voice/capture.rs",
            "infrastructure/voice/session.rs"
        ],
        "capture may only be defined in capture.rs and opened in the session worker (R-4.6)"
    );
    assert_eq!(
        cpal_files,
        vec!["infrastructure/voice/capture.rs"],
        "only capture.rs may touch the audio host (R-4.6)"
    );
}

/// R-5.4 / REQ-1.4 — voice input is opt-in: both frontend defaults are `false`
/// and are the values actually passed to persistence.
#[test]
fn frontend_voice_defaults_are_false() {
    let path = crate_root()
        .join("..")
        .join("..")
        .join("..")
        .join("apps")
        .join("ui")
        .join("src")
        .join("shared")
        .join("contexts")
        .join("CompanionContext.tsx");
    let source = read_source(&path);

    assert!(
        source.contains("export const VOICE_ENABLED_SETTING_KEY = 'Fredo_companion_voice_enabled';"),
        "the enablement key must stay `Fredo_companion_voice_enabled`"
    );
    assert!(
        source
            .contains("export const VOICE_AUTOSEND_SETTING_KEY = 'Fredo_companion_voice_autosend';"),
        "the autosend key must stay `Fredo_companion_voice_autosend`"
    );
    assert!(
        source.contains("export const DEFAULT_VOICE_ENABLED = false;"),
        "voice enablement must default to false (R-5.4 opt-in)"
    );
    assert!(
        source.contains("export const DEFAULT_VOICE_AUTOSEND = false;"),
        "voice autosend must default to false (REQ-1.4 / R-5.4)"
    );
    assert!(
        source.contains("VOICE_ENABLED_SETTING_KEY, DEFAULT_VOICE_ENABLED"),
        "the false default must be the persisted default, not dead copy (R-5.4)"
    );
    assert!(
        source.contains("VOICE_AUTOSEND_SETTING_KEY, DEFAULT_VOICE_AUTOSEND"),
        "the false default must be the persisted default, not dead copy (REQ-1.4)"
    );
}

/// REQ-NF5 — no panic-capable call on any shipped capture/engine/failure path.
#[test]
fn voice_production_region_has_no_panic_capable_calls() {
    for (file, production) in voice_production_sources() {
        let code = mask(&production);
        for &symbol in PANIC_SYMBOLS {
            assert!(
                !code.contains(symbol),
                "{file} shipped code must not use `{symbol}` (REQ-NF5 no-panic)"
            );
        }
    }
}

/// G-128 — the verified #2876 manifest pins must not drift.
#[test]
fn stt_manifest_pins_are_unchanged() {
    let source = read_source(&voice_dir().join("manifest.rs"));
    let production = production_region(&source);

    for pin in [
        "pub const STT_SUBDIR: &str = \"sherpa-onnx-streaming-zipformer-en-2023-06-26\";",
        "pub const STT_REVISION: &str = \"672fbf1b30579d6585301139bb363f42a0ad4a24\";",
        "pub const STT_HF_REPO: &str = \"csukuangfj\";",
        "pub const STT_TOTAL_BYTES: u64 = 72_654_782;",
    ] {
        assert!(production.contains(pin), "manifest pin drifted: {pin}");
    }

    for pin in [
        "\"sttTokens\"",
        "\"sttEncoder\"",
        "\"sttDecoder\"",
        "\"sttJoiner\"",
        "expected_bytes: 5_048,",
        "expected_bytes: 71_083_163,",
        "expected_bytes: 1_307_236,",
        "expected_bytes: 259_335,",
    ] {
        assert!(production.contains(pin), "manifest file pin drifted: {pin}");
    }

    for sha in [
        "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb",
        "563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1",
        "98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02",
        "d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297",
    ] {
        assert!(production.contains(sha), "manifest SHA-256 pin drifted: {sha}");
    }
}

// ── REQ-8 — continuous model-audio loopback confinement (Spec #2897, ST-8) ────
//
// REQ-8 is a `WHILE` (continuous) clause, so a discrete transition test cannot
// cover it (G-123). These pins are the STATIC/CI leg of QA F-108; the live legs
// (a loopback assertion on the running server and a process-scoped outbound block
// proven by a failing control fetch) stay with the Tester and are never
// substituted by these pins (G-148).

/// The raw source text of one crate-relative file (`src/<relative>`), comments
/// included. Exact literal pins — a `format!("http://…")` URL shell or a
/// `pub const … = "127.0.0.1";` — live in strings that [`mask`] blanks, so they
/// are asserted over the raw text; the pinned strings are production code, so a
/// stray comment could not satisfy them.
fn source_text(relative: &str) -> String {
    read_source(&crate_root().join("src").join(relative))
}

/// The shipped (non-test) region of one crate-relative file, raw. Used where the
/// pinned literal precedes the file's first `#[cfg(test)]`.
fn production_text(relative: &str) -> String {
    let source = source_text(relative);
    production_region(&source).to_string()
}

/// The masked shipped region of one crate-relative file: identifiers survive,
/// comments and string literals are blanked ([`mask`]).
fn production_code(relative: &str) -> String {
    mask(&production_text(relative))
}

/// The masked FULL source of one crate-relative file (byte offsets preserved).
/// Used where a `#[cfg(test)]` helper precedes a shipped item the pin must span —
/// `chat.rs` defines its test helpers before `server_host`/`run_stream`, so the
/// first-test-attribute slice would hide them.
fn source_code(relative: &str) -> String {
    mask(&source_text(relative))
}

/// REQ-8 (F-108 leg 2) — the model-audio delivery target is the managed
/// `llama-server` on the loopback host. The managed-host default, the launch
/// configuration default (`config.rs:108` in the plan) and the ONE chat URL shell
/// all resolve to `127.0.0.1`, and every chat request resolves its host through
/// that shell — never a hardcoded remote endpoint.
#[test]
fn model_audio_delivery_target_is_the_managed_loopback_host() {
    // The managed host default `resolve_host` falls back to.
    let module = source_text("features/llm_server/mod.rs");
    assert!(
        module.contains("pub const DEFAULT_LLAMA_SERVER_HOST: &str = \"127.0.0.1\";"),
        "the managed-server default host must stay loopback (REQ-8)"
    );

    // The launch configuration default (the `--host` the managed server binds).
    let config = production_text("features/llm_server/config.rs");
    assert!(
        config.contains("host: \"127.0.0.1\".to_string(),"),
        "the `llama-server` launch config must default to the loopback host (REQ-8)"
    );

    // The ONE chat-completions / properties URL shell: the resolved host is
    // templated, so the audio delivery ST-3 adds can only address the managed
    // server. `format!` strings are blanked by `mask()`, hence the raw text.
    let chat = production_text("features/llm_server/chat.rs");
    assert!(
        chat.contains("format!(\"http://{host}:{port}{CHAT_COMPLETIONS_PATH}\")"),
        "the chat-completions URL must template the resolved host (REQ-8)"
    );
    assert!(
        chat.contains("format!(\"http://{host}:{port}{PROPS_PATH}\")"),
        "the /props URL must template the resolved host (REQ-8)"
    );

    // The turn target reads the persisted host and resolves it through the
    // loopback-defaulting helper — the request cannot bypass the managed host.
    // `chat.rs` carries a `#[cfg(test)]` helper before those items, so span them
    // over the WHOLE masked file (offsets preserved) rather than the early slice.
    let code = source_code("features/llm_server/chat.rs");
    let resolve = item_span(&code, "fn resolve_host(");
    assert!(
        resolve.contains("DEFAULT_LLAMA_SERVER_HOST"),
        "resolve_host must fall back to the managed loopback default (REQ-8): {resolve}"
    );
    let server_host = item_span(&code, "fn server_host(");
    assert!(
        server_host.contains("resolve_host(") && server_host.contains("LLAMA_SERVER_HOST_KEY"),
        "the turn target must resolve the persisted host via resolve_host (REQ-8): {server_host}"
    );

    // The shared HTTP/SSE shell every chat request flows through resolves the
    // host through `server_host`; ST-3's audio delivery reuses this ONE shell.
    let run_stream = item_span(&code, "pub async fn run_stream(");
    assert!(
        run_stream.contains("server_host(app)"),
        "run_stream must resolve the managed host via server_host (REQ-8): {run_stream}"
    );

    // The health probe shares the same loopback-templated host.
    let health = production_text("features/llm_server/health.rs");
    assert!(
        health.contains("format!(\"http://{host}:{port}{HEALTH_PATH}\")"),
        "the health URL must template the resolved host (REQ-8)"
    );

    // Conditional (ST-3): once the audio delivery command lands, it must route
    // through the managed chat module — never its own transport/URL. The names
    // are absent today, so this leg strengthens automatically when ST-3 ships.
    let commands = production_code("features/llm_server/commands.rs");
    if commands.contains("fn llm_chat_with_audio(") {
        let audio_command = item_span(&commands, "fn llm_chat_with_audio(");
        assert!(
            audio_command.contains("chat::")
                || audio_command.contains("run_stream")
                || audio_command.contains("server_host"),
            "llm_chat_with_audio must deliver through the managed chat module (REQ-8): {audio_command}"
        );
    }
}

/// REQ-8 (F-108 leg 1) — the captured clip crosses the IPC boundary only. The
/// voice module (capture + `stt_take_audio_clip`) never references the model
/// transport names, while the delivery surface (`llm_chat_with_audio`, the
/// `input_audio` content part) lives only in `features/llm_server/`, which owns
/// the managed loopback client. ST-2/ST-3 introduce those names; the scan is
/// positive-controlled on the SHIPPED `llm_chat_with_image` surface, so an
/// audio-only green is provably not a scanner that matches nothing.
#[test]
fn model_audio_surfaces_stay_on_their_ipc_side_of_the_boundary() {
    let mut delivery_files = Vec::new();
    let mut clip_files = Vec::new();
    let mut audio_part_files = Vec::new();

    for (file, production) in crate_production_sources() {
        let code = mask(&production);
        if code.contains("llm_chat_with_image") || code.contains("llm_chat_with_audio") {
            delivery_files.push(file.clone());
        }
        if code.contains("stt_take_audio_clip") {
            clip_files.push(file.clone());
        }
        if code.contains("input_audio") {
            audio_part_files.push(file.clone());
        }
    }

    // Positive control: the already-shipped multimodal delivery command proves the
    // scan sees the surface (its name is an identifier, not a blanked literal).
    assert!(
        delivery_files.contains(&"features/llm_server/commands.rs".to_string()),
        "the delivery-surface scan must see the shipped llm_chat_with_image: {delivery_files:?}"
    );

    for file in &delivery_files {
        assert!(
            file.starts_with("features/llm_server/") || file == "lib.rs",
            "{file} must not carry the audio/multimodal delivery surface outside features/llm_server (REQ-8)"
        );
    }
    for file in &clip_files {
        assert!(
            file.starts_with("infrastructure/voice/") || file == "lib.rs",
            "{file} must not pull the captured audio clip outside the voice module (REQ-8)"
        );
    }
    for file in &audio_part_files {
        assert!(
            file.starts_with("features/llm_server/"),
            "{file} must not render the model-audio content part outside features/llm_server (REQ-8)"
        );
    }
}

// ── REQ-2 — local transcription preserved (Spec #2897, ST-7) ──────────────────
//
// REQ-2 is the regression-protection clause: when the persisted method is
// `'local'` (the default, and the healed value of an absent/unknown key on an
// upgraded install), the shipped dictation path must be unchanged. These are
// ADD-ONLY static pins — they assert the SHAPE of the local path (engine +
// capture + `run_recognition` + no phase/ceiling + no capability gate + no clip)
// and never weaken an existing invariant. The live oracle (a real hold over the
// `FREDO_STT_FEED_WAV` fixture rendering partials/finals into the bar) stays the
// Tester's F-103/R-30 leg and is never substituted by these pins (G-148).

/// REQ-2 (ST-1 reader leg) — the mode reader is a CLOSED two-member set whose
/// ONLY model value is the exact `"model"` literal. An absent key (the
/// upgraded-install case), a malformed/legacy raw, and every non-`model` value
/// heal to `Local`, so an existing install keeps the shipped transcription path
/// with no migration step.
#[test]
fn voice_handling_reader_heals_absent_and_unknown_keys_to_local() {
    // The parse arm compares against a STRING LITERAL, which [`mask`] blanks, so
    // the literal leg is asserted over the raw shipped text; identifier legs use
    // the masked region.
    let raw = production_text("infrastructure/voice/session.rs");
    let code = production_code("infrastructure/voice/session.rs");

    // The reader is the persisted-key lookup; the key is the ST-1 contract.
    assert!(
        code.contains("VOICE_HANDLING_KEY"),
        "the mode reader must read the persisted `Fredo_companion_voice_handling` key (REQ-1/REQ-2)"
    );

    let parse = item_span(&raw, "fn parse_voice_handling(");
    assert!(
        parse.contains("Some(\"model\") => VoiceHandling::Model"),
        "only the exact `model` literal may select model audio: {parse}"
    );
    assert!(
        parse.contains("_ => VoiceHandling::Local"),
        "every other stored value (absent/blank/stale) must heal to local: {parse}"
    );
    // The reader is the AppStore lookup feeding that parser — the same
    // per-`stt_start` read as the enable/device prefs.
    let reader = item_span(&code, "fn persisted_voice_handling(");
    assert!(
        reader.contains("VOICE_HANDLING_KEY") && reader.contains("parse_voice_handling("),
        "persisted_voice_handling must read the key through the healing parser: {reader}"
    );

    // The frontend mirror is the same closed set with the same healing rule.
    let context = ui_source("shared/contexts/CompanionContext.tsx");
    assert!(
        context.contains("export const VOICE_HANDLING_SETTING_KEY = 'Fredo_companion_voice_handling';"),
        "the UI must own the same key literal (single contract)"
    );
    assert!(
        context.contains("export const DEFAULT_VOICE_HANDLING: VoiceHandling = 'local';"),
        "the UI default must be `local` (REQ-2 upgraded install)"
    );
    assert!(
        context.contains("raw === 'model' ? 'model' : DEFAULT_VOICE_HANDLING"),
        "the UI parser must heal every non-`model` raw to the local default"
    );
}

/// REQ-2 (worker leg) — a `Local` session still acquires the engine, opens the
/// SAME capture, and drives `run_recognition` over the SAME `AppHandleSink`;
/// the model-audio branch is the ONLY one that skips the engine and accumulates
/// a clip. The mode branch is a `match` on `VoiceHandling`, so the local arm is
/// structurally guaranteed to be the shipped path.
#[test]
fn local_session_still_acquires_the_engine_and_runs_the_recognition_loop() {
    let code = source_code("infrastructure/voice/session.rs");

    // The worker branches on the resolved mode; the local arm is the shipped one.
    let worker = item_span(&code, "fn worker_main(");
    assert!(
        worker.contains("match mode"),
        "the worker must branch on the resolved handling mode: {worker}"
    );
    let local_arm = between(worker, "VoiceHandling::Local =>", "VoiceHandling::Model =>");
    assert!(
        local_arm.contains("run_recognition("),
        "the local arm must run the shipped recognition loop: {local_arm}"
    );
    assert!(
        local_arm.contains("AppHandleSink::new("),
        "the local arm must emit through the shipped sink: {local_arm}"
    );
    assert!(
        local_arm.contains("park_engine("),
        "the local arm must return the engine to the resident slot (R-7): {local_arm}"
    );
    assert!(
        !local_arm.contains("run_model_audio_session("),
        "the local arm must never enter the model-audio session: {local_arm}"
    );
    assert_eq!(
        occurrences(worker, "run_model_audio_session("),
        1,
        "only ONE worker arm may accumulate a clip (the model arm)"
    );

    // Engine acquisition is TRANSCRIPTION ONLY: the model branch short-circuits
    // to no engine, and the local branch resolves through the resident take /
    // single-flight warm (never a silent skip).
    let acquisition = between(
        &code,
        "let (engine, engine_resident, slot_generation)",
        "let selected_device = persisted_device(app);",
    );
    assert!(
        acquisition.contains("handling == VoiceHandling::Model"),
        "acquisition must be gated on the mode: {acquisition}"
    );
    assert!(
        acquisition.contains("acquire_engine("),
        "the local path must still acquire the engine: {acquisition}"
    );
    assert!(
        acquisition.contains("(None, false, 0)"),
        "the model path opens no recognizer: {acquisition}"
    );

    // The engine handoff in the worker: only the local branch receives/loads.
    let handoff = between(
        &code,
        "let recognizer: Option<Box<dyn Recognizer>>",
        "let capture = match",
    );
    assert!(
        handoff.contains("mode == VoiceHandling::Model"),
        "the engine handoff must be skipped for model audio only: {handoff}"
    );
    assert!(
        handoff.contains("engine::load_recognizer("),
        "the local cold-load fallback must be preserved: {handoff}"
    );

    // The sherpa model-presence gate protects the ENGINE and therefore applies
    // to local only — a model-audio start is never blocked by it.
    let gate = between(&code, "let model_gate = if", "if let Some(error) = model_gate");
    assert!(
        gate.contains("handling == VoiceHandling::Local"),
        "the engine's model-presence gate must be local-only: {gate}"
    );
}

/// REQ-2 — a local session reports the LEGACY (phase-less, ceiling-less) wire
/// shape and is never blocked by the ST-6 model-audio capability gate. The
/// additive model-audio fields stay `None`/absent on every local path, so the
/// shipped frontend contract is unchanged.
#[test]
fn local_sessions_carry_no_model_audio_phase_or_ceiling_and_are_never_gated() {
    let code = source_code("infrastructure/voice/session.rs");

    // `phase_for_handling` / `limit_for_handling` are exhaustive matches whose
    // Local arm is the legacy `None`.
    let phase = item_span(&code, "fn phase_for_handling(");
    assert!(
        phase.contains("VoiceHandling::Local => None"),
        "a local session reports no model-audio phase: {phase}"
    );
    let limit = item_span(&code, "fn limit_for_handling(");
    assert!(
        limit.contains("VoiceHandling::Local => None"),
        "a local session advertises no pinned ceiling: {limit}"
    );

    // `finish_phase` only stamps `processing`/`limitReached` for a model-audio
    // STOP; a local stop keeps the legacy (None, None) pair.
    let finish = item_span(&code, "fn finish_phase(");
    assert!(
        finish.contains("mode == Some(VoiceHandling::Model) && is_stop"),
        "the terminal phase/limit must be model-audio-stop only: {finish}"
    );

    // The ST-6 capability gate is invisible to local: its first act is to return
    // `None` unless the mode is Model, so a failed probe can never block local.
    let gate = item_span(&code, "fn model_audio_start_gate(");
    assert!(
        gate.contains("if handling != VoiceHandling::Model"),
        "the capability gate must short-circuit for local (REQ-2/REQ-7): {gate}"
    );

    // The error builder never claims a phase/limit — every local failure path
    // (disabled / modelMissing / noDevice) keeps the shipped shape.
    let error_state = item_span(&code, "fn state_event_error(");
    assert!(
        error_state.contains("phase: None") && error_state.contains("limit_reached: None"),
        "an error state must never claim a model-audio phase/limit: {error_state}"
    );
    assert!(
        error_state.contains("limit_ms: None"),
        "an error state must never advertise a model-audio ceiling: {error_state}"
    );

    // The clip is cleared on EVERY start (including local) and only a model
    // session can commit one — no clip is ever stashed on the local path.
    let start = item_span(&code, "pub async fn start(");
    assert!(
        start.contains("*lock_clip(&state) = None"),
        "a new listen must invalidate any stale clip on every mode: {start}"
    );
}

/// REQ-2 — the clip slot is empty on a local session: `stt_take_audio_clip`
/// only ever returns what a MODEL session committed, and the local path has no
/// writer. Pinned at the source: `lock_clip(..) = Some(..)` occurs exactly once
/// (inside the model-audio session), so local can never populate the slot.
#[test]
fn only_the_model_audio_session_can_commit_a_clip() {
    let code = source_code("infrastructure/voice/session.rs");

    assert_eq!(
        occurrences(&code, "*guard = Some(clip)"),
        1,
        "the clip slot must have exactly ONE writer — the model-audio session"
    );
    let writer = between(&code, "fn run_model_audio_session(", "fn auto_stop_state(");
    assert!(
        writer.contains("*guard = Some(clip)"),
        "the only clip writer must live inside run_model_audio_session: {writer}"
    );
    assert!(
        writer.contains("run_model_audio_capture("),
        "the clip must be produced by the model-audio accumulator: {writer}"
    );

    // `take_audio_clip` is the IPC reader: it takes + clears, and is the ONLY
    // path that hands the clip out of `voice/`.
    let take = item_span(&code, "fn take_clip(");
    assert!(
        take.contains("guard.take()"),
        "taking the clip must be destructive (a second take is empty): {take}"
    );

    // A local stop/cancel never touches the clip slot's `Some` path: the finish
    // path clears the slot for model-cancel and reads `at_limit` for model-stop
    // only, both gated on the model mode.
    let finish = item_span(&code, "async fn finish(");
    assert!(
        finish.contains("mode == Some(VoiceHandling::Model)"),
        "clip handling in finish must be gated to the model mode: {finish}"
    );
}

/// REQ-2 (frontend leg) — the launcher's model-audio gate is a STRICT `'model'`
/// equality: in `'local'` mode `deriveModelAudioPhase` is always `idle` and the
/// shell's transcript-write suppression (`if (modelVoice) return;`) does not
/// engage, so the shipped `Listening`/`Listening…` cue and the shipped
/// transcript → bar write are the ONLY paths. Pinned at the source so a future
/// change that made local behave like model would fail here.
#[test]
fn local_mode_keeps_the_shipped_launcher_transcript_path() {
    let bar = ui_source("features/home/components/launcher/LauncherCommandBar.tsx");
    // Local mode is always idle — the model derivation is a strict mode check.
    assert!(
        bar.contains("if (input.voiceMode !== 'model') return 'idle';"),
        "deriveModelAudioPhase must be idle for every non-model mode (REQ-2)"
    );
    assert!(
        bar.contains("voiceMode = 'local',"),
        "the bar's voiceMode must default to 'local' (omitted ⇒ shipped rendering)"
    );

    let shell = ui_source("features/home/components/launcher/LauncherShell.tsx");
    // The suppression is a strict equality on the persisted handling.
    assert!(
        shell.contains("const modelVoice = voiceHandling === 'model';"),
        "the shell must gate every model-audio behavior on a strict `=== 'model'` (REQ-2)"
    );
    // The transcript → bar write effect short-circuits on `modelVoice` and then
    // proceeds with the shipped launcher-origin path unchanged.
    let write = between(
        &shell,
        "Spec #2897 ST-4 (REQ-3) — model-audio mode has NO transcript",
        "}, [voice.origin, voice.liveText",
    );
    assert!(
        write.contains("if (modelVoice) return;"),
        "the transcript write must short-circuit on model mode only: {write}"
    );
    assert!(
        write.contains("if (voice.origin !== 'launcher') return;")
            && write.contains("handleQueryChange(joinBarText(scoped, voice.partial));"),
        "the shipped launcher transcript → bar write must remain the local path: {write}"
    );
}

/// REQ-2 — the #2887 latency/residency observables are untouched by the
/// model-audio work: the start-success state still carries the receipt-based
/// `readyMs` and the honest `engineResident` stamp, and only a genuine resident
/// slot take may report residency. (Additive pin — the shipped `session.rs`
/// unit tests already assert these values; this asserts the SOURCE contract
/// cannot drift.)
#[test]
fn local_start_still_stamps_the_receipt_based_ready_ms_and_residency() {
    let code = source_code("infrastructure/voice/session.rs");

    // `readyMs` is measured from the receipt at capture-live, never a constant.
    assert!(
        code.contains("ready_ms: elapsed_ms(receipt),"),
        "readyMs must be the receipt → capture-live elapsed time (R-1)"
    );
    let acquire = item_span(&code, "async fn acquire_engine_with<");
    assert!(
        acquire.contains("return (Some(engine), true);"),
        "only a genuine resident slot take reports residency (R-4): {acquire}"
    );
    assert!(
        acquire.contains("(resident.take(), false)"),
        "a joined/self-started warm must NOT report residency (never optimistic): {acquire}"
    );

    // The start-success path stamps BOTH observables from the resolved values.
    let start = item_span(&code, "pub async fn start(");
    assert!(
        start.contains("Some(info.ready_ms),")
            && start.contains("engine_resident,")
            && start.contains("phase_for_handling(handling),")
            && start.contains("limit_for_handling(handling),"),
        "the start-success state must carry the honest observables + the mode-derived phase/limit: {start}"
    );
}

/// REQ-2 (frontend merge leg) — the `stt:transcript` merge semantics are
/// unchanged: a non-final REPLACES the current segment, a final commits it and
/// clears the partial, and the hook still consumes the transcript channel in
/// `'local'` mode. Pinned at the source so the model-audio suppression can never
/// leak into the local merge path.
#[test]
fn local_transcript_merge_semantics_are_unchanged() {
    let hook = ui_source("shared/hooks/useVoiceDictation.ts");

    // The shipped merge: a final joins into `committed` and clears `partial`;
    // a non-final replaces `partial`.
    assert!(
        hook.contains("setCommitted((prev) => joinSegments(prev, text));"),
        "a final transcript must still commit into `committed` (R-3.1)"
    );
    assert!(
        hook.contains("setPartial(text);"),
        "a partial must still replace the current segment (R-3.1)"
    );
    assert!(
        hook.contains("liveText: joinSegments(committed, partial),"),
        "`liveText` must stay `committed + partial` (R-3.1)"
    );

    // The transcript subscription is mode-agnostic: the hook always listens.
    assert!(
        hook.contains("register('stt:transcript',"),
        "the hook must keep consuming `stt:transcript` in every mode (control plane)"
    );

    // The model-audio signals are additive and default to the legacy shape:
    // `phase ?? null` and a one-shot `limitReached`, so a local event clears them.
    assert!(
        hook.contains("setModelAudioPhase(event.phase ?? null);"),
        "the phase must derive from the event and be null on local (REQ-2)"
    );
    assert!(
        hook.contains("setLimitReached(event.limitReached === true);"),
        "`limitReached` must be a one-shot true, false on every local event (REQ-2)"
    );
    assert!(
        hook.contains("setModelAudioLimitMs(typeof event.limitMs === 'number' ? event.limitMs : null);"),
        "the ceiling must clear to null on every legacy/local event (REQ-2)"
    );
}
