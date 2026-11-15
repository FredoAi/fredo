//! Spec #3141 ST-6 (R-17.2 / R-17.3) — STATIC absence pins for the retired
//! out-of-process companion runtime.
//!
//! This target reads the shipped crate sources as TEXT
//! (`env!("CARGO_MANIFEST_DIR")`) and asserts the migration is COMPLETE:
//!
//! 1. **Zero `llama-server` process spawn sites** — no `Command::new` addresses a
//!    `llama-server` image, and no spawn helper survives.
//! 2. **Zero command registrations for the deleted commands.**
//! 3. **Zero machine-global executable resolution** — no PATH/winget/configured
//!    path lookup remains.
//!
//! Every absence pin is paired with a NON-VACUITY CONTROL: the same predicate is
//! applied to a seeded hit and must CATCH it, so a scanner that matches nothing
//! can never pass (G-430).

use std::path::{Path, PathBuf};

/// `apps/tauri/src-tauri` — the crate root, resolved by Cargo.
fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// `(path relative to src/, raw source)` for every Rust file under `src/`,
/// path-sorted.
fn crate_sources() -> Vec<(String, String)> {
    let root = crate_root().join("src");
    let mut out = Vec::new();
    collect(&root, &root, &mut out);
    out.sort_by_key(|(name, _)| name.clone());
    out
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let entries = std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("cannot list {}: {error}", dir.display()));
    for entry in entries {
        let path = entry.expect("readable source dir entry").path();
        if path.is_dir() {
            collect(root, &path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((relative, read_source(&path)));
        }
    }
}

/// Blank every comment and string literal, preserving byte offsets, so a scan
/// matches CODE symbols only.
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

/// The shipped (non-`#[cfg(test)]`) region of a source file.
fn production_region(source: &str) -> &str {
    match mask(source).find("#[cfg(test)]") {
        Some(index) => &source[..index],
        None => source,
    }
}

/// The companion-reserved symbols the retired runtime owned. These names are
/// unique to the companion surface (the PostgreSQL supervisor has its OWN
/// independent `persist_pid`/`sweep_orphan`, which are NOT these), so a
/// crate-wide scan is meaningful for them.
fn retired_runtime_violations(code: &str) -> Vec<&'static str> {
    let mut hits = Vec::new();
    for symbol in [
        // The spawn / supervision helpers of the deleted `process.rs`.
        "spawn_server(",
        "select_active_port(",
        "kill_process_tree(",
        "is_llama_server_image(",
        "LLAMA_SERVER_IMAGE",
        // The deleted readiness poll.
        "wait_until_healthy(",
        "ReqwestHealthClient",
        "HealthProbeSource",
        // The deleted managed-process slot.
        "LlamaServerState",
        "ManagedServer",
        // The deleted executable resolver.
        "resolve_llama_server",
        "LLAMA_SERVER_SETTING_KEY",
        "LLAMA_SERVER_BIN",
        "winget_links_shim",
        "find_on_path",
        // The deleted commands.
        "generate_llama_server_config",
        "install_llama_cpp",
        "probe_companion_skills",
        "companion_status_capability",
    ] {
        if code.contains(symbol) {
            hits.push(symbol);
        }
    }
    hits
}

// ── (1) Zero `llama-server` process spawn sites ─────────────────────────────

/// R-17.2 / R-17.3: NO shipped source spawns, supervises, or resolves a
/// `llama-server` process. The scan is positive-controlled below.
#[test]
fn no_shipped_source_carries_a_llama_server_spawn_or_resolution_site() {
    let sources = crate_sources();
    assert!(
        !sources.is_empty(),
        "the source walk must see the crate (not vacuous)"
    );
    for (file, source) in &sources {
        let code = mask(production_region(source));
        let violations = retired_runtime_violations(&code);
        assert!(
            violations.is_empty(),
            "{file} still carries retired runtime symbols: {violations:?}"
        );
    }

    // NON-VACUITY CONTROL: a seeded spawn + resolution hit must be caught.
    let seeded = "fn x() { spawn_server(&config, &log); resolve_llama_server(&app); }";
    let hits = retired_runtime_violations(&mask(seeded));
    assert!(
        hits.contains(&"spawn_server("),
        "the spawn predicate must catch a seeded hit: {hits:?}"
    );
    assert!(
        hits.contains(&"resolve_llama_server"),
        "the resolution predicate must catch a seeded hit: {hits:?}"
    );
}

