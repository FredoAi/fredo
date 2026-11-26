//! Spec #3244 ST-4 — the per-turn injection record (the live receipt).
//!
//! # Why this module exists
//!
//! AC-2 / AC-3 / AC-4 are runtime observables, and `telemetry_logs` is NOT an
//! accepted live receipt (known gate gap M9). The webview therefore reports the
//! turn's injection facts on the SAME structured-status turn it already sends
//! ([`super::status::llm_chat_with_status`]), and this module persists them into
//! `telemetry_spans` as `span_name = "companion.injection"`.
//!
//! The QA reads that span set back (`SELECT … FROM telemetry_spans WHERE
//! span_name = 'companion.injection'`) to assert the description reached the turn,
//! the pair's size, and freshness between turns.
//!
//! # Derived, never hand-authored (R-4b)
//!
//! The facts are computed by the RUN that produced the pair (the webview's
//! injection builder) and arrive here as data. This module adds no default and
//! invents no number — a missing leg arrives as its real zero.
//!
//! # Freshness (R-3a / AC-3)
//!
//! Every call mints a FRESH `span_id`, so two turns are always distinguishable
//! even when their byte counts coincide; the digests carry the content.

use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::span_store::SpanStore;
use crate::infrastructure::telemetry::TelemetrySpan;

/// The span name the QA reads the per-turn receipt back by.
pub const INJECTION_SPAN_NAME: &str = "companion.injection";

/// The provider label on the injection span (Fredo's own turn, not a CLI agent).
pub const INJECTION_PROVIDER: &str = "fredo";

/// The transport label on the injection span (in-process, no network hop).
pub const INJECTION_TRANSPORT: &str = "in_process";

/// The turn's injection facts, as the webview reports them.
///
/// `camelCase` on the wire (the webview's `CompanionInjectionFacts`), stored
/// verbatim in the span's `attributes_json` so a reader sees exactly what the
/// turn carried.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionInjectionSpan {
    /// The target application the turn was aimed at.
    pub app_id: String,
    /// Did the description+pair path resolve the target per-app? (AC-5 witness.)
    pub taught: bool,
    /// How many per-app enablement entries the path consulted.
    pub per_app_entries: i64,
    /// UTF-8 bytes of the injected description.
    pub description_bytes: i64,
    /// UTF-8 bytes of the injected screenshot (its base64 payload).
    pub screenshot_bytes: i64,
    /// UTF-8 bytes of the injected screen outline.
    pub simplified_html_bytes: i64,
    /// The number of nodes the injected screen outline carries (Spec #3244, ST-6;
    /// AC-4) — the `outline` leg's size alongside its byte count.
    pub simplified_html_nodes: i64,
    /// A content digest of the screenshot (freshness witness).
    pub screenshot_digest: String,
    /// A content digest of the screen outline (freshness witness).
    pub simplified_html_digest: String,
    /// The screenshot's ENCODED visual-token count (Spec #3244, ST-6; AC-4) — the
    /// engine's `MediaPlan::image_tokens` for the turn's image leg.
    ///
    /// It is NOT an input the webview knows: the projector computes it while
    /// ENCODING the screenshot, so it is filled in AFTER the turn
    /// ([`CompanionInjectionSpan::completed`]) and is absent when the engine
    /// never ran (a failed start). This is the number the AC-4 screen-read
    /// measurement records — the amount of screen Fredo can act on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_tokens: Option<i64>,
}

impl CompanionInjectionSpan {
    /// Complete the receipt with the engine's encoded image-token readout (or
    /// `None` when the engine never produced one). Consuming, so the facts are
    /// recorded exactly once with the value the run observed.
    pub fn completed(mut self, image_tokens: Option<i64>) -> Self {
        self.image_tokens = image_tokens;
        self
    }
}

fn now_ns() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as i64
}

/// Build the `telemetry_spans` row for one turn's injection facts.
///
/// Pure, so the row shape is pinnable without a store. A fresh `trace_id` and
/// `span_id` per call is what makes every turn its own record.
pub fn injection_span_record(facts: &CompanionInjectionSpan) -> TelemetrySpan {
    let start = now_ns();
    TelemetrySpan {
        trace_id: uuid::Uuid::new_v4().to_string(),
        span_id: uuid::Uuid::new_v4().to_string(),
        parent_span_id: None,
        span_name: INJECTION_SPAN_NAME.to_string(),
        span_kind: "INTERNAL".to_string(),
        start_time_ns: start,
        end_time_ns: Some(start),
        status_code: "OK".to_string(),
        status_message: None,
        session_id: facts.app_id.clone(),
        attributes_json: serde_json::to_string(facts).ok(),
        events_json: None,
        provider: Some(INJECTION_PROVIDER.to_string()),
        transport: Some(INJECTION_TRANSPORT.to_string()),
        event_type: Some(INJECTION_SPAN_NAME.to_string()),
        ingested_at: Utc::now().to_rfc3339(),
    }
}

