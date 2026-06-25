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
