//! Unit tests for the Contract Engine (Spec #295).
//!
//! Covers: registration, field extraction, stream vs deferred delivery,
//! completeWhen evaluation, timeout firing, lifecycle transitions,
//! multi-provider transparency, and composite keying.

#[cfg(test)]
mod contract_engine_tests {
use crate::infrastructure::comm::contract::*;
use crate::infrastructure::comm::contract::engine;
use crate::infrastructure::comm::event::*;
use std::collections::HashMap;
use serde_json::Value;

    // ── Helpers ───────────────────────────────────────────────────────────

    fn make_event(
        provider: EventProvider,
        tool_name: Option<&str>,
        correlation_id: Option<&str>,
        session_id: &str,
        payload: Option<Value>,
    ) -> FredoEvent {
        FredoEvent {
            id: "test-id".into(),
            event_type: EventType::ToolUse,
            state: EventState::Update,
            provider,
            transport: Transport::Hook,
            session_id: session_id.into(),
            correlation_id: correlation_id.map(|s| s.into()),
            tool_name: tool_name.map(|s| s.into()),
            payload,
            error: None,
            metadata: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }

    fn field(name: &str, path: &str, hint: DeliveryHint) -> ContractField {
        ContractField {
            name: name.into(),
            path: path.into(),
            hint,
        }
    }

    fn contract(
        name: &str,
        key: ContractKey,
        timeout_ms: Option<u64>,
        complete_when: Option<&str>,
        fields: Vec<ContractField>,
        filter: Option<ContractFilter>,
    ) -> EventContractDeclaration {
        EventContractDeclaration {
            name: name.into(),
            key,
            timeout_ms,
            complete_when: complete_when.map(|s| s.into()),
            fields,
            filter,
        }
    }

    // ── AC-1: Registration (REQ-1) ────────────────────────────────────────

    #[test]
    fn test_register_single_contract() {
        let mut engine = ContractEngine::new();
        let c = contract("test", ContractKey::Single("correlationId".into()), None, None, vec![], None);
        engine.register_contracts("feature-1", vec![c]);
        // Internal state: registry should have 1 entry
        // We verify by processing an event that would match
        let event = make_event(EventProvider::OpenCode, Some("tool"), Some("c1"), "s1", None);
        let deliveries = engine.process_event(&event);
        // No fields declared → no extraction → no delivery
        assert!(deliveries.is_empty());
    }

    #[test]
    fn test_register_multiple_contracts() {
        let mut engine = ContractEngine::new();
        let c1 = contract("c1", ContractKey::Single("correlationId".into()), None, None, vec![], None);
        let c2 = contract("c2", ContractKey::Single("correlationId".into()), None, None, vec![], None);
        engine.register_contracts("feature-1", vec![c1, c2]);
        // Register another feature
        let c3 = contract("c3", ContractKey::Single("correlationId".into()), None, None, vec![], None);
        engine.register_contracts("feature-2", vec![c3]);
    }

    // ── AC-2: Deregistration (REQ-2) ──────────────────────────────────────

    #[test]
    fn test_deregister_and_cleanup_buffered_state() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "testContract",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("data", "payload.data", DeliveryHint::Deferred)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Buffer an event
        let event = make_event(
            EventProvider::OpenCode,
            Some("tool"),
            Some("k1"),
            "s1",
            Some(serde_json::json!({"data": "hello"})),
        );
        engine.process_event(&event);

        // Deregister — should clean up buffered state
        engine.deregister_contracts("feature-1");
        // No more contracts → no deliveries
        let event2 = make_event(
            EventProvider::OpenCode,
            Some("tool"),
            Some("k1"),
            "s1",
            Some(serde_json::json!({"data": "world"})),
        );
        let deliveries = engine.process_event(&event2);
        assert!(deliveries.is_empty());
    }

    // ── AC-3: Stream Field Delivery (REQ-6) ───────────────────────────────

    #[test]
    fn test_stream_field_init_on_first_event() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "chatNode",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("text", "payload.content", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        let event = make_event(
            EventProvider::OpenCode,
            Some("ask"),
            Some("corr-1"),
            "s1",
            Some(serde_json::json!({"content": "Hello"})),
        );
        let deliveries = engine.process_event(&event);
        assert_eq!(deliveries.len(), 1, "Should emit Init delivery");
        assert_eq!(deliveries[0].lifecycle, Lifecycle::Init);
        assert_eq!(deliveries[0].contract_name, "chatNode");
        assert_eq!(deliveries[0].correlation_key, "corr-1");
        assert!(deliveries[0].fields.contains_key("text"));
    }

