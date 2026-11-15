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

// ── REQUIRED ARTIFACT — D2: a reasoning-first generation streams and does not


/// THE D2 end-to-end pin: a live, TOOL-OFFERING generation (the shipped shape
/// every chat turn takes — `commands/chat.rs` always calls `skill_turn`) whose
/// template opens its hidden reasoning channel must:
///
/// * never leak the template's reasoning markers or the chain-of-thought into a
///   `Token` (the pre-fix behaviour was ONE 716-char `llm-token` beginning
///   `<|channel>thought`);
/// * STREAM the visible answer as **≥2** deltas (the pre-fix gate withheld the
///   entire generation and flushed it as one blob);
/// * route the hidden span to [`EngineEvent::Reasoning`] — the channel that is
///   never forwarded to the webview — and that route must be OBSERVED at least
///   once, so the pin is about the reasoning channel rather than a vacuous
///   short answer.
///
/// Whether a specific prompt elicits a reasoning block is model sampling, not a
/// product invariant, so the pin drives SEVERAL reasoning-eliciting prompts and
/// requires the span to be observed at least once. Every trial must satisfy the
/// two universal clauses (no marker leak, ≥2 deltas).
#[tokio::test]
async fn a_reasoning_first_generation_streams_and_never_leaks_the_span() {
    let Some(model_paths) = models_or_skip() else {
        return;
    };
    let handle = CompanionEngineHandle::spawn_with_budget(DEFAULT_START_BUDGET);
    let started = handle.start(model_paths.clone(), CompanionBackendMode::Cpu);
    assert!(
        started.success,
        "the engine must start for the D2 gate: {:?} — {}",
        started.code,
        started.detail
    );

    // The markers the pinned template DECLARES (verified live by the gate's own
    // log line and by `chat_format`'s template pin). They are spelled here as the
    // NEGATIVE assertion only — production code must never contain them, which
    // `production_code_never_spells_the_reasoning_markers` enforces.
    let start_tag = "<|channel>thought";
    let end_tags = ["<channel|>"];
    // The shipped tool offer (the production shape every chat turn takes).
    let tools = vec![serde_json::json!({
        "type": "function",
        "function": {
            "name": "open_app",
            "description": "Open an application.",
            "parameters": {
                "type": "object",
                "properties": { "app": { "type": "string" } },
                "required": ["app"],
            },
        }
    })];

    // Prompts that make the model reason first and then answer over several
    // tokens. Genuine sampling variance means not every one produces a span, so
    // the gate requires at least ONE trial to exercise the whole mechanism
    // (reasoning observed AND the answer streamed in ≥2 deltas). The budget is
    // generous because the hidden span is generated INSIDE the completion
    // budget — too small a budget leaves no room for a multi-token answer after
    // the reasoning.
    let prompts = [
        "Think briefly, then explain in one sentence why the sky appears blue.",
        "Reason in one short sentence, then explain what a compiler does in one sentence.",
        "Compute 17 times 23. Reason briefly, then give the answer in a sentence.",
    ];

    let mut reasoning_events = 0usize;
    let mut trial_deltas: Vec<usize> = Vec::new();
    let mut trial_reasoning: Vec<usize> = Vec::new();
    let mut failure: Option<String> = None;

    for (trial, prompt) in prompts.iter().enumerate() {
        let turn = {
            use crate::applications::llm_server::chat::LlmMessage;
            crate::applications::llm_server::engine::request::ChatTurn::text(vec![
                LlmMessage {
                    role: "system".to_string(),
                    content: "You are a concise assistant.".to_string(),
                },
                LlmMessage {
                    role: "user".to_string(),
                    content: (*prompt).to_string(),
                },
            ])
            .with_tools(tools.clone(), "auto")
            .with_max_tokens(400)
        };

        let (events_tx, mut events_rx) = tokio::sync::mpsc::channel(256);
        let request = crate::applications::llm_server::engine::ChatRequest {
            turn,
            events: events_tx,
            paths: model_paths.clone(),
            mode: CompanionBackendMode::Cpu,
            seed: 23 + trial as u32,
        };
        handle
            .chat(request)
            .expect("the engine must accept the turn");

        let mut tokens: Vec<String> = Vec::new();
        let mut turn_reasoning = 0usize;
        let mut finished = 0usize;
        while let Some(event) = events_rx.recv().await {
            match event {
                crate::applications::llm_server::engine::stream::EngineEvent::Token(text) => {
                    tokens.push(text)
                }
                crate::applications::llm_server::engine::stream::EngineEvent::Reasoning(text) => {
                    assert!(
                        !text.is_empty(),
                        "a reasoning event must carry the span, not be empty"
                    );
                    turn_reasoning += 1;
                    reasoning_events += 1;
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

        let visible: String = tokens.concat();
        eprintln!(
            "D2 TRIAL {trial}: start={start_tag:?} ends={end_tags:?} prompt={prompt:?} \
             deltas={} reasoning_events={turn_reasoning} lens={:?} visible={visible:?}",
            tokens.len(),
            tokens.iter().map(|token| token.len()).collect::<Vec<_>>(),
        );
        assert!(
            failure.is_none(),
            "trial {trial}: the turn must not fail: {failure:?}"
        );
        assert_eq!(
            finished, 1,
            "trial {trial}: the turn must settle with exactly one Finished"
        );
        trial_deltas.push(tokens.len());
        trial_reasoning.push(turn_reasoning);

        // UNIVERSAL: no marker, no channel name, no chain-of-thought in the
        // visible text — on EVERY trial.
        for (index, payload) in tokens.iter().enumerate() {
            assert!(
                !payload.contains(start_tag),
                "trial {trial} delta {index} leaked the reasoning START marker \
                 {start_tag:?}: {payload:?}"
            );
            for end in &end_tags {
                assert!(
                    !payload.contains(*end),
                    "trial {trial} delta {index} leaked a reasoning END marker \
                     {end:?}: {payload:?}"
                );
            }
            assert!(
                !payload.contains("thought"),
                "trial {trial} delta {index} leaked the reasoning channel name: {payload:?}"
            );
        }
    }
    handle.stop();

    // THE MECHANISM CLAUSE: at least one trial must have produced a hidden span
    // AND streamed a multi-delta answer. That is exactly the shape the pre-fix
    // gate destroyed (one withheld blob containing the span), so this is what
    // keeps the pin from passing on prompts that never reason.
    let exercised = trial_reasoning
        .iter()
        .zip(trial_deltas.iter())
        .any(|(reasoning, deltas)| *reasoning >= 1 && *deltas >= 2);
    assert!(
        exercised,
        "no trial produced a reasoning span AND a multi-delta answer, so the D2 fix \
         was never exercised; reasoning per trial: {trial_reasoning:?}, deltas per \
         trial: {trial_deltas:?}"
    );
    eprintln!(
        "D2 REASONING RECEIPT: reasoning_events={reasoning_events} \
         reasoning_per_trial={trial_reasoning:?} deltas_per_trial={trial_deltas:?}"
    );
}

// ── REQUIRED ARTIFACT — D3: the FULL composition decodes a real tool call ─────

/// THE D3 pin: the SHIPPED composition — real handle → real engine thread → real
/// model → the token decoder → the streaming gate → the template's own reverse
/// parser — emits a validated [`EngineEvent::ToolCall`] and NEVER forwards the raw
/// call body as a `Token`.
///
/// ## Why the pre-existing pins could not catch the regression
///
/// Round 3 made reserved-token dropping live in the DECODER and the gate pin fed
/// the tool-call opener straight into the gate — i.e. it injected input AFTER the
/// transformation that broke. So the gate stayed green while the shipped path lost
/// the opener, decoded no call, and released the withheld body as prose (live:
/// nine `llm-token` deltas joined `call:open_app{app:<|"|>Mission Monitor<|"|>}`).
///
/// This pin drives the whole composition with the real `open_app` registry offer
/// (the same `ChatTurn::with_tools` shape `skills::skill_turn` produces) and the
/// prompt the Tester used, so the decoder stage the regression lived in is
/// EXERCISED rather than bypassed.
///
/// ## Non-flakiness
///
/// Whether one sampling run picks the tool is model behaviour, not a product
/// invariant, so the pin drives a few seeds and stops as soon as the call is
/// OBSERVED. The absence clause (no `Token` may carry `<|`-syntax) and the
/// single-`Finished` clause are asserted on EVERY trial that runs — so a
/// regression that releases the raw body fails immediately, without depending on
/// the model choosing the tool.
#[tokio::test]
async fn a_tool_offered_turn_emits_a_validated_tool_call_and_never_the_raw_body() {
    let Some(model_paths) = models_or_skip() else {
        return;
    };
    let handle = CompanionEngineHandle::spawn_with_budget(DEFAULT_START_BUDGET);
    // `Auto` (the shipped default): the composition under test — decoder → gate →
    // the template's reverse parser — is backend-independent, and the GPU path
    // keeps the pin fast on a GPU host while still falling back to CPU elsewhere.
    let started = handle.start(model_paths.clone(), CompanionBackendMode::Auto);
    assert!(
        started.success,
        "the engine must start for the D3 gate: {:?} — {}",
        started.code,
        started.detail
    );

    // The shipped companion offer, obtained from the ONE shared builder — never a
    // second registry construction (R-2; `voice_invariants` enforces it). With no
    // published surfaces it is exactly the three static skills (`open_app`,
    // `close_app`, `doom_mode`), which is what `skills::render_tools` then
    // forwards verbatim into the turn.
    let registry = crate::infrastructure::companion::surface_registry::build_companion_skill_registry(
        &[],
    );
    let tools = crate::applications::llm_server::skills::render_tools(&registry)
        .as_array()
        .cloned()
        .expect("the registry renders an array of tools");
    assert!(
        tools
            .iter()
            .any(|tool| tool["function"]["name"] == "open_app"),
        "the offered registry must declare open_app: {tools:?}"
    );

    let mut calls: Vec<(Option<String>, Option<String>)> = Vec::new();
    let mut trials_run = 0usize;
    let mut failure: Option<String> = None;
    let mut raw_body_leaks: Vec<String> = Vec::new();

    for seed in 0..3u32 {
        let turn = {
            use crate::applications::llm_server::chat::LlmMessage;
            crate::applications::llm_server::engine::request::ChatTurn::text(vec![
                LlmMessage {
                    role: "system".to_string(),
                    content: "You are Fredo, a concise desktop assistant.".to_string(),
                },
                LlmMessage {
                    role: "user".to_string(),
                    content: "Open the Mission Monitor application for me.".to_string(),
                },
            ])
            .with_tools(tools.clone(), "auto")
            .with_max_tokens(200)
        };

        let (events_tx, mut events_rx) = tokio::sync::mpsc::channel(256);
        let request = crate::applications::llm_server::engine::ChatRequest {
            turn,
            events: events_tx,
            paths: model_paths.clone(),
            mode: CompanionBackendMode::Auto,
            seed: 101 + seed,
        };
        handle
            .chat(request)
            .expect("the engine must accept the tool turn");

        let mut tokens: Vec<String> = Vec::new();
        let mut turn_calls: Vec<(Option<String>, Option<String>)> = Vec::new();
        let mut finished = 0usize;
        while let Some(event) = events_rx.recv().await {
            match event {
                crate::applications::llm_server::engine::stream::EngineEvent::Token(text) => {
                    tokens.push(text)
                }
                crate::applications::llm_server::engine::stream::EngineEvent::ToolCall {
                    name,
                    arguments,
                    ..
                } => turn_calls.push((name, arguments)),
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
        trials_run += 1;

        let visible: String = tokens.concat();
        eprintln!(
            "D3 TOOL TRIAL {seed}: deltas={} calls={:?} finished={finished} visible={visible:?}",
            tokens.len(),
            turn_calls
                .iter()
                .map(|(name, arguments)| (name.clone(), arguments.clone()))
                .collect::<Vec<_>>(),
        );

        assert!(
            failure.is_none(),
            "trial {seed}: the turn must not fail: {failure:?}"
        );
        assert_eq!(
            finished, 1,
            "trial {seed}: the turn must settle with exactly one Finished"
        );
        // UNIVERSAL (this is the regression's signature): no user-visible delta may
        // carry control syntax — the raw call body is NEVER a `llm-token`.
        if visible.contains("<|") {
            raw_body_leaks.push(visible.clone());
        }
        let observed = !turn_calls.is_empty();
        calls.extend(turn_calls);
        if observed {
            break;
        }
    }
    handle.stop();

    assert!(
        raw_body_leaks.is_empty(),
        "the raw tool-call body must never be forwarded as content: {raw_body_leaks:?}"
    );

    // THE MECHANISM CLAUSE: the call must actually be decoded at least once, so the
    // pin cannot pass on prompts that simply never produced a call.
    assert!(
        !calls.is_empty(),
        "no trial decoded an EngineEvent::ToolCall in {trials_run} trial(s) — the \
         tool path was never exercised (a vacuous pass)"
    );

    let validated: Vec<&(Option<String>, Option<String>)> = calls
        .iter()
        .filter(|(name, _)| name.as_deref() == Some("open_app"))
        .collect();
    assert!(
        !validated.is_empty(),
        "the decoded call must be the offered open_app skill: {calls:?}"
    );
    let (_, arguments) = validated[0];
    let arguments = arguments
        .as_deref()
        .expect("a decoded tool call must carry its argument JSON");
    let parsed: serde_json::Value =
        serde_json::from_str(arguments).expect("the decoded arguments must be JSON");
    assert_eq!(
        parsed["app"], "Mission Monitor",
        "the template's reverse parser must recover the app name from the call: {arguments}"
    );
}
