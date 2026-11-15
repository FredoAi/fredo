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
use std::path::PathBuf;

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

    tauri_build::build();

    // Restore original config so the working tree stays clean
    if let Some((_config_path, backup_path, original)) = restore {
        fs::write(&_config_path, original.as_bytes())
            .expect("Failed to restore tauri.conf.json");
        fs::remove_file(&backup_path).expect("Failed to remove config backup");
    }
}
