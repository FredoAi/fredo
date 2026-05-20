/// mapping.rs — translates OTLP protobuf payloads into StreamEvents.
///
/// Both the gRPC and HTTP receivers call into this module so the conversion
/// logic lives in one place.
use chrono::Utc;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::infrastructure::events::{
    EventSource, EventState, OtlpPayload, OtlpSignal, StreamEvent,
};

// ── Attribute extraction helpers ──────────────────────────────────────────────

use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};

pub fn kv_to_json(kvs: &[KeyValue]) -> Value {
    let mut map = Map::new();
    for kv in kvs {
        if let Some(v) = &kv.value {
            map.insert(kv.key.clone(), anyvalue_to_json(v));
        }
    }
    Value::Object(map)
}

fn anyvalue_to_json(av: &AnyValue) -> Value {
    match &av.value {
        Some(any_value::Value::StringValue(s)) => Value::String(s.clone()),
        Some(any_value::Value::BoolValue(b))   => Value::Bool(*b),
        Some(any_value::Value::IntValue(i))    => json!(i),
        Some(any_value::Value::DoubleValue(d)) => json!(d),
        Some(any_value::Value::BytesValue(b))  => Value::String(base64_encode(b)),
        Some(any_value::Value::ArrayValue(a))  => {
            Value::Array(a.values.iter().map(anyvalue_to_json).collect())
        }
        Some(any_value::Value::KvlistValue(kv)) => kv_to_json(&kv.values),
        None => Value::Null,
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::new();
    for b in bytes {
        write!(s, "{:02x}", b).ok();
    }
    s
}

// ── Session ID extraction ─────────────────────────────────────────────────────

/// Pull session ID out of a flat attribute map.
/// Copilot CLI uses `gen_ai.conversation.id`; falls back to `session.id`, then a fresh UUID.
pub fn session_id_from_attrs(attrs: &Value) -> String {
    attrs
        .get("gen_ai.conversation.id")
        .and_then(|v| v.as_str())
        .or_else(|| attrs.get("session.id").and_then(|v| v.as_str()))
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

/// Pull `service.name` out of resource attributes, falling back to `"unknown"`.
pub fn service_name_from_attrs(attrs: &Value) -> String {
    attrs
        .get("service.name")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| "unknown".to_owned())
}

// ── StreamEvent constructors ──────────────────────────────────────────────────

fn base_otlp_event(
    signal: OtlpSignal,
    source: EventSource,
    tool_name: String,
    session_id: String,
    attributes: Value,
) -> StreamEvent {
    StreamEvent {
        tool_name,
        session_id,
        state: EventState::Response,
        source,
        input: None,
        response: None,
        data: None,
        timestamp: Utc::now().to_rfc3339(),
        event_id: Some(Uuid::new_v4().to_string()),
        correlation_id: None,
        error: None,
        otlp: Some(OtlpPayload { signal, attributes }),
    }
}

// ── Span mapping ──────────────────────────────────────────────────────────────

use opentelemetry_proto::tonic::trace::v1::ResourceSpans;

/// Normalize a raw span name to a canonical operation name.
/// Allowed: chat, invoke_agent, execute_tool, permission, elicitation.
/// `chat` spans carry gen_ai.input/output.messages (message content) — the FE
/// caches their content and drops them as nodes; invoke_agent reads the cache.
pub fn normalize_op_name(name: &str) -> Option<&'static str> {
    for op in &["chat", "invoke_agent", "execute_tool", "permission", "elicitation"] {
        if name == *op || name.starts_with(&format!("{} ", op)) {
            return Some(op);
        }
    }
    None
}

