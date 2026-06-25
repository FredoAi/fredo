//! ContractEngine — the core of the Event Contract Engine.
//!
//! Manages registered contracts, processes incoming FredoEvents, extracts
//! fields by dot-path, buffers deferred fields, evaluates completeWhen
//! expressions, and emits SubscriptionDelivery objects via IPC.

use std::collections::HashMap;
use std::time::Instant;

use chrono::Utc;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::complete_when::{evaluate_complete_when, parse_complete_when};
use super::types::*;
use crate::infrastructure::comm::event::FredoEvent;

/// The ContractEngine manages contract registration, event processing,
/// and SubscriptionDelivery emission.
#[derive(Debug)]
pub struct ContractEngine {
    /// Contract registry: feature_id -> list of contracts.
    registry: HashMap<String, Vec<EventContractDeclaration>>,
    /// Buffered state: (contract_name, correlation_key) -> BufferedState.
    buffered: HashMap<(String, String), BufferedState>,
}

impl ContractEngine {
    /// Create a new empty ContractEngine.
    pub fn new() -> Self {
        ContractEngine {
            registry: HashMap::new(),
            buffered: HashMap::new(),
        }
    }

    // ── REQ-1: Contract Registration ──────────────────────────────────────

    /// Register one or more contracts for a feature.
    ///
    /// If the feature already has contracts registered, the new contracts
    /// are appended to the existing list.
    pub fn register_contracts(
        &mut self,
        feature_id: &str,
        contracts: Vec<EventContractDeclaration>,
    ) {
        self.registry
            .entry(feature_id.to_string())
            .or_insert_with(Vec::new)
            .extend(contracts);
    }

    // ── REQ-2: Contract Deregistration ────────────────────────────────────

    /// Deregister all contracts for a feature and clean up buffered state.
    pub fn deregister_contracts(&mut self, feature_id: &str) {
        // Remove the feature's contracts from registry
        if let Some(contracts) = self.registry.remove(feature_id) {
            // Clean up any buffered state for these contracts
            let contract_names: Vec<String> = contracts.into_iter().map(|c| c.name).collect();
            self.buffered.retain(|(cn, _), _| !contract_names.contains(cn));
        }
    }

    // ── REQ-3/REQ-4/REQ-5/REQ-6/REQ-7/REQ-8: Event Processing ─────────────

    /// Process an incoming FredoEvent through all registered contracts.
    ///
    /// Returns a list of SubscriptionDelivery objects to emit. These are
    /// returned rather than emitted directly to allow for testing without
    /// an AppHandle.
    pub fn process_event(&mut self, event: &FredoEvent) -> Vec<SubscriptionDelivery> {
        let mut deliveries = Vec::new();

        let event_json = match serde_json::to_value(event) {
            Ok(v) => v,
            Err(_) => return deliveries,
        };

        let provider_str = format!("{:?}", event.provider);

        // Check all registered contracts
        for contracts in self.registry.values() {
            for contract in contracts {
                // REQ-3: Check if event matches contract filter
                if !self.event_matches_contract(event, contract, &provider_str) {
                    continue;
                }

                // REQ-5: Extract correlation key
                let key_value = match self.extract_key_from_event(event, &event_json, &contract.key) {
                    Some(k) => k,
                    None => continue, // No key found, skip event
                };

                // REQ-4: Extract declared fields
                let mut extracted_fields: HashMap<String, Value> = HashMap::new();
                for field in &contract.fields {
                    if let Some(val) = extract_field_by_path(&event_json, &field.path) {
                        extracted_fields.insert(field.name.clone(), val);
                    }
                }

                if extracted_fields.is_empty() {
                    continue; // Nothing extracted
                }

                let state_key = (contract.name.clone(), key_value.clone());

                // Get or create buffered state
                if !self.buffered.contains_key(&state_key) {
                    self.buffered.insert(
                        state_key.clone(),
                        BufferedState {
                            fields: HashMap::new(),
                            first_seen: Instant::now(),
                            has_emitted_init: false,
                            has_ended: false,
                            contract: contract.clone(),
                        },
                    );
                }

                let state = self.buffered.get_mut(&state_key).unwrap();

                if state.has_ended {
                    continue; // Already ended, ignore
                }

                // Merge extracted fields into accumulated state
                state.fields.extend(extracted_fields);

                // Check which stream fields were updated for this event
                let has_stream_updates = contract.fields.iter().any(|f| {
                    matches!(f.hint, DeliveryHint::Stream)
                        && state.fields.contains_key(&f.name)
                });

                // REQ-8: Check completeWhen
                let should_end = contract.complete_when
                    .as_ref()
                    .and_then(|cw| parse_complete_when(cw).ok())
                    .map(|expr| evaluate_complete_when(&expr, &state.fields))
                    .unwrap_or(false);

                if should_end {
                    // If Init hasn't been emitted yet and we have stream fields, emit Init first
                    if !state.has_emitted_init && has_stream_updates {
                        let delivery = Self::build_delivery(
                            &contract.name,
                            &key_value,
                            &state.fields,
                            Lifecycle::Init,
                            false,
                        );
                        deliveries.push(delivery);
                        state.has_emitted_init = true;
                    }
                    // Emit End delivery
                    let delivery = Self::build_delivery(
                        &contract.name,
                        &key_value,
                        &state.fields,
                        Lifecycle::End,
                        false,
                    );
                    deliveries.push(delivery);
                    state.has_ended = true;
                } else if has_stream_updates {
                    // REQ-6: Stream field delivery
                    let delivery = Self::build_delivery(
                        &contract.name,
                        &key_value,
                        &state.fields,
                        if state.has_emitted_init {
                            Lifecycle::Update
                        } else {
                            state.has_emitted_init = true;
                            Lifecycle::Init
                        },
                        false,
                    );
                    deliveries.push(delivery);
                }
            }
        }

        deliveries
    }

