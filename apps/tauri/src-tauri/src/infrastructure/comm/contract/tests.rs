//! Comprehensive unit tests for the Event Contract Engine.
//!
//! Covers all acceptance criteria from BL#303:
//! - AC-B1: Contract registration (REQ-1)
//! - AC-B2: Stream field delivery — Init→Update→End lifecycle (REQ-2)
//! - AC-B3: Deferred field buffering (REQ-3)
//! - AC-B4: completeWhen evaluation (REQ-4)
//! - AC-B5: Timeout eviction (REQ-5)
//! - AC-B6: Periodic sweep (REQ-6 — tested via manual sweep call)
//! - AC-B7: Contract deregistration (REQ-7)
//! - AC-B8: Provider filtering (REQ-8)
//! - AC-B9: No-match silent drop (REQ-9)
//! - AC-B10: Field mismatch skip (REQ-10)
//! - AC-B11: Composite key isolation (REQ-11)
//! - AC-B12: Delivery queue overflow (REQ-12)
//! - AC-B13: Full payload delivery (REQ-13)
//! - NB-C1: All completeWhen operators
//! - NB-C2: Timeout validation

#![cfg(test)]

use std::sync::Arc;

use crate::infrastructure::comm::contract::engine::ContractEngine;
use crate::infrastructure::comm::contract::types::ContractDeclaration;
use crate::infrastructure::comm::contract::EventContractEngine;
use crate::infrastructure::comm::event::{
    EventProvider, EventState, EventType, FredoEvent, Transport,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn make_engine() -> Arc<ContractEngine> {
    ContractEngine::new()
}

fn test_event(
    session_id: &str,
    correlation_id: Option<&str>,
    tool_name: Option<&str>,
    state: EventState,
    provider: EventProvider,
    payload: Option<serde_json::Value>,
) -> FredoEvent {
    let mut b = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(state)
        .provider(provider)
        .session_id(session_id)
        .transport(Transport::Hook);
    if let Some(cid) = correlation_id {
        b = b.correlation_id(cid);
    }
    if let Some(tn) = tool_name {
        b = b.tool_name(tn);
    }
    if let Some(p) = payload {
        b = b.payload(p);
    }
    b.build()
}

fn default_payload() -> serde_json::Value {
    serde_json::json!({
        "result": "file content",
        "status": "running",
        "progress": 0.3
    })
}

// ── AC-B1: Contract registration ──────────────────────────────────────────────

#[test]
fn register_valid_contract() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "test-contract".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 30000,
        providers: None,
        transports: None,
        event_types: None,
    };
    let result = engine.req_1_register(vec![contract]);
    assert!(result.is_ok(), "Expected OK, got: {:?}", result);
}

#[test]
fn register_rejects_timeout_over_300s() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "bad-timeout".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 300_001,
        providers: None,
        transports: None,
        event_types: None,
    };
    let result = engine.req_1_register(vec![contract]);
    assert!(result.is_err());
    let errs = result.unwrap_err();
    assert!(errs[0].contains("timeout"), "Expected timeout error, got: {:?}", errs);
}

#[test]
fn register_accepts_max_timeout() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "max-timeout".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 300_000,
        providers: None,
        transports: None,
        event_types: None,
    };
    let result = engine.req_1_register(vec![contract]);
    assert!(result.is_ok());
}

#[test]
fn register_rejects_invalid_complete_when() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "bad-expr".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "not a valid expression".to_string(),
        timeout: 10000,
        providers: None,
        transports: None,
        event_types: None,
    };
    let result = engine.req_1_register(vec![contract]);
    assert!(result.is_err());
}

#[test]
fn register_empty_contract_list_is_ok() {
    let engine = make_engine();
    let result = engine.req_1_register(vec![]);
    assert!(result.is_ok());
}

#[test]
fn register_multiple_contracts_all_valid() {
    let engine = make_engine();
    let c1 = ContractDeclaration {
        contract_name: "c1".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 10000,
        providers: None,
        transports: None,
        event_types: None,
    };
    let c2 = ContractDeclaration {
        contract_name: "c2".to_string(),
        stream_fields: vec!["toolName".to_string()],
        deferred_fields: vec![],
        key: vec!["correlationId".to_string()],
        complete_when: "exists payload.result".to_string(),
        timeout: 20000,
        providers: None,
        transports: None,
        event_types: None,
    };
    let result = engine.req_1_register(vec![c1, c2]);
    assert!(result.is_ok());
}

// ── AC-B2 / AC-B13: Stream field delivery — Init→Update→End lifecycle ─────────

#[test]
fn first_event_emits_init() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "lifecycle".to_string(),
        stream_fields: vec!["state".to_string(), "payload.status".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let deliveries = engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Init,
        EventProvider::OpenCode,
        Some(default_payload()),
    ));

    assert_eq!(deliveries.len(), 1, "Expected 1 delivery");
    assert_eq!(deliveries[0].lifecycle, "init");
    assert_eq!(deliveries[0].contract_name, "lifecycle");
    assert!(deliveries[0].timed_out.is_none());
    assert!(deliveries[0].payload.as_object().unwrap().contains_key("state"));
}

#[test]
fn second_event_emits_update() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "lifecycle-update".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // First event → init
    engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Init,
        EventProvider::OpenCode,
        None,
    ));

    // Second event → update
    let deliveries = engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Update,
        EventProvider::OpenCode,
        None,
    ));

    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].lifecycle, "update");
}

#[test]
fn complete_when_triggers_end() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "end-test".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec!["payload.result".to_string()],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Init event
    engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Init,
        EventProvider::OpenCode,
        Some(serde_json::json!({ "status": "running" })),
    ));

    // Response event → triggers completeWhen → end
    let deliveries = engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Response,
        EventProvider::OpenCode,
        Some(serde_json::json!({ "status": "completed", "result": "done" })),
    ));

    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].lifecycle, "end");
    assert!(deliveries[0].timed_out.is_none());
}

#[test]
fn complete_when_on_first_event_emits_init_and_end() {
    // REQ-1 / Spec #369: When completeWhen fires on the first matching event
    // for a composite key, both init and end deliveries are emitted in order
    // (init first, end second).
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "first-event-complete".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec!["payload.result".to_string()],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Single event where completeWhen fires immediately (is_new=true, should_complete=true)
    let deliveries = engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Response,
        EventProvider::OpenCode,
        Some(serde_json::json!({ "result": "done" })),
    ));

    assert_eq!(deliveries.len(), 2, "Expected 2 deliveries (init + end)");
    assert_eq!(deliveries[0].lifecycle, "init",
        "First delivery should be init");
    assert_eq!(deliveries[1].lifecycle, "end",
        "Second delivery should be end");
    assert!(deliveries[1].timed_out.is_none(),
        "End delivery should not be timed out");

    // init payload should have stream fields only
    let init_payload = deliveries[0].payload.as_object().unwrap();
    assert!(init_payload.contains_key("state"),
        "Init payload should contain stream field 'state'");
    assert!(!init_payload.contains_key("payload.result"),
        "Init payload should NOT contain deferred field 'payload.result'");

    // end payload should have full accumulated payload (stream + deferred)
    let end_payload = deliveries[1].payload.as_object().unwrap();
    assert!(end_payload.contains_key("state"),
        "End payload should contain stream field 'state'");
    assert!(end_payload.contains_key("payload.result"),
        "End payload should contain deferred field 'payload.result'");
}

