//! Stream-health liveness producer (Spec #3064 ST-1).
//!
//! Gives the desktop "stream connected" flag a REAL producer: a backend-owned
//! ingest-pipeline heartbeat that ticks independently of agent activity, plus a
//! read-only IPC-liveness probe (`stream_health`). Without it the frontend flag
//! was a mount constant (`StreamContext.tsx:44`).
//!
//! The heartbeat leaves the backend ONLY through [`crate::infrastructure::comm::bus::EventBus::emit_stream_health`]
//! (never a direct `app_handle.emit`); the RTDB row path
//! (`emit_row_delivery_batch`) is untouched.
//!
//! ## Outage lever (G-376 — inert by default)
//!
//! A genuine telemetry outage is not tester-drivable, so this module owns an
//! inert-by-default env seam mirroring the `FREDO_PG_FORCE_START_FAIL` /
//! `FREDO_COMPANION_FORCE_NOT_INSTALLED` precedents:
//!
//! - `degraded` — suppresses heartbeat emission (the REAL staleness path runs:
//!   `last_heartbeat_ms` stops advancing, so the probe's `age_ms` grows).
//! - `down` — suppresses emission AND makes the probe return `Err` (simulated
//!   IPC outage; verifies the state mapping, not a real outage).
//! - `ingest-down` — keeps heartbeats emitting (`seq` advances) while reporting
//!   `ingestConnected: false`, exercising the REAL `ingestConnected` branch of
//!   `deriveStreamHealth` with no port occupation.
//!
//! Unset / blank / unknown are INERT — byte-identical to no lever.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Manager;

use crate::infrastructure::comm::bus::EventBus;

/// One heartbeat every 5 s (the cadence the frontend's stale window is 3× of).
pub const STREAM_HEARTBEAT_INTERVAL_MS: u64 = 5_000;

/// The env-var name of the inert-by-default outage lever (G-376).
pub const STREAM_HEALTH_FORCE_ENV: &str = "FREDO_STREAM_HEALTH_FORCE";

/// The three force tokens the outage lever accepts.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StreamHealthForce {
    /// Suppress heartbeat emission (real staleness path).
    Degraded,
    /// Suppress emission AND make the probe return `Err`.
    Down,
    /// Keep heartbeats emitting while reporting `ingestConnected: false`.
    IngestDown,
}

/// Resolve the outage lever through an injected lookup (deterministic tests;
/// G-222 — never mutate the process environment).
///
/// Inert (`None`) when the variable is unset, blank, or carries an unknown
/// token. A blank value is treated as unset, mirroring [`crate::infrastructure::env::EnvConfig`].
pub fn stream_health_force_with(
    get: impl Fn(&str) -> Option<String>,
) -> Option<StreamHealthForce> {
    match get(STREAM_HEALTH_FORCE_ENV)?.trim() {
        "degraded" => Some(StreamHealthForce::Degraded),
        "down" => Some(StreamHealthForce::Down),
        "ingest-down" => Some(StreamHealthForce::IngestDown),
        _ => None,
    }
}

/// Resolve the outage lever from the live process environment (production).
pub fn stream_health_force() -> Option<StreamHealthForce> {
    stream_health_force_with(|key| std::env::var(key).ok())
}

/// One heartbeat envelope body on the `fredo-stream-event` channel (camelCase
/// wire shape under the `streamHealth` field).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamHealthHeartbeat {
    /// Monotonic per-process heartbeat sequence.
    pub seq: u64,
    /// Whether the OTLP ingest receiver reports connected.
    pub ingest_connected: bool,
    /// Age of the previous heartbeat in ms (`0` on a freshly emitted tick).
    pub age_ms: i64,
    /// Epoch-ms emission stamp.
    pub emitted_at_ms: i64,
}

/// The `stream_health` probe response (camelCase wire shape).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamHealthSnapshot {
    /// The current heartbeat sequence.
    pub seq: u64,
    /// Whether the OTLP ingest receiver reports connected.
    pub ingest_connected: bool,
    /// Age of the last heartbeat in ms.
    pub age_ms: i64,
    /// Whether the inert-by-default outage lever is active.
    pub forced: bool,
}

/// Wall-clock milliseconds since the Unix epoch (`0` on a clock error).
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// The backend liveness monitor: sequence, ingest connectivity, last-heartbeat
/// stamp, and the resolved outage lever.
pub struct StreamHealthMonitor {
    seq: AtomicU64,
    ingest_connected: AtomicBool,
    last_heartbeat_ms: AtomicI64,
    forced: Option<StreamHealthForce>,
}

