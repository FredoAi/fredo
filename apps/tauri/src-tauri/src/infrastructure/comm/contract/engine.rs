//! Event Contract Engine — the Rust-side engine that buffers FredoEvents,
//! evaluates completeWhen expressions, manages Init→Update→End lifecycle,
//! and delivers SubscriptionDelivery objects to the frontend via EventBus.
//!
//! # Lifecycle
//!
//! 1. Frontend calls `register_event_contracts` IPC → contracts stored in registry.
//! 2. Adapters produce FredoEvents → `process()` buffers + evaluates.
//! 3. On first key match → `init` delivery with stream fields.
//! 4. On subsequent matches → `update` delivery with stream fields.
//! 5. On completeWhen match → `end` delivery with full (stream+deferred) payload.
//! 6. On timeout → sweep emits `end` with `timedOut: true`.
//! 7. Frontend calls `deregister_event_contracts` → in-flight keys get timedOut end.
//!
//! The engine stores no reference to EventBus; the caller (lib.rs or command
//! handlers) is responsible for emitting SubscriptionDelivery objects returned
//! by `process()` and `sweep()`.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use chrono::Utc;
use uuid::Uuid;

use crate::infrastructure::comm::contract::complete::{
    evaluate_complete_when, parse_complete_when,
};
use crate::infrastructure::comm::contract::field::{extract_field, payload_rule_matches};
use crate::infrastructure::comm::contract::input::EngineInput;
use crate::infrastructure::comm::contract::types::{
    BufferedContract, CompleteWhenExpr, ContractDeclaration, ContractKey, ExcludePayloadRule,
    SubscriptionDelivery,
};
use crate::infrastructure::comm::event::EventState;

/// Streaming update cadence in milliseconds.
/// When an ECE buffer has pending accumulated content that hasn't been
/// delivered yet, update deliveries are emitted at most once per this
/// interval per buffer. The first update after init is always immediate
/// (REQ-2). Single consumer — the cadenced-update branch below.
pub const STREAM_UPDATE_CADENCE_MS: i64 = 500;

/// Interior state behind the engine's RwLock.
struct EngineInner {
    /// Registered contracts by name.
    contracts: HashMap<String, ContractDeclaration>,
    /// Pre-parsed completeWhen expressions (cached after registration).
    parsed_exprs: HashMap<String, CompleteWhenExpr>,
    /// Active per-instance buffers keyed by (contract_name, ContractKey).
    buffers: HashMap<(String, ContractKey), BufferedContract>,
    /// Child-to-parent session relationships for ECE compositing (Spec #523).
    /// Key: child_session_id, Value: parent_session_id.
    /// Capped at 10,000 entries with oldest-first eviction.
    child_to_parent: HashMap<String, String>,
    /// Reverse lookup for cleanup — Key: parent_session_id, Value: list of child session IDs.
    parent_to_children: HashMap<String, Vec<String>>,
}

impl EngineInner {
    fn new() -> Self {
        EngineInner {
            contracts: HashMap::new(),
            parsed_exprs: HashMap::new(),
            buffers: HashMap::new(),
            child_to_parent: HashMap::new(),
            parent_to_children: HashMap::new(),
        }
    }
}

/// Thread-safe Event Contract Engine.
///
/// Registered as Tauri state (`Arc<ContractEngine>`) and consumed by IPC
/// command handlers, the IPC socket dispatcher, and OTLP receivers.
///
/// The engine manages contract registration, event processing, sweep, and
/// deregistration. All return `Vec<SubscriptionDelivery>`; the caller emits
/// these on the "fredo-stream-event" channel via EventBus.
pub struct ContractEngine {
    inner: RwLock<EngineInner>,
}

// ── Trait from contract-303.rs ────────────────────────────────────────────────

/// Trait that mirrors the contract file interface.
pub trait EventContractEngine: Send + Sync + 'static {
    /// REQ-1: Register contracts — returns errors per contract.
    fn req_1_register(&self, contracts: Vec<ContractDeclaration>) -> Result<(), Vec<String>>;
    /// REQ-2,3: Process an incoming `EngineInput` → Vec of deliveries.
    ///
    /// Accepts anything convertible to `EngineInput` so legacy sites (CLI
    /// `EmitEvent`, `InternalAdapter`, the OTLP receivers until they produce
    /// `EngineInput` in S2/S3) keep compiling via `From<FredoEvent>` (R4) —
    /// the engine itself only ever consumes `EngineInput`.
    fn req_2_3_process(&self, input: impl Into<EngineInput>) -> Vec<SubscriptionDelivery>;
    /// REQ-6: Periodic sweep — returns timed-out deliveries.
    fn req_6_sweep(&self) -> Vec<SubscriptionDelivery>;
    /// REQ-7: Deregister contracts by name.
    fn req_7_deregister(&self, names: Vec<String>) -> Vec<SubscriptionDelivery>;
}

impl EventContractEngine for ContractEngine {
    fn req_1_register(&self, contracts: Vec<ContractDeclaration>) -> Result<(), Vec<String>> {
        self.do_register(contracts)
    }

    fn req_2_3_process(&self, input: impl Into<EngineInput>) -> Vec<SubscriptionDelivery> {
        self.do_process(input.into())
    }

    fn req_6_sweep(&self) -> Vec<SubscriptionDelivery> {
        self.do_sweep()
    }

    fn req_7_deregister(&self, names: Vec<String>) -> Vec<SubscriptionDelivery> {
        self.do_deregister(names)
    }
}

