//! Continuous voice invariants pinned as static, executable guards
//! (G-148/G-123): the `WHILE` conditions that a discrete transition test cannot
//! cover.
//!
//! This target reads the shipped voice sources as TEXT (`env!("CARGO_MANIFEST_DIR")`)
//! — it imports no crate, opens no device, loads no model, and measures nothing.
//! It pins:
//!
//! - **LOCAL-ONLY** — the capture/session decode path references no network
//!   client, socket, or process-spawn symbol; the feature's only network-capable
//!   component is model acquisition (outside `voice/`).
//! - **NO IDLE RESOURCE (R-4.6)** — `VoiceState` holds no engine and no `cpal`
//!   stream; the `cpal` stream is constructed ONLY inside the session worker
//!   (`worker_main`).
//! - **OPT-IN (R-5.4)** — the frontend voice default is `false` and is the value
//!   actually handed to `usePersistedSetting`.
//! - **NO-PANIC (REQ-NF5)** — the shipped voice region contains no `unwrap()` /
//!   `expect(` / `panic!` / `unreachable!`.
//! - **ONE MODEL-AUDIO PATH (#2914)** — no sherpa/ONNX engine, no STT model
//!   manifest pin, no local-transcription branch and no speech-handling key
//!   survive; every session accumulates the bounded model-audio clip and carries
//!   the model-audio phase + ceiling.
//! - **REQ-8 MODEL-AUDIO LOOPBACK-ONLY** — a `WHILE` invariant: the captured
//!   clip crosses the IPC boundary only (captured and taken inside
//!   `infrastructure/voice/`; the model transport names never appear there), and
//!   the managed delivery target is the loopback host
//!   (`DEFAULT_LLAMA_SERVER_HOST` = `127.0.0.1`, the launch-config default, and
//!   the ONE chat URL shell that templates the resolved host).
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

/// `(path relative to apps/ui/src, raw source)` for every `.ts`/`.tsx` file,
/// path-sorted. The #2914 UI absence pins (G-183 rows 14/16) scan the WHOLE
/// frontend tree so a residual consumer cannot hide in a file the Rust pin did
/// not name.
fn ui_sources() -> Vec<(String, String)> {
    let root = crate_root()
        .join("..")
        .join("..")
        .join("..")
        .join("apps")
        .join("ui")
        .join("src");
    let mut out = Vec::new();
    collect_ui_sources(&root, &root, &mut out);
    out.sort_by_key(|(name, _)| name.clone());
    out
}

fn collect_ui_sources(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let entries = std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("cannot list {}: {error}", dir.display()));
    for entry in entries {
        let path = entry.expect("readable ui source dir entry").path();
        if path.is_dir() {
            collect_ui_sources(root, &path, out);
        } else if matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("ts") | Some("tsx")
        ) {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((relative, read_source(&path)));
        }
    }
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
        "the model acquisition transport must remain the network-capable component (R-3.3)"
    );
}

/// R-4.6 — the capture stream is owned by the session worker alone; the app
/// holds nothing while idle. (#2914 re-point: the recognizer legs are gone with
/// the engine — there is no `Recognizer` to hold.)
#[test]
fn voice_state_holds_no_engine_and_the_worker_is_the_only_construction_site() {
    let source = read_source(&voice_dir().join("session.rs"));
    let code = mask(production_region(&source));

    let state = item_span(&code, "struct VoiceState");
    assert!(
        state.contains("Mutex<Option<ActiveSession>>"),
        "VoiceState must hold only the active-session slot: {state}"
    );
    for forbidden in ["cpal", "Stream"] {
        assert!(
            !state.contains(forbidden),
            "VoiceState must not hold `{forbidden}` (R-4.6 lazy capture)"
        );
    }

    let session = item_span(&code, "struct ActiveSession");
    for forbidden in ["cpal", "Stream"] {
        assert!(
            !session.contains(forbidden),
            "ActiveSession must not hold `{forbidden}` (R-4.6)"
        );
    }

    let constructor = item_span(&code, "impl VoiceState");
    assert!(
        constructor.contains("Mutex::new(None)"),
        "VoiceState must start empty — no eager resource"
    );

    let worker = item_span(&code, "fn worker_main(");
    assert!(
        worker.contains("capture::start_capture("),
        "worker_main is capture's construction site (R-4.6)"
    );
    assert!(
        !worker.contains("load_recognizer"),
        "worker_main must not construct a recognizer — the engine is deleted (#2914)"
    );
    assert_eq!(
        occurrences(&code, "capture::start_capture("),
        1,
        "session.rs must open capture in exactly one place — the worker"
    );
}

