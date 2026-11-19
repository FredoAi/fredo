// ── Spec #3158 ST-1: the shipped `dynamic-link` engine payload ────────────────
//
// `llama-cpp-4` is built with `dynamic-link` (see `Cargo.toml` — the EXECUTED
// gate chose it: static archives do not propagate private deps). That means
// `ggml*.dll` / `llama*.dll` / `mtmd.dll` must sit BESIDE `fredo.exe`. The GPU
// backend is Vulkan only (no `ggml-cuda`), so the payload is the ggml/llama/mtmd
// DLLs plus the Vulkan loader (`vulkan-1.dll`).
//
// SHIPPED WIRING (recorded here because `tauri.conf.json` is strict JSON and
// cannot carry a comment; this build script is the file that owns the bundle
// wiring):
//
//   * `tauri.conf.json` declares `bundle.resources` as the DIRECTORY map
//     `{ "engine-payload/": "" }` — a map entry, not a glob. A `*` glob that
//     matches nothing raises `GlobPathNotFound`, and a missing directory raises
//     `ResourcePathNotFound`; an EMPTY directory is a legal no-op, so plain
//     `cargo check` / `cargo build` stay green on a tree with nothing staged.
//   * The payload is staged into `engine-payload/` by the Tauri CLI's
//     `build.beforeBundleCommand` (`.opencode/scripts/stage-engine-payload.ps1`).
//     That hook is executed by the bundler only — never by `cargo check` /
//     `cargo build` — so those commands never depend on a staged payload.
//   * This script PRE-CREATES `engine-payload/` before `tauri_build` runs so the
//     resource path always resolves. Do NOT add a
//     `cargo:rerun-if-changed=engine-payload` line: the directory changes on
//     every bundle and would force the build script to re-run needlessly.
//   * `bundle.externalBin` stays `[]` — an invariant, and the engine DLLs are
//     NOT sidecar binaries.
//   * The build NEVER rewrites `tauri.conf.json`. A previous CI-only branch
//     swapped the config for a copy with `bundle.resources` cleared and restored
//     it afterward; that mechanism is deleted, so no build (on CI or locally) can
//     empty the shipped payload — and a killed build can no longer leave a
//     modified config plus a stray `tauri.conf.json.bak` in the tree.
//
// The manifest source for the engine crate is the crates.io registry
// (`llama-cpp-4 = "0.11.0"`), deliberately not a git/path dependency — see the
// `Cargo.toml` comment for the feature set and its justification.

use std::fs;
use std::path::Path;

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

    // Spec #3158 ST-1 — make the shipped `bundle.resources` path resolvable.
    //
    // `tauri.conf.json` ships the engine payload as the directory map entry
    // `{ "engine-payload/": "" }`. `tauri_build` errors with
    // `ResourcePathNotFound` when a resources path is ABSENT, but an EMPTY
    // directory is a legal no-op. Pre-create it so plain `cargo check` /
    // `cargo build` stay green on a fresh tree where nothing has been staged
    // yet; the bundler's `beforeBundleCommand` fills it before packaging.
    // Deliberately NO `cargo:rerun-if-changed=engine-payload` — the directory
    // changes on every bundle and would force needless build-script re-runs.
    fs::create_dir_all("engine-payload")
        .expect("failed to create the engine-payload staging directory");

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
