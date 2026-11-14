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
//! ## The gate (G-314 / G-222) — a NAMED blocker, never a silent skip
//!
//! A REAL construction needs the three pinned GGUF files (`models.rs`), which
//! live OUTSIDE the repo and are not a test fixture (G-172). When they are
//! absent the gate SKIPS by name: it prints the exact missing-file list and the
//! lever that points it at a manifest-shaped dir (`FREDO_COMPANION_MODELS_DIR`),
//! and asserts nothing. That is the plan's "skipped only with an explicit named
//! blocker, never silently" — a hard panic here would instead turn every CI
//! runner (which has no models) red for an environment reason, not a defect.
//!
//! The PURE force-CPU rule ([`super::device::force_cpu_with`]) is pinned
//! separately and may never skip: it needs no model files at all.
//!
//! ## The force-CPU seam is process-global
//!
//! The two seam-driving tests mutate `FREDO_COMPANION_FORCE_CPU`, a
//! process-global. They hold [`ENV_LOCK`] for their whole duration so they can
//! never observe each other's value (G-222: no cross-test env race).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

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

/// A real construction needs the pinned GGUF trio.
///
/// When the trio is absent the gate SKIPS — loudly and by name, never silently:
/// it prints the exact missing-file list plus the lever to point the test at a
/// manifest-shaped dir, and returns `None` so the caller returns early. It never
/// passes vacuously (nothing is asserted on the skipped path) and never turns the
/// suite red on a host that simply has no models, which is every CI runner.
fn require_models(dir: &std::path::Path) -> Option<paths::EnginePaths> {
    let manifest = default_manifest();
    match paths::resolve_for_app(dir, &manifest) {
        Ok(paths) => Some(paths),
        Err((code, detail)) => {
            eprintln!(
                "ST-1 ENGINE GATE SKIPPED (named blocker: {code:?}) — {detail}. \
                 Provide the three pinned GGUF files under {} (set \
                 FREDO_COMPANION_MODELS_DIR to point at them) to run this gate. \
                 Nothing was asserted on this path.",
                dir.display()
            );
            None
        }
    }
}

/// Resolve the model paths or skip the calling test by name.
///
/// Usage: `let Some(model_paths) = models_or_skip() else { return };`
fn models_or_skip() -> Option<paths::EnginePaths> {
    require_models(&models_dir())
}

