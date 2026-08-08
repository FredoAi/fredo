//! raw.rs — Raw OTLP span ingestion converter (Spec #2449, Capsule S3).
//!
//! Ends the span-loss class (R1): converts every OTLP span from an
//! `ExportTraceServiceRequest` (the tonic protobuf types the gRPC :4317 and
//! HTTP :4318 receivers already deserialize — see `grpc.rs`) into a
//! [`RawSpan`] that carries the raw OTLP identity: real hex `trace_id` /
//! `span_id` / `parent_span_id`, the raw span name as received, times, mapped
//! status, merged resource+span attributes, and persisted classification
//! columns (`provider`, `transport`, `event_type`).
//!
//! The raw OTLP `span_id` is the row identity (`telemetry_spans.span_id`
//! PRIMARY KEY), so two distinct spans never collide (R4). The receivers
//! persist these rows immediately on receipt, before and independent of any
//! delivery processing (Tempo/Loki/Prometheus-style ingestion).
//!
//! Provider-agnostic by construction: classification reads the OTel GenAI
//! semantic-convention registry keys (`gen_ai.operation.name`,
//! `gen_ai.provider.name`, `gen_ai.conversation.id`) with no `fredo.*`
//! span-name dependency — any OTLP emitter works identically.

use chrono::Utc;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::trace::v1 as otlp_trace;

/// A raw OTLP span normalized to the `telemetry_spans` row shape.
///
/// Field-for-field matches the `telemetry_spans` schema (span_store.rs) so a
/// batch insert is a direct column mapping; the OTLP `span_id` is preserved
/// verbatim as the PRIMARY KEY identity.
#[derive(Debug, Clone)]
pub struct RawSpan {
    /// Hex of `span.trace_id` (falls back to the resolved session id when the
    /// OTLP trace_id is empty).
    pub trace_id: String,
    /// Hex of `span.span_id` — the row identity (PRIMARY KEY).
    pub span_id: String,
    /// Hex of `span.parent_span_id` (`None` when empty).
    pub parent_span_id: Option<String>,
    /// Raw OTLP span name as received (e.g. `fredo.tool.Bash`, `my.llm`).
    pub span_name: String,
    /// Mapped OTLP `SpanKind` (`INTERNAL`/`SERVER`/`CLIENT`/`PRODUCER`/`CONSUMER`).
    pub span_kind: String,
    /// `span.start_time_unix_nano` (nanoseconds).
    pub start_time_ns: i64,
    /// `span.end_time_unix_nano` (`None` for in-flight spans with end time 0).
    pub end_time_ns: Option<i64>,
    /// Mapped OTLP status code (`UNSET`/`OK`/`ERROR`).
    pub status_code: String,
    /// `span.status.message`.
    pub status_message: Option<String>,
    /// Resolved session id: `session.id` → `gen_ai.conversation.id` →
    /// trace_id hex → `"unknown"`.
    pub session_id: String,
    /// Merged resource + span attributes (all keys verbatim), JSON object.
    pub attributes_json: Option<String>,
    /// `span.events` serialized as a JSON array (camelCase, `None` when empty).
    pub events_json: Option<String>,
    /// `gen_ai.provider.name` → flat `provider` → resource `service.name` →
    /// `"unknown"`.
    pub provider: Option<String>,
    /// `"otlp_grpc"` / `"otlp_http"` (preserved transport names).
    pub transport: Option<String>,
    /// Canonical event type (`chat`/`agent_session`/`tool_use`) classified from
    /// `gen_ai.operation.name` registry values with generic name heuristics.
    pub event_type: Option<String>,
    /// `Utc::now()` RFC3339 — ingestion time.
    pub ingested_at: String,
}

impl RawSpan {
    /// Map a single OTLP span to a [`RawSpan`] using merged resource + span
    /// attributes (span attributes win on key conflicts).
    pub fn from_proto(
        span: &otlp_trace::Span,
        resource_attrs: &[KeyValue],
        transport: &str,
        ingested_at: &str,
    ) -> RawSpan {
        // Merge resource attributes + span attributes, all keys verbatim.
        let mut merged = attrs_to_map(resource_attrs);
        for (k, v) in attrs_to_map(&span.attributes) {
            merged.insert(k, v);
        }

        let op_name = merged
            .get("gen_ai.operation.name")
            .and_then(|v| v.as_str());

        // Session id resolution: session.id → gen_ai.conversation.id → trace_id.
        let session_attr = merged
            .get("session.id")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| {
                merged
                    .get("gen_ai.conversation.id")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            });
        let trace_id_hex = if span.trace_id.is_empty() {
            String::new()
        } else {
            bytes_to_hex(&span.trace_id)
        };
        let session_id = session_attr
            .clone()
            .or_else(|| {
                if trace_id_hex.is_empty() {
                    None
                } else {
                    Some(trace_id_hex.clone())
                }
            })
            .unwrap_or_else(|| "unknown".to_string());