/// R-4.6 crate-wide: nothing outside the session worker opens a device, and the
/// only audio host is `capture.rs`. (#2914 re-point: the recognizer/engine leg is
/// gone — there is no engine construction site to confine.)
#[test]
fn engine_and_capture_construction_is_confined_crate_wide() {
    let mut capture_files = Vec::new();
    let mut cpal_files = Vec::new();
    for (file, production) in crate_production_sources() {
        let code = mask(&production);
        if code.contains("start_capture(") {
            capture_files.push(file.clone());
        }
        if code.contains("cpal::") {
            cpal_files.push(file.clone());
        }
    }

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

/// R-5.4 — voice input is opt-in: the frontend enable default is `false` and is
/// the value actually passed to persistence. (#2914: the autosend toggle was
/// removed with the transcript path, so only the enable leg remains.)
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
        source.contains("export const DEFAULT_VOICE_ENABLED = false;"),
        "voice enablement must default to false (R-5.4 opt-in)"
    );
    assert!(
        source.contains("VOICE_ENABLED_SETTING_KEY, DEFAULT_VOICE_ENABLED"),
        "the false default must be the persisted default, not dead copy (R-5.4)"
    );
}

/// REQ-NF5 — no panic-capable call on any shipped capture/failure path.
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

/// #2914 (G-183 row 7 replacement) — no STT model manifest pin survives: the
/// crate declares no sherpa/ONNX engine and references no engine/manifest
/// symbol (SA-10/SA-11). A green scan of ALL shipped crate sources proves the
/// removal is confined and complete; the manifest + lockfile are checked too so
/// a lingering dependency entry cannot hide there.
#[test]
fn no_stt_manifest_pin_survives() {
    for (file, production) in crate_production_sources() {
        let code = mask(&production);
        for symbol in [
            "STT_SUBDIR",
            "STT_REVISION",
            "STT_HF_REPO",
            "STT_DEFAULT_MANIFEST",
            "STT_TOTAL_BYTES",
            "resolve_stt_manifest",
            "sherpa",
            "sherpa_onnx",
            "SherpaRecognizer",
            "OnlineRecognizer",
            "Recognizer",
            "ResidentEngine",
        ] {
            assert!(
                !code.contains(symbol),
                "{file} must not reference `{symbol}` — no STT model pin survives (#2914 / SA-11)"
            );
        }
    }

    let cargo = read_source(&crate_root().join("Cargo.toml"));
    assert!(
        !cargo.contains("sherpa"),
        "Cargo.toml must not declare the sherpa-onnx dependency (#2914 / SA-10/SA-11)"
    );

    // The lockfile is the dependency-closure record: a stale entry here would
    // make `--locked` fetch/retain the native archive (SA-10/SA-11).
    let lock = read_source(&crate_root().join("Cargo.lock"));
    assert!(
        !lock.contains("sherpa"),
        "Cargo.lock must not retain any sherpa-onnx entry (#2914 / SA-10/SA-11)"
    );
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
/// configuration default and the ONE chat URL shell all resolve to `127.0.0.1`,
/// and every chat request resolves its host through that shell — never a
/// hardcoded remote endpoint.
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
    // templated, so the audio delivery can only address the managed server.
    // `format!` strings are blanked by `mask()`, hence the raw text.
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
    // host through `server_host`; the audio delivery reuses this ONE shell.
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

    // The audio delivery command must route through the managed chat module —
    // never its own transport/URL.
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
/// the managed loopback client. The scan is positive-controlled on the SHIPPED
/// `llm_chat_with_image` surface, so an audio-only green is provably not a
/// scanner that matches nothing.
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

// ── ONE MODEL-AUDIO PATH (#2914) ─────────────────────────────────────────────
//
// #2914 deletes the on-device engine and the `local` transcription mode. Every
// session now accumulates the bounded model-audio clip. These pins assert the
// removal is complete and that the surviving path still carries the model-audio
// phase + ceiling. They replace the #2897 REQ-2 local-path pins one-for-one
// (G-183); no assertion was deleted without its stated replacement.

/// #2914 (G-183 row 10 replacement) — the handling key is never read: there is
/// exactly ONE speech path, so no code path consults a persisted handling mode.
/// The UI leg (achievable once the launcher/context shim landed) pins the same
/// absence in `CompanionContext.tsx`. The ONE per-input ceiling that bounds the
/// surviving path is pinned here too.
#[test]
fn the_voice_handling_key_is_never_read_and_the_clip_ceiling_is_pinned() {
    for (file, production) in crate_production_sources() {
        let code = mask(&production);
        for symbol in [
            "VOICE_HANDLING_KEY",
            "VOICE_HANDLING_SETTING_KEY",
            "parse_voice_handling",
            "persisted_voice_handling",
            "VoiceHandling",
            "DEFAULT_VOICE_HANDLING",
        ] {
            assert!(
                !code.contains(symbol),
                "{file} must not read `{symbol}` — the handling key is never read (#2914 / SA-14)"
            );
        }
    }

    // UI leg (G-183 row 10): the settings context no longer carries or reads a
    // speech-handling mode — `voiceHandling`/`DEFAULT_VOICE_HANDLING`/
    // `VOICE_HANDLING_SETTING_KEY` were deleted with the local path (SA-14).
    let context = ui_source("shared/contexts/CompanionContext.tsx");
    for symbol in [
        "voiceHandling",
        "DEFAULT_VOICE_HANDLING",
        "VOICE_HANDLING_SETTING_KEY",
    ] {
        assert!(
            !context.contains(symbol),
            "CompanionContext.tsx must not carry `{symbol}` — one speech path (#2914 / SA-14)"
        );
    }

    // The ONE pinned ceiling bounding the surviving model-audio path.
    let state = production_text("infrastructure/voice/state.rs");
    assert!(
        state.contains("pub const MAX_AUDIO_CLIP_MS: u64 = 30_000;"),
        "the pinned per-input ceiling must stay 30_000 ms (NFR-2)"
    );

    // The relocated audio-domain constants keep their shipped values.
    let capture = production_text("infrastructure/voice/capture.rs");
    assert!(
        capture.contains("pub const AUDIO_SAMPLE_RATE: u32 = 16_000;"),
        "the audio sample rate must stay 16 000 Hz (NFR-2)"
    );
    assert!(
        capture.contains("pub const CAPTURE_CHUNK_SAMPLES: usize = 3200;"),
        "the capture chunk must stay 3200 samples (NFR-2)"
    );
}

/// #2914 (G-183 row 11 replacement) — every session runs the model-audio loop:
/// `worker_main` has exactly ONE arm calling `run_model_audio_session`, and the
/// deleted engine/recognition symbols are gone.
#[test]
fn every_session_runs_the_model_audio_loop() {
    let code = source_code("infrastructure/voice/session.rs");

    let worker = item_span(&code, "fn worker_main(");
    assert_eq!(
        occurrences(worker, "run_model_audio_session("),
        1,
        "the worker must have exactly ONE arm — the model-audio loop: {worker}"
    );
    assert!(
        !worker.contains("match mode"),
        "the worker must not branch on a handling mode: {worker}"
    );

    for banned in ["load_recognizer", "run_recognition", "acquire_engine", "park_engine"] {
        assert!(
            !code.contains(banned),
            "session.rs must not contain `{banned}` — the local path is deleted (#2914)"
        );
    }
}

/// #2914 (G-183 row 12 replacement) — every session carries the model-audio
/// phase + ceiling: a start emits `capturing` + `limitMs`, a stop emits
/// `processing` + `limitReached`.
#[test]
fn every_session_carries_the_model_audio_phase_and_ceiling() {
    let code = source_code("infrastructure/voice/session.rs");

    let start = item_span(&code, "pub async fn start(");
    assert!(
        start.contains("Some(SttPhaseWire::Capturing)"),
        "a started session must report the capturing phase: {start}"
    );
    assert!(
        start.contains("Some(MAX_AUDIO_CLIP_MS)"),
        "a started session must advertise the pinned ceiling: {start}"
    );

    let finish = item_span(&code, "async fn finish(");
    assert!(
        finish.contains("Some(SttPhaseWire::Processing)"),
        "a stopped session must report the processing phase: {finish}"
    );
    assert!(
        finish.contains("limit_reached") && finish.contains("MAX_AUDIO_CLIP_MS"),
        "a stopped session must report the limit flag + the pinned ceiling: {finish}"
    );
}

/// REQ-2 — the clip slot is populated ONLY by the model-audio session:
/// `stt_take_audio_clip` only ever returns what a session committed, and the
/// path has no other writer. Pinned at the source: `lock_clip(..) = Some(..)`
/// occurs exactly once (inside the model-audio session). (#2914 re-point: the
/// handling-mode legs are gone — there is only this ONE path.)
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

    // `take_clip` is the IPC reader: it takes + clears, and is the ONLY path that
    // hands the clip out of `voice/`.
    let take = item_span(&code, "fn take_clip(");
    assert!(
        take.contains("guard.take()"),
        "taking the clip must be destructive (a second take is empty): {take}"
    );

    // A new listen clears any stale clip, so a re-listen can never deliver a
    // previous session's audio.
    let start = item_span(&code, "pub async fn start(");
    assert!(
        start.contains("*lock_clip(&state) = None"),
        "a new listen must invalidate any stale clip: {start}"
    );
}