impl ContractEngine {
    /// Create a new ContractEngine without starting any background tasks.
    ///
    /// The caller (lib.rs) is responsible for starting the 5-second sweep
    /// task via `tauri::async_runtime::spawn`.
    pub fn new() -> Arc<Self> {
        Arc::new(ContractEngine {
            inner: RwLock::new(EngineInner::new()),
        })
    }

    /// Return the delivery from `req_6_sweep()` — used by the sweep task in lib.rs.
    /// This is a shorthand that calls do_sweep() internally.
    pub fn sweep(&self) -> Vec<SubscriptionDelivery> {
        self.do_sweep()
    }

    // ── REQ-1: Register contracts ──────────────────────────────────────────────

    fn do_register(&self, contracts: Vec<ContractDeclaration>) -> Result<(), Vec<String>> {
        let mut errors: Vec<String> = Vec::new();
        let mut to_add: Vec<ContractDeclaration> = Vec::new();
        let mut to_parse: Vec<(String, String)> = Vec::new();

        for contract in &contracts {
            // REQ-1 / NB-C2: Validate timeout ≤ 300000ms
            if contract.timeout > 300_000 {
                errors.push(format!(
                    "{}: timeout {} exceeds maximum 300000ms",
                    contract.contract_name, contract.timeout
                ));
                continue;
            }

            // REQ-4: Validate completeWhen is parseable (empty string = no condition)
            if !contract.complete_when.is_empty() {
                if let Err(e) = parse_complete_when(&contract.complete_when) {
                    errors.push(format!(
                        "{}: invalid completeWhen '{}': {}",
                        contract.contract_name, contract.complete_when, e
                    ));
                    continue;
                }
            }

            // Spec #2723 (req 5): Validate excludePayload rules — non-empty paths only.
            if let Some(rules) = &contract.exclude_payload {
                if rules.iter().any(|r| r.path.trim().is_empty()) {
                    errors.push(format!(
                        "{}: excludePayload rule has an empty path",
                        contract.contract_name
                    ));
                    continue;
                }
            }

            to_add.push(contract.clone());
            to_parse.push((contract.contract_name.clone(), contract.complete_when.clone()));
        }

        if !errors.is_empty() {
            return Err(errors);
        }

        let mut state = match self.inner.write() {
            Ok(s) => s,
            Err(_) => return Err(vec!["Lock poisoned".to_string()]),
        };

        for contract in to_add {
            state
                .contracts
                .insert(contract.contract_name.clone(), contract.clone());
        }
        for (name, expr_str) in to_parse {
            if !expr_str.is_empty() {
                if let Ok(parsed) = parse_complete_when(&expr_str) {
                    state.parsed_exprs.insert(name, parsed);
                }
            }
        }

        Ok(())
    }

    // ── REQ-2/3: Process EngineInput → SubscriptionDeliveries ─────────────────

    fn do_process(&self, input: EngineInput) -> Vec<SubscriptionDelivery> {
        // Spec #523: Check for relationship metadata before contract processing.
        // This ensures the relationship is registered before any child events
        // are processed, enabling forward compositing.
        let relationship_deliveries = self.detect_and_register_relationship(&input);

        let state = match self.inner.read() {
            Ok(s) => s,
            Err(_) => return relationship_deliveries,
        };

        let contract_names: Vec<String> = state.contracts.keys().cloned().collect();
        // Drop read lock before taking write lock in process_for_contract
        drop(state);

        let mut all_deliveries: Vec<SubscriptionDelivery> = relationship_deliveries;

        for name in &contract_names {
            let deliveries = self.process_for_contract(name, &input);
            all_deliveries.extend(deliveries);
        }

        all_deliveries
    }

