//! Engine integration test — the ST-1 "constructs the engine twice" gate
//! (Spec #3141, ST-1; AC-22.1 / AC-23.1 / AC-24.2 / AC-25).
//!
//! ## What this proves
//!
//! * The engine constructs in BOTH offload shapes: once requesting FULL offload
//!   (`auto`/`gpu` ⇒ `u32::MAX` layers) and once requesting ZERO offload
//!   (`cpu` ⇒ `0` layers) — the offload-request discriminator (R-24.2).
//! * `gpu` mode against a CPU-only enumeration is the typed `GpuUnavailable`
//!   refusal, never a silent CPU fallback (AC-25).
//! * `auto` mode against a CPU-only enumeration STARTS on the CPU (AC-23.1).
//!
//! ## The hard gate (G-314 / G-222) — an EXPLICIT named blocker, never silent
//!
//! A REAL construction needs the three pinned GGUF files (`models.rs`), which
//! live OUTSIDE the repo and are not a test fixture (G-172). When they are
//! absent this test FAILS LOUDLY with the exact missing-file list rather than
//! passing vacuously or being `#[ignore]`d silently. Set
//! `FREDO_COMPANION_MODELS_DIR` to a manifest-shaped dir to run it.
//!
//! ## The force-CPU seam is process-global
//!
//! The two seam-driving tests mutate `FREDO_COMPANION_FORCE_CPU`, a
//! process-global. They hold [`ENV_LOCK`] for their whole duration so they can
//! never observe each other's value (G-222: no cross-test env race).

use std::path::PathBuf;
use std::sync::Mutex;

use crate::applications::llm_server::engine::handle::{CompanionEngineHandle, DEFAULT_START_BUDGET};
use crate::applications::llm_server::engine::paths;
use crate::applications::llm_server::engine::{
    CompanionBackendKind, CompanionBackendMode, CompanionEngineErrorCode,
};
use crate::applications::llm_server::engine::device::COMPANION_FORCE_CPU_ENV;
use crate::infrastructure::companion::models::default_manifest;

/// Serialises the tests that mutate the process-global force-CPU env var.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// The models dir the engine integration test loads from.
///
/// `FREDO_COMPANION_MODELS_DIR` when set, else the product default
/// (`{home}/fredo-models`) — the SAME rule `resolve_models_dir` uses. Nothing
/// here invents a second location.
fn models_dir() -> PathBuf {
    match std::env::var("FREDO_COMPANION_MODELS_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir.trim()),
        _ => std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(PathBuf::from)
            .map(|home| home.join("fredo-models"))
            .unwrap_or_else(|_| PathBuf::from(".").join("fredo-models")),
    }
}

/// A real construction needs the pinned GGUF trio. When absent, fail with the
/// exact named blocker (never a vacuous pass, never a silent skip).
fn require_models(dir: &std::path::Path) -> paths::EnginePaths {
    let manifest = default_manifest();
    match paths::resolve_for_app(dir, &manifest) {
        Ok(paths) => paths,
        Err((code, detail)) => panic!(
            "ST-1 engine gate BLOCKED (named): {code:?} — {detail}. \
             This test needs the three pinned GGUF files under {} (set \
             FREDO_COMPANION_MODELS_DIR to point at them). This is an EXPLICIT \
             environment blocker, NOT a skipped test.",
            dir.display()
        ),
    }
}

/// AC-22.1 / AC-24.2: the engine constructs TWICE — once requesting full
/// offload, once requesting zero offload — and both reach a terminal status.
///
/// Each construction uses its own engine handle (the backend is process-once, so
/// the two runs are sequential and the first handle is dropped before the second
/// starts — which releases the backend for the second `init`).
#[test]
fn engine_constructs_twice_full_offload_then_zero_offload() {
    let dir = models_dir();
    let model_paths = require_models(&dir);

    // Leg 1: full offload (`auto` ⇒ u32::MAX layers requested).
    let full = {
        let handle = CompanionEngineHandle::spawn_with_budget(DEFAULT_START_BUDGET);
        let result = handle.start(model_paths.clone(), CompanionBackendMode::Auto);
        handle.stop();
        result
    };
    assert!(
        full.success,
        "full-offload construction must succeed: {:?} — {}",
        full.code, full.detail
    );
    assert!(full.backend.is_some(), "a loaded engine must report a backend");
    assert!(
        !full.devices.is_empty(),
        "a loaded engine must report ggml devices"
    );

    // Leg 2: zero offload (`cpu` ⇒ 0 layers requested). The backend is released
    // when the first handle is dropped, so this second `init` is legitimate.
    let zero = {
        let handle = CompanionEngineHandle::spawn_with_budget(DEFAULT_START_BUDGET);
        let result = handle.start(model_paths, CompanionBackendMode::Cpu);
        handle.stop();
        result
    };
    assert!(
        zero.success,
        "zero-offload construction must succeed: {:?} — {}",
        zero.code, zero.detail
    );
    // `cpu` mode must report a CPU backend (never over-claim a GPU — AC-23.2).
    assert_eq!(
        zero.backend,
        Some(CompanionBackendKind::Cpu),
        "cpu mode must report the CPU backend when no force seam is engaged"
    );
}

/// AC-25: `gpu` mode on a machine with no usable GPU is a typed `GpuUnavailable`
/// refusal, never a silent CPU fallback. Driven through the FORCE-CPU seam so it
/// is provable on ANY host (including one WITH a GPU), which is the whole point
/// of the seam (G-409/G-275).
#[test]
fn gpu_mode_refuses_when_the_forced_enumeration_is_cpu_only() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // The seam must be set BEFORE the start reads it (the handle reads it inside
    // `start`). `ENV_LOCK` guarantees no other test observes this value.
    std::env::set_var(COMPANION_FORCE_CPU_ENV, "1");

    let dir = models_dir();
    let model_paths = require_models(&dir);

    let handle = CompanionEngineHandle::spawn_with_budget(DEFAULT_START_BUDGET);
    let result = handle.start(model_paths, CompanionBackendMode::Gpu);
    handle.stop();

    std::env::remove_var(COMPANION_FORCE_CPU_ENV);

    assert!(!result.success, "gpu mode must refuse a CPU-only enumeration");
    assert_eq!(
        result.code,
        Some(CompanionEngineErrorCode::GpuUnavailable),
        "the refusal must be the typed GpuUnavailable code: {}",
        result.detail
    );
}

/// AC-23.1: `auto` mode against a forced CPU-only enumeration STARTS on the CPU
/// (no refusal) — the GPU-less-machine path.
#[test]
fn auto_mode_starts_on_a_forced_cpu_enumeration() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::env::set_var(COMPANION_FORCE_CPU_ENV, "1");

    let dir = models_dir();
    let model_paths = require_models(&dir);

    let handle = CompanionEngineHandle::spawn_with_budget(DEFAULT_START_BUDGET);
    let result = handle.start(model_paths, CompanionBackendMode::Auto);
    handle.stop();

    std::env::remove_var(COMPANION_FORCE_CPU_ENV);

    assert!(
        result.success,
        "auto mode must fall back to CPU, not fail: {:?} — {}",
        result.code, result.detail
    );
    assert_eq!(
        result.backend,
        Some(CompanionBackendKind::Cpu),
        "auto mode on a forced CPU-only enumeration must report the CPU backend"
    );
    assert_eq!(result.devices.len(), 1, "the forced set is exactly one device");
}
