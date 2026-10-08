//! The `applicationBatch` notification envelope (Spec #2896, ST-4).
//!
//! Declared-table and canonical-table watches emit [`ApplicationRowNotification`]
//! values batched into a [`ApplicationDeliveryBatch`]. The envelope rides the
//! EXISTING `"fredo-stream-event"` Tauri channel (see
//! [`crate::infrastructure::comm::bus::EventBus::emit_application_delivery_batch`])
//! and is discriminated on the frontend by the `applicationBatch` field — checked
//! BEFORE the RTDB `rowBatch` validators. The RTDB `RowDeliveryBatch` shape is
//! untouched.
//!
//! Wire shape (serde `camelCase`):
//!
//! ```json
//! {
//!   "applicationBatch": [{
//!     "watchId": "…",
//!     "applicationId": "mission-monitor",   // null for canonical-table watches
//!     "table": "sessions",
//!     "kind": "update",
//!     "key": ["ses_1"],
//!     "changedFields": ["customName"],
//!     "values": { "sessionId": "ses_1", "customName": "Renamed", "_rowVersion": 3 },
//!     "version": 12,
//!     "timestamp": "2026-09-18T00:00:00+00:00"
//!   }]
//! }
//! ```

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};

/// The kind of a declared/canonical record change — serialized lowercase
/// (`insert` | `update` | `remove`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApplicationChangeKind {
    Insert,
    Update,
    Remove,
}

/// One notification for one watched record (contract (c)).
///
/// - `values` is `None` on a `remove` (a removal carries no value, R-3.4) and
///   the current record values otherwise. Reserved backend-managed columns are
///   surfaced camelCase (`_rowVersion` / `_updatedAt`) so consumers have one
///   naming convention.
/// - `key` is the primary-key values in declaration order for a declared
///   table; `[correlationId, sessionId]` for a canonical table.
/// - `version` is the scope version at which the change was applied — the
///   declared table's `last_version` snapshot, or the canonical row's durable
///   `seq`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationRowNotification {
    pub watch_id: String,
    /// `None` for canonical-table watches.
    #[serde(rename = "applicationId")]
    pub feature_id: Option<String>,
    /// `sessions` (declared) | `chat` | `toolUse` | `agentSession`.
    pub table: String,
    pub kind: ApplicationChangeKind,
    pub key: Vec<JsonValue>,
    pub changed_fields: Vec<String>,
    /// Current values; `None` on a `remove`.
    pub values: Option<Map<String, JsonValue>>,
    pub version: u64,
    /// RFC3339 emission time.
    pub timestamp: String,
}

/// The batched wire envelope — one `"fredo-stream-event"` IPC emission carries
/// every notification produced by one coalescing flush.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDeliveryBatch {
    pub application_batch: Vec<ApplicationRowNotification>,
}

impl ApplicationDeliveryBatch {
    /// Wrap a notification batch.
    pub fn new(application_batch: Vec<ApplicationRowNotification>) -> Self {
        ApplicationDeliveryBatch { application_batch }
    }

    /// Number of notifications in the batch.
    pub fn len(&self) -> usize {
        self.application_batch.len()
    }

    /// `true` when the batch carries no notification.
    pub fn is_empty(&self) -> bool {
        self.application_batch.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(kind: ApplicationChangeKind) -> ApplicationRowNotification {
        ApplicationRowNotification {
            watch_id: "w1".to_string(),
            feature_id: Some("mission-monitor".to_string()),
            table: "sessions".to_string(),
            kind,
            key: vec![json!("ses_1")],
            changed_fields: vec!["customName".to_string()],
            values: match kind {
                ApplicationChangeKind::Remove => None,
                _ => Some(
                    json!({ "sessionId": "ses_1", "customName": "Renamed", "_rowVersion": 3 })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            },
            version: 12,
            timestamp: "2026-09-18T00:00:00+00:00".to_string(),
        }
    }

    #[test]
    fn notification_serializes_exact_camel_case_keys() {
        let value = serde_json::to_value(sample(ApplicationChangeKind::Update)).unwrap();
        let object = value.as_object().expect("object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "applicationId",
                "changedFields",
                "key",
                "kind",
                "table",
                "timestamp",
                "values",
                "version",
                "watchId",
            ],
            "exact camelCase wire keys"
        );
        assert_eq!(object.get("watchId"), Some(&json!("w1")));
        assert_eq!(object.get("applicationId"), Some(&json!("mission-monitor")));
        assert_eq!(object.get("changedFields"), Some(&json!(["customName"])));
        assert_eq!(object.get("kind"), Some(&json!("update")));
        assert_eq!(object.get("version"), Some(&json!(12)));
    }

    #[test]
    fn kind_serializes_lowercase() {
        assert_eq!(serde_json::to_value(ApplicationChangeKind::Insert).unwrap(), json!("insert"));
        assert_eq!(serde_json::to_value(ApplicationChangeKind::Update).unwrap(), json!("update"));
        assert_eq!(serde_json::to_value(ApplicationChangeKind::Remove).unwrap(), json!("remove"));
    }

    #[test]
    fn remove_carries_null_values_and_the_previously_known_fields() {
        let value = serde_json::to_value(sample(ApplicationChangeKind::Remove)).unwrap();
        assert_eq!(value.get("kind"), Some(&json!("remove")));
        assert!(
            value.get("values").is_some_and(serde_json::Value::is_null),
            "remove must carry values: null, got {value}"
        );
    }

    #[test]
    fn canonical_notification_has_a_null_feature_id() {
        let mut notification = sample(ApplicationChangeKind::Insert);
        notification.feature_id = None;
        notification.table = "chat".to_string();
        let value = serde_json::to_value(&notification).unwrap();
        assert!(value.get("applicationId").is_some_and(serde_json::Value::is_null));
        assert_eq!(value.get("table"), Some(&json!("chat")));
    }

    #[test]
    fn batch_serializes_the_application_batch_field() {
        let batch = ApplicationDeliveryBatch::new(vec![
            sample(ApplicationChangeKind::Insert),
            sample(ApplicationChangeKind::Remove),
        ]);
        assert_eq!(batch.len(), 2);
        let value = serde_json::to_value(&batch).unwrap();
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 1, "single discriminating field: {value}");
        let entries = value.get("applicationBatch").and_then(|v| v.as_array()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].get("kind"), Some(&json!("insert")));
        assert_eq!(entries[1].get("kind"), Some(&json!("remove")));
    }

    #[test]
    fn batch_round_trips_through_serde() {
        let batch = ApplicationDeliveryBatch::new(vec![sample(ApplicationChangeKind::Update)]);
        let json = serde_json::to_string(&batch).unwrap();
        let parsed: ApplicationDeliveryBatch = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, batch);
    }
}