/// AC-22.1 / AC-24.2: the engine constructs TWICE — once requesting full
/// offload, once requesting zero offload — and both reach a terminal status.
///
/// Each construction uses its own engine handle (the backend is process-once, so
/// the two runs are sequential and the first handle is dropped before the second
/// starts — which releases the backend for the second `init`).
#[test]
fn engine_constructs_twice_full_offload_then_zero_offload() {
    let Some(model_paths) = models_or_skip() else {
        return;
    };

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
    // Empirical obligation — buft-name ↔ device-name correspondence. The
    // reported backend now comes from ggml's per-buffer WEIGHT bytes, matched
    // against the enumerated device names. On a host whose enumeration contains
    // a usable non-CPU device, a SUCCESSFUL full-offload load is only reachable
    // when that correspondence holds on THIS host's actual backend: if the
    // weight buffer type had not matched the device name, the report would have
    // been `Cpu` and the "full offload but reported CPU" guard would have
    // refused the start. So this assertion is the executed proof that the
    // weight bufts are non-empty AND their names match the enumeration here.
    if let Some(expected) = full
        .devices
        .iter()
        .find(|device| device.device_type != CompanionBackendKind::Cpu)
        .map(|device| device.device_type)
    {
        assert_eq!(
            full.backend,
            Some(expected),
            "a successful full-offload load on a host enumerating a usable GPU must report that \
             GPU — otherwise the weight-buffer names did not correspond to the device names"
        );
    }

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
    // Resolve the assets BEFORE touching the process-global seam, so the skip
    // path can never leave `FREDO_COMPANION_FORCE_CPU` set for a sibling test.
    let Some(model_paths) = models_or_skip() else {
        return;
    };
    let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // The seam must be set BEFORE the start reads it (the handle reads it inside
    // `start`). `ENV_LOCK` guarantees no other test observes this value.
    std::env::set_var(COMPANION_FORCE_CPU_ENV, "1");

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
    // Assets first — see the note in the sibling seam test.
    let Some(model_paths) = models_or_skip() else {
        return;
    };
    let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::env::set_var(COMPANION_FORCE_CPU_ENV, "1");

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

// ── REQUIRED ARTIFACT — repeat-turn engine survival (the suite's real gap) ────

/// The engine handle type the survival gate drives.
type SurvivalHandle = CompanionEngineHandle;

/// THE repeat-turn survival pin (Spec #3141 fix F1).
///
/// The Tester's suite gap: no case ran TWO consecutive turns on ONE engine, which
/// is exactly the shape that caught the real bug. The old code's lazy tool grammar
/// fired on the wrong token, emptied its stack, and the crate's panicking
/// `sample`/`accept` killed the ONE engine thread on turn 3 — so every later turn
/// got "the engine stopped".
///
/// This gate drives THREE real turns on ONE handle, through the real
/// `EngineCommand::Chat` path, and asserts:
///
/// * every turn settles with exactly one `Finished` (never a bare channel close),
/// * NO turn fails (no typed `Failed`),
/// * the engine is still loaded after turn 3 (the survival receipt), and
/// * the MTP counters ADVANCED and were published (the F2 observable).
#[tokio::test]
async fn three_consecutive_turns_on_one_engine_all_settle_and_it_survives() {
    let Some(model_paths) = models_or_skip() else {
        return;
    };
    let handle = SurvivalHandle::spawn_with_budget(DEFAULT_START_BUDGET);
    let started = handle.start(model_paths.clone(), CompanionBackendMode::Auto);
    assert!(
        started.success,
        "the engine must start for the survival gate: {:?} — {}",
        started.code,
        started.detail
    );

    let mut per_turn_events: Vec<Vec<String>> = Vec::new();
    for turn in 0..3u32 {
        let (events_tx, mut events_rx) = tokio::sync::mpsc::channel(256);
        let request = crate::applications::llm_server::engine::ChatRequest {
            turn: crate::applications::llm_server::engine::request::ChatTurn::text(vec![
                crate::applications::llm_server::chat::LlmMessage {
                    role: "system".to_string(),
                    content: "You are a concise assistant.".to_string(),
                },
                crate::applications::llm_server::chat::LlmMessage {
                    role: "user".to_string(),
                    content: format!("Say one short sentence about turn {}.", turn + 1),
                },
            ])
            .with_max_tokens(24),
            events: events_tx,
            paths: model_paths.clone(),
            mode: CompanionBackendMode::Auto,
            seed: 7 + turn,
        };
        handle
            .chat(request)
            .expect("the engine must accept the turn");

        let mut names: Vec<String> = Vec::new();
        let mut failure: Option<String> = None;
        while let Some(event) = events_rx.recv().await {
            match event {
                crate::applications::llm_server::engine::stream::EngineEvent::Token(_) => {
                    names.push("llm-token".to_string())
                }
                crate::applications::llm_server::engine::stream::EngineEvent::Finished { .. } => {
                    names.push("finished".to_string())
                }
                crate::applications::llm_server::engine::stream::EngineEvent::Failed {
                    code,
                    detail,
                } => {
                    failure = Some(format!("{code:?}: {detail}"));
                    names.push("llm-error".to_string());
                }
                _ => {}
            }
        }
        eprintln!("ST-1 repeat turn {}: {names:?}", turn + 1);
        assert!(
            failure.is_none(),
            "turn {} must not fail (the engine must survive): {failure:?}",
            turn + 1
        );
        assert_eq!(
            names.iter().filter(|name| *name == "finished").count(),
            1,
            "turn {} must settle with exactly one Finished: {names:?}",
            turn + 1
        );
        assert!(
            names.last().map(String::as_str) == Some("finished"),
            "turn {} must settle LAST: {names:?}",
            turn + 1
        );
        per_turn_events.push(names);
    }

    // SURVIVAL: the engine is still loaded after three turns on one instance.
    {
        let slot = handle.slot();
        let guard = slot.lock().expect("slot lock");
        assert!(
            guard.snapshot.loaded,
            "the engine must STILL be loaded after three turns — a dead thread is the bug"
        );
        assert!(
            guard.snapshot.last_error_code.is_none(),
            "no turn may have left a typed failure behind: {:?}",
            guard.snapshot.last_error_code
        );

        // F2: the counters ADVANCED and were PUBLISHED on the surviving engine.
        let stats = guard
            .snapshot
            .mtp_stats
            .expect("a surviving engine must publish its MTP counters");
        assert!(
            stats.draft_calls > 0,
            "the draft loop must have run on the surviving engine: {stats:?}"
        );
        assert!(
            stats.drafts_proposed > 0,
            "turns on a surviving engine must propose drafts (R-19.1): {stats:?}"
        );
        assert!(
            stats.drafts_accepted > 0,
            "turns on a surviving engine must accept drafts (R-19.1): {stats:?}"
        );
        eprintln!(
            "ST-1 REPEAT-TURN SURVIVAL: drafts_proposed={} drafts_accepted={} draft_calls={}",
            stats.drafts_proposed, stats.drafts_accepted, stats.draft_calls
        );
    }

    handle.stop();
}

// ── REQUIRED ARTIFACT — `stop` then `start` on the SAME engine (fix D1) ───────

/// THE D1 pin: `stop_llama_server` is NOT a one-way door.
///
/// The Tester reproduced this live: launch → stop → launch failed with
/// `startTimeout` (or `backendInitFailed`), and only an app restart recovered.
/// The cause was `EngineCommand::Stop` ending `run()` with `break`, so the ONE
/// engine thread died and every later `Start` was queued to a dead receiver.
///
/// This gate drives a REPEAT cycle over the REAL handle — start, stop, start,
/// stop, start — and asserts the engine is reusable:
///
/// * every `start` succeeds and reports a backend,
/// * `stop` publishes the default (not-loaded, no devices) snapshot — i.e. the
///   engine state really was released, not just marked idle, and
/// * a TURN after the second start settles with exactly one `Finished`.
///
/// Skipped by name when the pinned GGUF trio is absent (G-172 / G-314).
#[tokio::test]
async fn stop_then_start_is_reusable_on_the_same_process() {
    let Some(model_paths) = models_or_skip() else {
        return;
    };
    let handle = CompanionEngineHandle::spawn_with_budget(DEFAULT_START_BUDGET);

    // Repeat cycle: the engine must survive TWO stops and start again each time.
    for cycle in 1..=2u32 {
        let started = handle.start(model_paths.clone(), CompanionBackendMode::Cpu);
        assert!(
            started.success,
            "cycle {cycle}: start must succeed: {:?} — {}",
            started.code, started.detail
        );
        assert!(
            started.backend.is_some(),
            "cycle {cycle}: a loaded engine must report a backend"
        );

        handle.stop();
        // The stop must actually RELEASE the engine state (the memory release),
        // observable as the default snapshot — not merely a cleared `loaded` flag.
        // `stop()` only enqueues the command, so wait (bounded) for the thread to
        // publish the released state.
        let slot = handle.slot();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            {
                let guard = slot.lock().expect("slot lock");
                if !guard.snapshot.loaded
                    && guard.snapshot.devices.is_empty()
                    && guard.snapshot.backend.is_none()
                {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "cycle {cycle}: stop must release the engine state (devices=({:?}) backend={:?})",
                    guard.snapshot.devices.len(),
                    guard.snapshot.backend
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        eprintln!("D1 REPEAT CYCLE {cycle}: start OK -> stop released state");
    }

    // After the second start the engine must serve a real turn — the one-way door
    // used to fail here with `startTimeout` and then a dead engine.
    let started = handle.start(model_paths.clone(), CompanionBackendMode::Cpu);
    assert!(
        started.success,
        "post-cycle start must succeed: {:?} — {}",
        started.code,
        started.detail
    );

    let (events_tx, mut events_rx) = tokio::sync::mpsc::channel(256);
    let request = crate::applications::llm_server::engine::ChatRequest {
        turn: crate::applications::llm_server::engine::request::ChatTurn::text(vec![
            crate::applications::llm_server::chat::LlmMessage {
                role: "user".to_string(),
                content: "Say one short sentence.".to_string(),
            },
        ])
        .with_max_tokens(64),
        events: events_tx,
        paths: model_paths,
        mode: CompanionBackendMode::Cpu,
        seed: 11,
    };
    handle
        .chat(request)
        .expect("the restarted engine must accept the turn");

    let mut finished = 0usize;
    let mut failure: Option<String> = None;
    let mut tokens = 0usize;
    let mut reasoning = 0usize;
    while let Some(event) = events_rx.recv().await {
        match event {
            crate::applications::llm_server::engine::stream::EngineEvent::Token(_) => {
                tokens += 1
            }
            crate::applications::llm_server::engine::stream::EngineEvent::Reasoning(_) => {
                reasoning += 1
            }
            crate::applications::llm_server::engine::stream::EngineEvent::Finished { .. } => {
                finished += 1
            }
            crate::applications::llm_server::engine::stream::EngineEvent::Failed {
                code,
                detail,
            } => failure = Some(format!("{code:?}: {detail}")),
            _ => {}
        }
    }
    handle.stop();

    assert!(
        failure.is_none(),
        "the turn after a restart must not fail (the one-way door is gone): {failure:?}"
    );
    assert_eq!(
        finished, 1,
        "the turn after a restart must settle with exactly one Finished"
    );
    // The turn really generated: either visible content or a reasoning span. A
    // turn that produced NEITHER would mean the engine accepted the command but
    // did no work.
    assert!(
        tokens >= 1 || reasoning >= 1,
        "the turn after a restart must generate (tokens={tokens}, reasoning={reasoning})"
    );
    eprintln!(
        "D1 POST-RESTART TURN: tokens={tokens} reasoning={reasoning} finished={finished}"
    );
}