    #[test]
    fn test_stream_field_update_on_second_event() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "chatNode",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("text", "payload.content", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Event 1
        engine.process_event(&make_event(
            EventProvider::OpenCode, Some("ask"), Some("corr-1"), "s1",
            Some(serde_json::json!({"content": "Hello"})),
        ));

        // Event 2
        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("ask"), Some("corr-1"), "s1",
            Some(serde_json::json!({"content": "World"})),
        ));
        assert_eq!(deliveries.len(), 1, "Should emit Update delivery");
        assert_eq!(deliveries[0].lifecycle, Lifecycle::Update);
        assert_eq!(deliveries[0].correlation_key, "corr-1");
    }

    #[test]
    fn test_stream_field_different_keys_emit_independent_init() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "multiKey",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("data", "payload.data", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Two different correlation keys
        let d1 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "one"})),
        ));
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].lifecycle, Lifecycle::Init);
        assert_eq!(d1[0].correlation_key, "k1");

        let d2 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k2"), "s1",
            Some(serde_json::json!({"data": "two"})),
        ));
        assert_eq!(d2.len(), 1);
        assert_eq!(d2[0].lifecycle, Lifecycle::Init);
        assert_eq!(d2[0].correlation_key, "k2");
    }

    #[test]
    fn test_stream_field_accumulates_all_fields() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "accumulate",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![
                field("title", "payload.title", DeliveryHint::Stream),
                field("body", "payload.body", DeliveryHint::Stream),
            ],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Event 1: title only
        let d1 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"title": "Hello"})),
        ));
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].fields.len(), 1);
        assert_eq!(d1[0].fields.get("title").unwrap(), &Value::String("Hello".into()));

        // Event 2: body only — previous fields should be in the delivery
        let d2 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"body": "World"})),
        ));
        assert_eq!(d2.len(), 1);
        assert_eq!(d2[0].fields.len(), 2);
        assert_eq!(d2[0].fields.get("title").unwrap(), &Value::String("Hello".into()));
        assert_eq!(d2[0].fields.get("body").unwrap(), &Value::String("World".into()));
    }

    // ── AC-4: Deferred Field + completeWhen (REQ-7, REQ-8) ─────────────────

    #[test]
    fn test_deferred_buffers_no_immediate_emit() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "buffered",
            ContractKey::Single("correlationId".into()),
            None,
            Some(r#"status === "done""#),
            vec![field("result", "payload.result", DeliveryHint::Deferred)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"result": "working"})),
        ));
        assert!(deliveries.is_empty(), "Deferred should not emit");
    }

    #[test]
    fn test_deferred_emits_end_when_complete_when_matches() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "buffered",
            ContractKey::Single("correlationId".into()),
            None,
            Some(r#"status === "done""#),
            vec![
                field("result", "payload.result", DeliveryHint::Deferred),
                field("status", "payload.status", DeliveryHint::Deferred),
            ],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // First event: buffer
        engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"result": "data"})),
        ));

        // Second event: status = done triggers End
        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"status": "done"})),
        ));
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].lifecycle, Lifecycle::End);
        assert!(!deliveries[0].timed_out);
        // Both fields accumulated
        assert!(deliveries[0].fields.contains_key("result"));
        assert!(deliveries[0].fields.contains_key("status"));
    }

    #[test]
    fn test_deferred_with_complete_when_not_met() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "noEndYet",
            ContractKey::Single("correlationId".into()),
            None,
            Some(r#"status === "complete""#),
            vec![field("status", "payload.status", DeliveryHint::Deferred)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Multiple events with status = "running" — never triggers End
        for _ in 0..3 {
            let deliveries = engine.process_event(&make_event(
                EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
                Some(serde_json::json!({"status": "running"})),
            ));
            assert!(deliveries.is_empty(), "Should still buffer when condition not met");
        }
    }

    #[test]
    fn test_complete_when_exists_and_not_exists() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "existsTest",
            ContractKey::Single("correlationId".into()),
            None,
            Some("error !exists"),
            vec![
                field("result", "payload.result", DeliveryHint::Stream),
            ],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Event with result but no error field → !exists evaluates to true
        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"result": "success"})),
        ));
        // Stream field triggers Init, then !exists triggers End
        assert_eq!(deliveries.len(), 2);
        assert_eq!(deliveries[0].lifecycle, Lifecycle::Init);
        assert_eq!(deliveries[1].lifecycle, Lifecycle::End);
    }

    // ── AC-5: Timeout (REQ-9) ─────────────────────────────────────────────

    #[test]
    fn test_timeout_emits_end_with_timed_out_flag() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "timeoutTest",
            ContractKey::Single("correlationId".into()),
            Some(1), // 1 ms timeout
            None,
            vec![field("data", "payload.data", DeliveryHint::Deferred)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Buffer event
        engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "test"})),
        ));

        // Sleep past timeout
        std::thread::sleep(std::time::Duration::from_millis(5));

        // Sweep
        let deliveries = engine.sweep_timeouts();
        assert!(!deliveries.is_empty(), "Should time out after sleep");
        assert_eq!(deliveries[0].lifecycle, Lifecycle::End);
        assert!(deliveries[0].timed_out);
        assert_eq!(deliveries[0].correlation_key, "k1");
        assert!(deliveries[0].fields.contains_key("data"));
    }

    #[test]
    fn test_timeout_sweep_cleans_up_buffered_state() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "cleanup",
            ContractKey::Single("correlationId".into()),
            Some(1),
            None,
            vec![field("data", "payload.data", DeliveryHint::Deferred)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "test"})),
        ));

        std::thread::sleep(std::time::Duration::from_millis(5));
        engine.sweep_timeouts();

        // After sweep, no more deliveries for this key
        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "after"})),
        ));
        assert!(deliveries.is_empty(), "No more deliveries after cleanup");

        // Re-registering same contract for same key = fresh state
        let c2 = contract(
            "cleanup",
            ContractKey::Single("correlationId".into()),
            Some(1),
            None,
            vec![field("data", "payload.data", DeliveryHint::Deferred)],
            None,
        );
        engine.register_contracts("feature-2", vec![c2]);
        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "fresh"})),
        ));
        // State was cleaned up, so this should buffer again
        assert!(deliveries.is_empty());
    }

    #[test]
    fn test_no_timeout_within_threshold() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "longTimeout",
            ContractKey::Single("correlationId".into()),
            Some(60_000), // 60s
            None,
            vec![field("data", "payload.data", DeliveryHint::Deferred)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "test"})),
        ));

        // Sweep immediately — no timeout
        let deliveries = engine.sweep_timeouts();
        assert!(deliveries.is_empty(), "60s timeout should not expire immediately");
    }

    // ── AC-6: Lifecycle Transitions (REQ-10) ──────────────────────────────

    #[test]
    fn test_full_lifecycle_init_update_end() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "fullCycle",
            ContractKey::Single("correlationId".into()),
            None,
            Some(r#"state === "done""#),
            vec![field("state", "payload.state", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Init
        let d1 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"state": "started"})),
        ));
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].lifecycle, Lifecycle::Init);

        // Update
        let d2 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"state": "running"})),
        ));
        assert_eq!(d2.len(), 1);
        assert_eq!(d2[0].lifecycle, Lifecycle::Update);

        // End
        let d3 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"state": "done"})),
        ));
        assert_eq!(d3.len(), 1);
        assert_eq!(d3[0].lifecycle, Lifecycle::End);

        // After End — no more deliveries
        let d4 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"state": "restarted"})),
        ));
        assert!(d4.is_empty(), "No deliveries after End state");
    }

    #[test]
    fn test_lifecycle_different_keys_independent() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "indep",
            ContractKey::Single("correlationId".into()),
            None,
            Some(r#"state === "done""#),
            vec![field("state", "payload.state", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // k1: started, done
        // k2: started
        let d1_k1 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"state": "started"})),
        ));
        assert_eq!(d1_k1[0].lifecycle, Lifecycle::Init);

        let d1_k2 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k2"), "s1",
            Some(serde_json::json!({"state": "started"})),
        ));
        assert_eq!(d1_k2[0].lifecycle, Lifecycle::Init);

        let d2_k1 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"state": "done"})),
        ));
        // Init (no stream update since state was unchanged from prev) + End (completeWhen)
        // Actually state=done doesn't match "started" so fields extend and completeWhen triggers End
        // Wait, the state value is "done" which is different from "started", so field is extracted.
        // Stream field is extracted, so Init/Update based on has_emitted_init.
        // Since k1 already has emitted_init=true, it will be Update.
        // Then completeWhen (state === "done") matches, so End is also emitted.
        assert_eq!(d2_k1.len(), 2);
        assert_eq!(d2_k1[0].lifecycle, Lifecycle::Update);
        assert_eq!(d2_k1[1].lifecycle, Lifecycle::End);

        // k2 should still be active (not ended)
        let d2_k2 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k2"), "s1",
            Some(serde_json::json!({"state": "running"})),
        ));
        assert_eq!(d2_k2.len(), 1);
        assert_eq!(d2_k2[0].lifecycle, Lifecycle::Update);
    }

    // ── AC-7: No Delivery for Unregistered Contracts (REQ-13) ─────────────

    #[test]
    fn test_no_delivery_without_registered_contracts() {
        let mut engine = ContractEngine::new();
        // No contracts registered
        let event = make_event(
            EventProvider::OpenCode, Some("ask"), Some("corr-1"), "s1",
            Some(serde_json::json!({"content": "Hello"})),
        );
        let deliveries = engine.process_event(&event);
        assert!(deliveries.is_empty(), "No contracts → no deliveries");
    }

    #[test]
    fn test_event_matches_no_contract_filter_no_delivery() {
        let mut engine = ContractEngine::new();
        // Contract only matches tool "write", event has tool "read"
        let c = contract(
            "strict",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("data", "payload.data", DeliveryHint::Stream)],
            Some(ContractFilter {
                providers: None,
                tool_names: Some(vec!["write".into()]),
            }),
        );
        engine.register_contracts("feature-1", vec![c]);

        let event = make_event(
            EventProvider::OpenCode, Some("read"), Some("corr-1"), "s1",
            Some(serde_json::json!({"data": "test"})),
        );
        let deliveries = engine.process_event(&event);
        assert!(deliveries.is_empty(), "Tool 'read' should not match 'write' filter");
    }

    // ── AC-10: Multi-Provider Transparency (REQ-17) ────────────────────────

    #[test]
    fn test_no_provider_filter_matches_all_providers() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "multiProvider",
            ContractKey::Single("sessionId".into()),
            None,
            None,
            vec![field("data", "payload.data", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // OpenCode event
        let d1 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), None, "session-1",
            Some(serde_json::json!({"data": "opencode"})),
        ));
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].lifecycle, Lifecycle::Init);

        // Internal event — same session key → Update
        let d2 = engine.process_event(&make_event(
            EventProvider::Internal, Some("tool"), None, "session-1",
            Some(serde_json::json!({"data": "internal"})),
        ));
        assert_eq!(d2.len(), 1);
        assert_eq!(d2[0].lifecycle, Lifecycle::Update);
    }

    #[test]
    fn test_provider_filter_restricts_matching() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "onlyOpenCode",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("data", "payload.data", DeliveryHint::Stream)],
            Some(ContractFilter {
                providers: Some(vec!["OpenCode".into()]),
                tool_names: None,
            }),
        );
        engine.register_contracts("feature-1", vec![c]);

        // OpenCode matches
        let d1 = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "yes"})),
        ));
        assert_eq!(d1.len(), 1);

        // Internal does not match
        let d2 = engine.process_event(&make_event(
            EventProvider::Internal, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "no"})),
        ));
        assert!(d2.is_empty(), "Internal should not match OpenCode filter");
    }

    // ── Field Extraction (REQ-4) ──────────────────────────────────────────

    #[test]
    fn test_deeply_nested_field_extraction() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "deepExtract",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![
                field("partText", "payload.properties.part.text", DeliveryHint::Stream),
                field("partType", "payload.properties.part.type", DeliveryHint::Stream),
            ],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        let payload = serde_json::json!({
            "properties": {
                "part": {
                    "text": "Hello world",
                    "type": "assistant"
                }
            }
        });

        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("ask"), Some("corr-1"), "s1", Some(payload),
        ));

        assert_eq!(deliveries.len(), 1);
        assert_eq!(
            deliveries[0].fields.get("partText").unwrap(),
            &Value::String("Hello world".into())
        );
        assert_eq!(
            deliveries[0].fields.get("partType").unwrap(),
            &Value::String("assistant".into())
        );
    }

    #[test]
    fn test_field_extraction_missing_path_yields_none() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "missing",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("missing", "payload.nonexistent.field", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"other": "data"})),
        ));
        assert!(deliveries.is_empty(), "Missing path → no extraction → no delivery");
    }

    // ── Composite Key (REQ-5) ─────────────────────────────────────────────

    #[test]
    fn test_composite_key_joins_values() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "composite",
            ContractKey::Composite(vec!["sessionId".into(), "correlationId".into()]),
            None,
            None,
            vec![field("data", "payload.data", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("corr-1"), "session-abc",
            Some(serde_json::json!({"data": "test"})),
        ));

        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].correlation_key, "session-abc::corr-1");
    }

    #[test]
    fn test_composite_key_with_missing_part_skips() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "compositePartial",
            ContractKey::Composite(vec!["correlationId".into(), "sessionId".into()]),
            None,
            None,
            vec![field("data", "payload.data", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Event without correlationId
        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), None, "session-abc",
            Some(serde_json::json!({"data": "test"})),
        ));

        // Should still get a key from sessionId alone
        // But Single key extraction requires string values that are non-empty
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].correlation_key, "session-abc");
    }

    // ── Edge Cases ────────────────────────────────────────────────────────

    #[test]
    fn test_empty_fields_list_no_delivery() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "emptyFields",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![], // No fields = no extraction → no delivery
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        let deliveries = engine.process_event(&make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"data": "test"})),
        ));
        assert!(deliveries.is_empty(), "No fields declared → no delivery");
    }

    #[test]
    fn test_event_with_null_payload_handled_gracefully() {
        let mut engine = ContractEngine::new();
        let c = contract(
            "nullPayload",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("data", "payload.data", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feature-1", vec![c]);

        // Event with null payload
        let event = make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1", None,
        );
        let deliveries = engine.process_event(&event);
        assert!(deliveries.is_empty(), "Null payload → no extraction → no delivery");
    }

    #[test]
    fn test_multiple_features_separate_registrations() {
        let mut engine = ContractEngine::new();

        let c1 = contract(
            "feat1Contract",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("d1", "payload.d1", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feat-1", vec![c1]);

        let c2 = contract(
            "feat2Contract",
            ContractKey::Single("correlationId".into()),
            None,
            None,
            vec![field("d2", "payload.d2", DeliveryHint::Stream)],
            None,
        );
        engine.register_contracts("feat-2", vec![c2]);

        // Event should match both contracts
        let event = make_event(
            EventProvider::OpenCode, Some("tool"), Some("k1"), "s1",
            Some(serde_json::json!({"d1": "val1", "d2": "val2"})),
        );
        let deliveries = engine.process_event(&event);
        assert_eq!(deliveries.len(), 2, "Both contracts should produce deliveries");

        // Each delivery has its own contract_name
        let names: Vec<&str> = deliveries.iter().map(|d| d.contract_name.as_str()).collect();
        assert!(names.contains(&"feat1Contract"));
        assert!(names.contains(&"feat2Contract"));
    }

    // ── extract_field_by_path ─────────────────────────────────────────────

    #[test]
    fn test_extract_field_by_path_direct() {
        let value = serde_json::json!({
            "payload": {
                "properties": {
                    "part": {
                        "text": "hello"
                    }
                }
            }
        });

        let result = engine::extract_field_by_path(&value, "payload.properties.part.text");
        assert_eq!(result, Some(Value::String("hello".into())));

        let missing = engine::extract_field_by_path(&value, "payload.nonexistent");
        assert!(missing.is_none());

        let root = engine::extract_field_by_path(&value, "payload");
        assert!(root.is_some());
    }

    #[test]
    fn test_correlation_key_extraction_single() {
        let event = make_event(
            EventProvider::OpenCode, Some("tool"), Some("my-corr-id"), "session-1", None,
        );
        let event_json = serde_json::to_value(&event).unwrap();
        let engine = ContractEngine::new();
        let key = engine.extract_key_from_event(
            &event, &event_json, &ContractKey::Single("correlationId".into())
        );
        assert_eq!(key, Some("my-corr-id".into()));
    }

    #[test]
    fn test_correlation_key_extraction_missing() {
        let event = make_event(
            EventProvider::OpenCode, Some("tool"), None, "session-1", None,
        );
        let event_json = serde_json::to_value(&event).unwrap();
        let engine = ContractEngine::new();
        let key = engine.extract_key_from_event(
            &event, &event_json, &ContractKey::Single("correlationId".into())
        );
        assert_eq!(key, None);
    }
}