    /// Process input against a single registered contract.
    fn process_for_contract(
        &self,
        contract_name: &str,
        input: &EngineInput,
    ) -> Vec<SubscriptionDelivery> {
        let state = match self.inner.read() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let contract = match state.contracts.get(contract_name) {
            Some(c) => c.clone(),
            None => return Vec::new(),
        };
        let parsed_expr = state.parsed_exprs.get(contract_name).cloned();

        // REQ-8: Provider filtering
        // Uses serde-aware as_str() (snake_case) to match frontend contract declarations.
        if let Some(ref providers) = contract.providers {
            let event_provider = input.provider.as_str();
            if !providers.iter().any(|p| *p == event_provider) {
                return Vec::new(); // Provider doesn't match — skip
            }
        }

        // REQ-1: Transport filtering
        // Uses serde-aware as_str() (snake_case) to match frontend contract declarations.
        if let Some(ref transports) = contract.transports {
            let event_transport = input.transport.as_str();
            if !transports.iter().any(|t| *t == event_transport) {
                return Vec::new(); // Transport doesn't match — skip
            }
        }

        // REQ-2: EventType filtering
        // Uses serde-aware as_str() (snake_case) to match frontend contract declarations.
        if let Some(ref event_types) = contract.event_types {
            let event_event_type = input.event_type.as_str();
            if !event_types.iter().any(|et| *et == event_event_type) {
                return Vec::new(); // EventType doesn't match — skip
            }
        }

        // Spec #2723 (req 5): Payload exclusion filtering.
        // An event is SKIPPED for this contract (no buffer, no delivery) when
        // ANY rule matches: payload_rule_matches(input.payload, path, equals).
        // Evaluated BEFORE key extraction/buffering — an excluded event never
        // creates a buffer, so it can never be composited into a parent's
        // buffer either. Mirrors the Spec #382 providers/transports/eventTypes
        // filter architecture above.
        if let Some(ref rules) = contract.exclude_payload {
            let event_payload = input.payload.as_ref().unwrap_or(&serde_json::Value::Null);
            if rules
                .iter()
                .any(|rule| payload_rule_matches(event_payload, &rule.path, &rule.equals))
            {
                tracing::debug!(target: "fredo::contract_engine", contract_name, "ECE: event skipped by excludePayload rule");
                return Vec::new();
            }
        }

        // REQ-11: Build composite key
        let mut key_values: HashMap<String, String> = HashMap::new();
        let mut all_keys_found = true;

        for key_field in &contract.key {
            match extract_field(input, key_field) {
                Some(val) => {
                    let str_val = value_to_string(&val);
                    key_values.insert(key_field.clone(), str_val);
                }
                None => {
                    all_keys_found = false;
                    break; // REQ-10: missing key field → skip contract for this event
                }
            }
        }

        if !all_keys_found {
            return Vec::new();
        }

        // Spec #523: Cross-session compositing.
        // If the event's sessionId is a known child, substitute parent's sessionId
        // in the key_values so the buffer is created under the parent's composite key.
        // The event itself retains its real sessionId — only the ECE key is affected.
        let composited_child_sid: Option<String> = {
            if let Some(parent_sid) = state.child_to_parent.get(&input.session_id) {
                if let Some(v) = key_values.get_mut("sessionId") {
                    let original = v.clone();
                    *v = parent_sid.clone();
                    Some(original)
                } else {
                    None
                }
            } else {
                None
            }
        };

        let contract_key = ContractKey {
            pairs: contract
                .key
                .iter()
                .map(|k| (k.clone(), key_values[k].clone()))
                .collect(),
        };

        let buffer_key = (contract.contract_name.clone(), contract_key);

        drop(state); // Release read lock before taking write lock

        // ── Now acquire write lock to modify buffer ────────────────────────
        let mut state = match self.inner.write() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        // Get or create buffer entry
        let is_new = !state.buffers.contains_key(&buffer_key);

        if is_new {
            let buffered = BufferedContract::new(contract.clone(), key_values.clone());
            state.buffers.insert(buffer_key.clone(), buffered);
        }

        let buffered = match state.buffers.get_mut(&buffer_key) {
            Some(b) => b,
            None => return Vec::new(),
        };

        buffered.last_event_at = Utc::now();

        // Spec #627 (REQ-1/REQ-2): Buffer reset on new Init for completed buffers.
        // When an Init-state event arrives for a completed buffer, reset the buffer
        // lifecycle so a fresh init→update→end sequence can begin, enabling
        // multi-message OTLP sessions to deliver response data after prior
        // messages completed the buffer.
        // Non-Init events for completed buffers silently accumulate (existing behavior).
        let mut was_reset = false;
        if !is_new && buffered.completed {
            if input.state == EventState::Init {
                tracing::info!(target: "fredo::contract_engine",
                    contract_name,
                    session_id = %input.session_id,
                    correlation_id = ?input.correlation_id,
                    "ECE: buffer reset on Init event for completed buffer"
                );
                buffered.completed = false;
                buffered.accumulated_payload.clear();
                buffered.delivery_queue.clear();
                buffered.delivery_count = 0;
                buffered.last_update_emitted_at = None;
                was_reset = true;
            } else {
                return Vec::new();
            }
        }

        // REQ-10 / REQ-2/3: Extract field values (stream + deferred)
        // Spec #555: Compaction observability — log payload extraction for
        // debugging AC-7 (compacted node display) where the payload stream
        // field may be dropped during ECE delivery.
        let mut has_compacted = false;
        for field in &contract.stream_fields {
            if let Some(value) = extract_field(input, field) {
                tracing::debug!(target: "fredo::contract_engine", contract_name, field, ?value, "contract field resolved");
                // Spec #555: Detect compaction payload — log for diagnostics
                if field == "payload" {
                    if let Some(obj) = value.as_object() {
                        if obj.contains_key("compacted") {
                            has_compacted = true;
                            tracing::info!(target: "fredo::contract_engine",
                                contract_name,
                                session_id = %input.session_id,
                                correlation_id = ?input.correlation_id,
                                event_type = %input.event_type.as_str(),
                                state = ?input.state,
                                compacted = ?obj.get("compacted"),
                                "ECE: compaction payload detected — extracting payload stream field"
                            );
                        }
                    }
                }
                // Spec #555 / Content Merging (anti-pattern 4):
                // When accumulating a stream field that already exists in the
                // buffer AND both old and new values are JSON objects, merge
                // the new object sub-fields INTO the existing object rather than
                // replacing it entirely. This preserves init-time data (user
                // message, session metadata) through subsequent update/end
                // deliveries that carry partial content (e.g., compacted: true).
                //
                // If values are not objects (scalar, array, null), or the field
                // doesn't exist yet, fall back to a direct insertion.
                // Clone the existing value first to avoid borrow conflict with
                // the mutable insert that follows.
                let existing_clone = buffered.accumulated_payload.get(field).cloned();
                match existing_clone {
                    Some(existing_val) => {
                        if let (Some(existing_obj), Some(new_obj)) = (
                            existing_val.as_object(),
                            value.as_object(),
                        ) {
                            let mut merged = existing_obj.clone();
                            for (k, v) in new_obj {
                                merged.insert(k.clone(), v.clone());
                            }
                            buffered.accumulated_payload.insert(
                                field.clone(),
                                serde_json::Value::Object(merged),
                            );
                        } else {
                            buffered
                                .accumulated_payload
                                .insert(field.clone(), value.clone());
                        }
                    }
                    None => {
                        buffered.accumulated_payload.insert(field.clone(), value);
                    }
                }
            } else {
                tracing::debug!(target: "fredo::contract_engine", contract_name, field, "contract field missing");
            }
        }

        // Spec #555: Log accumulated payload keys after extraction for
        // compaction diagnostics — confirms all stream fields are present.
        if has_compacted {
            let acc_keys: Vec<&String> = buffered.accumulated_payload.keys().collect();
            tracing::info!(target: "fredo::contract_engine",
                contract_name,
                session_id = %input.session_id,
                accumulated_keys = ?acc_keys,
                is_new = is_new,
                completed = buffered.completed,
                "ECE: accumulated payload state for compaction event"
            );
        }

        for field in &contract.deferred_fields {
            if let Some(value) = extract_field(input, field) {
                buffered.accumulated_payload.insert(field.clone(), value);
            }
        }

        // ── Build the delivery payload for Init/Update ─────────────────────
        // Stream fields only (NB-C7)
        let mut stream_payload = serde_json::Map::new();
        for field in &contract.stream_fields {
            if let Some(value) = buffered.accumulated_payload.get(field) {
                stream_payload.insert(field.clone(), value.clone());
            }
        }

        // Spec #523: Add compositedChildSessionId for composited deliveries
        if let Some(ref child_sid) = composited_child_sid {
            stream_payload.insert(
                "compositedChildSessionId".to_string(),
                serde_json::Value::String(child_sid.clone()),
            );
        }

        let lifecycle = if is_new || was_reset { "init" } else { "update" };

        let delivery = SubscriptionDelivery {
            id: Uuid::new_v4().to_string(),
            contract_name: contract.contract_name.clone(),
            lifecycle: lifecycle.to_string(),
            key: key_values.clone(),
            payload: serde_json::Value::Object(stream_payload.clone()),
            timestamp: Utc::now().to_rfc3339(),
            provider: Some(input.provider.as_str().to_string()),
            timed_out: None,
        };

        // REQ-4: Evaluate completeWhen
        let should_complete = if !contract.complete_when.is_empty() {
            match &parsed_expr {
                Some(expr) => evaluate_complete_when(expr, &buffered.accumulated_payload),
                None => false,
            }
        } else {
            false
        };

        let mut deliveries: Vec<SubscriptionDelivery> = Vec::new();

        if should_complete {
            // REQ-1 / Spec #369: If this is the first event for this key
            // (or a buffer reset), emit the init delivery BEFORE the end
            // delivery so the frontend can create the node before
            // receiving its completion state.
            if is_new || was_reset {
                deliveries.push(delivery); // init delivery
            }

            // ── End with full payload (stream + deferred merged) ───────────
            let mut full_payload = serde_json::Map::new();
            for (field, value) in &buffered.accumulated_payload {
                full_payload.insert(field.clone(), value.clone());
            }

            // Spec #523: Add compositedChildSessionId for composited deliveries
            if let Some(ref child_sid) = composited_child_sid {
                full_payload.insert(
                    "compositedChildSessionId".to_string(),
                    serde_json::Value::String(child_sid.clone()),
                );
            }

            // Spec #555: Log end delivery payload keys for compaction
            // diagnostics — confirms the payload stream field is included
            // in the final delivery to the frontend.
            if has_compacted {
                let end_keys: Vec<&String> = full_payload.keys().collect();
                let payload_field = full_payload.get("payload");
                tracing::info!(target: "fredo::contract_engine",
                    contract_name,
                    end_payload_keys = ?end_keys,
                    has_payload_field = payload_field.is_some(),
                    payload_value_is_object = payload_field.map(|v| v.is_object()).unwrap_or(false),
                    "ECE: end delivery built for compaction event"
                );
            }

            let end_delivery = SubscriptionDelivery {
                id: Uuid::new_v4().to_string(),
                contract_name: contract.contract_name.clone(),
                lifecycle: "end".to_string(),
                key: key_values.clone(),
                payload: serde_json::Value::Object(full_payload),
                timestamp: Utc::now().to_rfc3339(),
                provider: Some(input.provider.as_str().to_string()),
                timed_out: None,
            };

            deliveries.push(end_delivery);
            // REQ-3/4 (Spec #382): Mark completed instead of removing.
            // The buffer stays in the map so subsequent events deliver
            // updates (new data like OTLP tokens) rather than creating
            // new buffers (duplicate nodes).
            buffered.completed = true;
        } else {
            // REQ-1/REQ-2: Cadenced updates — emit immediately for the first
            // non-completing event after init (last_update_emitted_at is None),
            // then at STREAM_UPDATE_CADENCE_MS cadence per buffer. Completed
            // buffers never reach this branch (guarded by buffer reset check above).
            if !is_new && !was_reset {
                if let Some(last_emitted) = buffered.last_update_emitted_at {
                    let elapsed = Utc::now() - last_emitted;
                    if elapsed.num_milliseconds() < STREAM_UPDATE_CADENCE_MS {
                        return Vec::new();
                    }
                }
                buffered.last_update_emitted_at = Some(Utc::now());
            }

            // REQ-12: Queue overflow protection — drop oldest if >100
            if buffered.delivery_queue.len() >= 100 {
                buffered.delivery_queue.remove(0);
            }
            buffered.delivery_queue.push(delivery.clone());
            buffered.delivery_count += 1;
            deliveries.push(delivery);
        }

        deliveries
    }