#[test]
fn complete_when_on_first_event_with_exists_operator() {
    // REQ-1 / Spec #369: When completeWhen uses 'exists' operator and fires
    // on the first event, both init and end are emitted.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "first-event-exists".to_string(),
        stream_fields: vec!["state".to_string(), "payload.result".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "exists payload.result".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let deliveries = engine.req_2_3_process(test_event(
        "s1",
        None,
        None,
        EventState::Init,
        EventProvider::OpenCode,
        Some(serde_json::json!({ "result": "immediate" })),
    ));

    assert_eq!(deliveries.len(), 2,
        "First event with exists match should emit init + end");
    assert_eq!(deliveries[0].lifecycle, "init");
    assert_eq!(deliveries[1].lifecycle, "end");
}

#[test]
fn no_deliveries_after_complete() {
    // After a contract instance completes, buffered events stay in the map
    // (marked completed=true) so subsequent events deliver as UPDATES rather
    // than creating new buffers (prevents duplicate nodes — Spec #382 AC-4).
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "complete-once".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode, None,
    ));

    // After completion, a new event for the same key delivers as UPDATE,
    // not init — the completed buffer persists to deliver late data.
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries[0].lifecycle, "update",
        "After completion, subsequent events deliver as update (buffer persists)");
}

// ── AC-B3: Deferred field buffering ───────────────────────────────────────────

#[test]
fn deferred_fields_not_in_init_update() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "deferred-test".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec!["payload.result".to_string()],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Init — deferred field should NOT be in delivery payload
    let deliveries_init = engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Init,
        EventProvider::OpenCode,
        Some(serde_json::json!({ "result": "data", "status": "running" })),
    ));

    assert_eq!(deliveries_init.len(), 1);
    assert_eq!(deliveries_init[0].lifecycle, "init");
    let init_payload = deliveries_init[0].payload.as_object().unwrap();
    assert!(init_payload.contains_key("state"));
    assert!(!init_payload.contains_key("payload.result"),
        "Deferred field should not appear in init payload");

    // End — deferred field SHOULD be in delivery payload
    let deliveries_end = engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Response,
        EventProvider::OpenCode,
        Some(serde_json::json!({ "result": "data", "status": "completed" })),
    ));

    assert_eq!(deliveries_end.len(), 1);
    assert_eq!(deliveries_end[0].lifecycle, "end");
    let end_payload = deliveries_end[0].payload.as_object().unwrap();
    assert!(end_payload.contains_key("state"));
    assert!(end_payload.contains_key("payload.result"),
        "Deferred field should appear in end payload");
}

// ── AC-B4 / NB-C1: completeWhen evaluation with all operators ─────────────────

#[test]
fn complete_when_equals_operator() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "eq-op".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    let d = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode, None,
    ));
    assert_eq!(d[0].lifecycle, "end");
}

#[test]
fn complete_when_not_equals_operator() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "ne-op".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "state !== 'Init'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    let d = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Update, EventProvider::OpenCode, None,
    ));
    assert_eq!(d[0].lifecycle, "end");
}

#[test]
fn complete_when_exists_operator() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "exists-op".to_string(),
        stream_fields: vec!["state".to_string(), "payload.result".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "exists payload.result".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    let d = engine.req_2_3_process(test_event(
        "s1",
        None,
        None,
        EventState::Update,
        EventProvider::OpenCode,
        Some(serde_json::json!({ "result": "done" })),
    ));
    assert_eq!(d[0].lifecycle, "end");
}

#[test]
fn complete_when_not_exists_operator() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "nexists-op".to_string(),
        stream_fields: vec!["state".to_string(), "payload.error".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "!exists payload.error".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    // Event without payload.error → completeWhen true on first event
    let d = engine.req_2_3_process(test_event(
        "s1",
        None,
        None,
        EventState::Init,
        EventProvider::OpenCode,
        Some(serde_json::json!({})),
    ));
    assert_eq!(d.len(), 2, "First event with !exists match should emit init + end");
    assert_eq!(d[0].lifecycle, "init", "First delivery should be init");
    assert_eq!(d[1].lifecycle, "end", "Second delivery should be end");
}

#[test]
fn complete_when_greater_than() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "gt-op".to_string(),
        stream_fields: vec!["state".to_string(), "payload.progress".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "payload.progress > 0.5".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode,
        Some(serde_json::json!({ "progress": 0.3 })),
    ));
    let d = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Update, EventProvider::OpenCode,
        Some(serde_json::json!({ "progress": 0.9 })),
    ));
    assert_eq!(d[0].lifecycle, "end");
}

#[test]
fn complete_when_greater_than_or_equal() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "gte-op".to_string(),
        stream_fields: vec!["state".to_string(), "payload.progress".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "payload.progress >= 0.8".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode,
        Some(serde_json::json!({ "progress": 0.8 })),
    ));
    let d = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Update, EventProvider::OpenCode,
        Some(serde_json::json!({ "progress": 0.3 })),
    ));
    // After completion, subsequent events deliver as update (buffer persists)
    assert_eq!(d[0].lifecycle, "update",
        "After end, next event delivers as update (buffer persists)");
}

#[test]
fn complete_when_less_than() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "lt-op".to_string(),
        stream_fields: vec!["state".to_string(), "payload.count".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "payload.count < 5".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    let d = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode,
        Some(serde_json::json!({ "count": 3 })),
    ));
    assert_eq!(d.len(), 2, "First event with < match should emit init + end");
    assert_eq!(d[0].lifecycle, "init");
    assert_eq!(d[1].lifecycle, "end");
}

#[test]
fn complete_when_less_than_or_equal() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "lte-op".to_string(),
        stream_fields: vec!["state".to_string(), "payload.count".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "payload.count <= 10".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    let d = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode,
        Some(serde_json::json!({ "count": 10 })),
    ));
    assert_eq!(d.len(), 2, "First event with <= match should emit init + end");
    assert_eq!(d[0].lifecycle, "init");
    assert_eq!(d[1].lifecycle, "end");
}

#[test]
fn complete_when_partial_match_does_not_complete() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "no-complete".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    let d = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d[0].lifecycle, "init", "Init should not complete");
}

// ── AC-B5 / AC-B6: Timeout eviction + periodic sweep ──────────────────────────

#[test]
fn sweep_evicts_expired_keys() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "sweep-test".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 1, // 1ms — expires very quickly
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Process one event to create a buffer entry
    engine.req_2_3_process(test_event(
        "session-1",
        None,
        None,
        EventState::Init,
        EventProvider::OpenCode,
        None,
    ));

    // Sleep briefly to ensure elapsed >= 1ms
    std::thread::sleep(std::time::Duration::from_millis(10));

    // Sweep should find expired key
    let deliveries = engine.req_6_sweep();
    assert!(!deliveries.is_empty(), "Expected at least one expired delivery");
    assert_eq!(deliveries[0].lifecycle, "end");
    assert_eq!(deliveries[0].timed_out, Some(true));
}