pub fn resource_spans_to_events(
    resource_spans: Vec<ResourceSpans>,
    source: EventSource,
) -> Vec<StreamEvent> {
    let mut events = Vec::new();

    for rs in resource_spans {
        // Collect resource attributes (shared by all spans in this resource)
        let res_attrs = rs
            .resource
            .as_ref()
            .map(|r| kv_to_json(&r.attributes))
            .unwrap_or(Value::Object(Map::new()));

        // ── Pass 1: build a trace_id → conversation_id map ────────────────────
        // execute_tool spans don't carry gen_ai.conversation.id, but they share
        // the same trace as their parent invoke_agent span which does.  We use
        // this map so all spans in a trace end up in the same session.
        let mut trace_to_conv: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for scope_spans in &rs.scope_spans {
            for span in &scope_spans.spans {
                let span_attrs = kv_to_json(&span.attributes);
                if let Some(conv_id) = span_attrs
                    .get("gen_ai.conversation.id")
                    .and_then(|v| v.as_str())
                {
                    if !span.trace_id.is_empty() {
                        let trace_hex: String =
                            span.trace_id.iter().map(|b| format!("{:02x}", b)).collect();
                        trace_to_conv.entry(trace_hex).or_insert_with(|| conv_id.to_owned());
                    }
                }
            }
        }

        // ── Pass 2: emit StreamEvents ──────────────────────────────────────────
        for scope_spans in rs.scope_spans {
            for span in scope_spans.spans {
                let mut attrs = res_attrs.clone();
                if let Value::Object(ref mut map) = attrs {
                    if let Value::Object(span_attrs) = kv_to_json(&span.attributes) {
                        map.extend(span_attrs);
                    }
                    map.insert("span.name".to_string(), Value::String(span.name.clone()));
                    map.insert("span.kind".to_string(), json!(span.kind));
                }

                // Canonical op name: only invoke_agent and execute_tool reach the UI
                let op_name: &str = if let Some(op) = attrs
                    .get("gen_ai.operation.name")
                    .and_then(|v| v.as_str())
                    .and_then(normalize_op_name)
                {
                    op
                } else if let Some(op) = normalize_op_name(&span.name) {
                    op
                } else {
                    continue; // chat, metrics, unknown — drop
                };

                // Session: span's own conversation.id → trace-level conversation.id
                //          → raw trace_id hex → fresh UUID
                let trace_hex: String =
                    span.trace_id.iter().map(|b| format!("{:02x}", b)).collect();
                let session_id = attrs
                    .get("gen_ai.conversation.id")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .or_else(|| trace_to_conv.get(&trace_hex).cloned())
                    .unwrap_or_else(|| {
                        if !trace_hex.is_empty() {
                            trace_hex.clone()
                        } else {
                            Uuid::new_v4().to_string()
                        }
                    });

                // DEBUG: log every invoke_agent span's full attribute set so we can
                // see exactly what Copilot CLI sends (remove once content capture is verified)
                if op_name == "invoke_agent" {
                    eprintln!(
                        "[fredo-otlp/DEBUG] invoke_agent attrs keys: {:?}",
                        attrs.as_object().map(|m| m.keys().collect::<Vec<_>>()).unwrap_or_default()
                    );
                    // Print a few key values
                    for key in &["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.conversation.id", "gen_ai.request.model"] {
                        eprintln!(
                            "[fredo-otlp/DEBUG]   {key} = {:?}",
                            attrs.get(*key)
                        );
                    }
                }

                events.push(base_otlp_event(
                    OtlpSignal::Span,
                    source.clone(),
                    op_name.to_owned(),
                    session_id,
                    attrs,
                ));
            }
        }
    }

    events
}

// ── Metric mapping ────────────────────────────────────────────────────────────

use opentelemetry_proto::tonic::metrics::v1::ResourceMetrics;

pub fn resource_metrics_to_events(
    _resource_metrics: Vec<ResourceMetrics>,
    _source: EventSource,
) -> Vec<StreamEvent> {
    // Metrics are not used by any UI feature — drop them at the source.
    Vec::new()
}

// ── Log mapping ───────────────────────────────────────────────────────────────

use opentelemetry_proto::tonic::logs::v1::ResourceLogs;

pub fn resource_logs_to_events(
    _resource_logs: Vec<ResourceLogs>,
    _source: EventSource,
) -> Vec<StreamEvent> {
    // Logs are not used by any UI feature — drop them at the source.
    Vec::new()
}