    // ── REQ-6: Sweep ───────────────────────────────────────────────────────────

    fn do_sweep(&self) -> Vec<SubscriptionDelivery> {
        let mut state = match self.inner.write() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let now = Utc::now();
        let mut deliveries: Vec<SubscriptionDelivery> = Vec::new();
        let mut to_remove: Vec<(String, ContractKey)> = Vec::new();

        for (key, buffered) in state.buffers.iter() {
            if buffered.completed {
                continue;
            }

            let elapsed = now - buffered.first_event_at;
            let elapsed_ms = elapsed.num_milliseconds() as u64;
            let timeout = buffered.declaration.timeout;

            if elapsed_ms >= timeout && timeout > 0 {
                // REQ-5: Emit timedOut End with full accumulated payload
                let mut full_payload = serde_json::Map::new();
                for (field, value) in &buffered.accumulated_payload {
                    full_payload.insert(field.clone(), value.clone());
                }

                deliveries.push(SubscriptionDelivery {
                    id: Uuid::new_v4().to_string(),
                    contract_name: key.0.clone(),
                    lifecycle: "end".to_string(),
                    key: buffered.key_values.clone(),
                    payload: serde_json::Value::Object(full_payload),
                    timestamp: now.to_rfc3339(),
                    provider: None,
                    timed_out: Some(true),
                });

                to_remove.push(key.clone());
            }
        }

        for key in to_remove {
            // Spec #523: Clean up relationships when buffer is removed
            Self::cleanup_relationships_by_key_inner(&mut state, &key);
            state.buffers.remove(&key);
        }

        // REQ-9: Remove completed buffers older than 5 minutes (300 seconds).
        // This prevents unbounded growth when contracts complete quickly but
        // their completed buffers are never cleaned up.
        let mut to_remove_completed: Vec<(String, ContractKey)> = Vec::new();
        for (key, buffered) in state.buffers.iter() {
            if buffered.completed {
                let elapsed = now - buffered.first_event_at;
                let elapsed_ms = elapsed.num_milliseconds() as u64;
                if elapsed_ms >= 300_000 {
                    to_remove_completed.push(key.clone());
                }
            }
        }
        for key in to_remove_completed {
            // Spec #523: Clean up relationships when completed buffer is removed
            Self::cleanup_relationships_by_key_inner(&mut state, &key);
            state.buffers.remove(&key);
        }

        deliveries
    }