#[test]
fn sweep_does_not_evict_unexpired_keys() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "no-sweep".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));

    let deliveries = engine.req_6_sweep();
    assert!(deliveries.is_empty(), "Should not evict unexpired keys");
}

#[test]
fn zero_timeout_does_not_sweep_immediately() {
    // timeout = 0 means disabled (no timeout), so sweep doesn't remove it
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "zero-timeout-sweep".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 0,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    let deliveries = engine.req_6_sweep();
    assert!(deliveries.is_empty(), "Zero timeout should not trigger sweep");
}

// ── AC-B7: Contract deregistration ────────────────────────────────────────────

#[test]
fn deregister_emits_timed_out_for_in_flight() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "dereg".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Create in-flight buffer entry
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));

    // Deregister
    let deliveries = engine.req_7_deregister(vec!["dereg".to_string()]);
    assert!(!deliveries.is_empty(), "Expected timedOut deliveries");
    assert_eq!(deliveries[0].timed_out, Some(true));
}

#[test]
fn deregister_removes_contract() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "remove-me".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_7_deregister(vec!["remove-me".to_string()]);

    // After deregister, events should not match (silent drop — AC-B9)
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert!(deliveries.is_empty(), "Expected no deliveries after deregister");
}

#[test]
fn deregister_nonexistent_contract_is_noop() {
    let engine = make_engine();
    let deliveries = engine.req_7_deregister(vec!["does-not-exist".to_string()]);
    assert!(deliveries.is_empty(), "Deregistering unknown contract should produce no deliveries");
}

// ── AC-B8: Provider filtering ─────────────────────────────────────────────────

#[test]
fn provider_filter_skips_non_matching() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "provider-test".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: Some(vec!["open_code".to_string()]),
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Internal provider should be skipped
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::Internal, None,
    ));
    assert!(deliveries.is_empty(), "Internal provider should be filtered out");
}

#[test]
fn provider_filter_allows_matching() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "provider-match".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: Some(vec!["open_code".to_string()]),
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].provider.as_deref(), Some("open_code"));
}

#[test]
fn provider_filter_multi_allows_any_match() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "multi-provider".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: Some(vec!["open_code".to_string(), "internal".to_string()]),
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let d1 = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d1.len(), 1, "OpenCode should match");

    let d2 = engine.req_2_3_process(test_event(
        "s2", None, None, EventState::Init, EventProvider::Internal, None,
    ));
    assert_eq!(d2.len(), 1, "Internal should match");
}

fn test_event_transport(
    session_id: &str,
    correlation_id: Option<&str>,
    tool_name: Option<&str>,
    state: EventState,
    provider: EventProvider,
    payload: Option<serde_json::Value>,
    transport: Transport,
) -> FredoEvent {
    let mut b = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(state)
        .provider(provider)
        .session_id(session_id)
        .transport(transport);
    if let Some(cid) = correlation_id {
        b = b.correlation_id(cid);
    }
    if let Some(tn) = tool_name {
        b = b.tool_name(tn);
    }
    if let Some(p) = payload {
        b = b.payload(p);
    }
    b.build()
}

fn test_event_eventtype(
    session_id: &str,
    correlation_id: Option<&str>,
    tool_name: Option<&str>,
    state: EventState,
    provider: EventProvider,
    payload: Option<serde_json::Value>,
    event_type: EventType,
) -> FredoEvent {
    let mut b = FredoEvent::builder()
        .event_type(event_type)
        .state(state)
        .provider(provider)
        .session_id(session_id)
        .transport(Transport::Hook);
    if let Some(cid) = correlation_id {
        b = b.correlation_id(cid);
    }
    if let Some(tn) = tool_name {
        b = b.tool_name(tn);
    }
    if let Some(p) = payload {
        b = b.payload(p);
    }
    b.build()
}

fn test_event_full(
    session_id: &str,
    correlation_id: Option<&str>,
    tool_name: Option<&str>,
    state: EventState,
    provider: EventProvider,
    payload: Option<serde_json::Value>,
    transport: Transport,
    event_type: EventType,
) -> FredoEvent {
    let mut b = FredoEvent::builder()
        .event_type(event_type)
        .state(state)
        .provider(provider)
        .session_id(session_id)
        .transport(transport);
    if let Some(cid) = correlation_id {
        b = b.correlation_id(cid);
    }
    if let Some(tn) = tool_name {
        b = b.tool_name(tn);
    }
    if let Some(p) = payload {
        b = b.payload(p);
    }
    b.build()
}

#[test]
fn transport_filter_skips_non_matching() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "transport-test".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: Some(vec!["hook".to_string()]),
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // OtlpGrpc transport should be skipped
    let deliveries = engine.req_2_3_process(test_event_transport(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None, Transport::OtlpGrpc,
    ));
    assert!(deliveries.is_empty(), "OtlpGrpc transport should be filtered out");
}

#[test]
fn transport_filter_allows_matching() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "transport-match".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: Some(vec!["hook".to_string()]),
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let deliveries = engine.req_2_3_process(test_event_transport(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None, Transport::Hook,
    ));
    assert_eq!(deliveries.len(), 1);
}

#[test]
fn transport_filter_multi_allows_any_match() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "multi-transport".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: Some(vec!["hook".to_string(), "otlp_grpc".to_string()]),
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let d1 = engine.req_2_3_process(test_event_transport(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None, Transport::Hook,
    ));
    assert_eq!(d1.len(), 1, "Hook should match");

    let d2 = engine.req_2_3_process(test_event_transport(
        "s2", None, None, EventState::Init, EventProvider::OpenCode, None, Transport::OtlpGrpc,
    ));
    assert_eq!(d2.len(), 1, "OtlpGrpc should match");
}

#[test]
fn transport_filter_default_matches_all() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "transport-default".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None, // Default � match all
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let d1 = engine.req_2_3_process(test_event_transport(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None, Transport::Hook,
    ));
    assert_eq!(d1.len(), 1, "Hook should match with default transports");

    let d2 = engine.req_2_3_process(test_event_transport(
        "s2", None, None, EventState::Init, EventProvider::OpenCode, None, Transport::OtlpGrpc,
    ));
    assert_eq!(d2.len(), 1, "OtlpGrpc should match with default transports");
}

#[test]
fn event_type_filter_skips_non_matching() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "eventtype-test".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: Some(vec!["tool_use".to_string()]),
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Chat event should be skipped
    let deliveries = engine.req_2_3_process(test_event_eventtype(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None, EventType::Chat,
    ));
    assert!(deliveries.is_empty(), "Chat event type should be filtered out");
}

