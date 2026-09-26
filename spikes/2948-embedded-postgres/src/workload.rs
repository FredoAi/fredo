//! Fixed workload shared by both benchmark variants.
//!
//! Contract (from the Implementation Plan, section B):
//!   * N = 10_000 operations, 90% unique `(session_id, correlation_id)`,
//!     10% re-upserts of existing keys.
//!   * one transaction per batch of 512 rows (mirrors RTDB_MAX_EMISSION_BATCH).
//!   * timed separately: batch upsert, point read by PK, range read by started_at_ns.
//!
//! Both variants run the *identical* generated rows so the deltas are comparable.

use serde::Serialize;

pub const ROWS: usize = 10_000;
pub const BATCH: usize = 512;
pub const REUPSERT_PERMILLE: usize = 100; // 10%

/// One chat-row-shaped row. Mirrors the representative schema in `schema.rs`.
#[derive(Clone, Debug)]
pub struct Row {
    pub session_id: String,
    pub correlation_id: String,
    pub seq: i64,
    pub started_at_ns: i64,
    pub ended_at_ns: Option<i64>,
    pub updated_at: String,
    pub state: String,
    pub user_message: Option<String>,
    pub agent_reply: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub model: Option<String>,
    pub parent_session_id: Option<String>,
    pub composited_child_session_id: Option<String>,
    pub raw_json: String,
    pub provider: String,
}

impl Row {
    /// Key used for point reads (PK).
    pub fn key(&self) -> (String, String) {
        (self.session_id.clone(), self.correlation_id.clone())
    }
}

/// Base wall-clock epoch (ns) for deterministic `started_at_ns` values.
const BASE_NS: i64 = 1_700_000_000_000_000_000;

/// Generate exactly `n` operations: `n - n/10` unique keys followed by
/// `n/10` re-upserts of the first keys (the write-contention probe).
pub fn generate_n(n: usize) -> Vec<Row> {
    let unique = n - n * REUPSERT_PERMILLE / 1000;
    (0..n)
        .map(|i| {
            // Re-upsert ops reuse the first `unique_count/10` keys.
            let key_index = if i < unique { i } else { i - unique };
            let is_reupsert = i >= unique;
            let updated_at = if is_reupsert {
                format!("2026-01-02T00:00:{:02}.{:03}Z", key_index % 60, key_index % 1000)
            } else {
                format!("2026-01-01T00:00:{:02}.{:03}Z", key_index % 60, key_index % 1000)
            };
            let state = if is_reupsert { "updated" } else { "completed" };
            let user_message = if key_index % 7 == 0 {
                Some(format!("héllo ✅ 漢字 — representative payload #{key_index}"))
            } else {
                Some(format!("representative user message #{key_index}"))
            };
            let raw_json = serde_json::json!({
                "sessionId": format!("sess-{:04}", key_index % 500),
                "correlationId": format!("corr-{key_index:05}"),
                "state": state,
                "provider": "opencode",
                "model": "gpt-5",
                "usage": {"input": 1200 + (key_index as i64 % 97), "output": 340, "cacheRead": 10},
                "note": if is_reupsert { "re-upsert" } else { "initial" },
                "payload": "x".repeat(256),
            })
            .to_string();
            Row {
                session_id: format!("sess-{:04}", key_index % 500),
                correlation_id: format!("corr-{key_index:05}"),
                seq: (i + 1) as i64,
                started_at_ns: BASE_NS + (key_index as i64) * 1_000_000,
                ended_at_ns: Some(BASE_NS + (key_index as i64) * 1_000_000 + 5_000_000),
                updated_at,
                state: state.to_string(),
                user_message,
                agent_reply: Some(format!("representative agent reply #{key_index}")),
                prompt_tokens: Some(1200 + (key_index as i64 % 97)),
                completion_tokens: Some(340),
                cache_read_tokens: Some(10),
                cost_usd: Some(0.001 * (key_index as f64 + 1.0)),
                model: Some("gpt-5".to_string()),
                parent_session_id: if key_index % 11 == 0 {
                    Some("sess-parent".to_string())
                } else {
                    None
                },
                composited_child_session_id: None,
                raw_json,
                provider: "opencode".to_string(),
            }
        })
        .collect()
}

/// The full fixed workload (10 000 operations).
pub fn generate() -> Vec<Row> {
    generate_n(ROWS)
}

/// A truncated workload for the PoC smoke run (still batch-sized).
pub fn generate_poc() -> Vec<Row> {
    generate_n(1024)
}

/// Public description of the workload for the results file.
#[derive(Serialize)]
pub struct Workload {
    pub rows: usize,
    pub batch: usize,
    pub reupsert_ratio: f64,
    pub unique_keys: usize,
}

pub fn description() -> Workload {
    let unique_keys = ROWS - ROWS * REUPSERT_PERMILLE / 1000;
    Workload {
        rows: ROWS,
        batch: BATCH,
        reupsert_ratio: REUPSERT_PERMILLE as f64 / 1000.0,
        unique_keys,
    }
}
