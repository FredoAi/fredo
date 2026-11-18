// ── Spec #3141 ST-1: the `dynamic-link` payload decision ──────────────────────
//
// `llama-cpp-4` is built with `dynamic-link` (see `Cargo.toml` — the EXECUTED
// gate chose it: static archives do not propagate private deps). That means
// `ggml*.dll` / `llama*.dll` must sit BESIDE `fredo.exe`. The GPU backend is
// Vulkan only (no `ggml-cuda`), so the payload is the ggml/llama/mtmd DLLs.
//
// DECISION (recorded here because `tauri.conf.json` is strict JSON and cannot
// carry a comment; this build script is the file that owns the bundle wiring):
//
//   * `bundle.externalBin` stays `[]` — it is an invariant of this spec, and
//     the engine DLLs are not sidecar binaries.
//   * `bundle.resources` is deliberately NOT populated in ST-1. The DLLs are
//     produced by `llama-cpp-sys-4`'s build script under the CARGO TARGET dir
//     (`<target>/<profile>/`), which is where Cargo's DLL search path already
//     finds them for `cargo run` / `cargo test` — so developer runs load them
//     with no config entry.
//   * Shipping them in the INSTALLER is a release-packaging concern (installer
//     artifact leg), and wiring it here in ST-1 would be unverifiable and
//     breakage-prone for three concrete reasons, none of which ST-1 can settle
//     without an executed release bundle:
//       1. a `bundle.resources` glob that matches nothing makes
//          `tauri_build` hard-error (`GlobPathNotFound`) on every build,
//          including `cargo check` on a machine whose target dir lives
//          elsewhere (the shared worktree target-dir config makes a relative
//          `target/**` pattern resolve out of tree);
//       2. the CI branch below CLEARS `bundle.resources` before `tauri_build`,
//          so a resource entry added now would be silently dropped from the
//          release installer CI produces;
//       3. the GPU runtime redistributable set is a licensing/notices decision
//          (`docs/THIRD_PARTY_NOTICES.md`, AC-29). With the Vulkan-only
//          backend the payload is `vulkan-1.dll` (the loader) plus the
//          ggml/llama/mtmd DLLs; there is no CUDA runtime to redistribute.
//   * Follow-up owner: ST-6 (teardown/packaging) + the deployment installer
//     leg, which must bundle the engine + Vulkan DLLs via a matched
//     `bundle.resources` map and adjust the CI clear below in the same change.
//
// The manifest source for the engine crate is the crates.io registry
// (`llama-cpp-4 = "0.11.0"`), deliberately not a git/path dependency — see the
// `Cargo.toml` comment for the feature set and its justification.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// Spec #3147 ST-1 — the application command manifest.
//
// `src/runtime/command_manifest.rs` is the ONE list of registered application
// commands. It is `include!`-ed here rather than imported because this build
// script is a separate crate from the app; the file is deliberately
// import-free so the same source compiles in both places. Its `#[cfg(test)]`
// guards are inert in a build script (`cfg(test)` is not set here) and run as
// unit tests in the app crate.
mod command_manifest {
    include!("src/runtime/command_manifest.rs");
}

use command_manifest::COMMAND_MANIFEST;

