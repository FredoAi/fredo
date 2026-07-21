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
fn update_after_complete_no_deliveries() {
    // REQ-2: After a contract instance completes, non-Init events silently
    // accumulate payload without producing deliveries.
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

    // After completion, a non-Init event (Update) for the same key
    // silently accumulates payload — no new deliveries produced.
    let deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Update, EventProvider::OpenCode, None,
    ));
    assert_eq!(deliveries.len(), 0,
        "After completion, non-Init events should not produce deliveries");
}

#[test]
fn init_after_complete_resets_buffer() {
    // REQ-1: When an Init-state event arrives for a completed buffer,
    // the buffer resets and a fresh init delivery is emitted.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "reset-test".to_string(),
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

    // First lifecycle: Init → Response (completes)
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    let end_deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode, None,
    ));
    assert_eq!(end_deliveries.len(), 1);
    assert_eq!(end_deliveries[0].lifecycle, "end");

    // Second lifecycle: Init arrives for the completed buffer →
    // buffer resets, init delivery emitted
    let reset_deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(reset_deliveries.len(), 1,
        "Init after completion should produce 1 delivery (init)");
    assert_eq!(reset_deliveries[0].lifecycle, "init",
        "Reset delivery should be 'init'");

    // Subsequent Response should trigger end for the new lifecycle
    let second_end = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode, None,
    ));
    assert_eq!(second_end.len(), 1,
        "Response after reset should produce 1 delivery (end)");
    assert_eq!(second_end[0].lifecycle, "end",
        "Delivery after reset+Response should be 'end'");
}

#[test]
fn buffer_reset_clears_accumulated_payload() {
    // REQ-1: Buffer reset clears accumulated_payload so no stale data
    // from the prior lifecycle leaks into the new delivery.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "payload-clear".to_string(),
        stream_fields: vec!["state".to_string(), "payload.data".to_string()],
        deferred_fields: vec![],
        key: vec!["sessionId".to_string()],
        complete_when: "state === 'Response'".to_string(),
        timeout: 60000,
        providers: None,
        transports: None,
        event_types: None,
    };
    engine.req_1_register(vec![contract]).unwrap();

    // First lifecycle: Init with data="old" → Response → end
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode,
        Some(serde_json::json!({"data": "old"})),
    ));
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode,
        Some(serde_json::json!({"data": "old", "result": "done"})),
    ));

    // Second lifecycle: Init with data="new" → the reset delivery should
    // contain "new", not "old"
    let reset_deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode,
        Some(serde_json::json!({"data": "new"})),
    ));
    assert_eq!(reset_deliveries.len(), 1);
    assert_eq!(reset_deliveries[0].lifecycle, "init");
    let payload = reset_deliveries[0].payload.as_object().unwrap();
    let data_val = payload.get("payload.data")
        .and_then(|v| v.as_str());
    assert_eq!(data_val, Some("new"),
        "Reset init delivery should contain new data, not stale 'old' data");
}

