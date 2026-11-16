//! Spec #3064 ST-1 — stream-health liveness producer: behaviour + wiring.
//!
//! Two layers:
//!   1. Behaviour — the public monitor/probe/force API (`fredo_lib::infrastructure::rtdb::health`)
//!      is exercised directly: cadence, inert lever tokens, tick/seq semantics,
//!      the `ingest-down` and `degraded`/`down` lever paths, and snapshot `age_ms`.
//!   2. Wiring — static source pins that `lib.rs` manages the health state,
//!      registers the `stream_health` command, spawns the publisher near the OTLP
//!      wiring, and marks ingest disconnected on the OTLP error path; that the
//!      heartbeat leaves the backend ONLY via `EventBus::emit_stream_health`; and
//!      that the RTDB row path (`emit_row_delivery_batch`) is untouched.

use fredo_lib::infrastructure::rtdb::health::{
    probe, stream_health_force_with, StreamHealthForce, StreamHealthMonitor,
    STREAM_HEARTBEAT_INTERVAL_MS,
};

// ── Behaviour ───────────────────────────────────────────────────────────────

#[test]
fn cadence_constant_is_five_seconds() {
    assert_eq!(STREAM_HEARTBEAT_INTERVAL_MS, 5_000);
}

#[test]
fn unset_blank_and_unknown_lever_tokens_are_inert() {
    assert_eq!(stream_health_force_with(|_| None), None);
    assert_eq!(stream_health_force_with(|_| Some(String::new())), None);
    assert_eq!(stream_health_force_with(|_| Some("   ".to_string())), None);
    assert_eq!(stream_health_force_with(|_| Some("unknown".to_string())), None);
}

#[test]
fn lever_tokens_resolve() {
    assert_eq!(
        stream_health_force_with(|_| Some("degraded".to_string())),
        Some(StreamHealthForce::Degraded)
    );
    assert_eq!(
        stream_health_force_with(|_| Some("down".to_string())),
        Some(StreamHealthForce::Down)
    );
    assert_eq!(
        stream_health_force_with(|_| Some("ingest-down".to_string())),
        Some(StreamHealthForce::IngestDown)
    );
}

#[test]
fn a_normal_monitor_ticks_and_probes_healthy() {
    let monitor = StreamHealthMonitor::new(None);
    let first = monitor.tick().expect("normal tick emits");
    assert_eq!(first.seq, 1);
    assert!(first.ingest_connected);

    let snapshot = probe(&monitor).expect("normal probe is Ok");
    assert_eq!(snapshot.seq, 1);
    assert!(snapshot.ingest_connected);
    assert!(!snapshot.forced);
    assert!(snapshot.age_ms < STREAM_HEARTBEAT_INTERVAL_MS as i64);
}

#[test]
fn ingest_down_ticks_with_ingest_connected_false() {
    let monitor = StreamHealthMonitor::new(Some(StreamHealthForce::IngestDown));
    let first = monitor.tick().expect("ingest-down keeps ticking");
    assert!(!first.ingest_connected);
    let second = monitor.tick().expect("ingest-down keeps ticking");
    assert_eq!(second.seq, 2, "seq advances under ingest-down");

    let snapshot = probe(&monitor).expect("ingest-down is not the down lever");
    assert!(!snapshot.ingest_connected);
    assert!(snapshot.forced);
}

#[test]
fn degraded_suppresses_emission_but_probe_still_answers() {
    let monitor = StreamHealthMonitor::new(Some(StreamHealthForce::Degraded));
    assert!(monitor.tick().is_none());
    let snapshot = probe(&monitor).expect("degraded still answers the probe");
    assert_eq!(snapshot.seq, 0);
    assert!(snapshot.forced);
}

#[test]
fn down_lever_makes_the_probe_err() {
    let monitor = StreamHealthMonitor::new(Some(StreamHealthForce::Down));
    assert!(monitor.tick().is_none(), "down suppresses emission");
    assert!(probe(&monitor).is_err(), "down makes the probe fail");
}

// ── Wiring (static source pins) ─────────────────────────────────────────────

/// Read the crate source file at `relative` (from the crate root).
fn source(relative: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// Blank every comment and string literal, preserving byte offsets, so the
/// structural scans match CODE only.
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

#[test]
fn lib_rs_wires_the_stream_health_producer() {
    let masked = mask(&source("src/lib.rs"));

    assert!(
        masked.contains("StreamHealthMonitor::new(stream_health_force())"),
        "lib.rs must construct the monitor from the resolved outage lever"
    );
    assert!(
        masked.contains("app.manage(StreamHealthState("),
        "lib.rs must manage the health state (the probe command's state)"
    );
    assert!(
        masked.contains("spawn_stream_health_publisher("),
        "lib.rs must spawn the liveness publisher"
    );
    assert!(
        masked.contains("set_ingest_connected(false)"),
        "the OTLP error path must mark the ingest pipeline not-connected"
    );
    assert!(
        masked.contains("infrastructure::rtdb::health::stream_health,"),
        "the `stream_health` command must be registered in invoke_handler"
    );
}

#[test]
fn heartbeat_leaves_the_backend_only_via_the_event_bus() {
    let health = mask(&source("src/infrastructure/rtdb/health.rs"));
    let bus = mask(&source("src/infrastructure/comm/bus.rs"));

    assert!(
        bus.contains("pub fn emit_stream_health("),
        "EventBus must expose emit_stream_health"
    );
    assert!(
        health.contains("bus.emit_stream_health("),
        "the publisher must emit through EventBus::emit_stream_health"
    );
    assert!(
        !health.contains("app.emit("),
        "the health module must never call AppHandle::emit directly"
    );
    // The RTDB row path is untouched by this spec.
    assert!(
        bus.contains("pub fn emit_row_delivery_batch("),
        "the RTDB row emission path must remain present"
    );
    assert!(
        !health.contains("emit_row_delivery_batch"),
        "the health module must not touch the RTDB row path"
    );
}