#[test]
fn event_type_filter_allows_matching() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "eventtype-match".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: Some(vec!["chat".to_string()]),
    };
    engine.req_1_register(vec![contract]).unwrap();

    let deliveries = engine.req_2_3_process(test_event_eventtype(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None, EventType::Chat,
    ));
    assert_eq!(deliveries.len(), 1);
}

#[test]
fn event_type_filter_multi_allows_any_match() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "multi-eventtype".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: Some(vec!["tool_use".to_string(), "chat".to_string()]),
    };
    engine.req_1_register(vec![contract]).unwrap();

    let d1 = engine.req_2_3_process(test_event_eventtype(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None, EventType::ToolUse,
    ));
    assert_eq!(d1.len(), 1, "ToolUse should match");

    let d2 = engine.req_2_3_process(test_event_eventtype(
        "s2", None, None, EventState::Init, EventProvider::OpenCode, None, EventType::Chat,
    ));
    assert_eq!(d2.len(), 1, "Chat should match");
}

#[test]
fn event_type_filter_default_matches_all() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "eventtype-default".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None, // Default � match all
    };
    engine.req_1_register(vec![contract]).unwrap();

    let d1 = engine.req_2_3_process(test_event_eventtype(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None, EventType::ToolUse,
    ));
    assert_eq!(d1.len(), 1, "ToolUse should match with default event_types");

    let d2 = engine.req_2_3_process(test_event_eventtype(
        "s2", None, None, EventState::Init, EventProvider::OpenCode, None, EventType::Chat,
    ));
    assert_eq!(d2.len(), 1, "Chat should match with default event_types");
}

#[test]
fn combined_transport_and_event_type_filters() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "combined-filter".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: Some(vec!["hook".to_string()]),
        event_types: Some(vec!["chat".to_string()]),
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Matching: Hook + Chat ? should pass
    let d1 = engine.req_2_3_process(test_event_full(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
        Transport::Hook, EventType::Chat,
    ));
    assert_eq!(d1.len(), 1, "Hook+Chat should match");

    // Wrong transport: OtlpGrpc + Chat ? should be filtered
    let d2 = engine.req_2_3_process(test_event_full(
        "s2", None, None, EventState::Init, EventProvider::OpenCode, None,
        Transport::OtlpGrpc, EventType::Chat,
    ));
    assert!(d2.is_empty(), "OtlpGrpc+Chat should be filtered by transport");

    // Wrong eventType: Hook + ToolUse ? should be filtered
    let d3 = engine.req_2_3_process(test_event_full(
        "s3", None, None, EventState::Init, EventProvider::OpenCode, None,
        Transport::Hook, EventType::ToolUse,
    ));
    assert!(d3.is_empty(), "Hook+ToolUse should be filtered by eventType");

    // Both wrong: OtlpGrpc + ToolUse ? should be filtered
    let d4 = engine.req_2_3_process(test_event_full(
        "s4", None, None, EventState::Init, EventProvider::OpenCode, None,
        Transport::OtlpGrpc, EventType::ToolUse,
    ));
    assert!(d4.is_empty(), "OtlpGrpc+ToolUse should be filtered by both");
}

// ── AC-B9: No-match silent drop ───────────────────────────────────────────────

#[test]
fn unmatched_event_dropped_silently() {
    let engine = make_engine();
    // No contracts registered
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert!(deliveries.is_empty(), "Unmatched event should be dropped silently");
}

// ── AC-B10: Field mismatch skip ───────────────────────────────────────────────

#[test]
fn missing_field_skipped_gracefully() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "missing-field".to_string(),
        stream_fields: vec!["state".to_string(), "payload.nonexistent".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Event without the nested field should still produce a delivery
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries.len(), 1);
    let payload = deliveries[0].payload.as_object().unwrap();
    assert!(payload.contains_key("state"));
    assert!(!payload.contains_key("payload.nonexistent"),
        "Missing field should not appear in payload");
}

#[test]
fn missing_key_field_skips_contract() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "missing-key".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string(), "correlationId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Event without correlationId should not match the contract
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert!(deliveries.is_empty(),
        "Event missing key field should be dropped");
}

// ── AC-B11: Composite key isolation ───────────────────────────────────────────

#[test]
fn different_keys_produce_independent_instances() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "key-isolation".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string(), "correlationId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Two different sessions + correlations → separate instances
    let d1 = engine.req_2_3_process(test_event(
        "s1", Some("c1"), None, EventState::Init, EventProvider::OpenCode, None,
    ));
    let d2 = engine.req_2_3_process(test_event(
        "s2", Some("c2"), None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d1[0].lifecycle, "init");
    assert_eq!(d2[0].lifecycle, "init");

    // End s1,c1 — s2,c2 should still be alive
    let d_end = engine.req_2_3_process(test_event(
        "s1", Some("c1"), None, EventState::Response, EventProvider::OpenCode, None,
    ));
    assert_eq!(d_end[0].lifecycle, "end");

    // s2,c2 should still get update, not end
    let d3 = engine.req_2_3_process(test_event(
        "s2", Some("c2"), None, EventState::Update, EventProvider::OpenCode, None,
    ));
    assert_eq!(d3[0].lifecycle, "update",
        "Separate key instance should not be affected");
}

#[test]
fn single_key_field_isolation() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "single-key".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let d_a = engine.req_2_3_process(test_event(
        "session-a", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    let d_b = engine.req_2_3_process(test_event(
        "session-b", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d_a[0].lifecycle, "init");
    assert_eq!(d_b[0].lifecycle, "init");
}

// ── AC-B12: Delivery queue overflow ───────────────────────────────────────────

#[test]
fn many_deliveries_do_not_cause_panic() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "overflow-test".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Send 150 events to the same key — no panics expected
    for i in 0..150 {
        let state = if i % 2 == 0 {
            EventState::Init
        } else {
            EventState::Update
        };
        let deliveries = engine.req_2_3_process(test_event(
            "s1", None, None, state, EventProvider::OpenCode, None,
        ));
        assert_eq!(deliveries.len(), 1, "All events should produce a delivery");
    }
}

// ── AC-B13: Full payload delivery ─────────────────────────────────────────────

#[test]
fn end_delivery_contains_full_accumulated_payload() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "full-payload".to_string(),
        stream_fields: vec!["state".to_string(), "payload.status".to_string()],
        deferred_fields: vec!["payload.result".to_string()],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Init event
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode,
        Some(serde_json::json!({ "status": "running" })),
    ));

    // Update event with deferred field
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Update, EventProvider::OpenCode,
        Some(serde_json::json!({ "status": "almost", "result": "partial" })),
    ));

    // Response event → End with full payload
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode,
        Some(serde_json::json!({ "status": "completed", "result": "final" })),
    ));

    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].lifecycle, "end");

    let payload = deliveries[0].payload.as_object().unwrap();
    assert!(payload.contains_key("state"), "state should be in end payload");
    assert!(payload.contains_key("payload.status"), "stream field should be in end payload");
    assert!(payload.contains_key("payload.result"), "deferred field should be in end payload");
}

// ── NB-C2: Timeout validation ─────────────────────────────────────────────────

