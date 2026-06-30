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
    };
    let c2 = ContractDeclaration {
        contract_name: "c2".to_string(),
        stream_fields: vec!["toolName".to_string()],
        deferred_fields: vec![],
        key: vec!["correlationId".to_string()],
        complete_when: "exists payload.result".to_string(),
        timeout: 20000,
        providers: None,
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
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "exists payload.result".to_string(),
        timeout: 60000,
        providers: None,
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
    // After a contract instance completes, further events create new instances
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "complete-once".to_string(),
        stream_fields: vec!["state".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
    };
    engine.req_1_register(vec![contract]).unwrap();
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode, None,
    ));

    // After end, a new event with non-matching state starts a new init instance.
    // Note: if the first event after removal already matches completeWhen,
    // it goes directly to "end" (init→complete fires in one pass).
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries[0].lifecycle, "init",
        "After completion + removal, non-matching event starts new init");
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
    // The first event (progress=0.8) triggers completeWhen, second should be new init
    assert_eq!(d[0].lifecycle, "init",
        "After end, next event starts new init");
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
        providers: Some(vec!["opencode".to_string()]),
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
        providers: Some(vec!["opencode".to_string()]),
    };
    engine.req_1_register(vec![contract]).unwrap();

    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].provider.as_deref(), Some("opencode"));
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
        providers: Some(vec!["opencode".to_string(), "internal".to_string()]),
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
    };
    let c2 = ContractDeclaration {
        contract_name: "mc2".to_string(),
        stream_fields: vec!["toolName".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "".to_string(),
        timeout: 60000,
        providers: None,
    };
    engine.req_1_register(vec![c1, c2]).unwrap();

    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, Some("read_file"), EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries.len(), 2, "Both contracts should produce deliveries");
}