        // Provider: gen_ai.provider.name → flat provider → resource service.name.
        let provider = merged
            .get("gen_ai.provider.name")
            .and_then(|v| v.as_str())
            .or_else(|| merged.get("provider").and_then(|v| v.as_str()))
            .or_else(|| {
                resource_attrs
                    .iter()
                    .find(|kv| kv.key == "service.name")
                    .and_then(|kv| match kv.value.as_ref().and_then(|v| v.value.as_ref()) {
                        Some(any_value::Value::StringValue(s)) => Some(s.as_str()),
                        _ => None,
                    })
            })
            .unwrap_or("unknown")
            .to_string();

        let attributes_json = if merged.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(merged.clone()).to_string())
        };

        let events_json = if span.events.is_empty() {
            None
        } else {
            serde_json::to_string(&span.events).ok()
        };

        RawSpan {
            trace_id: if trace_id_hex.is_empty() {
                session_id.clone()
            } else {
                trace_id_hex
            },
            span_id: bytes_to_hex(&span.span_id),
            parent_span_id: if span.parent_span_id.is_empty() {
                None
            } else {
                Some(bytes_to_hex(&span.parent_span_id))
            },
            span_name: span.name.clone(),
            span_kind: span_kind_str(span.kind).to_string(),
            start_time_ns: span.start_time_unix_nano as i64,
            end_time_ns: if span.end_time_unix_nano == 0 {
                None
            } else {
                Some(span.end_time_unix_nano as i64)
            },
            status_code: status_code_str(span.status.as_ref().map(|s| s.code).unwrap_or(0))
                .to_string(),
            status_message: span.status.as_ref().and_then(|s| {
                if s.message.is_empty() {
                    None
                } else {
                    Some(s.message.clone())
                }
            }),
            session_id,
            attributes_json,
            events_json,
            provider: Some(provider),
            transport: Some(transport.to_string()),
            event_type: Some(classify_event_type(op_name, &span.name)),
            ingested_at: ingested_at.to_string(),
        }
    }
}

/// Convert every span in an OTLP trace export to a [`RawSpan`].
///
/// Returns one `RawSpan` per OTLP span in the export — nothing is dropped
/// (R1). Handles the standard OTLP `resourceSpans → scopeSpans → spans`
/// envelope. Callers pass the preserved transport name (`"otlp_grpc"` /
/// `"otlp_http"`).
pub fn raw_spans_from_export(
    request: &ExportTraceServiceRequest,
    transport: &str,
) -> Vec<RawSpan> {
    let now = Utc::now().to_rfc3339();
    let mut spans = Vec::new();
    for rs in &request.resource_spans {
        let resource_attrs: Vec<KeyValue> = rs
            .resource
            .as_ref()
            .map(|r| r.attributes.clone())
            .unwrap_or_default();
        for scope in &rs.scope_spans {
            for span in &scope.spans {
                spans.push(RawSpan::from_proto(span, &resource_attrs, transport, &now));
            }
        }
    }
    spans
}

/// Convert an OTLP `AnyValue` to a serde_json value (mirrors grpc.rs).
fn any_value_to_json(value: &Option<AnyValue>) -> serde_json::Value {
    use any_value::Value as AnyVal;
    match value.as_ref().and_then(|v| v.value.as_ref()) {
        Some(AnyVal::StringValue(s)) => serde_json::Value::String(s.clone()),
        Some(AnyVal::BoolValue(b)) => serde_json::Value::Bool(*b),
        Some(AnyVal::IntValue(i)) => serde_json::json!(*i),
        Some(AnyVal::DoubleValue(d)) => serde_json::json!(*d),
        Some(AnyVal::BytesValue(b)) => serde_json::Value::String(bytes_to_hex(b)),
        Some(AnyVal::ArrayValue(arr)) => {
            let vals = arr
                .values
                .iter()
                .map(|v| any_value_to_json(&Some(v.clone())))
                .collect();
            serde_json::Value::Array(vals)
        }
        Some(AnyVal::KvlistValue(kv)) => {
            let mut map = serde_json::Map::new();
            for kv in &kv.values {
                map.insert(kv.key.clone(), any_value_to_json(&kv.value));
            }
            serde_json::Value::Object(map)
        }
        None => serde_json::Value::Null,
    }
}