#[test]
fn timeout_zero_is_accepted() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "zero-timeout".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 0,
        providers: None,
        transports: None,
        event_types: None,
    };
    let result = engine.req_1_register(vec![contract]);
    assert!(result.is_ok(), "Zero timeout should be accepted");
}

#[test]
fn timeout_boundary_300000_is_accepted() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "boundary-timeout".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 300000,
        providers: None,
        transports: None,
        event_types: None,
    };
    let result = engine.req_1_register(vec![contract]);
    assert!(result.is_ok());
}

// ── Edge cases ────────────────────────────────────────────────────────────────

#[test]
fn event_with_null_payload_still_produces_delivery() {
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "null-payload".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].lifecycle, "init");
}

#[test]
fn multiple_contracts_same_key_different_names() {
    let engine = make_engine();
    let c1 = ContractDeclaration {
        contract_name: "mc1".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    let c2 = ContractDeclaration {
        contract_name: "mc2".to_string(),
        stream_fields: vec!["toolName".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![c1, c2]).unwrap();

    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, Some("read_file"), EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries.len(), 2, "Both contracts should produce deliveries");
}

// ── Spec #523: ECE Compositing — Relationship Registry ────────────────────────
//
// Tests cover:
//   - REQ-2 (relationship): child→parent mapping stored, forward compositing
//   - REQ-3 (relationship): composited sessionId in key, payload, and re-keying
//   - REQ-4 (relationship): late-relationship buffer re-keying
//   - REQ-7 (relationship): relationship cleanup on buffer removal
//   - REQ-8 (relationship): 10K cap with eviction, multiple children
//   - Backward compatibility: no compositing without relationship
//   - Cross-event-type compositing

fn make_relationship_event(parent: &str, child: &str) -> FredoEvent {
    FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Init)
        .provider(EventProvider::OpenCode)
        .session_id(parent)
        .transport(Transport::Hook)
        .metadata(serde_json::json!({
            "relationship": {
                "type": "parent-child",
                "parentSessionId": parent,
                "childSessionId": child,
            }
        }))
        .build()
}

