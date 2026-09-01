//! RTDB subscription delivery envelope + patch projector (Spec #2788, P2.2).
//!
//! [`RowDelivery`] is the patch envelope P2.3 emits over IPC: one row
//! mutation, projected for ONE query. [`project_patch`] builds the patch
//! payload as the intersection of the query's selection paths and the row's
//! CHANGED fields (the camelCase names of the fields present in the applied
//! P1.1 `merge.rs` patch, passed in by the caller):
//!
//! - `Insert` — the key ENTERED the query's result set: the patch carries the
//!   full merged row (all fields; respecting a subset selection if the query
//!   selected one).
//! - `Update` — the patch carries ONLY changed+selected fields, read from the
//!   POST-merge row snapshot, so patch values are the current merged values.
//! - `Remove` — retention eviction: patch is `None` (produced exclusively by
//!   the registry's `match_removal`; binding decision, P2.2).
//!
//! Patch keys match row field names by construction: the snapshot is
//! serialized with the rows.rs serde shape (camelCase), never re-keyed.
//! Patch paths mirror the selection path shape (a multi-segment selection
//! path nests; canonical rows are flat, so paths are single-segment in
//! practice and unresolvable paths are skipped).

use crate::infrastructure::rtdb::query::EventTypeArg;
use crate::infrastructure::rtdb::rows::{AgentSessionRow, ChatRow, ToolUseRow};
use serde::{Deserialize, Serialize};

/// Composite row identity — mirrors the store key
/// (`{ session_id, correlation_id }`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowKey {
    pub session_id: String,
    pub correlation_id: String,
}

/// What happened to a key in a query's result set. `Remove` is produced ONLY
/// by [`crate::infrastructure::rtdb::subscriptions::SubscriptionRegistry::
/// match_removal`] (retention eviction) — binding decision, P2.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RowChangeKind {
    Insert,
    Update,
    Remove,
}

/// The patch delivery envelope P2.3 emits (one per matching query per
/// mutation). `seq` is the row's durable per-key monotonic sequence carried
/// from the row snapshot (and the last delivered seq on removals).
/// `Deserialize` supports the batch-envelope serde round-trip test (F-33 W-1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDelivery {
    pub query_id: String,
    pub event_type: EventTypeArg,
    pub kind: RowChangeKind,
    pub seq: i64,
    pub key: RowKey,
    /// Changed+selected fields only on update; full row on insert; `None` on
    /// remove. Keys are the row's camelCase field names.
    pub patch: Option<serde_json::Value>,
    /// RFC3339 emission time.
    pub timestamp: String,
}

/// Wire envelope for BATCHED RowDelivery emission (Spec #2788 F-33 fix, W-1).
/// ONE "fredo-stream-event" IPC event per flush chunk carries this envelope —
/// camelCase `rowBatch` field discriminates it from single-delivery envelopes
/// (the frontend `isRowDeliveryBatch` validator checks this exact field;
/// single-delivery v1 consumers are unaffected). Ownership is a plain `Vec`:
/// emission chunks are ≤ [`crate::infrastructure::rtdb::flush::
/// RTDB_MAX_EMISSION_BATCH`] rows, so the per-chunk copy is negligible.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDeliveryBatch {
    pub row_batch: Vec<RowDelivery>,
}

