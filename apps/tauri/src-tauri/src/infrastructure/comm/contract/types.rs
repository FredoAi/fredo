//! Core types for the Event Contract Engine.
//!
//! Spec #295, REQ-1 through REQ-20.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── REQ-5: Correlation Keying ────────────────────────────────────────────

/// The key used to group events into contract delivery instances.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(untagged)]
pub enum ContractKey {
    /// Single field name (e.g. "correlationId" or "sessionId")
    Single(String),
    /// Composite of field names (e.g. ["sessionId", "correlationId"])
    Composite(Vec<String>),
}

// ── REQ-6/REQ-7: Delivery Hints ──────────────────────────────────────────

/// Whether a contract field is delivered immediately (stream) or buffered (deferred).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryHint {
    Stream,
    Deferred,
}

impl Default for DeliveryHint {
    fn default() -> Self {
        DeliveryHint::Stream
    }
}

// ── REQ-3/REQ-17: Contract Filters ───────────────────────────────────────

/// Optional filter criteria for matching events to contracts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractFilter {
    /// Which providers to match (e.g. ["OpenCode"]). None = all providers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<String>>,
    /// Which tool names to match (e.g. ["ask", "edit"]). None = all tools.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_names: Option<Vec<String>>,
}

// ── REQ-4: Contract Field Declaration ─────────────────────────────────────

/// A single field declaration on a contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractField {
    /// Name of the field (used as key in SubscriptionDelivery.fields).
    pub name: String,
    /// Dot-path into the FredoEvent (e.g. "payload.properties.part.text").
    pub path: String,
    /// Delivery hint: stream (default) or deferred.
    #[serde(default)]
    pub hint: DeliveryHint,
}

// ── REQ-1: EventContractDeclaration ──────────────────────────────────────

/// A full contract declaration sent by a frontend feature.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventContractDeclaration {
    /// Unique name for this contract (e.g. "chatNode", "toolResult").
    pub name: String,
    /// Key field(s) for grouping events.
    pub key: ContractKey,
    /// Timeout in milliseconds. Optional — if None, no timeout is enforced.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Optional completeWhen expression string (DSL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete_when: Option<String>,
    /// The fields to extract from matching events.
    pub fields: Vec<ContractField>,
    /// Optional filter. None = match all events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<ContractFilter>,
}

// ── REQ-10: Lifecycle Enum ───────────────────────────────────────────────

/// Lifecycle state of a delivery instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lifecycle {
    /// First delivery for this key.
    Init,
    /// Subsequent intermediate delivery.
    Update,
    /// Final delivery (triggered by completeWhen or timeout).
    End,
}

// ── REQ-11/REQ-12: SubscriptionDelivery ──────────────────────────────────

/// A delivery emitted from the Contract Engine to the frontend via IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionDelivery {
    /// Name of the contract that produced this delivery.
    pub contract_name: String,
    /// Lifecycle state.
    pub lifecycle: Lifecycle,
    /// The correlation key value.
    pub correlation_key: String,
    /// Accumulated field values.
    pub fields: HashMap<String, Value>,
    /// ISO 8601 timestamp of the delivery.
    pub timestamp: String,
    /// Whether this delivery was triggered by timeout.
    #[serde(default)]
    pub timed_out: bool,
}

// ── REQ-8: CompleteWhenExpr AST ───────────────────────────────────────────

/// An expression node in the completeWhen DSL.
#[derive(Debug, Clone, PartialEq)]
pub enum CompleteWhenExpr {
    /// `field.path === "expected"` — string or number equality against accumulated state.
    Equals(String, String),
    /// `field.path !== "expected"` — inequality.
    NotEquals(String, String),
    /// `field.path exists` — field is present and non-null.
    Exists(String),
    /// `field.path !exists` — field is absent or null.
    NotExists(String),
}

// ── REQ-19: Tauri Command Payloads ───────────────────────────────────────

/// Payload for the register_event_contracts Tauri command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterContractsPayload {
    pub feature_id: String,
    pub contracts: Vec<EventContractDeclaration>,
}

/// Payload for the deregister_event_contracts Tauri command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeregisterContractsPayload {
    pub feature_id: String,
}

// ── Internal Buffered State ──────────────────────────────────────────────

/// Internal buffered state for a contract + correlation key.
#[derive(Debug, Clone)]
pub(crate) struct BufferedState {
    /// Accumulated field values.
    pub fields: HashMap<String, Value>,
    /// Timestamp (Instant) when the first event for this key was received.
    pub first_seen: std::time::Instant,
    /// Whether Init has been emitted (for lifecycle tracking).
    pub has_emitted_init: bool,
    /// Whether End has been emitted (for cleanup).
    pub has_ended: bool,
    /// The contract declaration this state belongs to (for timeout_ms and completeWhen).
    pub contract: EventContractDeclaration,
}