/// Record one turn's injection facts into `telemetry_spans` (best-effort).
///
/// A missing span store or a failed insert is logged and swallowed: the receipt
/// is observability, and a telemetry write must never fail the turn. The record
/// itself is built BEFORE any I/O, so the facts are the caller's own.
pub async fn record_injection_span(app: &AppHandle, facts: &CompanionInjectionSpan) {
    let Some(store) = app.try_state::<Arc<SpanStore>>() else {
        tracing::warn!(
            target: "fredo::llm_server",
            "injection span not recorded: the span store is not managed"
        );
        return;
    };
    let record = injection_span_record(facts);
    if let Err(error) = store.inner().insert_spans(&[record]).await {
        tracing::warn!(
            target: "fredo::llm_server",
            error = %error,
            "the injection span could not be inserted"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CompanionInjectionSpan {
        CompanionInjectionSpan {
            app_id: "qa3244-untaught".to_string(),
            taught: false,
            per_app_entries: 0,
            description_bytes: 42,
            screenshot_bytes: 2048,
            simplified_html_bytes: 512,
            simplified_html_nodes: 9,
            screenshot_digest: "0a1b2c3d4e5f6071".to_string(),
            simplified_html_digest: "1122334455667788".to_string(),
            image_tokens: Some(1120),
        }
    }

    /// The record names itself the way the QA reads it back and carries the
    /// caller's facts verbatim — no default, no invented number (R-4b).
    #[test]
    fn the_record_carries_the_facts_and_the_readable_span_name() {
        let record = injection_span_record(&sample());
        assert_eq!(record.span_name, INJECTION_SPAN_NAME);
        assert_eq!(record.span_name, "companion.injection");
        assert_eq!(record.session_id, "qa3244-untaught");
        assert_eq!(record.provider.as_deref(), Some(INJECTION_PROVIDER));
        assert_eq!(record.transport.as_deref(), Some(INJECTION_TRANSPORT));
        assert_eq!(record.event_type.as_deref(), Some(INJECTION_SPAN_NAME));
        assert_eq!(record.status_code, "OK");
        assert!(record.end_time_ns.is_some(), "a completed record has an end");
        assert!(!record.ingested_at.is_empty());

        // The facts round-trip through the stored attributes (camelCase wire).
        let stored = record.attributes_json.expect("attributes are stored");
        let parsed: CompanionInjectionSpan =
            serde_json::from_str(&stored).expect("the stored attributes are the facts");
        assert_eq!(parsed, sample());
    }

    /// The witness fields are the CAMEL-CASE keys the QA plan names, so a reader
    /// queries exactly `taught` / `perAppEntries`.
    #[test]
    fn the_attributes_use_the_camel_case_witness_keys() {
        let stored = serde_json::to_value(sample()).expect("serialize");
        let object = stored.as_object().expect("object");
        for key in [
            "appId",
            "taught",
            "perAppEntries",
            "descriptionBytes",
            "screenshotBytes",
            "simplifiedHtmlBytes",
            "simplifiedHtmlNodes",
            "screenshotDigest",
            "simplifiedHtmlDigest",
            "imageTokens",
        ] {
            assert!(object.contains_key(key), "the facts must carry `{key}`: {stored}");
        }
        assert_eq!(object["taught"], serde_json::json!(false));
        assert_eq!(object["perAppEntries"], serde_json::json!(0));
        assert_eq!(object["simplifiedHtmlNodes"], serde_json::json!(9));
        assert_eq!(object["imageTokens"], serde_json::json!(1120));
    }

    /// Spec #3244 ST-6 (AC-4): `imageTokens` is NOT a webview input — the engine
    /// adds it AFTER the turn. A webview payload that omits it deserializes to
    /// `None`, and `completed` fills it from the run; when the engine never ran
    /// the key is ABSENT (G-413), never a fabricated `0`.
    #[test]
    fn the_image_token_readout_is_filled_from_the_run_never_the_webview() {
        // The webview's own payload: every input fact, no imageTokens key.
        let webview_payload = serde_json::json!({
            "appId": "qa3244-untaught",
            "taught": false,
            "perAppEntries": 0,
            "descriptionBytes": 42,
            "screenshotBytes": 2048,
            "simplifiedHtmlBytes": 512,
            "simplifiedHtmlNodes": 9,
            "screenshotDigest": "0a1b2c3d4e5f6071",
            "simplifiedHtmlDigest": "1122334455667788",
        });
        let mut facts: CompanionInjectionSpan =
            serde_json::from_value(webview_payload).expect("the webview payload deserializes");
        assert_eq!(facts.image_tokens, None, "the webview carries no image tokens");

        // The engine's readout fills it (the AC-4 number).
        facts = facts.completed(Some(1120));
        assert_eq!(facts.image_tokens, Some(1120));
        let stored = serde_json::to_value(&facts).expect("serialize");
        assert_eq!(stored["imageTokens"], serde_json::json!(1120));

        // An engine that never ran leaves the key ABSENT — never an invented 0.
        let absent = sample().completed(None);
        let stored = serde_json::to_value(&absent).expect("serialize");
        assert!(
            stored.get("imageTokens").is_none(),
            "an unmeasured turn must not carry an imageTokens key: {stored}"
        );
    }

    /// Freshness (AC-3): two records of the SAME facts still differ by identity —
    /// a distinct `span_id` (and trace) per call, so two turns are never merged by
    /// `telemetry_spans`' primary key.
    #[test]
    fn every_record_gets_its_own_span_identity() {
        let facts = sample();
        let first = injection_span_record(&facts);
        let second = injection_span_record(&facts);
        assert_ne!(
            first.span_id, second.span_id,
            "each turn must be its own row (AC-3)"
        );
        assert_ne!(first.trace_id, second.trace_id);
    }
}