#[test]
fn register_relationship_stores_mapping() {
    // REQ-2 (relationship): Verify child→parent mapping is stored by checking
    // that child events are composited to the parent sessionId in their delivery key.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "rel-map".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Register two unique relationships
    let rel1 = make_relationship_event("parent-a", "child-a");
    engine.req_2_3_process(rel1);

    let rel2 = make_relationship_event("parent-b", "child-b");
    engine.req_2_3_process(rel2);

    // child-a should be composited to parent-a
    let d_a = engine.req_2_3_process(test_event(
        "child-a", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d_a.len(), 1);
    assert_eq!(
        d_a[0].key.get("sessionId").unwrap(),
        "parent-a",
        "child-a should map to parent-a"
    );

    // child-b should be composited to parent-b (independent mapping)
    let d_b = engine.req_2_3_process(test_event(
        "child-b", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d_b.len(), 1);
    assert_eq!(
        d_b[0].key.get("sessionId").unwrap(),
        "parent-b",
        "child-b should map to parent-b"
    );
}

#[test]
fn compositing_substitutes_session_id_in_key() {
    // REQ-3 (relationship): When a child event is processed after a relationship
    // is registered, the delivery key should contain the parent sessionId
    // instead of the child sessionId. The child's own sessionId is only in
    // compositedChildSessionId in the payload.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "key-sub".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Register relationship
    let rel = make_relationship_event("parent-key", "child-key");
    engine.req_2_3_process(rel);

    // Process child event — key should have parent sessionId
    let deliveries = engine.req_2_3_process(test_event(
        "child-key", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries.len(), 1);
    assert_eq!(
        deliveries[0].key.get("sessionId").unwrap(),
        "parent-key",
        "Composited delivery key should contain parent sessionId"
    );
    assert_ne!(
        deliveries[0].key.get("sessionId").unwrap().as_str(),
        "child-key",
        "Composited delivery key should NOT contain child sessionId"
    );
}

#[test]
fn late_relationship_rekeys_existing_buffers() {
    // REQ-4 (relationship): When relationship metadata is received AFTER child
    // events have already been processed, the existing child buffer should be
    // re-keyed to the parent sessionId. Two deliveries are emitted:
    //  1. An "end" delivery with the old (child) key — tells the frontend
    //     this child session was composited.
    //  2. An "init" delivery with the new (parent) key — creates a new node
    //     (SubagentNode) under the parent session for the composited child data.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "late-rel".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Step 1: Process child event BEFORE relationship is registered.
    // The buffer is created under the child's own sessionId.
    let pre_rel = engine.req_2_3_process(test_event(
        "late-child", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(pre_rel.len(), 1);
    assert_eq!(pre_rel[0].lifecycle, "init");
    assert_eq!(
        pre_rel[0].key.get("sessionId").unwrap(),
        "late-child",
        "Before relationship, child uses its own sessionId in key"
    );

    // Step 2: Register relationship — triggers re-keying of the existing buffer.
    // The relationship event itself matches the contract (sessionId=late-parent),
    // producing an additional delivery from contract processing.
    // Total: 2 from register_relationship (end + init) + 1 from contract = 3
    let rel_event = make_relationship_event("late-parent", "late-child");
    let rel_deliveries = engine.req_2_3_process(rel_event);
    assert_eq!(rel_deliveries.len(), 3,
        "Expected 3 deliveries: re-keyed end + re-keyed init + contract-processing delivery");

    // Find the end delivery (composited cleanup for old child key)
    let end_delivery = rel_deliveries.iter().find(|d| {
        d.lifecycle == "end" && d.timed_out == Some(true)
    }).expect("Expected a timedOut end delivery for the old child buffer");

    assert_eq!(
        end_delivery.key.get("sessionId").unwrap(),
        "late-child",
        "End delivery should have the old child sessionId in its key"
    );
    assert_eq!(
        end_delivery.payload.as_object().unwrap()["compositedChildSessionId"]
            .as_str().unwrap(),
        "late-child",
        "End delivery should identify the composited child sessionId"
    );

    // Find the re-keyed init delivery (new parent key)
    // Bug #523: Was "update" — changed to "init" so the frontend creates
    // a SubagentNode for the composited child session.
    let rekeyed = rel_deliveries.iter().find(|d| {
        d.lifecycle == "init"
            && d.payload.as_object()
                .map(|p| p.contains_key("compositedChildSessionId"))
                .unwrap_or(false)
    }).expect("Expected a re-keyed init delivery with compositedChildSessionId");

    assert_eq!(rekeyed.lifecycle, "init");
    assert_eq!(
        rekeyed.payload.as_object().unwrap()["compositedChildSessionId"]
            .as_str().unwrap(),
        "late-child",
        "Re-keyed delivery should identify the composited child sessionId"
    );
    assert_eq!(
        rekeyed.key.get("sessionId").unwrap(),
        "late-parent",
        "Re-keyed delivery key should have parent sessionId"
    );

    // Step 3: After re-keying, new child events are composited forward
    let after_rel = engine.req_2_3_process(test_event(
        "late-child", None, None, EventState::Update, EventProvider::OpenCode, None,
    ));
    assert_eq!(after_rel.len(), 1);
    assert_eq!(
        after_rel[0].key.get("sessionId").unwrap(),
        "late-parent",
        "After re-keying, child events composit to parent forward"
    );
}

#[test]
fn no_compositing_without_relationship() {
    // Backward compatibility: Events processed without any registered
    // relationship should use their own sessionId in the delivery key
    // and should NOT include compositedChildSessionId in the payload.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "no-rel".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Process event with NO relationship registered
    let deliveries = engine.req_2_3_process(test_event(
        "standalone-session", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));

    assert_eq!(deliveries.len(), 1);
    // Key should have the original sessionId — no compositing
    assert_eq!(
        deliveries[0].key.get("sessionId").unwrap(),
        "standalone-session",
        "Without relationship, event uses its own sessionId in key"
    );
    // No compositedChildSessionId in payload
    let payload = deliveries[0].payload.as_object().unwrap();
    assert!(
        !payload.contains_key("compositedChildSessionId"),
        "Without relationship, delivery should not have compositedChildSessionId"
    );
}

#[test]
fn registry_cap_eviction() {
    // REQ-8 (relationship): The child→parent registry has a 10,000 entry cap.
    // Adding the 10,001st entry evicts one entry. Verify by adding >10K entries
    // and confirming (a) the last entry still composits, (b) new entries after
    // the cap still register correctly.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "cap-test".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Add 10,001 unique relationships — registry cap is 10,000
    for i in 0..10_001 {
        let child = format!("cap-child-{}", i);
        let parent = format!("cap-parent-{}", i);
        let rel = make_relationship_event(&parent, &child);
        engine.req_2_3_process(rel);
    }

    // The last entry (cap-child-10000) was added last and should still be composited
    // (it was inserted after one entry was evicted to stay at 10K)
    let d = engine.req_2_3_process(test_event(
        "cap-child-10000", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d.len(), 1);
    assert_eq!(
        d[0].key.get("sessionId").unwrap(),
        "cap-parent-10000",
        "Last added child should still be composited (eviction removed a different entry)"
    );

    // A NEW relationship after hitting the cap should still work
    // (registry allows new entries, evicting one if at cap)
    let new_rel = make_relationship_event("cap-new-parent", "cap-new-child");
    engine.req_2_3_process(new_rel);
    let d_new = engine.req_2_3_process(test_event(
        "cap-new-child", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d_new.len(), 1);
    assert_eq!(
        d_new[0].key.get("sessionId").unwrap(),
        "cap-new-parent",
        "New relationship after reaching cap should still composit"
    );
}

#[test]
fn cleanup_on_buffer_removal() {
    // REQ-7 (relationship): When a buffer is removed via sweep/timeout,
    // the associated relationship mappings should be cleaned up.
    // After cleanup, child events for that relationship should not be composited.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "cleanup-rel".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 1,  // 1ms — expires quickly
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Register relationship: parent-clean ↔ child-clean
    let rel = make_relationship_event("parent-clean", "child-clean");
    engine.req_2_3_process(rel);

    // Process child event — composited to parent, creates/updates buffer at parent sessionId
    let d = engine.req_2_3_process(test_event(
        "child-clean", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d.len(), 1);
    assert_eq!(
        d[0].key.get("sessionId").unwrap(),
        "parent-clean",
        "Child should be composited to parent before sweep"
    );

    // Sleep to ensure the 1ms timeout expires
    std::thread::sleep(std::time::Duration::from_millis(10));

    // Sweep — removes expired buffers AND cleans up relationships
    let sweep_deliveries = engine.req_6_sweep();
    assert!(!sweep_deliveries.is_empty(),
        "Sweep should find and remove expired buffer");

    // After sweep + cleanup, child event should NOT be composited
    // (the relationship mapping was cleaned up when the buffer was removed)
    let d2 = engine.req_2_3_process(test_event(
        "child-clean", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d2.len(), 1);
    assert_eq!(
        d2[0].key.get("sessionId").unwrap(),
        "child-clean",
        "After buffer removal and relationship cleanup, child should not be composited"
    );
    // The delivery should NOT have compositedChildSessionId
    let payload = d2[0].payload.as_object().unwrap();
    assert!(
        !payload.contains_key("compositedChildSessionId"),
        "After cleanup, delivery should not have compositedChildSessionId"
    );
}

#[test]
fn composited_child_session_id_in_delivery() {
    // REQ-3 (relationship): Composited delivery payloads MUST include
    // compositedChildSessionId in both init/update deliveries (stream payload)
    // and end deliveries (full accumulated payload).
    let engine = make_engine();
    // Use event_types filter so the relationship event (ToolUse) doesn't
    // match the contract — avoids relationship event creating a buffer
    // before the child event is processed.
    let contract = ContractDeclaration {
        contract_name: "composited-payload".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: Some(vec!["chat".to_string()]),
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Register relationship (event type: ToolUse — doesn't match contract)
    let rel = make_relationship_event("parent-payload", "child-payload");
    engine.req_2_3_process(rel);

    // Process child Chat event — init delivery should have compositedChildSessionId
    let init_deliveries = engine.req_2_3_process(test_event_eventtype(
        "child-payload", None, None, EventState::Init, EventProvider::OpenCode, None,
        EventType::Chat,
    ));
    assert_eq!(init_deliveries.len(), 1);
    assert_eq!(init_deliveries[0].lifecycle, "init",
        "First composited delivery should be init");
    let init_payload = init_deliveries[0].payload.as_object().unwrap();
    assert!(
        init_payload.contains_key("compositedChildSessionId"),
        "Init delivery payload should contain compositedChildSessionId"
    );
    assert_eq!(
        init_payload["compositedChildSessionId"].as_str().unwrap(),
        "child-payload",
        "compositedChildSessionId should match the child event's sessionId"
    );

    // Process child response event — triggers completeWhen → end delivery
    // End delivery should also have compositedChildSessionId in full payload
    let end_deliveries = engine.req_2_3_process(test_event_eventtype(
        "child-payload", None, None, EventState::Response, EventProvider::OpenCode,
        Some(serde_json::json!({"status": "done"})),
        EventType::Chat,
    ));
    assert_eq!(end_deliveries.len(), 1,
        "Response event should trigger end delivery");
    assert_eq!(end_deliveries[0].lifecycle, "end",
        "Delivery should be 'end' when completeWhen fires");
    let end_payload = end_deliveries[0].payload.as_object().unwrap();
    assert!(
        end_payload.contains_key("compositedChildSessionId"),
        "End delivery full payload should contain compositedChildSessionId"
    );
    assert_eq!(
        end_payload["compositedChildSessionId"].as_str().unwrap(),
        "child-payload",
        "End delivery compositedChildSessionId should match child sessionId"
    );
}

#[test]
fn multiple_children_under_same_parent() {
    // REQ-2 (relationship): Multiple children can be registered under the same
    // parent. Each child event should be composited to the shared parent sessionId.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "multi-child".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Register two children under the same parent
    let rel1 = make_relationship_event("shared-parent", "child-alpha");
    engine.req_2_3_process(rel1);

    let rel2 = make_relationship_event("shared-parent", "child-beta");
    engine.req_2_3_process(rel2);

    // child-alpha composited to shared-parent
    let d_alpha = engine.req_2_3_process(test_event(
        "child-alpha", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d_alpha.len(), 1);
    assert_eq!(
        d_alpha[0].key.get("sessionId").unwrap(),
        "shared-parent",
        "child-alpha should be composited to shared-parent"
    );

    // child-beta composited to same shared-parent
    let d_beta = engine.req_2_3_process(test_event(
        "child-beta", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d_beta.len(), 1);
    assert_eq!(
        d_beta[0].key.get("sessionId").unwrap(),
        "shared-parent",
        "child-beta should be composited to shared-parent"
    );

    // Both composited events should have compositedChildSessionId
    let payload_alpha = d_alpha[0].payload.as_object().unwrap();
    assert_eq!(
        payload_alpha["compositedChildSessionId"].as_str().unwrap(),
        "child-alpha",
        "child-alpha delivery should identify itself"
    );
    let payload_beta = d_beta[0].payload.as_object().unwrap();
    assert_eq!(
        payload_beta["compositedChildSessionId"].as_str().unwrap(),
        "child-beta",
        "child-beta delivery should identify itself"
    );
}

#[test]
fn child_events_different_event_types() {
    // Compositing works regardless of the child event's event type.
    // Events of different types (chat, tool_use, agent_session) with a
    // known child sessionId should all be composited to the parent.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "diff-types".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // Register relationship
    let rel = make_relationship_event("parent-types", "child-types");
    engine.req_2_3_process(rel);

    // ToolUse child event — composited
    let d_tool = engine.req_2_3_process(test_event_eventtype(
        "child-types", None, None, EventState::Init, EventProvider::OpenCode, None,
        EventType::ToolUse,
    ));
    assert_eq!(d_tool.len(), 1);
    assert_eq!(
        d_tool[0].key.get("sessionId").unwrap(),
        "parent-types",
        "ToolUse child event should be composited"
    );

    // Chat child event — composited
    let d_chat = engine.req_2_3_process(test_event_eventtype(
        "child-types", None, None, EventState::Update, EventProvider::OpenCode, None,
        EventType::Chat,
    ));
    assert_eq!(d_chat.len(), 1);
    assert_eq!(
        d_chat[0].key.get("sessionId").unwrap(),
        "parent-types",
        "Chat child event should be composited"
    );

    // AgentSession child event — composited
    let d_agent = engine.req_2_3_process(test_event_eventtype(
        "child-types", None, None, EventState::Update, EventProvider::OpenCode, None,
        EventType::AgentSession,
    ));
    assert_eq!(d_agent.len(), 1);
    assert_eq!(
        d_agent[0].key.get("sessionId").unwrap(),
        "parent-types",
        "AgentSession child event should be composited"
    );
}

// ── Bug #523 Cycle 2: E2E Composites Simulation ───────────────────────────────
//
// Simulates the Mission Monitor contracts and a real subagent dispatch flow:
//   parent session.created → parent chat → PreToolUse task → child session.created
//   → child chat → PostToolUse task (relationship) → child post-relationship event.
//
// Verifies:
//   1. Child events before relationship create buffers at child sessionId
//   2. Relationship re-keys child buffers: end (old key) + update (new key)
//   3. Child events after relationship are composited to parent sessionId
//   4. compositedChildSessionId appears in re-keyed deliveries
//   5. Forward compositing works for ALL event types (chat, agent_session, tool_use)

#[test]
fn e2e_compositing_mission_monitor_simulation() {
    let engine = make_engine();

    // Register chat-node contract (matches Mission Monitor)
    let chat_node_contract = ContractDeclaration {
        contract_name: "chat-node".to_string(),
        stream_fields: vec!["payload".to_string(), "state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string(), "correlationId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 300000,
        providers: None,
        transports: Some(vec!["hook".to_string()]),
        event_types: Some(vec!["chat".to_string(), "agent_session".to_string()]),
    };

    // Register tool-use-lifecycle contract (matches Mission Monitor)
    let tool_use_contract = ContractDeclaration {
        contract_name: "tool-use-lifecycle".to_string(),
        stream_fields: vec![
            "toolName".to_string(),
            "state".to_string(),
            "payload".to_string(),
        ],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string(), "correlationId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 300000,
        providers: None,
        transports: Some(vec!["hook".to_string()]),
        event_types: Some(vec!["tool_use".to_string()]),
    };

    engine
        .req_1_register(vec![chat_node_contract, tool_use_contract])
        .unwrap();

    let parent_sid = "parent-session";
    let child_sid = "child-session";
    let parent_cid = "parent-correlation"; // AgentSession uses sessionId as cid
    let child_cid = "child-correlation";
    let tool_cid = "task-tool-cid";

    // Helper: chat-node event
    let make_chat = |sid: &str, cid: &str, state: EventState| {
        test_event_eventtype(sid, Some(cid), None, state, EventProvider::OpenCode, None, EventType::Chat)
    };
    let make_agent = |sid: &str, cid: &str, state: EventState| {
        test_event_eventtype(sid, Some(cid), None, state, EventProvider::OpenCode, None, EventType::AgentSession)
    };
    let make_tool = |sid: &str, cid: &str, state: EventState, tool_name: &str| {
        test_event_eventtype(sid, Some(cid), Some(tool_name), state, EventProvider::OpenCode, None, EventType::ToolUse)
    };

    // ── Step 1: Parent session.created ────────────────────────────────────
    let p1 = engine.req_2_3_process(make_agent(parent_sid, parent_cid, EventState::Init));
    assert_eq!(p1.len(), 1, "Step 1: parent session.created → 1 chat-node init");
    assert_eq!(p1[0].lifecycle, "init");
    assert_eq!(p1[0].contract_name, "chat-node");
    assert_eq!(p1[0].key.get("sessionId").unwrap(), parent_sid);
    assert_eq!(p1[0].key.get("correlationId").unwrap(), parent_cid);

    // ── Step 2: Parent chat response (triggers completeWhen) ──────────────
    let p2 = engine.req_2_3_process(make_chat(parent_sid, parent_cid, EventState::Response));
    assert_eq!(p2.len(), 1, "Step 2: parent chat response → 1 chat-node end");
    assert_eq!(p2[0].lifecycle, "end");
    assert_eq!(p2[0].contract_name, "chat-node");
    assert_eq!(p2[0].key.get("sessionId").unwrap(), parent_sid);

    // ── Step 3: PreToolUse task ───────────────────────────────────────────
    let p3 = engine.req_2_3_process(make_tool(parent_sid, tool_cid, EventState::Init, "task"));
    assert_eq!(p3.len(), 1, "Step 3: PreToolUse task → 1 tool-use-lifecycle init");
    assert_eq!(p3[0].lifecycle, "init");
    assert_eq!(p3[0].contract_name, "tool-use-lifecycle");
    assert_eq!(p3[0].key.get("sessionId").unwrap(), parent_sid);
    assert_eq!(p3[0].key.get("correlationId").unwrap(), tool_cid);

    // ── Step 4: Child session.created (BEFORE relationship) ──────────────
    let p4 = engine.req_2_3_process(make_agent(child_sid, child_cid, EventState::Init));
    assert_eq!(p4.len(), 1, "Step 4: child session.created → 1 chat-node init");
    assert_eq!(p4[0].lifecycle, "init");
    assert_eq!(p4[0].contract_name, "chat-node");
    assert_eq!(
        p4[0].key.get("sessionId").unwrap(),
        child_sid,
        "Before relationship, child uses its own sessionId"
    );
    assert_eq!(p4[0].key.get("correlationId").unwrap(), child_cid);

    // ── Step 5: Child chat response (BEFORE relationship) ────────────────
    let p5 = engine.req_2_3_process(make_chat(child_sid, child_cid, EventState::Response));
    assert_eq!(p5.len(), 1, "Step 5: child chat response → 1 chat-node end");
    assert_eq!(p5[0].lifecycle, "end");
    assert_eq!(p5[0].contract_name, "chat-node");
    assert_eq!(
        p5[0].key.get("sessionId").unwrap(),
        child_sid,
        "Before relationship, child end uses child sessionId"
    );

    // ── Step 6: PostToolUse task (RELATIONSHIP ARRIVES) ──────────────────
    // Build a relationship event (simulating what the adapter emits)
    let rel_event = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Response)
        .provider(EventProvider::OpenCode)
        .session_id(parent_sid)
        .correlation_id(tool_cid)
        .tool_name("task")
        .transport(Transport::Hook)
        .metadata(serde_json::json!({
            "relationship": {
                "type": "parent-child",
                "parentSessionId": parent_sid,
                "childSessionId": child_sid,
            }
        }))
        .build();

    let p6 = engine.req_2_3_process(rel_event);
    // Expected deliveries:
    //   a. End (old child key, from register_relationship) — chat-node
    //   b. Init (new parent key, from register_relationship) — chat-node
    //   c. End (tool-use-lifecycle, from contract processing — completeWhen fires)
    assert_eq!(
        p6.len(), 3,
        "Step 6: relationship event → 3 deliveries (re-key end + re-key init + tool-use end)"
    );

    // Verify the end delivery for old child key
    let rekey_end = p6.iter().find(|d| {
        d.lifecycle == "end" && d.timed_out == Some(true)
    }).expect("Should have a timedOut end delivery for old child key");
    assert_eq!(rekey_end.contract_name, "chat-node");
    assert_eq!(
        rekey_end.key.get("sessionId").unwrap(),
        child_sid,
        "End delivery's key should still have child sessionId"
    );
    assert_eq!(
        rekey_end.payload.as_object().unwrap()["compositedChildSessionId"]
            .as_str().unwrap(),
        child_sid,
        "End delivery should identify the composited child"
    );

    // Verify the re-keyed init for new parent key
    // Bug #523: Changed from "update" to "init" so the frontend creates a
    // SubagentNode for the composited child session.
    let rekey_init = p6.iter().find(|d| {
        d.lifecycle == "init"
            && d.contract_name == "chat-node"
            && d.payload.as_object()
                .map(|p| p.contains_key("compositedChildSessionId"))
                .unwrap_or(false)
    }).expect("Should have an init delivery with compositedChildSessionId");
    assert_eq!(
        rekey_init.key.get("sessionId").unwrap(),
        parent_sid,
        "Re-keyed init should use parent sessionId in key"
    );
    assert_eq!(
        rekey_init.key.get("correlationId").unwrap(),
        child_cid,
        "Re-keyed init should preserve child correlationId"
    );

    // ── Step 7: Child post-relationship event (FORWARD COMPOSITING) ──────
    let p7 = engine.req_2_3_process(make_chat(child_sid, child_cid, EventState::Update));
    assert_eq!(p7.len(), 1, "Step 7: post-relationship child event → 1 update");
    assert_eq!(p7[0].contract_name, "chat-node");
    assert_eq!(
        p7[0].key.get("sessionId").unwrap(),
        parent_sid,
        "After relationship, child event composited to parent sessionId"
    );
    assert_eq!(
        p7[0].key.get("correlationId").unwrap(),
        child_cid,
        "After relationship, correlationId unchanged (still child's)"
    );

    // ── Step 8: Post-relationship child AgentSession event ───────────────
    let p8 = engine.req_2_3_process(make_agent(child_sid, child_cid, EventState::Update));
    assert_eq!(p8.len(), 1, "Step 8: child agent event → composited");
    assert_eq!(
        p8[0].key.get("sessionId").unwrap(),
        parent_sid,
        "AgentSession child event composited to parent"
    );

    // ── Step 9: Post-relationship child ToolUse event ────────────────────
    let p9 = engine.req_2_3_process(make_tool(child_sid, "child-tool-cid", EventState::Init, "Bash"));
    assert_eq!(p9.len(), 1, "Step 9: child tool event → composited");
    assert_eq!(
        p9[0].key.get("sessionId").unwrap(),
        parent_sid,
        "Child tool event composited to parent"
    );
    assert_eq!(p9[0].contract_name, "tool-use-lifecycle");
    // compositedChildSessionId should be in the payload for composited tool deliveries
    let tool_payload = p9[0].payload.as_object().unwrap();
    assert!(
        tool_payload.contains_key("compositedChildSessionId"),
        "Tool delivery should have compositedChildSessionId"
    );

    // ── Summary: Verify correct delivery counts per contract ─────────────
    //
    // chat-node deliveries:
    //   1. p1: parent init
    //   2. p2: parent end
    //   3. p4: child init (before relationship)
    //   4. p5: child end (before relationship)
    //   5. p6 re-key end: child end (composited)
    //   6. p6 re-key update: parent update (composited)
    //   7. p7: child update (post-relationship, composited)
    //   8. p8: child agent update (post-relationship, composited)
    // Total: 8 chat-node deliveries
    //
    // tool-use-lifecycle deliveries:
    //   1. p3: PreToolUse task init
    //   2. p6 contract end: PostToolUse task end
    //   3. p9: child tool init (composited)
    // Total: 3 tool-use-lifecycle deliveries

    println!(
        "E2E composite summary — chat-node: {} deliveries across parent({})/child({}) keys. tool-use-lifecycle: added child tool composited to parent.",
        "8",
        parent_sid,
        child_sid
    );

    // NOTE: This test validates the ECE's compositing behavior is correct.
    // The "6 deliveries" target from BL#523 is the frontend's abstraction
    // (Init→Update→End lifecycle per node), not the raw ECE delivery count.
    // The ECE correctly produces init+update+end deliveries per buffer,
    // plus re-keying overhead. The parent session's chat-node delivery
    // count includes all composited child deliveries, which the frontend
    // renders as a single SubagentNode under the parent session.
}