impl StreamHealthMonitor {
    /// Build a monitor. `forced` is the resolved outage lever (`None` = inert).
    pub fn new(forced: Option<StreamHealthForce>) -> Self {
        Self {
            seq: AtomicU64::new(0),
            ingest_connected: AtomicBool::new(true),
            last_heartbeat_ms: AtomicI64::new(now_ms()),
            forced,
        }
    }

    /// The resolved outage lever (inert = `None`).
    pub fn forced(&self) -> Option<StreamHealthForce> {
        self.forced
    }

    /// Whether the pipeline reports connected (the `ingest-down` lever forces
    /// `false` without touching the underlying receiver state).
    fn ingest_connected(&self) -> bool {
        match self.forced {
            Some(StreamHealthForce::IngestDown) => false,
            _ => self.ingest_connected.load(Ordering::Relaxed),
        }
    }

    /// Record the OTLP receiver's connectivity (the error path sets `false`).
    pub fn set_ingest_connected(&self, connected: bool) {
        self.ingest_connected.store(connected, Ordering::Relaxed);
    }

    /// Advance ONE heartbeat tick.
    ///
    /// Returns the heartbeat to emit, or `None` when the lever suppresses
    /// emission (`degraded`/`down`) — in which case `seq` and the
    /// last-heartbeat stamp do NOT advance, so the real staleness path runs.
    pub fn tick(&self) -> Option<StreamHealthHeartbeat> {
        match self.forced {
            Some(StreamHealthForce::Degraded) | Some(StreamHealthForce::Down) => None,
            _ => {
                let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
                let emitted_at_ms = now_ms();
                self.last_heartbeat_ms
                    .store(emitted_at_ms, Ordering::Relaxed);
                Some(StreamHealthHeartbeat {
                    seq,
                    ingest_connected: self.ingest_connected(),
                    age_ms: 0,
                    emitted_at_ms,
                })
            }
        }
    }

    /// The current probe snapshot (no emission).
    pub fn snapshot(&self) -> StreamHealthSnapshot {
        StreamHealthSnapshot {
            seq: self.seq.load(Ordering::Relaxed),
            ingest_connected: self.ingest_connected(),
            age_ms: now_ms() - self.last_heartbeat_ms.load(Ordering::Relaxed),
            forced: self.forced.is_some(),
        }
    }
}

/// Run the probe against a monitor. Returns `Err` when the `down` lever is
/// active (the simulated IPC outage); `Ok` otherwise.
pub fn probe(monitor: &StreamHealthMonitor) -> Result<StreamHealthSnapshot, String> {
    if monitor.forced() == Some(StreamHealthForce::Down) {
        return Err("stream health probe unavailable".to_string());
    }
    Ok(monitor.snapshot())
}

/// Tauri-managed wrapper around the monitor (the `stream_health` command state).
pub struct StreamHealthState(pub Arc<StreamHealthMonitor>);

/// Spawn the liveness publisher: every [`STREAM_HEARTBEAT_INTERVAL_MS`], advance
/// one tick and — unless the lever suppresses emission — emit the heartbeat
/// through [`EventBus::emit_stream_health`]. `tokio::time::interval` fires its
/// first tick immediately, so a cold start settles within one interval.
pub fn spawn_publisher(app: tauri::AppHandle, monitor: Arc<StreamHealthMonitor>) {
    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_millis(STREAM_HEARTBEAT_INTERVAL_MS));
        loop {
            interval.tick().await;
            if let Some(heartbeat) = monitor.tick() {
                let bus = app.state::<EventBus>();
                bus.emit_stream_health(&heartbeat);
            }
        }
    });
}