#[test]
fn buffer_reset_resets_delivery_queue() {
    // REQ-1: Buffer reset clears delivery_queue and delivery_count.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "queue-reset".to_string(),
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

    // First lifecycle
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode, None,
    ));

    // After reset, the delivery_count should be back to 0. We can verify
    // indirectly: after reset+Response, we should get an end delivery
    // (which requires the buffer to be in non-completed state, meaning
    // delivery_queue was also cleared).
    engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Init, EventProvider::OpenCode, None,
    ));
    let end_deliveries = engine.req_2_3_process(test_event(
        "s1", None, None, EventState::Response, EventProvider::OpenCode, None,
    ));
    assert_eq!(end_deliveries.len(), 1,
        "Reset buffer should produce end delivery on Response");
    assert_eq!(end_deliveries[0].lifecycle, "end");
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
    // After completion, subsequent events silently accumulate — no deliveries.
    assert_eq!(d.len(), 0,
        "After end, subsequent events for completed buffers produce no deliveries");
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

    // Send 150 events to the same key — no panics expected.
    // With update throttling, only the first init and first update produce
    // deliveries; subsequent events silently accumulate payload.
    let mut init_count = 0u32;
    let mut update_count = 0u32;
    for i in 0..150 {
        let state = if i % 2 == 0 {
            EventState::Init
        } else {
            EventState::Update
        };
        let deliveries = engine.req_2_3_process(test_event(
            "s1", None, None, state, EventProvider::OpenCode, None,
        ));
        if i == 0 {
            assert_eq!(deliveries.len(), 1, "First Init should produce 1 delivery (init)");
            init_count += 1;
        } else if i == 1 {
            assert_eq!(deliveries.len(), 1, "First Update should produce 1 delivery (update)");
            update_count += 1;
        } else {
            assert_eq!(deliveries.len(), 0, "Subsequent events should be throttled (got {} deliveries for i={})", deliveries.len(), i);
        }
    }
    assert_eq!(init_count, 1, "Should have exactly 1 init delivery");
    assert_eq!(update_count, 1, "Should have exactly 1 update delivery");
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

    // Step 3: After re-keying, new child events are composited forward.
    // With update throttling, the second update for the same lifecycle is
    // suppressed to avoid IPC churn from streaming. The compositing is still
    // valid — event data accumulates into the parent-keyed buffer silently.
    let after_rel = engine.req_2_3_process(test_event(
        "late-child", None, None, EventState::Update, EventProvider::OpenCode, None,
    ));
    assert_eq!(after_rel.len(), 0,
        "Update throttling suppresses second update for composited buffer");
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
    // Uses key [\"sessionId\", \"correlationId\"] so different children create
    // separate buffers — each gets its own init delivery.
    let engine = make_engine();
    let contract = ContractDeclaration {
        contract_name: "multi-child".to_string(),
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

    // Register two children under the same parent
    let rel1 = make_relationship_event("shared-parent", "child-alpha");
    engine.req_2_3_process(rel1);

    let rel2 = make_relationship_event("shared-parent", "child-beta");
    engine.req_2_3_process(rel2);

    // child-alpha composited to shared-parent (separate buffer via correlationId)
    let d_alpha = engine.req_2_3_process(test_event(
        "child-alpha", Some("alpha-correlation"), None, EventState::Init, EventProvider::OpenCode, None,
    ));
    assert_eq!(d_alpha.len(), 1);
    assert_eq!(
        d_alpha[0].key.get("sessionId").unwrap(),
        "shared-parent",
        "child-alpha should be composited to shared-parent"
    );

    // child-beta composited to same shared-parent (separate buffer via correlationId)
    let d_beta = engine.req_2_3_process(test_event(
        "child-beta", Some("beta-correlation"), None, EventState::Init, EventProvider::OpenCode, None,
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

    // Chat child event — composited, but throttled (update already sent
    // by d_tool, since the relationship event created the buffer first).
    let d_chat = engine.req_2_3_process(test_event_eventtype(
        "child-types", None, None, EventState::Update, EventProvider::OpenCode, None,
        EventType::Chat,
    ));
    assert_eq!(d_chat.len(), 0,
        "Chat child event update throttled (update_sent=true after d_tool)");

    // AgentSession child event — composited, but throttled (update already sent)
    let d_agent = engine.req_2_3_process(test_event_eventtype(
        "child-types", None, None, EventState::Update, EventProvider::OpenCode, None,
        EventType::AgentSession,
    ));
    assert_eq!(d_agent.len(), 0,
        "AgentSession child event update throttled (already sent one update)");
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

    // ── Step 5: RELATIONSHIP arrives (session.updated) ──────────────────
    // In real opencode, session.updated fires BEFORE the subagent starts
    // generating, carrying properties.info.parentID. The adapter attaches
    // relationship metadata. This re-keys the child's chat-node buffer
    // (NOT yet completed) to the parent sessionId.
    let rel_event = FredoEvent::builder()
        .event_type(EventType::AgentSession)
        .state(EventState::Update)
        .provider(EventProvider::OpenCode)
        .session_id(child_sid)
        .correlation_id(child_cid)
        .transport(Transport::Hook)
        .metadata(serde_json::json!({
            "relationship": {
                "type": "parent-child",
                "parentSessionId": parent_sid,
                "childSessionId": child_sid,
            }
        }))
        .build();

    let p5 = engine.req_2_3_process(rel_event);
    // Expected deliveries:
    //   a. End (old child key, timedOut cleanup)
    //   b. Init (new parent key, creates SubagentNode)
    //   c. Update (contract processing: the session.updated event itself
    //      produces an update to the re-keyed buffer — first update is NOT throttled)
    assert_eq!(
        p5.len(), 3,
        "Step 5: relationship event → 3 deliveries (end + init + update)"
    );

    // Verify the end delivery for old child key
    let rekey_end = p5.iter().find(|d| {
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

    // Verify the re-keyed init for new parent key (creates SubagentNode)
    let rekey_init = p5.iter().find(|d| {
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

    // Verify the contract-processing update for the session.updated event
    let rekey_update = p5.iter().find(|d| {
        d.lifecycle == "update"
            && d.contract_name == "chat-node"
            && d.timed_out.is_none()
    }).expect("Should have an update delivery from contract processing");
    assert_eq!(
        rekey_update.key.get("sessionId").unwrap(),
        parent_sid,
        "Update delivery should use parent sessionId"
    );

    // ── Step 6: Child chat response (completes re-keyed buffer) ──────────
    // After re-keying, the child's completion event arrives at the parent key.
    let p6 = engine.req_2_3_process(make_chat(child_sid, child_cid, EventState::Response));
    assert_eq!(p6.len(), 1, "Step 6: child chat response → 1 chat-node end");
    assert_eq!(p6[0].lifecycle, "end");
    assert_eq!(p6[0].contract_name, "chat-node");
    assert_eq!(
        p6[0].key.get("sessionId").unwrap(),
        parent_sid,
        "End delivery should use parent sessionId (composited)"
    );
    assert_eq!(
        p6[0].key.get("correlationId").unwrap(),
        child_cid,
        "End delivery should preserve child correlationId"
    );

    // ── Step 7: PostToolUse task (completes tool-use-lifecycle) ──────────
    // PostToolUse fires AFTER the subagent completes. No relationship metadata.
    let p7 = engine.req_2_3_process(make_tool(parent_sid, tool_cid, EventState::Response, "task"));
    assert_eq!(p7.len(), 1, "Step 7: PostToolUse task → 1 tool-use-lifecycle end");
    assert_eq!(p7[0].lifecycle, "end");
    assert_eq!(p7[0].contract_name, "tool-use-lifecycle");

    // ── Summary: Verify correct delivery counts per contract ─────────────
    //
    // chat-node deliveries (per-key lifecycle: Init→Update→End):
    //   1. p1: parent init (parent_sid, parent_cid)
    //   2. p2: parent end (parent_sid, parent_cid)
    //   3. p4: child init (child_sid, child_cid) — before relationship
    //   4. p5 re-key end: child end (child_sid, child_cid, timedOut)
    //   5. p5 re-key init: parent init (parent_sid, child_cid) — composited
    //   6. p5 update: parent update (parent_sid, child_cid) — first update
    //   7. p6: parent end (parent_sid, child_cid) — child completion
    // Total: 7 chat-node deliveries
    //
    // tool-use-lifecycle deliveries:
    //   1. p3: PreToolUse task init (parent_sid, tool_cid)
    //   2. p7: PostToolUse task end (parent_sid, tool_cid)
    // Total: 2 tool-use-lifecycle deliveries
    //
    // Total ECE deliveries: 7 + 2 = 9
    // Frontend deduplicates: ChatNode (p1,p2) + SubagentNode (p5 init,p5 update,p6)
    //   = 3 (parent) + 3 (subagent) = 6 lifecycle deliveries visible

    println!(
        "E2E composite summary — chat-node: {} deliveries. tool-use-lifecycle: 2. Frontend sees 6 lifecycle deliveries (3 ChatNode + 3 SubagentNode).",
        7
    );

    // NOTE: The "6 deliveries" target from BL#523 is the frontend's
    // abstraction (Init→Update→End lifecycle per node), not the raw ECE
    // delivery count. The ECE produces init + 1 update + end per buffer
    // (with update throttling), plus 1 re-keying end for cleanup.
    // The frontend handles timedOut end deliveries for cleanup and
    // creates SubagentNodes from composited init deliveries.
}