/// Borrowed view of one stored row — the matcher/projector input. The variant
/// must agree with the `EventTypeArg` routed through the registry
/// (`Chat` ↔ [`ChatRow`], `ToolUse` ↔ [`ToolUseRow`],
/// `AgentSession` ↔ [`AgentSessionRow`]).
#[derive(Clone, Debug)]
pub enum RowSnapshot<'a> {
    Chat(&'a ChatRow),
    ToolUse(&'a ToolUseRow),
    AgentSession(&'a AgentSessionRow),
}

impl RowSnapshot<'_> {
    /// The row's durable per-key monotonic sequence — carried on deliveries.
    pub fn seq(&self) -> i64 {
        match self {
            RowSnapshot::Chat(row) => row.seq,
            RowSnapshot::ToolUse(row) => row.seq,
            RowSnapshot::AgentSession(row) => row.seq,
        }
    }

    /// Serialize the row with the rows.rs serde shape (camelCase keys — patch
    /// keys match row field names by construction). These structs are plain
    /// data; serialization cannot fail in practice.
    pub fn to_row_json(&self) -> serde_json::Value {
        match self {
            RowSnapshot::Chat(row) => serde_json::to_value(row),
            RowSnapshot::ToolUse(row) => serde_json::to_value(row),
            RowSnapshot::AgentSession(row) => serde_json::to_value(row),
        }
        .unwrap_or_else(|_| serde_json::Value::Null)
    }
}

/// RFC3339 "now" — the established `chrono::Utc::now().to_rfc3339()` pattern.
pub fn rfc3339_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Project the patch for one mutation of `snapshot` against `selection`.
///
/// `changed_fields` holds the camelCase names of the fields present in the
/// applied P1.1 patch (the caller knows its own merge input). Returns `None`
/// for `Remove`. An `Update` with no changed fields yields an empty object —
/// callers should not emit one.
pub fn project_patch(
    snapshot: &RowSnapshot,
    selection: &[Vec<String>],
    kind: RowChangeKind,
    changed_fields: &[String],
) -> Option<serde_json::Value> {
    if kind == RowChangeKind::Remove {
        return None;
    }
    let row = snapshot.to_row_json();
    let obj = row.as_object()?;

    let mut out = serde_json::Map::new();
    match kind {
        RowChangeKind::Insert => {
            // Full row (all fields), respecting a subset selection.
            if selection.is_empty() {
                for (name, value) in obj {
                    out.insert(name.clone(), value.clone());
                }
            } else {
                for path in selection {
                    if let Some(value) = resolve_path(&row, path) {
                        insert_path(&mut out, path, value.clone());
                    }
                }
            }
        }
        RowChangeKind::Update => {
            // Intersection of the selection paths and the changed fields.
            if selection.is_empty() {
                for (name, value) in obj {
                    if changed_fields.iter().any(|field| field == name) {
                        out.insert(name.clone(), value.clone());
                    }
                }
            } else {
                for path in selection {
                    let Some(top) = path.first() else { continue };
                    if !changed_fields.iter().any(|field| field == top) {
                        continue;
                    }
                    if let Some(value) = resolve_path(&row, path) {
                        insert_path(&mut out, path, value.clone());
                    }
                }
            }
        }
        // Handled above; unreachable here.
        RowChangeKind::Remove => return None,
    }
    Some(serde_json::Value::Object(out))
}

/// Resolve a camelCase path (row field names) inside a serialized row.
fn resolve_path<'v>(
    value: &'v serde_json::Value,
    path: &[String],
) -> Option<&'v serde_json::Value> {
    let mut current = value;
    for segment in path {
        current = current.get(segment.as_str())?;
    }
    Some(current)
}

