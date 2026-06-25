// Auto-generated spec contract for Spec #295 — Event Contract Engine
// Do not edit manually. Coders implement against these types.
// Generated from: spec-295-body.md

#![allow(dead_code, unused_imports)]

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── REQ-5: Correlation Keying ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ContractKey {
    Single(String),
    Composite(Vec<String>),
}

// ── REQ-6/REQ-7: Delivery Hints ──────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryHint {
    Stream,
    Deferred,
}

// ── REQ-3/REQ-17: Contract Filters ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_names: Option<Vec<String>>,
}

// ── REQ-4: Contract Field Declaration ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractField {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub hint: DeliveryHint,
}

impl Default for DeliveryHint {
    fn default() -> Self { DeliveryHint::Stream }
}

// ── REQ-1: EventContractDeclaration ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventContractDeclaration {
    pub name: String,
    pub key: ContractKey,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete_when: Option<String>,
    pub fields: Vec<ContractField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<ContractFilter>,
}

// ── REQ-8: completeWhen Expression AST ────────────────────────────────────

#[derive(Debug, Clone)]
pub enum CompleteWhenExpr {
    Equals(String, String),
    NotEquals(String, String),
    Exists(String),
    NotExists(String),
}

// ── REQ-10: Lifecycle Enum ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lifecycle {
    Init,
    Update,
    End,
}

// ── REQ-11/REQ-12: SubscriptionDelivery ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionDelivery {
    pub contract_name: String,
    pub lifecycle: Lifecycle,
    pub correlation_key: String,
    pub fields: HashMap<String, Value>,
    pub timestamp: String,
    #[serde(default)]
    pub timed_out: bool,
}

// ── REQ-19: Tauri Command Payloads ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterContractsPayload {
    pub feature_id: String,
    pub contracts: Vec<EventContractDeclaration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeregisterContractsPayload {
    pub feature_id: String,
}

// ── Contract Engine Trait ────────────────────────────────────────────────

/// Core engine trait. All REQ-IDs map to methods.
pub trait SpecContract {
    fn req_1(&self, feature_id: &str, contracts: Vec<EventContractDeclaration>);
    fn req_2(&self, feature_id: &str);
    fn req_3(&self, event: &crate::infrastructure::comm::event::FredoEvent) -> Vec<SubscriptionDelivery>;
    fn req_4(&self, event: &crate::infrastructure::comm::event::FredoEvent, field: &ContractField) -> Option<Value>;
    fn req_5(&self, event: &crate::infrastructure::comm::event::FredoEvent, key: &ContractKey) -> Option<String>;
    fn req_6(&self, deliveries: &mut Vec<SubscriptionDelivery>);
    fn req_7(&self, deliveries: &mut Vec<SubscriptionDelivery>);
    fn req_8(&self, contract: &EventContractDeclaration, fields: &HashMap<String, Value>) -> bool;
    fn req_9(&self) -> Vec<SubscriptionDelivery>;
    fn req_10(&self, contract_name: &str, key: &str, fields: HashMap<String, Value>, current_lifecycle: Option<Lifecycle>) -> SubscriptionDelivery;
    fn req_17(&self, filter: &Option<ContractFilter>, provider: &str) -> bool;
}