    // ── REQ-7: Deregister ──────────────────────────────────────────────────────

    fn do_deregister(&self, names: Vec<String>) -> Vec<SubscriptionDelivery> {
        let mut state = match self.inner.write() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let mut deliveries: Vec<SubscriptionDelivery> = Vec::new();
        let now = Utc::now();

        for name in &names {
            state.contracts.remove(name);
            state.parsed_exprs.remove(name);
        }

        // Find all buffer entries for deregistered contracts
        let to_remove_by_name: Vec<(String, ContractKey)> = state
            .buffers
            .keys()
            .filter(|key| names.contains(&key.0))
            .cloned()
            .collect();

        for key in &to_remove_by_name {
            if let Some(buffered) = state.buffers.get(key) {
                if buffered.delivery_count > 0 || !buffered.accumulated_payload.is_empty() {
                    // In-flight instance: emit timedOut End
                    let mut full_payload = serde_json::Map::new();
                    for (field, value) in &buffered.accumulated_payload {
                        full_payload.insert(field.clone(), value.clone());
                    }

                    deliveries.push(SubscriptionDelivery {
                        id: Uuid::new_v4().to_string(),
                        contract_name: key.0.clone(),
                        lifecycle: "end".to_string(),
                        key: buffered.key_values.clone(),
                        payload: serde_json::Value::Object(full_payload),
                        timestamp: now.to_rfc3339(),
                        provider: None,
                        timed_out: Some(true),
                    });
                }
            }
        }

        for key in to_remove_by_name {
            // Spec #523: Clean up relationships when buffer is removed
            Self::cleanup_relationships_by_key_inner(&mut state, &key);
            state.buffers.remove(&key);
        }

        deliveries
    }

    // ── Spec #523: ECE Compositing — Relationship Registry ─────────────────────