/// #2914 (G-183 row 14 replacement) — no local transcription path remains: the
/// recognition loop, the transcript sink and the transcript wire type are all
/// gone from the shipped crate (SA-2/SA-11), and the launcher sources carry no
/// `voiceMode` gate, no dictated-transcript write into the bar and no
/// `modelVoice` transcript suppression.
#[test]
fn no_local_transcription_path_remains() {
    for (file, production) in crate_production_sources() {
        let code = mask(&production);
        for symbol in [
            "run_recognition",
            "TranscriptSink",
            "AppHandleSink",
            "SttTranscriptEvent",
            "load_recognizer",
        ] {
            assert!(
                !code.contains(symbol),
                "{file} must not reference `{symbol}` — no local transcription path remains (#2914)"
            );
        }
    }

    // UI leg (G-183 row 14): the launcher has ONE model-audio path. Comments are
    // masked, so a doc reference to the FORMER local path cannot satisfy the pin.
    let shell = mask(&ui_source("features/home/components/launcher/LauncherShell.tsx"));
    let bar = mask(&ui_source(
        "features/home/components/launcher/LauncherCommandBar.tsx",
    ));
    for (name, code) in [
        ("LauncherShell.tsx", shell.as_str()),
        ("LauncherCommandBar.tsx", bar.as_str()),
    ] {
        assert!(
            !code.contains("voiceMode"),
            "{name} must not carry a `voiceMode` gate — there is no local mode (#2914)"
        );
        assert!(
            !code.contains("modelVoice"),
            "{name} must not carry `modelVoice` transcript suppression (#2914)"
        );
    }
    assert!(
        !shell.contains("finalTranscript"),
        "LauncherShell.tsx must not write a dictated transcript into the bar (#2914)"
    );
    assert!(
        !shell.contains("dictated"),
        "LauncherShell.tsx must not carry dictated-transcript provenance (#2914)"
    );
}