    // ── REQ-9 / REQ-20: Timeout Sweep ─────────────────────────────────────

    /// Sweep all buffered keys and emit End for any that have timed out.
    ///
    /// Returns a list of timed-out SubscriptionDelivery objects to emit.
    pub fn sweep_timeouts(&mut self) -> Vec<SubscriptionDelivery> {
        let mut deliveries = Vec::new();
        let now = Instant::now();
        let mut to_remove: Vec<(String, String)> = Vec::new();

        for ((contract_name, key_value), state) in &self.buffered {
            if state.has_ended {
                to_remove.push((contract_name.clone(), key_value.clone()));
                continue;
            }

            if let Some(timeout_ms) = state.contract.timeout_ms {
                let elapsed = now.duration_since(state.first_seen);
                if elapsed.as_millis() >= timeout_ms as u128 {
                    // Timed out — emit End with timed_out: true
                    let delivery = Self::build_delivery(
                        contract_name,
                        key_value,
                        &state.fields,
                        Lifecycle::End,
                        true,
                    );
                    deliveries.push(delivery);
                    to_remove.push((contract_name.clone(), key_value.clone()));
                }
            }
        }

        // Remove all timed-out / ended keys
        for key in to_remove {
            self.buffered.remove(&key);
        }

        deliveries
    }

    // ── REQ-10: Build Delivery ────────────────────────────────────────────

    /// Build a SubscriptionDelivery from accumulated state.
    fn build_delivery(
        contract_name: &str,
        key_value: &str,
        fields: &HashMap<String, Value>,
        lifecycle: Lifecycle,
        timed_out: bool,
    ) -> SubscriptionDelivery {
        SubscriptionDelivery {
            contract_name: contract_name.to_string(),
            lifecycle,
            correlation_key: key_value.to_string(),
            fields: fields.clone(),
            timestamp: Utc::now().to_rfc3339(),
            timed_out,
        }
    }

    /// Emit deliveries via the Tauri IPC channel.
    pub fn emit_deliveries(deliveries: Vec<SubscriptionDelivery>, app: &AppHandle) {
        for delivery in deliveries {
            if let Err(e) = app.emit("fredo-stream-event", &delivery) {
                eprintln!("[fredo/contract] Failed to emit SubscriptionDelivery: {e}");
            }
        }
    }

    // ── REQ-3: Event Matching ─────────────────────────────────────────────