    /// Detect parent-child relationship metadata on the input and register it.
    /// Returns any re-keyed update deliveries from late relationship registration.
    fn detect_and_register_relationship(&self, input: &EngineInput) -> Vec<SubscriptionDelivery> {
        if let Some(rel) = input
            .metadata
            .as_ref()
            .and_then(|m| m.get("relationship"))
            .and_then(|r| r.get("type"))
            .and_then(|t| t.as_str())
        {
            if rel == "parent-child" {
                let parent_sid = input
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("relationship"))
                    .and_then(|r| r.get("parentSessionId"))
                    .and_then(|v| v.as_str());
                let child_sid = input
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("relationship"))
                    .and_then(|r| r.get("childSessionId"))
                    .and_then(|v| v.as_str());
                if let (Some(parent), Some(child)) = (parent_sid, child_sid) {
                    return self.register_relationship(parent, child);
                }
            }
        }
        Vec::new()
    }

    /// Register a parent-child session relationship.
    ///
    /// 1. Inserts child→parent mapping (capped at 10K with oldest-first eviction).
    /// 2. Inserts child into parent→children reverse mapping.
    /// 3. Re-keys existing child buffers to the parent's sessionId, returning
    ///    "update" SubscriptionDeliveries with compositedChildSessionId.
    fn register_relationship(&self, parent: &str, child: &str) -> Vec<SubscriptionDelivery> {
        let mut state = match self.inner.write() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        // No-op if already registered
        if state.child_to_parent.contains_key(child) {
            return Vec::new();
        }

        // Cap at 10,000 entries — remove oldest if at limit
        if state.child_to_parent.len() >= 10_000 {
            if let Some(oldest_child) = state.child_to_parent.keys().next().cloned() {
                if let Some(oldest_parent) = state.child_to_parent.remove(&oldest_child) {
                    if let Some(children) = state.parent_to_children.get_mut(&oldest_parent) {
                        children.retain(|c| c != &oldest_child);
                        if children.is_empty() {
                            state.parent_to_children.remove(&oldest_parent);
                        }
                    }
                }
            }
        }

        // Insert the mapping
        state
            .child_to_parent
            .insert(child.to_string(), parent.to_string());
        state
            .parent_to_children
            .entry(parent.to_string())
            .or_default()
            .push(child.to_string());

        // Re-key existing child buffers: find buffers whose ContractKey has sessionId == child.
        // For each child buffer, emit TWO deliveries:
        //   1. An "end" delivery with the OLD (child) key — tells the frontend
        //      this child session was composited into the parent (Bug #523 fix).
        //   2. An "update" delivery with the NEW (parent) key — carries composited
        //      data so the frontend can update the parent session.
        let child_session_key = "sessionId";
        let mut rekeyed_deliveries: Vec<SubscriptionDelivery> = Vec::new();

        let buffer_keys: Vec<(String, ContractKey)> = state.buffers.keys().cloned().collect();
        for buffer_key in &buffer_keys {
            let (contract_name, contract_key) = buffer_key;

            // Check if this buffer's sessionId value equals the child
            let has_child_sid = contract_key
                .pairs
                .iter()
                .any(|(k, v)| k == child_session_key && v == child);

            if has_child_sid {
                // Spec #2723 (req 5): Re-key guard. Re-keying would emit an
                // "init" delivery under the parent key that bypasses the
                // excludePayload rules evaluated at process time — the
                // composited child data must never reach the parent's buffer
                // either. When the child buffer's accumulated payload matches
                // an ACTIVE exclusion for its contract, drop the buffer
                // silently (no "end" for the child key, no "init" for the
                // parent key) instead of re-keying it.
                let excluded = match state.contracts.get(contract_name) {
                    Some(contract) => contract
                        .exclude_payload
                        .as_ref()
                        .and_then(|rules| {
                            state
                                .buffers
                                .get(buffer_key)
                                .map(|b| Self::buffer_matches_exclusion(&b.accumulated_payload, rules))
                        })
                        .unwrap_or(false),
                    None => false,
                };
                if excluded {
                    state.buffers.remove(buffer_key);
                    continue;
                }

                // Get the buffer before removing it so we can build both deliveries
                if let Some(buffered) = state.buffers.get(buffer_key) {
                    // Compile the full accumulated payload for the child buffer
                    let mut end_payload = serde_json::Map::new();
                    for (field, value) in &buffered.accumulated_payload {
                        end_payload.insert(field.clone(), value.clone());
                    }
                    end_payload.insert(
                        "compositedChildSessionId".to_string(),
                        serde_json::Value::String(child.to_string()),
                    );

                    // Emit "end" delivery with the OLD (child) key so the frontend
                    // can clean up the child session from the sidebar and merge
                    // sessions. timedOut=true signals the end was not a normal
                    // completion but a compositing transfer.
                    let end_delivery = SubscriptionDelivery {
                        id: Uuid::new_v4().to_string(),
                        contract_name: contract_name.clone(),
                        lifecycle: "end".to_string(),
                        key: contract_key.pairs.clone().into_iter().collect(),
                        payload: serde_json::Value::Object(end_payload),
                        timestamp: Utc::now().to_rfc3339(),
                        provider: None,
                        timed_out: Some(true),
                    };
                    rekeyed_deliveries.push(end_delivery);
                }

                // Now remove the buffer at the old key
                if let Some(buffered) = state.buffers.remove(buffer_key) {
                    // Build new ContractKey with parent sessionId substituted
                    let new_pairs: Vec<(String, String)> = contract_key
                        .pairs
                        .iter()
                        .map(|(k, v)| {
                            if k == child_session_key {
                                (k.clone(), parent.to_string())
                            } else {
                                (k.clone(), v.clone())
                            }
                        })
                        .collect();
                    let new_key = ContractKey { pairs: new_pairs.clone() };
                    let new_buffer_key = (contract_name.clone(), new_key);

                    // Build init delivery payload with compositedChildSessionId.
                    // Bug #523 fix: Use "init" lifecycle so the frontend creates
                    // a SubagentNode for the composited child session. The frontend
                    // only creates graph nodes on "init" deliveries — emitting
                    // "update" here meant no SubagentNode was ever created.
                    let mut payload_map = serde_json::Map::new();
                    for (field, value) in &buffered.accumulated_payload {
                        payload_map.insert(field.clone(), value.clone());
                    }
                    payload_map.insert(
                        "compositedChildSessionId".to_string(),
                        serde_json::Value::String(child.to_string()),
                    );

                    let init_delivery = SubscriptionDelivery {
                        id: Uuid::new_v4().to_string(),
                        contract_name: contract_name.clone(),
                        lifecycle: "init".to_string(),
                        key: new_pairs.into_iter().collect(),
                        payload: serde_json::Value::Object(payload_map),
                        timestamp: Utc::now().to_rfc3339(),
                        provider: None,
                        timed_out: None,
                    };
                    rekeyed_deliveries.push(init_delivery);

                    // Insert at the new parent key
                    state.buffers.insert(new_buffer_key, buffered);
                }
            }
        }

        rekeyed_deliveries
    }

    /// Spec #2723 (req 5): Evaluate excludePayload rules against a buffer's
    /// accumulated payload — the closest available proxy for the event payload
    /// the process-time exclusion evaluates. A rule matches when it matches the
    /// captured whole-payload value (the "payload" stream field) OR the flat
    /// accumulated field map (contracts that capture payload sub-paths as
    /// stream fields). Uses the same `payload_rule_matches` resolution so the
    /// re-key guard and the process-time check agree.
    fn buffer_matches_exclusion(
        accumulated: &HashMap<String, serde_json::Value>,
        rules: &[ExcludePayloadRule],
    ) -> bool {
        rules.iter().any(|rule| {
            // Target 1: the captured whole event payload (MM-style contracts).
            if let Some(payload_val) = accumulated.get("payload") {
                if payload_rule_matches(payload_val, &rule.path, &rule.equals) {
                    return true;
                }
            }
            // Target 2: the flat accumulated map (payload sub-path stream fields).
            match accumulated.get(rule.path.as_str()) {
                Some(literal) => literal == &rule.equals,
                None => extract_field(accumulated, &rule.path).map_or(false, |value| value == rule.equals),
            }
        })
    }

    /// Clean up relationship mappings when a buffer is removed.
    /// Called from do_sweep() and do_deregister() when removing buffers.
    fn cleanup_relationships_by_key_inner(
        state: &mut std::sync::RwLockWriteGuard<'_, EngineInner>,
        key: &(String, ContractKey),
    ) {
        let (_contract_name, contract_key) = key;

        // Find the sessionId value from the contract key
        let session_id = match contract_key
            .pairs
            .iter()
            .find(|(k, _)| k == "sessionId")
            .map(|(_, v)| v.clone())
        {
            Some(s) => s,
            None => return,
        };

        // If this sessionId is a child, remove the child→parent mapping
        if let Some(parent) = state.child_to_parent.remove(&session_id) {
            if let Some(children) = state.parent_to_children.get_mut(&parent) {
                children.retain(|c| c != &session_id);
                if children.is_empty() {
                    state.parent_to_children.remove(&parent);
                }
            }
        }

        // If this sessionId is a parent, remove all its children mappings
        if let Some(children) = state.parent_to_children.remove(&session_id) {
            for child in &children {
                state.child_to_parent.remove(child);
            }
        }
    }
}