/// Convert OTLP attributes to a JSON object map (all keys verbatim).
fn attrs_to_map(attrs: &[KeyValue]) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    for kv in attrs {
        map.insert(kv.key.clone(), any_value_to_json(&kv.value));
    }
    map
}

/// Small hex encoder (no external hex dependency in this crate).
fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Map OTLP `SpanKind` (i32 enum) to the persisted span_kind string.
fn span_kind_str(kind: i32) -> &'static str {
    match kind {
        1 => "INTERNAL",
        2 => "SERVER",
        3 => "CLIENT",
        4 => "PRODUCER",
        5 => "CONSUMER",
        _ => "UNSPECIFIED",
    }
}

/// Map OTLP status code (i32 enum) to the persisted status_code string.
fn status_code_str(code: i32) -> &'static str {
    match code {
        1 => "OK",
        2 => "ERROR",
        _ => "UNSET",
    }
}

/// Canonical `event_type` classification (R5/R6): `gen_ai.operation.name`
/// registry values first (`run_agent`→`agent_session`, `chat`→`chat`,
/// `execute_tool`→`tool_use`), then generic span-name heuristics — NO
/// `fredo.*` patterns.
fn classify_event_type(op_name: Option<&str>, span_name: &str) -> String {
    let op = op_name.unwrap_or("").trim();
    match op {
        "run_agent" | "session" => "agent_session",
        "chat" | "invoke_agent" => "chat",
        "execute_tool" | "permission" | "elicitation" => "tool_use",
        _ => {
            let lower = span_name.to_ascii_lowercase();
            if lower.contains("session") {
                "agent_session"
            } else if lower.contains("tool") {
                "tool_use"
            } else {
                "chat"
            }
        }
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::any_value;
    use opentelemetry_proto::tonic::trace::v1::span::Event;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span as OtlpSpan, Status};

    fn kv(key: &str, value: any_value::Value) -> KeyValue {
        KeyValue {
            key: key.to_string(),
            value: Some(AnyValue { value: Some(value) }),
        }
    }

    fn span_with(
        name: &str,
        span_id: [u8; 8],
        trace_id: Vec<u8>,
        parent_span_id: Vec<u8>,
        attrs: Vec<KeyValue>,
    ) -> OtlpSpan {
        OtlpSpan {
            name: name.to_string(),
            span_id: span_id.to_vec(),
            trace_id,
            parent_span_id,
            attributes: attrs,
            ..Default::default()
        }
    }

    fn export(spans: Vec<OtlpSpan>) -> ExportTraceServiceRequest {
        ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: None,
                scope_spans: vec![ScopeSpans {
                    scope: None,
                    spans,
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    #[test]
    fn raw_spans_from_export_maps_every_span() {
        // R1: one RawSpan per OTLP span, none dropped.
        let request = export(vec![
            span_with(
                "fredo.session",
                [0xAA; 8],
                vec![0x01; 16],
                Vec::new(), // root span — no parent
                vec![
                    kv(
                        "gen_ai.operation.name",
                        any_value::Value::StringValue("run_agent".to_string()),
                    ),
                    kv(
                        "gen_ai.provider.name",
                        any_value::Value::StringValue("open-code".to_string()),
                    ),
                    kv("session.id", any_value::Value::StringValue("sess-raw-1".to_string())),
                ],
            ),
            span_with(
                "fredo.tool.Bash",
                [0xBB; 8],
                vec![0x02; 16],
                [0xAA; 8].to_vec(),
                vec![
                    kv(
                        "gen_ai.operation.name",
                        any_value::Value::StringValue("execute_tool".to_string()),
                    ),
                    kv("session.id", any_value::Value::StringValue("sess-raw-1".to_string())),
                ],
            ),
        ]);

        let spans = raw_spans_from_export(&request, "otlp_grpc");
        assert_eq!(spans.len(), 2, "every span in the export must map (R1)");

        let session = &spans[0];
        assert_eq!(session.span_id, "aaaaaaaaaaaaaaaa", "raw OTLP span_id is row identity");
        assert_eq!(session.trace_id, "01010101010101010101010101010101");
        assert_eq!(session.parent_span_id, None);
        assert_eq!(session.span_name, "fredo.session", "raw span name preserved");
        assert_eq!(session.session_id, "sess-raw-1");
        assert_eq!(session.provider.as_deref(), Some("open-code"));
        assert_eq!(session.transport.as_deref(), Some("otlp_grpc"));
        assert_eq!(session.event_type.as_deref(), Some("agent_session"));

        let tool = &spans[1];
        assert_eq!(tool.span_id, "bbbbbbbbbbbbbbbb");
        assert_eq!(tool.parent_span_id.as_deref(), Some("aaaaaaaaaaaaaaaa"));
        assert_eq!(tool.event_type.as_deref(), Some("tool_use"));
        assert_eq!(tool.span_kind, "UNSPECIFIED");
    }

    #[test]
    fn raw_span_maps_status_kind_and_times() {
        let mut span = span_with(
            "my.llm",
            [0xCC; 8],
            vec![0x03; 16],
            Vec::new(),
            vec![kv(
                "gen_ai.operation.name",
                any_value::Value::StringValue("chat".to_string()),
            )],
        );
        span.kind = 2; // SPAN_KIND_SERVER
        span.start_time_unix_nano = 1_000_000_000;
        span.end_time_unix_nano = 2_000_000_000;
        span.status = Some(Status {
            code: 2,
            message: "agent crashed".to_string(),
        });
        span.events = vec![Event {
            time_unix_nano: 1_500_000_000,
            name: "gen_ai.message".to_string(),
            attributes: Vec::new(),
            dropped_attributes_count: 0,
        }];

        let raw = RawSpan::from_proto(&span, &[], "otlp_http", "2026-08-08T00:00:00+00:00");
        assert_eq!(raw.span_name, "my.llm");
        assert_eq!(raw.span_kind, "SERVER");
        assert_eq!(raw.start_time_ns, 1_000_000_000);
        assert_eq!(raw.end_time_ns, Some(2_000_000_000));
        assert_eq!(raw.status_code, "ERROR");
        assert_eq!(raw.status_message.as_deref(), Some("agent crashed"));
        assert_eq!(raw.event_type.as_deref(), Some("chat"));
        assert_eq!(raw.transport.as_deref(), Some("otlp_http"));
        let events: serde_json::Value = serde_json::from_str(raw.events_json.as_deref().unwrap()).unwrap();
        assert_eq!(events[0]["name"], "gen_ai.message");
        assert!(raw.attributes_json.is_some());
    }

    #[test]
    fn raw_span_resolves_session_and_provider_fallbacks() {
        // Provider falls back to resource service.name; session to conversation id.
        let span = span_with(
            "my.llm",
            [0xDD; 8],
            Vec::new(), // empty trace_id → session fallback used for trace_id too
            Vec::new(),
            vec![kv(
                "gen_ai.conversation.id",
                any_value::Value::StringValue("conv-raw".to_string()),
            )],
        );
        let resource_attrs = vec![kv(
            "service.name",
            any_value::Value::StringValue("copilot-cli".to_string()),
        )];

        let raw = RawSpan::from_proto(&span, &resource_attrs, "otlp_grpc", "2026-08-08T00:00:00+00:00");
        assert_eq!(raw.session_id, "conv-raw");
        assert_eq!(raw.trace_id, "conv-raw", "empty trace_id falls back to session");
        assert_eq!(raw.provider.as_deref(), Some("copilot-cli"));

        let attrs: serde_json::Value = serde_json::from_str(raw.attributes_json.as_deref().unwrap()).unwrap();
        assert_eq!(attrs["service.name"], "copilot-cli");
        assert_eq!(attrs["gen_ai.conversation.id"], "conv-raw");
    }

    #[test]
    fn raw_span_inflight_has_no_end_time() {
        // No session attribute → session falls back to the trace_id hex.
        let span = span_with("my.llm", [0xEE; 8], [0x04; 16].to_vec(), Vec::new(), Vec::new());
        let raw = RawSpan::from_proto(&span, &[], "otlp_grpc", "2026-08-08T00:00:00+00:00");
        assert_eq!(raw.end_time_ns, None, "in-flight span has no end time");
        assert_eq!(raw.status_code, "UNSET", "no status → UNSET");
        assert_eq!(raw.session_id, "04040404040404040404040404040404", "session falls back to trace_id");
    }

    #[test]
    fn empty_export_yields_no_spans() {
        let spans = raw_spans_from_export(&ExportTraceServiceRequest {
            resource_spans: Vec::new(),
        }, "otlp_grpc");
        assert!(spans.is_empty());
    }
}