/// The RAW spawn-target guard: every `Command::new(...)` in shipped code is
/// inspected, and none addresses the retired binary (nor a launch-config
/// executable field). This scans the raw text on purpose — a doc/comment token
/// is not a spawn site (QA F-2), so only the call's own argument list is judged.
#[test]
fn no_command_new_addresses_the_llama_server_image() {
    for (file, source) in &crate_sources() {
        let production = production_region(source);
        let mut rest = production;
        while let Some(at) = rest.find("Command::new(") {
            let call = &rest[at..];
            let end = call.find(')').unwrap_or(call.len());
            let argument = &call[..end];
            assert!(
                !argument.contains("llama-server") && !argument.contains("config.executable"),
                "{file} spawns the retired binary: {argument}"
            );
            rest = &call[end..];
        }
    }

    // NON-VACUITY CONTROL: a seeded spawn call is caught by the same slice.
    let seeded = "let mut command = std::process::Command::new(&config.executable);";
    let at = seeded.find("Command::new(").expect("seeded call");
    let call = &seeded[at..];
    let end = call.find(')').unwrap_or(call.len());
    assert!(
        call[..end].contains("config.executable"),
        "the spawn-slice predicate must catch a seeded executable spawn"
    );
}

// ── (2) Zero command registrations for the deleted commands ─────────────────

/// The four commands ST-6 deletes must not be registered (or even mentioned in
/// shipped code) anywhere in the crate.
#[test]
fn no_deleted_command_is_registered() {
    const DELETED: [&str; 4] = [
        "generate_llama_server_config",
        "install_llama_cpp",
        "probe_companion_skills",
        "companion_status_capability",
    ];

    let lib = read_source(&crate_root().join("src").join("lib.rs"));
    for command in DELETED {
        assert!(
            !lib.contains(command),
            "lib.rs still registers/mentions the deleted command `{command}`"
        );
    }
    // NON-VACUITY CONTROL: a seeded registration line is caught.
    let seeded = "applications::setup::commands::install_llama_cpp,";
    assert!(
        DELETED.iter().any(|command| seeded.contains(command)),
        "the registration predicate must catch a seeded deleted command"
    );

    // No shipped source declares the deleted command either.
    for (file, source) in &crate_sources() {
        let code = mask(production_region(source));
        for command in DELETED {
            assert!(
                !code.contains(command),
                "{file} still declares or calls the deleted command `{command}`"
            );
        }
    }
}

// ── (3) Zero machine-global executable resolution ───────────────────────────

/// R-17.2: the companion runtime is resolved from the Fredo installation only —
/// there is no PATH/winget/configured-path lookup left, and the resolver module
/// is deleted.
#[test]
fn no_machine_global_executable_resolution_remains() {
    assert!(
        !crate_root()
            .join("src")
            .join("infrastructure")
            .join("companion")
            .join("resolver.rs")
            .exists(),
        "the retired executable resolver module must be deleted"
    );

    for (file, source) in &crate_sources() {
        let code = mask(production_region(source));
        for symbol in [
            "LLAMA_SERVER_SETTING_KEY",
            "LLAMA_SERVER_BIN",
            "winget_links_shim",
            "find_on_path",
            "WINGET_APP_ID",
            "WINGET_BIN",
        ] {
            assert!(
                !code.contains(symbol),
                "{file} still carries the retired machine-global resolution symbol `{symbol}`"
            );
        }
    }

    // NON-VACUITY CONTROL: a seeded lookup helper is caught.
    let seeded = "fn find_on_path(bin: &str) -> Option<PathBuf> { None }";
    assert!(mask(seeded).contains("find_on_path"));
}

// ── (4) The externalBin position ────────────────────────────────────────────

/// The migration adds NO shipped sidecar: `bundle.externalBin` must stay `[]`.
#[test]
fn the_bundle_external_bin_stays_empty() {
    let config = read_source(&crate_root().join("tauri.conf.json"));
    let parsed: serde_json::Value = serde_json::from_str(&config).expect("valid tauri.conf.json");
    let external_bin = &parsed["bundle"]["externalBin"];
    assert_eq!(
        external_bin,
        &serde_json::json!([]),
        "bundle.externalBin must stay [] — there is no shipped llama-server sidecar"
    );
}