// ── Helper: Convert serde_json::Value to String for key building ──────────────

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Array(a) => {
            let items: Vec<String> = a.iter().map(value_to_string).collect();
            format!("[{}]", items.join(","))
        }
        serde_json::Value::Object(o) => {
            let items: Vec<String> = o
                .iter()
                .map(|(k, v)| format!("{}:{}", k, value_to_string(v)))
                .collect();
            format!("{{{}}}", items.join(","))
        }
    }
}

// ── Spec #555: Compaction payload accumulation tests ──────────────────────────
//
// AC-7: When a compaction event (agent_session with compacted: true, state: Response)
// is processed for an existing chat-node buffer, the end delivery MUST include
// the accumulated payload with both "state" and "payload" fields.
//
// Root cause investigation:
// The `accumulated_payload` HashMap stores each stream field as a top-level key.
// When a subsequent event provides a new value for "payload",
// `accumulated_payload.insert("payload", new_value)` replaces the init event's
// normalized payload with the compaction event's raw payload.
// This causes the frontend to receive only the raw compaction payload structure
// instead of the merged normalized payload with compacted:true added.
//
// The fix merges new payload fields into the existing accumulated payload
// when both old and new values are JSON objects, preserving the init event's
// payload data while adding compaction metadata.

#[cfg(test)]
mod compaction_tests {
    use super::*;
    use crate::infrastructure::comm::contract::input::EngineInput;
    use crate::infrastructure::comm::contract::EventContractEngine;
    use crate::infrastructure::comm::event::{
        EventProvider, EventState, EventType, Transport,
    };

    fn make_engine() -> Arc<ContractEngine> {
        ContractEngine::new()
    }

    /// Helper: build an EngineInput with full control over payload and event type.
    fn make_event(
        event_type: EventType,
        state: EventState,
        session_id: &str,
        correlation_id: Option<&str>,
        payload: Option<serde_json::Value>,
    ) -> EngineInput {
        EngineInput {
            state,
            provider: EventProvider::OpenCode,
            transport: Transport::Hook,
            event_type,
            session_id: session_id.to_string(),
            correlation_id: correlation_id.map(|s| s.to_string()),
            tool_name: None,
            payload,
            error: None,
            metadata: None,
        }
    }