fn main() {
    // NOTE: there is deliberately no CUDA import-library wiring here anymore.
    // Spec #3141 was re-scoped to a Vulkan-only GPU backend (see the
    // `llama-cpp-4` feature list in Cargo.toml for the build-cost rationale),
    // so `ggml-cuda` is never compiled and `cudart`/`cublas`/`cublasLt` have
    // nothing to resolve. `build.rs` previously emitted those link lines from
    // `CUDA_PATH`; that function is removed rather than left inert so a
    // future CUDA re-introduction is a deliberate, visible change.

    // CI environment variable is set to "true" by GitHub Actions (and other CI
    // providers). On CI runners, the OpenCode plugin dist doesn't exist, so we
    // temporarily clear bundle resources before the build and restore the
    // original config afterward. Locally (no CI), resources are left intact.
    let is_ci = env::var("CI").unwrap_or_default() == "true";

    let restore = if is_ci {
        let config_path = PathBuf::from("tauri.conf.json");
        let backup_path = PathBuf::from("tauri.conf.json.bak");

        let config_str =
            fs::read_to_string(&config_path).expect("Failed to read tauri.conf.json");

        let mut config: serde_json::Value =
            serde_json::from_str(&config_str).expect("Failed to parse tauri.conf.json");

        // Clear all bundle resources — none exist on CI
        if let Some(bundle) = config.get_mut("bundle") {
            if let Some(resources) = bundle.get_mut("resources") {
                *resources = serde_json::Value::Object(serde_json::Map::new());
            }
        }

        let filtered =
            serde_json::to_string_pretty(&config).expect("Failed to serialize config");

        // Swap: backup original, write filtered in its place
        fs::rename(&config_path, &backup_path)
            .expect("Failed to backup tauri.conf.json");
        fs::write(&config_path, filtered.as_bytes())
            .expect("Failed to write filtered tauri.conf.json");

        println!("cargo:warning=Bundle resources cleared (CI build)");

        Some((config_path.clone(), backup_path, config_str))
    } else {
        None
    };

    // Spec #3147 ST-1 — turn Tauri's IPC authority gate ON.
    //
    // Before this, `build.rs` called bare `tauri_build::build()`, which registers
    // NO application manifest. Tauri then skips the ACL check for app commands
    // entirely (`has_app_acl_manifest` is false; `webview/mod.rs` only denies
    // when `(plugin_command.is_some() || has_app_acl_manifest)`), so EVERY
    // registered command was callable from EVERY window regardless of label,
    // origin or capability.
    //
    // `AppManifest::commands(...)` creates the `__app-acl__` manifest. From then
    // on `resolve_access` runs for every command, and a window that matches no
    // capability is refused — which is exactly what gives an `installed-<id>`
    // window zero command access (AC-2).
    //
    // It also generates `allow-<command>`/`deny-<command>` permissions for each
    // listed command under `permissions/autogenerated/` (gitignored build
    // output; the hand-authored set lives under `permissions/app/**`). A
    // registered command that is NOT listed gets no permission, so it cannot be
    // granted and is denied in every built-in window — hence
    // `COMMAND_MANIFEST` must stay a superset of `generate_handler!`, which
    // `src/runtime/command_manifest.rs`'s unit test enforces.
    //
    // The built-in windows keep their full surface because
    // `capabilities/app-commands.json` grants the app-manifest `default`
    // permission set (`permissions/app/default.toml`) to exactly
    // `["main", "terminal", "doom", "app-*"]` — the same window class the
    // shipped capabilities already target. Installed windows (`installed-*`)
    // match neither, which is deliberate.

    // Spec #3152 -- see `prune_stale_autogenerated_permissions`. MUST run BEFORE
    // `try_build`, which derives the ACL manifest (and `gen/schemas/*`) from the
    // permission files currently on disk.
    println!("cargo:rerun-if-changed=permissions/autogenerated");
    println!("cargo:rerun-if-changed=src/runtime/command_manifest.rs");
    match prune_stale_autogenerated_permissions(Path::new("permissions/autogenerated")) {
        Ok(0) => {}
        Ok(pruned) => println!("pruned {pruned} stale autogenerated permission file(s)"),
        Err(error) => {
            println!("failed to prune stale autogenerated permissions: {error}");
            std::process::exit(1);
        }
    }

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMAND_MANIFEST));

    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }

    // Restore original config so the working tree stays clean
    if let Some((_config_path, backup_path, original)) = restore {
        fs::write(&_config_path, original.as_bytes())
            .expect("Failed to restore tauri.conf.json");
        fs::remove_file(&backup_path).expect("Failed to remove config backup");
    }
}

/// Spec #3152 -- delete autogenerated permission files for commands that are no
/// longer registered.
///
/// `tauri_build::AppManifest::commands(...)` (see `main`) autogenerates
/// `allow-<command>` / `deny-<command>` permission files under
/// `permissions/autogenerated/`, but it NEVER deletes one for a command that has
/// been removed from the list.  `tauri_build` then derives the ACL manifest and
/// `gen/schemas/*` from EVERY file on disk, so a dead grant for a delisted command
/// resurrects into tracked artifacts on every build.  Prune those files, always
/// before `try_build` derives the manifest.
///
/// Safety -- the delete predicate is the INTERSECTION of four independent checks:
///   1. the entry is a regular file with the `.toml` extension;
///   2. its name is `<command>.toml` for a bare command-shaped stem
///      (`[a-z0-9_]`, the same shape `command_manifest`'s unit test enforces);
///   3. its CONTENT carries the exact autogenerated header AND declares
///      `commands.allow|deny = ["<stem>"]` for its OWN stem -- so a hand-authored
///      file can never match (hand-authored permissions live in `permissions/app/**`
///      and do not carry the header);
///   4. that stem is ABSENT from `COMMAND_MANIFEST`, the single source of truth.
///
/// An emptied manifest is a no-op rather than a directory sweep, a missing directory is
/// a no-op (fresh checkout), and a second run deletes nothing (idempotent).
fn prune_stale_autogenerated_permissions(dir: &Path) -> std::io::Result<usize> {
    if COMMAND_MANIFEST.is_empty() {
        return Ok(0);
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut pruned = 0usize;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("toml") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !stem
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            continue;
        }
        if COMMAND_MANIFEST.contains(&stem) {
            continue;
        }
        let content = fs::read_to_string(&path)?;
        let declares_own_command = content.contains(&format!("commands.allow = [\"{stem}\"]"))
            || content.contains(&format!("commands.deny = [\"{stem}\"]"));
        if !content.contains("# Automatically generated - DO NOT EDIT!") || !declares_own_command
        {
            continue;
        }
        fs::remove_file(&path)?;
        pruned += 1;
    }
    Ok(pruned)
}