/// Insert `value` at `path` in `out`, creating intermediate objects for
/// multi-segment paths (selection paths mirror this shape on output).
fn insert_path(
    out: &mut serde_json::Map<String, serde_json::Value>,
    path: &[String],
    value: serde_json::Value,
) {
    if path.len() == 1 {
        out.insert(path[0].clone(), value);
        return;
    }
    let Some(first) = path.first() else { return };
    let entry = out
        .entry(first.clone())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if let serde_json::Value::Object(map) = entry {
        insert_path(map, &path[1..], value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::rtdb::rows::{CHAT_FIELDS, RowState};
    use serde_json::json;

    fn chat_row(seq: i64, agent_reply: Option<&str>) -> ChatRow {
        ChatRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a_1".to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:00Z".to_string(),
            state: RowState::Init,
            user_message: Some("fix the bug".to_string()),
            agent_reply: agent_reply.map(str::to_string),
            prompt_tokens: Some(25),
            completion_tokens: None,
            cache_read_tokens: None,
            cost_usd: None,
            model: None,
            parent_session_id: None,
            composited_child_session_id: None,
            raw_json: "{}".to_string(),
        }
    }

    fn names(selection: &[&str]) -> Vec<Vec<String>> {
        selection
            .iter()
            .map(|field| vec![field.to_string()])
            .collect()
    }

    fn changed(fields: &[&str]) -> Vec<String> {
        fields.iter().map(|field| field.to_string()).collect()
    }

    #[test]
    fn insert_without_selection_is_the_full_row_camel_case() {
        let row = chat_row(1, Some("reply"));
        let patch =
            project_patch(&RowSnapshot::Chat(&row), &[], RowChangeKind::Insert, &[]).expect("patch");
        let obj = patch.as_object().expect("object");
        for field in CHAT_FIELDS {
            assert!(obj.contains_key(*field), "insert patch missing {field}");
        }
        assert_eq!(obj.get("seq"), Some(&json!(1)));
        assert_eq!(obj.get("userMessage"), Some(&json!("fix the bug")));
        assert_eq!(obj.get("agentReply"), Some(&json!("reply")));
    }

    #[test]
    fn insert_with_selection_is_the_selected_subset() {
        let row = chat_row(1, Some("reply"));
        let selection = names(&["userMessage", "seq"]);
        let patch = project_patch(
            &RowSnapshot::Chat(&row),
            &selection,
            RowChangeKind::Insert,
            &[],
        )
        .expect("patch");
        let obj = patch.as_object().expect("object");
        assert_eq!(obj.len(), 2);
        assert_eq!(obj.get("userMessage"), Some(&json!("fix the bug")));
        assert_eq!(obj.get("seq"), Some(&json!(1)));
        assert!(!obj.contains_key("agentReply"));
    }

    #[test]
    fn update_carries_only_changed_fields() {
        let row = chat_row(2, Some("fuller reply"));
        let patch = project_patch(
            &RowSnapshot::Chat(&row),
            &[],
            RowChangeKind::Update,
            &changed(&["agentReply", "seq"]),
        )
        .expect("patch");
        let obj = patch.as_object().expect("object");
        assert_eq!(obj.len(), 2, "only changed fields are projected");
        assert_eq!(obj.get("agentReply"), Some(&json!("fuller reply")));
        assert_eq!(obj.get("seq"), Some(&json!(2)));
        assert!(!obj.contains_key("userMessage"));
    }

    #[test]
    fn update_patch_is_selection_and_changed_intersection() {
        let row = chat_row(2, Some("fuller reply"));
        let selection = names(&["agentReply", "promptTokens", "model"]);
        let patch = project_patch(
            &RowSnapshot::Chat(&row),
            &selection,
            RowChangeKind::Update,
            &changed(&["agentReply", "promptTokens"]),
        )
        .expect("patch");
        let obj = patch.as_object().expect("object");
        assert_eq!(obj.len(), 2);
        assert!(obj.contains_key("agentReply"));
        assert!(obj.contains_key("promptTokens"));
        assert!(!obj.contains_key("model"), "selected but unchanged → excluded");
    }

    #[test]
    fn update_with_no_changed_fields_is_empty_object() {
        let row = chat_row(2, Some("reply"));
        let patch = project_patch(
            &RowSnapshot::Chat(&row),
            &[],
            RowChangeKind::Update,
            &changed(&[]),
        )
        .expect("patch");
        assert_eq!(patch.as_object().expect("object").len(), 0);
    }

    #[test]
    fn remove_projects_none() {
        let row = chat_row(3, None);
        assert_eq!(
            project_patch(&RowSnapshot::Chat(&row), &[], RowChangeKind::Remove, &[]),
            None
        );
    }

    #[test]
    fn unresolvable_selection_paths_are_skipped() {
        let row = chat_row(2, Some("reply"));
        let selection = vec![vec!["agentReply".to_string()], vec!["nested".to_string(), "deep".to_string()]];
        let patch = project_patch(
            &RowSnapshot::Chat(&row),
            &selection,
            RowChangeKind::Insert,
            &[],
        )
        .expect("patch");
        let obj = patch.as_object().expect("object");
        assert_eq!(obj.len(), 1);
        assert!(obj.contains_key("agentReply"));
    }

    #[test]
    fn tool_and_session_snapshots_project_their_own_fields() {
        let tool = ToolUseRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a_2".to_string(),
            seq: 4,
            started_at_ns: None,
            ended_at_ns: None,
            updated_at: "t".to_string(),
            state: RowState::Update,
            tool_name: Some("bash".to_string()),
            tool_success: Some(false),
            tool_error: None,
            duration_ms: Some(120),
            tool_input_json: None,
            tool_output_json: None,
            is_subagent: None,
            raw_json: "{}".to_string(),
        };
        let patch = project_patch(
            &RowSnapshot::ToolUse(&tool),
            &[],
            RowChangeKind::Insert,
            &[],
        )
        .expect("patch");
        let obj = patch.as_object().expect("object");
        assert_eq!(obj.get("toolName"), Some(&json!("bash")));
        assert_eq!(obj.get("toolSuccess"), Some(&json!(false)));

        let session = AgentSessionRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a".to_string(),
            seq: 5,
            started_at_ns: None,
            ended_at_ns: None,
            updated_at: "t".to_string(),
            state: RowState::Update,
            total_tokens: Some(59_200),
            total_messages: None,
            total_cost_usd: None,
            agent_name: None,
            raw_json: "{}".to_string(),
        };
        let patch = project_patch(
            &RowSnapshot::AgentSession(&session),
            &[],
            RowChangeKind::Insert,
            &[],
        )
        .expect("patch");
        assert_eq!(
            patch.get("totalTokens"),
            Some(&json!(59_200)),
            "patch keys are the row's camelCase field names"
        );
    }

    #[test]
    fn row_delivery_serializes_the_pinned_camel_case_envelope() {
        let row = chat_row(7, Some("reply"));
        let patch = project_patch(
            &RowSnapshot::Chat(&row),
            &[],
            RowChangeKind::Insert,
            &[],
        );
        let delivery = RowDelivery {
            query_id: "q-1".to_string(),
            event_type: EventTypeArg::Chat,
            kind: RowChangeKind::Insert,
            seq: 7,
            key: RowKey {
                session_id: "ses_a".to_string(),
                correlation_id: "ses_a_1".to_string(),
            },
            patch,
            timestamp: "2026-08-31T00:00:00+00:00".to_string(),
        };
        let json = serde_json::to_value(&delivery).expect("serialize RowDelivery");
        let obj = json.as_object().expect("object");
        for key in ["queryId", "eventType", "kind", "seq", "key", "patch", "timestamp"] {
            assert!(obj.contains_key(key), "RowDelivery JSON missing {key}");
        }
        assert_eq!(json.get("eventType"), Some(&json!("Chat")));
        assert_eq!(json.get("kind"), Some(&json!("insert")));
        let key = json.get("key").and_then(|k| k.as_object()).expect("key object");
        assert!(key.contains_key("sessionId"));
        assert!(key.contains_key("correlationId"));
    }

    #[test]
    fn row_change_kinds_serialize_lowercase() {
        for (kind, name) in [
            (RowChangeKind::Insert, "insert"),
            (RowChangeKind::Update, "update"),
            (RowChangeKind::Remove, "remove"),
        ] {
            let json = serde_json::to_value(kind).expect("serialize kind");
            assert_eq!(json.as_str(), Some(name));
        }
    }

    // ── Batch envelope (F-33 fix, W-1) ──────────────────────────────────────

    fn sample_delivery(query: &str, seq: i64, correlation: &str) -> RowDelivery {
        RowDelivery {
            query_id: query.to_string(),
            event_type: EventTypeArg::Chat,
            kind: RowChangeKind::Insert,
            seq,
            key: RowKey {
                session_id: "ses_a".to_string(),
                correlation_id: correlation.to_string(),
            },
            patch: Some(serde_json::json!({ "userMessage": "q", "seq": seq })),
            timestamp: "2026-08-31T00:00:00+00:00".to_string(),
        }
    }

    #[test]
    fn row_batch_envelope_serializes_the_camel_case_row_batch_field() {
        let batch = RowDeliveryBatch {
            row_batch: vec![
                sample_delivery("q-1", 1, "c1"),
                sample_delivery("q-1", 2, "c2"),
            ],
        };
        let json = serde_json::to_value(&batch).expect("serialize RowDeliveryBatch");
        let obj = json.as_object().expect("object");
        assert_eq!(obj.len(), 1, "the envelope carries exactly one field");
        assert!(
            obj.contains_key("rowBatch"),
            "envelope must expose the camelCase `rowBatch` discriminator"
        );
        let rows = obj.get("rowBatch").and_then(|v| v.as_array()).expect("array");
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn row_batch_envelope_round_trips_through_serde_unchanged() {
        let batch = RowDeliveryBatch {
            row_batch: vec![
                sample_delivery("q-1", 1, "c1"),
                sample_delivery("q-2", 2, "c2"),
            ],
        };
        let json = serde_json::to_string(&batch).expect("serialize");
        let parsed: RowDeliveryBatch = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, batch, "serde round-trip must be lossless");
    }

    #[test]
    fn row_delivery_itself_round_trips_for_the_batch_elements() {
        let delivery = sample_delivery("q-1", 3, "c1");
        let json = serde_json::to_string(&delivery).expect("serialize");
        let parsed: RowDelivery = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, delivery);
    }

    #[test]
    fn rfc3339_now_is_parseable_rfc3339() {
        let stamp = rfc3339_now();
        chrono::DateTime::parse_from_rfc3339(&stamp).expect("rfc3339_now must parse as RFC3339");
    }
}