/// The read-only IPC-liveness probe (Spec #3064 ST-1).
///
/// Rides IPC so its SUCCESS proves the IPC channel is alive — the signal that
/// distinguishes `degraded` (IPC alive, pipeline silent) from `down` (IPC
/// unavailable). Returns `Err` only under the `down` lever.
#[tauri::command]
pub fn stream_health(
    state: tauri::State<StreamHealthState>,
) -> Result<StreamHealthSnapshot, String> {
    probe(&state.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn force_unset_is_inert() {
        assert_eq!(stream_health_force_with(|_| None), None);
    }

    #[test]
    fn force_blank_is_inert() {
        assert_eq!(stream_health_force_with(|_| Some(String::new())), None);
        assert_eq!(stream_health_force_with(|_| Some("   ".to_string())), None);
    }

    #[test]
    fn force_unknown_token_is_inert() {
        assert_eq!(stream_health_force_with(|_| Some("bogus".to_string())), None);
        assert_eq!(
            stream_health_force_with(|_| Some("Degraded".to_string())),
            None,
            "tokens are case-sensitive; anything else is inert"
        );
    }

    #[test]
    fn force_tokens_resolve() {
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
    fn force_token_is_trimmed() {
        assert_eq!(
            stream_health_force_with(|_| Some("  ingest-down  ".to_string())),
            Some(StreamHealthForce::IngestDown)
        );
    }

    #[test]
    fn normal_tick_emits_and_advances_seq() {
        let monitor = StreamHealthMonitor::new(None);
        let first = monitor.tick().expect("a normal tick emits");
        assert_eq!(first.seq, 1);
        assert!(first.ingest_connected);
        assert_eq!(first.age_ms, 0);
        assert!(first.emitted_at_ms > 0);

        let second = monitor.tick().expect("a normal tick emits");
        assert_eq!(second.seq, 2, "seq advances every tick");
        assert!(!monitor.snapshot().forced);
    }

    #[test]
    fn ingest_down_keeps_ticking_with_ingest_connected_false() {
        let monitor = StreamHealthMonitor::new(Some(StreamHealthForce::IngestDown));
        let first = monitor.tick().expect("ingest-down keeps ticking");
        assert!(!first.ingest_connected);
        let second = monitor.tick().expect("ingest-down keeps ticking");
        assert_eq!(second.seq, 2, "seq keeps advancing under ingest-down");

        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.seq, 2);
        assert!(!snapshot.ingest_connected);
        assert!(snapshot.forced);
        assert_eq!(
            snapshot.age_ms, 0,
            "heartbeats stay fresh under ingest-down"
        );
    }

    #[test]
    fn ingest_down_probe_is_ok_with_ingest_connected_false() {
        let monitor = StreamHealthMonitor::new(Some(StreamHealthForce::IngestDown));
        let snapshot = probe(&monitor).expect("ingest-down is not the down lever");
        assert!(!snapshot.ingest_connected);
        assert!(snapshot.forced);
    }

    #[test]
    fn degraded_suppresses_emission_and_does_not_advance() {
        let monitor = StreamHealthMonitor::new(Some(StreamHealthForce::Degraded));
        assert!(monitor.tick().is_none(), "degraded suppresses emission");
        assert_eq!(monitor.snapshot().seq, 0, "seq does not advance");
        assert!(monitor.snapshot().forced);
    }

    #[test]
    fn degraded_probe_is_ok_but_age_grows() {
        let monitor = StreamHealthMonitor::new(Some(StreamHealthForce::Degraded));
        // Simulate the last heartbeat landing 20 s ago (past the 15 s stale
        // window): the REAL staleness path.
        monitor
            .last_heartbeat_ms
            .store(now_ms() - 20_000, Ordering::Relaxed);
        let snapshot = probe(&monitor).expect("degraded still answers the probe");
        assert!(
            snapshot.age_ms >= 19_000,
            "age_ms must reflect the stalled heartbeat, got {}",
            snapshot.age_ms
        );
    }

    #[test]
    fn forced_down_probe_returns_err() {
        let monitor = StreamHealthMonitor::new(Some(StreamHealthForce::Down));
        assert!(probe(&monitor).is_err());
    }

    #[test]
    fn snapshot_age_ms_tracks_last_heartbeat() {
        let monitor = StreamHealthMonitor::new(None);
        monitor
            .last_heartbeat_ms
            .store(now_ms() - 30_000, Ordering::Relaxed);
        assert!(monitor.snapshot().age_ms >= 29_000);
    }

    #[test]
    fn set_ingest_connected_reflects_in_snapshot() {
        let monitor = StreamHealthMonitor::new(None);
        assert!(monitor.snapshot().ingest_connected);
        monitor.set_ingest_connected(false);
        assert!(!monitor.snapshot().ingest_connected);
        assert!(
            !monitor.tick().expect("still emits").ingest_connected,
            "a real ingest disconnect rides the heartbeat too"
        );
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let snapshot = StreamHealthSnapshot {
            seq: 7,
            ingest_connected: false,
            age_ms: 1234,
            forced: true,
        };
        let json = serde_json::to_value(&snapshot).expect("snapshot serializes");
        assert_eq!(json["seq"], 7);
        assert_eq!(json["ingestConnected"], false);
        assert_eq!(json["ageMs"], 1234);
        assert_eq!(json["forced"], true);
    }

    #[test]
    fn heartbeat_serializes_camel_case() {
        let heartbeat = StreamHealthHeartbeat {
            seq: 3,
            ingest_connected: true,
            age_ms: 0,
            emitted_at_ms: 42,
        };
        let json = serde_json::to_value(&heartbeat).expect("heartbeat serializes");
        assert_eq!(json["seq"], 3);
        assert_eq!(json["ingestConnected"], true);
        assert_eq!(json["ageMs"], 0);
        assert_eq!(json["emittedAtMs"], 42);
    }
}
