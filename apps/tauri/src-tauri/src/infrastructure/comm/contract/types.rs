//! Event Contract Engine — core types.
//!
//! Mirrors TypeScript EventContractDeclaration and defines the internal
//! buffer structures, delivery envelope, completeWhen expression AST,
//! and composite key for per-instance isolation.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

// ── REQ-1: Contract Registration ──────────────────────────────────────────────

/// Contract declaration — mirrors TypeScript EventContractDeclaration.
/// Deserialized from IPC command arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractDeclaration {
    pub contract_name: String,
    pub stream_fields: Vec<String>,
    pub deferred_fields: Vec<String>,
    pub key: Vec<String>,
    pub complete_when: String,
    pub timeout: u64,
    #[serde(default)]
    pub providers: Option<Vec<String>>,
    #[serde(default)]
    pub transports: Option<Vec<String>>,
    #[serde(default)]
    pub event_types: Option<Vec<String>>,
    /// Spec #2723 (req 5): optional payload-path exclusion rules. An event is
    /// SKIPPED for this contract (no buffer, no delivery) when ANY rule
    /// matches: `payload_rule_matches(input.payload, path, equals)`. Evaluated
    /// in `process_for_contract` BEFORE key extraction/buffering, mirroring the
    /// Spec #382 providers/transports/eventTypes filter architecture.
    /// Backward compatible — contracts that omit this field behave unchanged.
    #[serde(default)]
    pub exclude_payload: Option<Vec<ExcludePayloadRule>>,
    /// Spec #2768 (ST-3): persistent contracts are registered once at app
    /// bootstrap (frontend `registerFeature()`-adjacent bootstrap calling
    /// `register_event_contracts`) and are SKIPPED by unmount-time
    /// deregistration — the ECE keeps buffering and the delivery layer
    /// persists their deliveries while the feature is closed. Backward
    /// compatible — omitting this field means `false` (non-persistent,
    /// byte-identical behavior).
    #[serde(default)]
    pub persistent: bool,
}

/// Payload-path exclusion rule (Spec #2723, req 5).
///
/// `path` is resolved against the event's payload — first as an exact literal
/// key (so payload keys containing dots, e.g. `agent.type`, match directly),
/// then via dot-notation traversal (`extract_field`). An event is skipped when
/// the resolved value strictly equals `equals`.
#[derive(Debug, Clone, Deserialize)]
pub struct ExcludePayloadRule {
    pub path: String,
    pub equals: serde_json::Value,
}

/// Validation error for a contract declaration.
#[derive(Debug, Clone)]
pub struct ContractValidation {
    pub name: String,
    pub errors: Vec<String>,
}

// ── REQ-2: Subscription Delivery ──────────────────────────────────────────────

/// Delivery envelope emitted to frontend via IPC on the "fredo-stream-event" channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionDelivery {
    pub id: String,
    pub contract_name: String,
    pub lifecycle: String, // "init" | "update" | "end"
    pub key: HashMap<String, String>,
    pub payload: serde_json::Value,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
}

// ── REQ-11: Composite Key ─────────────────────────────────────────────────────

/// Composite key built from FredoEvent fields for buffer isolation.
/// Two ContractKey values with the same pairs in the same order are equal.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContractKey {
    /// Serialized key:value pairs from the event, in declaration order.
    pub pairs: Vec<(String, String)>,
}

// ── REQ-4: completeWhen Expression ────────────────────────────────────────────

/// Parsed completeWhen expression AST node.
#[derive(Debug, Clone)]
pub enum CompleteWhenExpr {
    /// field === value
    Equals { field: String, value: String },
    /// field !== value
    NotEquals { field: String, value: String },
    /// field > value
    GreaterThan { field: String, value: String },
    /// field >= value
    GreaterThanOrEqual { field: String, value: String },
    /// field < value
    LessThan { field: String, value: String },
    /// field <= value
    LessThanOrEqual { field: String, value: String },
    /// exists field
    Exists { field: String },
    /// !exists field
    NotExists { field: String },
}

// ── REQ-2/3/4/5: Buffered Contract Instance ───────────────────────────────────

/// Per-key contract instance state — one per (contract_name, composite_key).
///
/// Holds the accumulated payload, delivery queue, timeout deadline, and
/// whether this instance has been completed.
#[derive(Debug, Clone)]
pub struct BufferedContract {
    /// The original contract declaration (for stream/deferred field lists).
    pub declaration: ContractDeclaration,
    /// The resolved key:value pairs for this instance, in declaration order.
    pub key_values: HashMap<String, String>,
    /// Full accumulated payload — all fields (stream + deferred) merged.
    pub accumulated_payload: HashMap<String, serde_json::Value>,
    /// UTC timestamp of the first event that created this instance.
    pub first_event_at: DateTime<Utc>,
    /// UTC timestamp of the most recent event.
    pub last_event_at: DateTime<Utc>,
    /// Number of deliveries emitted so far (excluding End).
    pub delivery_count: u32,
    /// Pending delivery queue (REQ-12: max 100).
    pub delivery_queue: Vec<SubscriptionDelivery>,
    /// Whether this instance has received a complete/timeout End.
    pub completed: bool,
    /// Timestamp of the last cadenced update delivery emission, if any.
    /// When None, the next non-completing event emits an immediate update
    /// (REQ-2). Subsequent events emit updates only when at least
    /// STREAM_UPDATE_CADENCE_MS has elapsed since this timestamp (REQ-1).
    pub last_update_emitted_at: Option<DateTime<Utc>>,
    /// #2770 ST-3 (round 6): the INNER composited child session id — the true
    /// owner session of the events accumulated in this buffer, recorded the
    /// first time a composited event (a known child's event re-keyed under
    /// the parent composite key) lands here (first-wins: every event of a
    /// re-keyed buffer belongs to that child). The relationship re-key
    /// machinery PRESERVES this stamp on the re-keyed end+init deliveries
    /// instead of re-stamping them with the re-key's direct child, so a
    /// multi-hop re-key cascade (L2's buffer → L1 → root) never clobbers the
    /// inner owner — the mis-stamped duplicate-row source the round-6 triage
    /// verified in `feature_mission_monitor_events`. The field rides the
    /// buffer through re-keys (the buffered struct moves wholesale), and is
    /// cleared on the Spec #627 buffer reset.
    pub composited_child_session_id: Option<String>,
}

impl BufferedContract {
    /// Create a new buffered contract instance from the first matching event.
    pub fn new(
        declaration: ContractDeclaration,
        key_values: HashMap<String, String>,
    ) -> Self {
        BufferedContract {
            declaration,
            key_values,
            accumulated_payload: HashMap::new(),
            first_event_at: Utc::now(),
            last_event_at: Utc::now(),
            delivery_count: 0,
            delivery_queue: Vec::new(),
            completed: false,
            last_update_emitted_at: None,
            composited_child_session_id: None,
        }
    }
}

// ── REQ-10: Field extraction path ─────────────────────────────────────────────

/// Dot-notation segment; either a named field or an index.
#[derive(Debug, Clone, PartialEq)]
pub enum PathSegment {
    Field(String),
    Index(usize),
}