/// #2914 — the #2887 `readyMs` observable is untouched by the removal: the
/// start-success state still carries the receipt-based `readyMs`. (#2914
/// re-point: the engine-residency legs are gone with the engine — there is no
/// residency to stamp.)
#[test]
fn local_start_still_stamps_the_receipt_based_ready_ms_and_residency() {
    let code = source_code("infrastructure/voice/session.rs");

    // `readyMs` is measured from the receipt at capture-live, never a constant.
    assert!(
        code.contains("ready_ms: elapsed_ms(receipt),"),
        "readyMs must be the receipt → capture-live elapsed time (R-1)"
    );

    // The start-success path stamps the observable from the resolved value.
    let start = item_span(&code, "pub async fn start(");
    assert!(
        start.contains("Some(info.ready_ms),"),
        "the start-success state must carry the honest receipt-based readyMs: {start}"
    );
    assert!(
        !code.contains("engine_resident") && !code.contains("engineResident"),
        "the removed engine-residency observable must not reappear (#2914)"
    );
}

/// #2914 (G-183 row 16 replacement) — `stt:transcript` is never emitted (no
/// recognizer in the shipped crate) and never consumed (no UI registration
/// anywhere under `apps/ui/src`).
#[test]
fn stt_transcript_is_never_emitted() {
    for (file, production) in crate_production_sources() {
        assert!(
            !production.contains("stt:transcript"),
            "{file} must not produce `stt:transcript` — there is no recognizer (#2914)"
        );
        let code = mask(&production);
        assert!(
            !code.contains("transcript"),
            "{file} must not carry a transcript symbol — the transcript path is deleted (#2914)"
        );
    }

    // UI leg (G-183 row 16): no consumer registers the retired event. Scanning
    // the WHOLE frontend tree means a residual consumer cannot hide in a file
    // the pin did not name.
    let sources = ui_sources();
    assert!(
        sources
            .iter()
            .any(|(name, _)| name == "shared/hooks/useVoiceDictation.ts"),
        "the UI source walk must see the voice hook (the scan is not vacuous)"
    );
    for (name, source) in &sources {
        for registration in ["register('stt:transcript'", "register(\"stt:transcript\""] {
            assert!(
                !source.contains(registration),
                "{name} must not register the retired `stt:transcript` event (#2914 / G-183 row 16)"
            );
        }
    }
}