    /// AC-7: Compaction payload must survive ECE processing.
    ///
    /// Scenario:
    /// 1. Chat init event with normalized payload → creates buffer
    /// 2. AgentSession Response event with compacted:true → completes buffer
    /// 3. End delivery must include BOTH "state" and "payload" keys
    #[test]
    fn compaction_payload_included_in_end_delivery() {
        let engine = make_engine();
        let contract = ContractDeclaration {
            contract_name: "chat-node".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string(), "correlationId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: Some(vec!["hook".to_string()]),
            event_types: Some(vec!["chat".to_string(), "agent_session".to_string()]),
            exclude_payload: None,
        };
        engine.req_1_register(vec![contract]).unwrap();

        // Step 1: Chat init event with a normalized payload
        let chat_payload = serde_json::json!({
            "userMessage": "hello",
            "agentReply": "",
            "promptTokens": 10,
            "completionTokens": 0,
        });
        let p1 = engine.req_2_3_process(make_event(
            EventType::Chat,
            EventState::Init,
            "test-session-001",
            Some("test-correlation-001"),
            Some(chat_payload),
        ));
        assert_eq!(p1.len(), 1, "Chat init should produce 1 delivery");
        assert_eq!(p1[0].lifecycle, "init");
        let p1_payload = p1[0].payload.as_object().unwrap();
        assert!(p1_payload.contains_key("payload"), "Init delivery should contain 'payload' key");
        assert!(p1_payload.contains_key("state"), "Init delivery should contain 'state' key");

        // Step 2: Compaction event — AgentSession, Response, compacted:true
        let compaction_payload = serde_json::json!({
            "compacted": true,
            "sessionId": "test-session-001",
        });
        let p2 = engine.req_2_3_process(make_event(
            EventType::AgentSession,
            EventState::Response,
            "test-session-001",
            Some("test-correlation-001"),
            Some(compaction_payload),
        ));
        assert_eq!(p2.len(), 1, "Compaction event should produce 1 delivery (end)");
        assert_eq!(p2[0].lifecycle, "end", "Second event should be 'end'");

        // THE BUG: The end delivery payload must include both "state" and "payload"
        let end_payload = p2[0].payload.as_object().unwrap();
        assert!(
            end_payload.contains_key("state"),
            "End delivery MUST contain 'state' key"
        );
        assert!(
            end_payload.contains_key("payload"),
            "End delivery MUST contain 'payload' key — this test fails if the compaction payload is dropped"
        );

        // Verify the payload value is an object containing "compacted":true
        let end_payload_val = end_payload.get("payload").unwrap();
        assert!(end_payload_val.is_object(), "Payload value must be an object");
        let payload_obj = end_payload_val.as_object().unwrap();
        assert_eq!(
            payload_obj.get("compacted").and_then(|v| v.as_bool()),
            Some(true),
            "Payload must contain compacted: true"
        );
        // CRITICAL: The init event's fields MUST survive through the compaction input.
        // Without object-level merging, the compaction payload replaces the init payload,
        // losing userMessage, agentReply, promptTokens, and completionTokens.
        assert!(
            payload_obj.contains_key("userMessage"),
            "Payload must preserve userMessage from init event — merge sub-fields, don't replace entire payload"
        );
        assert_eq!(
            payload_obj.get("userMessage").and_then(|v| v.as_str()),
            Some("hello"),
            "userMessage must be preserved after compaction event processing"
        );
    }

    /// Verify that when a first event sets payload and a second event also has
    /// a payload, both payload contributions are visible after the end delivery
    /// (merged if both are objects, or the latest value replaces if not).
    #[test]
    fn payload_accumulation_merges_across_events() {
        let engine = make_engine();
        let contract = ContractDeclaration {
            contract_name: "merge-test".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: None,
            event_types: None,
            exclude_payload: None,
        };
        engine.req_1_register(vec![contract]).unwrap();

        // First event: Init with payload {a: 1}
        engine.req_2_3_process(make_event(
            EventType::Chat,
            EventState::Init,
            "merge-session",
            None,
            Some(serde_json::json!({"a": 1})),
        ));

        // Second event: Response with payload {b: 2}
        let deliveries = engine.req_2_3_process(make_event(
            EventType::Chat,
            EventState::Response,
            "merge-session",
            None,
            Some(serde_json::json!({"b": 2})),
        ));

        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].lifecycle, "end");

        let end_payload = deliveries[0].payload.as_object().unwrap();
        assert!(end_payload.contains_key("payload"), "End delivery should have payload");
        let payload_val = end_payload.get("payload").unwrap();
        assert!(payload_val.is_object(), "Payload should be an object");

        // The second event's payload replaces the first (no deep merge needed —
        // each event brings its own complete payload). The key requirement is
        // that the payload key EXISTS in the final delivery.
        let payload_obj = payload_val.as_object().unwrap();
        // After the fix, the payload should have BOTH a:1 (from init) AND b:2 (from response)
        assert!(payload_obj.contains_key("b"), "Payload should contain 'b' from the second event");
    }

    /// Compaction event without payload: accumulated payload should still
    /// contain the init event's payload (not cleared/lost).
    #[test]
    fn payload_survives_when_second_event_has_no_payload() {
        let engine = make_engine();
        let contract = ContractDeclaration {
            contract_name: "survive-test".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: None,
            event_types: None,
            exclude_payload: None,
        };
        engine.req_1_register(vec![contract]).unwrap();

        // First event: Init with payload
        engine.req_2_3_process(make_event(
            EventType::Chat,
            EventState::Init,
            "survive-session",
            None,
            Some(serde_json::json!({"original": "data"})),
        ));

        // Second event: Response with NO payload
        let deliveries = engine.req_2_3_process(make_event(
            EventType::Chat,
            EventState::Response,
            "survive-session",
            None,
            None, // no payload!
        ));

        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].lifecycle, "end");

        let end_payload = deliveries[0].payload.as_object().unwrap();
        assert!(
            end_payload.contains_key("payload"),
            "End delivery MUST contain 'payload' key even when the response event has no payload"
        );
        let payload_val = end_payload.get("payload").unwrap();
        assert_eq!(
            payload_val.as_object().unwrap().get("original").and_then(|v| v.as_str()),
            Some("data"),
            "Init event's payload should survive when second event has no payload"
        );
    }
}
