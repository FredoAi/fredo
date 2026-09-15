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
//! - **R-4.6 NO IDLE RESOURCE** — the recognizer and the `cpal` stream are
//!   constructed only inside the session worker (`worker_main`); `VoiceState`
//!   holds neither, and no other module constructs them (nothing is held or
//!   built at app launch).
//! - **R-5.4 OPT-IN** — the frontend voice defaults are `false` and are the
//!   values actually handed to `usePersistedSetting`.
//! - **REQ-NF5 NO-PANIC** — the shipped voice region contains no `unwrap()` /
//!   `expect(` / `panic!` / `unreachable!`.
//! - **G-128 MANIFEST PINS** — `STT_TOTAL_BYTES` and the four pinned STT files
//!   (ids, paths, sizes, SHA-256) are the verified #2876 values.
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

/// R-4.6 crate-wide: nothing outside the session worker builds the engine or
/// opens a device, so a cold app holds no recognizer and no microphone.
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
            "infrastructure/voice/session.rs"
        ],
        "the recognizer may only be defined in engine.rs and built in the session worker (R-4.6)"
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