    /// Check whether an event matches a contract's filter criteria.
    fn event_matches_contract(
        &self,
        event: &FredoEvent,
        contract: &EventContractDeclaration,
        provider_str: &str,
    ) -> bool {
        match &contract.filter {
            None => {
                // REQ-17: No filter means match all events
                true
            }
            Some(filter) => {
                // Check provider filter
                if let Some(ref providers) = filter.providers {
                    if !providers.iter().any(|p| p == provider_str) {
                        // Also check if the serde serialized name matches
                        let serialized = serde_json::to_value(&event.provider)
                            .ok()
                            .and_then(|v| v.as_str().map(|s| s.to_string()))
                            .unwrap_or_default();
                        if !providers.iter().any(|p| p == &serialized) {
                            return false;
                        }
                    }
                }

                // Check tool_name filter
                if let Some(ref tool_names) = filter.tool_names {
                    if let Some(ref tool_name) = event.tool_name {
                        if !tool_names.iter().any(|t| t == tool_name) {
                            return false;
                        }
                    } else {
                        // Event has no tool_name but filter expects one
                        return false;
                    }
                }

                true
            }
        }
    }

    // ── REQ-5: Key Extraction ─────────────────────────────────────────────

    /// Extract the correlation key value from a FredoEvent based on ContractKey.
    pub(crate) fn extract_key_from_event(
        &self,
        _event: &FredoEvent,
        event_json: &Value,
        key: &ContractKey,
    ) -> Option<String> {
        match key {
            ContractKey::Single(field_name) => {
                extract_field_by_path(event_json, field_name)
                    .and_then(|v| match v {
                        Value::String(s) if !s.is_empty() => Some(s),
                        _ => None,
                    })
            }
            ContractKey::Composite(field_names) => {
                let parts: Vec<String> = field_names
                    .iter()
                    .filter_map(|name| {
                        extract_field_by_path(event_json, name)
                            .and_then(|v| match v {
                                Value::String(s) if !s.is_empty() => Some(s),
                                _ => None,
                            })
                    })
                    .collect();
                if parts.is_empty() {
                    None
                } else {
                    Some(parts.join("::"))
                }
            }
        }
    }
}

/// Extract a value from a serde_json::Value by dot-path.
///
/// E.g., `extract_field_by_path(json, "payload.properties.part.text")`
/// navigates `json["payload"]["properties"]["part"]["text"]`.
pub(crate) fn extract_field_by_path<'a>(value: &'a Value, path: &str) -> Option<Value> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = value;

    for part in &parts {
        match current {
            Value::Object(map) => {
                current = map.get(*part)?;
            }
            _ => return None,
        }
    }

    Some(current.clone())
}

