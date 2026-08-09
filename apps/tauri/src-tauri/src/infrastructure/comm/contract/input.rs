//! `EngineInput` — the ECE's input contract.
//!
//! Replaces `FredoEvent` at the `EventContractEngine` boundary (Spec #2449 S1).
//! Serialized camelCase exactly matching the surface `extract_field` and the
//! typed reads in engine.rs rely on, so dot-path resolution is unchanged.
//! `id`/`timestamp` are dropped — the engine never consumes them.
//!
//! `FredoEvent` remains the CLI/Hook wire format (`CliCommand::EmitEvent`,
//! `InternalAdapter`); legacy sites that still construct one convert at the
//! boundary via `From<FredoEvent> for EngineInput` and behave identically (R4).

use serde::{Deserialize, Serialize};

use crate::infrastructure::comm::event::{
    EventProvider, EventState, EventType, FredoEvent, FredoEventError, Transport,
};

/// The ECE's input contract — replaces `FredoEvent` at the engine boundary.
///
/// Serialized camelCase, exactly matching the surface `extract_field` and the
/// typed reads in engine.rs rely on. `id`/`timestamp` are dropped (never
/// consumed by the engine).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInput {
    pub state: EventState,        // PascalCase: Init|Update|Response|Error
    pub provider: EventProvider,  // snake_case as_str (event.rs:70-77)
    pub transport: Transport,     // snake_case as_str — OtlpGrpc => "otlp_grpc"
    pub event_type: EventType,    // snake_case as_str (event.rs:46-55)
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FredoEventError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>, // relationship metadata (Spec #523)
}

/// Shim: any still-constructing path (CLI EmitEvent, InternalAdapter, tests)
/// converts at the boundary — nothing else changes.
impl From<FredoEvent> for EngineInput {
    fn from(e: FredoEvent) -> Self {
        EngineInput {
            state: e.state,
            provider: e.provider,
            transport: e.transport,
            event_type: e.event_type,
            session_id: e.session_id,
            correlation_id: e.correlation_id,
            tool_name: e.tool_name,
            payload: e.payload,
            error: e.error,
            metadata: e.metadata,
        }
    }
}