impl Default for ContractEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::comm::event::*;

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
            timestamp: Utc::now().to_rfc3339(),
        }
    }

    // ── AC-1: Registration ────────────────────────────────────────────────

    #[test]
    fn test_register_contracts() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "testContract".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: None,
            fields: vec![ContractField {
                name: "status".into(),
                path: "payload.properties.status".into(),
                hint: DeliveryHint::Stream,
            }],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);
        assert_eq!(engine.registry.len(), 1);
        assert_eq!(engine.registry.get("feature-1").unwrap().len(), 1);
    }

    // ── AC-2: Deregistration ──────────────────────────────────────────────

    #[test]
    fn test_deregister_contracts() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "testContract".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: None,
            fields: vec![],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);
        engine.deregister_contracts("feature-1");
        assert!(engine.registry.is_empty());
    }

    // ── AC-3: Stream field delivery ───────────────────────────────────────

    #[test]
    fn test_stream_field_emit_init_on_first_event() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "chatNode".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: None,
            fields: vec![ContractField {
                name: "text".into(),
                path: "payload.content".into(),
                hint: DeliveryHint::Stream,
            }],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        let payload = serde_json::json!({"content": "Hello"});
        let event = make_event(
            EventProvider::OpenCode,
            Some("ask"),
            Some("corr-1"),
            "session-1",
            Some(payload),
        );

        let deliveries = engine.process_event(&event);
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].lifecycle, Lifecycle::Init);
        assert_eq!(deliveries[0].contract_name, "chatNode");
        assert_eq!(deliveries[0].correlation_key, "corr-1");
        assert_eq!(
            deliveries[0].fields.get("text").unwrap(),
            &Value::String("Hello".into())
        );
    }

    #[test]
    fn test_stream_field_emit_update_on_second_event() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "chatNode".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: None,
            fields: vec![ContractField {
                name: "text".into(),
                path: "payload.content".into(),
                hint: DeliveryHint::Stream,
            }],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        // First event
        let payload1 = serde_json::json!({"content": "Hello"});
        let event1 = make_event(
            EventProvider::OpenCode,
            Some("ask"),
            Some("corr-1"),
            "session-1",
            Some(payload1),
        );
        let deliveries1 = engine.process_event(&event1);
        assert_eq!(deliveries1.len(), 1);
        assert_eq!(deliveries1[0].lifecycle, Lifecycle::Init);

        // Second event — same key
        let payload2 = serde_json::json!({"content": "World"});
        let event2 = make_event(
            EventProvider::OpenCode,
            Some("ask"),
            Some("corr-1"),
            "session-1",
            Some(payload2),
        );
        let deliveries2 = engine.process_event(&event2);
        assert_eq!(deliveries2.len(), 1);
        assert_eq!(deliveries2[0].lifecycle, Lifecycle::Update);
        assert_eq!(
            deliveries2[0].fields.get("text").unwrap(),
            &Value::String("World".into())
        );
        // Both accumulated
        assert_eq!(deliveries2[0].fields.len(), 1); // text field overwrote previous
    }

    // ── AC-4: Deferred field buffering + completeWhen ──────────────────────

    #[test]
    fn test_deferred_field_buffers_until_complete_when() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "toolResult".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: Some(r#"status === "complete""#.into()),
            fields: vec![
                ContractField {
                    name: "result".into(),
                    path: "payload.result".into(),
                    hint: DeliveryHint::Deferred,
                },
                ContractField {
                    name: "status".into(),
                    path: "payload.status".into(),
                    hint: DeliveryHint::Deferred,
                },
            ],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        // First event — deferred, no delivery
        let payload1 = serde_json::json!({"result": "partial data"});
        let event1 = make_event(
            EventProvider::OpenCode,
            Some("read"),
            Some("corr-1"),
            "session-1",
            Some(payload1),
        );
        let deliveries1 = engine.process_event(&event1);
        assert!(deliveries1.is_empty(), "Deferred fields should not emit");

        // Second event — status = complete triggers End
        let payload2 = serde_json::json!({"status": "complete"});
        let event2 = make_event(
            EventProvider::OpenCode,
            Some("read"),
            Some("corr-1"),
            "session-1",
            Some(payload2),
        );
        let deliveries2 = engine.process_event(&event2);
        assert_eq!(deliveries2.len(), 1);
        assert_eq!(deliveries2[0].lifecycle, Lifecycle::End);
        assert!(!deliveries2[0].timed_out);
        // Both fields should be accumulated
        assert!(deliveries2[0].fields.contains_key("result"));
        assert!(deliveries2[0].fields.contains_key("status"));
    }

    #[test]
    fn test_deferred_does_not_emit_when_complete_when_not_met() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "toolResult".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: Some(r#"status === "complete""#.into()),
            fields: vec![
                ContractField {
                    name: "status".into(),
                    path: "payload.status".into(),
                    hint: DeliveryHint::Deferred,
                },
            ],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        // Event with status = running — NOT complete
        let payload = serde_json::json!({"status": "running"});
        let event = make_event(
            EventProvider::OpenCode,
            Some("read"),
            Some("corr-1"),
            "session-1",
            Some(payload),
        );
        let deliveries = engine.process_event(&event);
        assert!(deliveries.is_empty(), "Deferred should buffer without delivery");
    }

    // ── AC-5: Timeout ─────────────────────────────────────────────────────

    #[test]
    fn test_timeout_fires_end_delivery() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "timeoutTest".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: Some(1), // 1 ms timeout — will expire immediately
            complete_when: None,
            fields: vec![ContractField {
                name: "data".into(),
                path: "payload.data".into(),
                hint: DeliveryHint::Deferred,
            }],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        // First event buffers
        let payload = serde_json::json!({"data": "test"});
        let event = make_event(
            EventProvider::OpenCode,
            Some("tool"),
            Some("corr-1"),
            "session-1",
            Some(payload),
        );
        let deliveries = engine.process_event(&event);
        assert!(deliveries.is_empty(), "Deferred should buffer");

        // Small sleep to trigger timeout
        std::thread::sleep(std::time::Duration::from_millis(5));

        // Sweep
        let timeout_deliveries = engine.sweep_timeouts();
        assert!(
            !timeout_deliveries.is_empty(),
            "Should have timed out after sleep"
        );
        let delivery = &timeout_deliveries[0];
        assert_eq!(delivery.lifecycle, Lifecycle::End);
        assert!(delivery.timed_out);
        assert_eq!(delivery.correlation_key, "corr-1");

        // Buffered state should be cleaned up
        assert!(engine.buffered.is_empty());
    }

    #[test]
    fn test_timeout_respects_threshold() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "noTimeout".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: Some(60_000), // 60 second timeout — shouldn't expire
            complete_when: None,
            fields: vec![ContractField {
                name: "data".into(),
                path: "payload.data".into(),
                hint: DeliveryHint::Deferred,
            }],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        let payload = serde_json::json!({"data": "test"});
        let event = make_event(
            EventProvider::OpenCode,
            Some("tool"),
            Some("corr-1"),
            "session-1",
            Some(payload),
        );
        engine.process_event(&event);

        // Sweep immediately — no timeout
        let deliveries = engine.sweep_timeouts();
        assert!(deliveries.is_empty(), "60s timeout should not expire immediately");
    }

    // ── AC-6: Lifecycle transitions ───────────────────────────────────────

    #[test]
    fn test_lifecycle_transitions_full_cycle() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "cycleTest".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: Some(r#"state === "done""#.into()),
            fields: vec![
                ContractField {
                    name: "state".into(),
                    path: "payload.state".into(),
                    hint: DeliveryHint::Stream,
                },
            ],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        // Event 1: Init
        let p1 = serde_json::json!({"state": "started"});
        let e1 = make_event(EventProvider::OpenCode, Some("tool"), Some("k1"), "s1", Some(p1));
        let d1 = engine.process_event(&e1);
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].lifecycle, Lifecycle::Init);

        // Event 2: Update (state != done, so no End)
        let p2 = serde_json::json!({"state": "running"});
        let e2 = make_event(EventProvider::OpenCode, Some("tool"), Some("k1"), "s1", Some(p2));
        let d2 = engine.process_event(&e2);
        assert_eq!(d2.len(), 1);
        assert_eq!(d2[0].lifecycle, Lifecycle::Update);

        // Event 3: End (state = done)
        let p3 = serde_json::json!({"state": "done"});
        let e3 = make_event(EventProvider::OpenCode, Some("tool"), Some("k1"), "s1", Some(p3));
        let d3 = engine.process_event(&e3);
        assert_eq!(d3.len(), 1);
        assert_eq!(d3[0].lifecycle, Lifecycle::End);

        // After End, no more deliveries for this key
        let p4 = serde_json::json!({"state": "restarted"});
        let e4 = make_event(EventProvider::OpenCode, Some("tool"), Some("k1"), "s1", Some(p4));
        let d4 = engine.process_event(&e4);
        assert!(d4.is_empty(), "No deliveries after End");
    }

    // ── AC-7: No delivery for unregistered contracts ──────────────────────

    #[test]
    fn test_no_delivery_for_unregistered_contracts() {
        let mut engine = ContractEngine::new();
        // No contracts registered

        let event = make_event(
            EventProvider::OpenCode,
            Some("ask"),
            Some("corr-1"),
            "session-1",
            Some(serde_json::json!({"content": "Hello"})),
        );

        let deliveries = engine.process_event(&event);
        assert!(
            deliveries.is_empty(),
            "No contracts registered — no deliveries"
        );
    }

    // ── AC-8: Field extraction ────────────────────────────────────────────

    #[test]
    fn test_field_extraction_by_dot_path() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "deepField".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: None,
            fields: vec![
                ContractField {
                    name: "text".into(),
                    path: "payload.properties.part.text".into(),
                    hint: DeliveryHint::Stream,
                },
                ContractField {
                    name: "type".into(),
                    path: "payload.properties.type".into(),
                    hint: DeliveryHint::Stream,
                },
            ],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        let payload = serde_json::json!({
            "properties": {
                "part": {
                    "text": "Hello from deep path"
                },
                "type": "assistant"
            }
        });

        let event = make_event(
            EventProvider::OpenCode,
            Some("ask"),
            Some("corr-1"),
            "session-1",
            Some(payload),
        );

        let deliveries = engine.process_event(&event);
        assert_eq!(deliveries.len(), 1);
        assert_eq!(
            deliveries[0].fields.get("text").unwrap(),
            &Value::String("Hello from deep path".into())
        );
        assert_eq!(
            deliveries[0].fields.get("type").unwrap(),
            &Value::String("assistant".into())
        );
    }

    // ── AC-10: Multi-provider transparency ────────────────────────────────

    #[test]
    fn test_no_filter_matches_all_providers() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "multiProvider".into(),
            key: ContractKey::Single("sessionId".into()),
            timeout_ms: None,
            complete_when: None,
            fields: vec![ContractField {
                name: "data".into(),
                path: "payload.data".into(),
                hint: DeliveryHint::Stream,
            }],
            filter: None, // No filter = match all providers
        };

        engine.register_contracts("feature-1", vec![contract]);

        // OpenCode event
        let oc_event = make_event(
            EventProvider::OpenCode,
            Some("tool"),
            None,
            "session-1",
            Some(serde_json::json!({"data": "opencode"})),
        );
        let d1 = engine.process_event(&oc_event);
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].lifecycle, Lifecycle::Init);

        // Internal event — same session key, should emit Update
        let int_event = make_event(
            EventProvider::Internal,
            Some("tool"),
            None,
            "session-1",
            Some(serde_json::json!({"data": "internal"})),
        );
        let d2 = engine.process_event(&int_event);
        assert_eq!(d2.len(), 1);
        assert_eq!(d2[0].lifecycle, Lifecycle::Update);
    }

    // ── ToolName Filter ───────────────────────────────────────────────────

    #[test]
    fn test_tool_name_filter_matches_correctly() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "filteredTool".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: None,
            fields: vec![ContractField {
                name: "data".into(),
                path: "payload.data".into(),
                hint: DeliveryHint::Stream,
            }],
            filter: Some(ContractFilter {
                providers: None,
                tool_names: Some(vec!["ask".into(), "edit".into()]),
            }),
        };

        engine.register_contracts("feature-1", vec![contract]);

        // Matching tool
        let matching = make_event(
            EventProvider::OpenCode,
            Some("ask"),
            Some("corr-1"),
            "session-1",
            Some(serde_json::json!({"data": "yes"})),
        );
        let d = engine.process_event(&matching);
        assert_eq!(d.len(), 1, "ask tool should match");

        // Non-matching tool
        let non_matching = make_event(
            EventProvider::OpenCode,
            Some("read"),
            Some("corr-2"),
            "session-1",
            Some(serde_json::json!({"data": "no"})),
        );
        let d2 = engine.process_event(&non_matching);
        assert!(d2.is_empty(), "read tool should not match");
    }

    // ── Composite Key ─────────────────────────────────────────────────────

    #[test]
    fn test_composite_key_uses_concatenated_value() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "compositeKey".into(),
            key: ContractKey::Composite(vec!["sessionId".into(), "correlationId".into()]),
            timeout_ms: None,
            complete_when: None,
            fields: vec![ContractField {
                name: "data".into(),
                path: "payload.data".into(),
                hint: DeliveryHint::Stream,
            }],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        let event = make_event(
            EventProvider::OpenCode,
            Some("tool"),
            Some("corr-1"),
            "session-abc",
            Some(serde_json::json!({"data": "test"})),
        );

        let deliveries = engine.process_event(&event);
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].correlation_key, "session-abc::corr-1");
    }

    // ── Exists / NotExists completeWhen ───────────────────────────────────

    #[test]
    fn test_complete_when_exists_triggers_end() {
        let mut engine = ContractEngine::new();
        let contract = EventContractDeclaration {
            name: "existsTest".into(),
            key: ContractKey::Single("correlationId".into()),
            timeout_ms: None,
            complete_when: Some("error !exists".into()),
            fields: vec![
                ContractField {
                    name: "result".into(),
                    path: "payload.result".into(),
                    hint: DeliveryHint::Stream,
                },
            ],
            filter: None,
        };

        engine.register_contracts("feature-1", vec![contract]);

        // First event — no error field exists yet
        let p1 = serde_json::json!({"result": "ok"});
        let e1 = make_event(
            EventProvider::OpenCode,
            Some("tool"),
            Some("corr-1"),
            "session-1",
            Some(p1),
        );
        let d1 = engine.process_event(&e1);
        // Stream field + completeWhen (!exists) should both trigger
        // The stream field triggers Init delivery
        // Then completeWhen is checked: "error" doesn't exist in accumulated fields
        // So !exists evaluates to TRUE
        assert_eq!(d1.len(), 2, "Should emit Init + End");
        assert_eq!(d1[0].lifecycle, Lifecycle::Init);
        assert_eq!(d1[1].lifecycle, Lifecycle::End);
    }

    // ── Verify extract_field_by_path directly ─────────────────────────────

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

        let result = extract_field_by_path(&value, "payload.properties.part.text");
        assert_eq!(result, Some(Value::String("hello".into())));

        let missing = extract_field_by_path(&value, "payload.nonexistent");
        assert!(missing.is_none());
    }
}
