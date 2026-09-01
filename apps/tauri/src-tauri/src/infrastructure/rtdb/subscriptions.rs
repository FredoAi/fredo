//! RTDB subscription registry + matcher (Spec #2788, P2.2).
//!
//! The in-memory LIVE matcher: registered queries (P2.1 parser/schema output,
//! via `ValidatedQuery`) are evaluated against each upserted row snapshot.
//! Argument evaluation runs on the row's serde JSON (rows.rs shape) with
//! typed-column semantics: numbers compare numerically (exact `i64` when both
//! sides are integers, `f64` otherwise), strings compare lexicographically,
//! booleans support equality only (ordering ops on them never match), and a
//! missing/null field never matches any operator. SQL pushdown for REPLAY is
//! the P2.3 store's concern — this module never touches SQL. No IPC exposure
//! (P2.3), no flush loop (P2.3).
//!
//! Matching is KEY-COMPLETE — every lifecycle routes:
//! - first match of a key for a query → [`RowChangeKind::Insert`] with a
//!   full-row patch: the row ENTERED the query's result set (a row that only
//!   starts qualifying after a later merge also enters with `Insert`, which
//!   re-syncs the client with the full merged row);
//! - subsequent matches → [`RowChangeKind::Update`] with a patch holding only
//!   changed+selected fields (see `project.rs`);
//! - retention eviction → [`SubscriptionRegistry::match_removal`] →
//!   [`RowChangeKind::Remove`] with patch `None` — the ONLY producer of
//!   `Remove` (binding decision, P2.2);
//! - a row that stops matching (an arg fails) silently LEAVES the query's
//!   result set — no delivery is emitted, and its membership is forgotten so
//!   the next qualifying mutation re-`Insert`s with a full-row re-sync.
//!
//! Bounded internal state (NFR-2 — feature scale, no caps needed, but every
//! map is bounded):
//! - `subscriptions` — one entry per registered query; removed by
//!   `unregister`. Bounded by the number of live UI subscriptions (P2.3
//!   wires register/unregister to the UI lifecycle).
//! - `members` — per query, the keys currently in its result set. Entries
//!   shrink on arg-failure and are removed per key on eviction
//!   (`match_removal`) and wholesale on `unregister`. Bounded by
//!   (#live queries × #live rows); #live rows is bounded by the store's
//!   retention policy (P2.3).
//! - `last_seq` — one entry per live (event type, key) holding the last
//!   delivered row seq, so removal deliveries stay per-key monotonic;
//!   removed on eviction. Bounded by #live rows.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use crate::infrastructure::rtdb::project::{
    project_patch, rfc3339_now, RowChangeKind, RowDelivery, RowKey, RowSnapshot,
};
use crate::infrastructure::rtdb::query::{CompareOp, EventTypeArg, QueryArg, QuerySpec, ValidatedQuery};
use uuid::Uuid;

/// One registered query — the matcher's unit of routing.
pub struct Subscription {
    pub query_id: String,
    pub spec: QuerySpec,
}

struct RegistryInner {
    subscriptions: HashMap<String, Subscription>,
    /// query_id → keys currently in that query's result set (delivered at
    /// least once and still matching).
    members: HashMap<String, HashSet<RowKey>>,
    /// (event tag, session_id, correlation_id) → last delivered row seq, for
    /// per-key monotonic seq on removal deliveries.
    last_seq: HashMap<(u8, String, String), i64>,
}

/// Registry + matcher for upserted rows against registered queries.
///
/// Interior-mutability (`std::sync::Mutex`) so P2.3 can share one instance
/// behind Tauri state. Locks are recovered from poisoning via
/// `into_inner()` (no `unwrap()`); the registry holds no invariants that a
/// panic mid-update could break beyond a possibly-missed delivery.
pub struct SubscriptionRegistry {
    inner: Mutex<RegistryInner>,
}

impl SubscriptionRegistry {
    pub fn new() -> Self {
        SubscriptionRegistry {
            inner: Mutex::new(RegistryInner {
                subscriptions: HashMap::new(),
                members: HashMap::new(),
                last_seq: HashMap::new(),
            }),
        }
    }

    /// Register a validated query; returns its generated query id
    /// (established `uuid::Uuid::new_v4()` pattern). Registering the same
    /// query twice yields two independent subscriptions (distinct ids, both
    /// delivered).
    pub fn register(&self, query: ValidatedQuery) -> String {
        let query_id = Uuid::new_v4().to_string();
        let mut inner = self.lock();
        inner.subscriptions.insert(
            query_id.clone(),
            Subscription {
                query_id: query_id.clone(),
                spec: query.spec,
            },
        );
        query_id
    }

    /// Remove a subscription. Unknown or already-removed ids are a no-op
    /// (idempotent); the query's membership state is dropped with it.
    pub fn unregister(&self, query_id: &str) {
        let mut inner = self.lock();
        inner.subscriptions.remove(query_id);
        inner.members.remove(query_id);
    }

    /// Number of currently registered queries (observability/tests).
    pub fn subscription_count(&self) -> usize {
        self.lock().subscriptions.len()
    }

    /// Route one upsert (insert or merged update) to every query whose
    /// `event_type` matches and whose args all evaluate true on the row
    /// snapshot. `changed_fields` holds the camelCase names of the fields
    /// present in the applied P1.1 patch (see `project.rs`).
    ///
    /// Returns one [`RowDelivery`] per matching query (empty when no query
    /// matches).
    pub fn match_mutation(
        &self,
        event_type: EventTypeArg,
        key: &RowKey,
        snapshot: &RowSnapshot,
        changed_fields: &[String],
    ) -> Vec<RowDelivery> {
        let mut inner = self.lock();
        // Deconstruct the guard so `subscriptions` (read) and `members` /
        // `last_seq` (written) are disjoint borrows.
        let RegistryInner {
            subscriptions,
            members,
            last_seq,
        } = &mut *inner;
        let row_json = snapshot.to_row_json();
        let tag = event_tag(&event_type);
        let mut deliveries = Vec::new();

        for subscription in subscriptions.values() {
            if event_tag(&subscription.spec.event_type) != tag {
                continue;
            }
            if !subscription
                .spec
                .args
                .iter()
                .all(|arg| evaluate_arg(&row_json, arg))
            {
                // The row left this query's result set — forget membership so
                // the next qualifying mutation re-Inserts (full-row re-sync).
                if let Some(members) = members.get_mut(&subscription.query_id) {
                    members.remove(key);
                }
                continue;
            }
            let members = members.entry(subscription.query_id.clone()).or_default();
            let kind = if members.contains(key) {
                RowChangeKind::Update
            } else {
                RowChangeKind::Insert
            };
            let patch = project_patch(snapshot, &subscription.spec.selection, kind, changed_fields);
            deliveries.push(RowDelivery {
                query_id: subscription.query_id.clone(),
                event_type: event_type.clone(),
                kind,
                seq: snapshot.seq(),
                key: key.clone(),
                patch,
                timestamp: rfc3339_now(),
            });
            members.insert(key.clone());
        }

        if !deliveries.is_empty() {
            last_seq.insert(
                (tag, key.session_id.clone(), key.correlation_id.clone()),
                snapshot.seq(),
            );
        }
        deliveries
    }

    /// Route a retention eviction of `key` to every query of `event_type`
    /// that currently holds the key in its result set. Emits
    /// [`RowChangeKind::Remove`] deliveries with patch `None` and the last
    /// delivered seq (monotonic per key). This is the ONLY producer of
    /// `Remove` — a row that merely stops matching does NOT route here.
    ///
    /// Returns one [`RowDelivery`] per previously-delivering query (empty
    /// when the key was never in any result set).
    pub fn match_removal(&self, event_type: EventTypeArg, key: &RowKey) -> Vec<RowDelivery> {
        let mut inner = self.lock();
        let RegistryInner {
            subscriptions,
            members,
            last_seq,
        } = &mut *inner;
        let tag = event_tag(&event_type);
        let seq = last_seq
            .get(&(tag, key.session_id.clone(), key.correlation_id.clone()))
            .copied()
            .unwrap_or(0);
        let mut deliveries = Vec::new();

        for subscription in subscriptions.values() {
            if event_tag(&subscription.spec.event_type) != tag {
                continue;
            }
            let was_member = match members.get_mut(&subscription.query_id) {
                Some(members) => members.remove(key),
                None => false,
            };
            if was_member {
                deliveries.push(RowDelivery {
                    query_id: subscription.query_id.clone(),
                    event_type: event_type.clone(),
                    kind: RowChangeKind::Remove,
                    seq,
                    key: key.clone(),
                    patch: None,
                    timestamp: rfc3339_now(),
                });
            }
        }

        // The row is evicted — its seq history goes with it. A reappearance
        // is a fresh insert.
        last_seq.remove(&(tag, key.session_id.clone(), key.correlation_id.clone()));
        deliveries
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for SubscriptionRegistry {
    fn default() -> Self {
        SubscriptionRegistry::new()
    }
}

/// Stable routing tag per event family — avoids requiring `PartialEq`/`Hash`
/// on the P2.1 enum and keys `last_seq` without borrowing.
fn event_tag(event_type: &EventTypeArg) -> u8 {
    match event_type {
        EventTypeArg::Chat => 0,
        EventTypeArg::ToolUse => 1,
        EventTypeArg::AgentSession => 2,
    }
}

/// Evaluate one filter arg against the serialized row: the field path must
/// resolve and the pinned `CompareOp` semantics must hold.
fn evaluate_arg(row: &serde_json::Value, arg: &QueryArg) -> bool {
    let Some(actual) = resolve_json_path(row, &arg.field) else {
        return false;
    };
    match arg.op {
        CompareOp::Eq => json_values_equal(actual, &arg.value),
        CompareOp::Gt | CompareOp::Gte | CompareOp::Lt | CompareOp::Lte => {
            json_ordering_compare(actual, &arg.value, arg.op)
        }
    }
}

fn resolve_json_path<'v>(
    value: &'v serde_json::Value,
    path: &[String],
) -> Option<&'v serde_json::Value> {
    let mut current = value;
    for segment in path {
        current = current.get(segment.as_str())?;
    }
    Some(current)
}

/// Typed equality: numbers compare numerically across integer/float encodings
/// (25 == 25.0); everything else compares by JSON value equality.
fn json_values_equal(actual: &serde_json::Value, expected: &serde_json::Value) -> bool {
    match (actual, expected) {
        (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
            numeric_compare(a, b, CompareOp::Eq)
        }
        _ => actual == expected,
    }
}

/// Typed ordering: numbers numerically, strings lexicographically. Booleans
/// and other JSON types support equality only — ordering never matches.
/// A missing/null field never reaches here (`evaluate_arg` rejects first).
fn json_ordering_compare(
    actual: &serde_json::Value,
    expected: &serde_json::Value,
    op: CompareOp,
) -> bool {
    match (actual, expected) {
        (serde_json::Value::Number(a), serde_json::Value::Number(b)) => numeric_compare(a, b, op),
        (serde_json::Value::String(a), serde_json::Value::String(b)) => match op {
            CompareOp::Gt => a > b,
            CompareOp::Gte => a >= b,
            CompareOp::Lt => a < b,
            CompareOp::Lte => a <= b,
            CompareOp::Eq => a == b,
        },
        _ => false,
    }
}

/// Numeric comparison with an exact `i64` path when both sides are integers
/// (no `f64` precision loss), falling back to `f64`.
fn numeric_compare(a: &serde_json::Number, b: &serde_json::Number, op: CompareOp) -> bool {
    if let (Some(ai), Some(bi)) = (a.as_i64(), b.as_i64()) {
        return match op {
            CompareOp::Eq => ai == bi,
            CompareOp::Gt => ai > bi,
            CompareOp::Gte => ai >= bi,
            CompareOp::Lt => ai < bi,
            CompareOp::Lte => ai <= bi,
        };
    }
    let (Some(af), Some(bf)) = (a.as_f64(), b.as_f64()) else {
        return false;
    };
    match op {
        CompareOp::Eq => af == bf,
        CompareOp::Gt => af > bf,
        CompareOp::Gte => af >= bf,
        CompareOp::Lt => af < bf,
        CompareOp::Lte => af <= bf,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::rtdb::rows::{AgentSessionRow, ChatRow, RowState, ToolUseRow};
    use serde_json::json;

    // ── Fixtures ────────────────────────────────────────────────────────────

    fn key(session: &str, correlation: &str) -> RowKey {
        RowKey {
            session_id: session.to_string(),
            correlation_id: correlation.to_string(),
        }
    }

    fn chat_row(seq: i64, prompt_tokens: Option<i64>, agent_reply: Option<&str>) -> ChatRow {
        ChatRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a_1".to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:00Z".to_string(),
            state: RowState::Update,
            user_message: Some("fix the bug".to_string()),
            agent_reply: agent_reply.map(str::to_string),
            prompt_tokens,
            completion_tokens: None,
            cache_read_tokens: None,
            cost_usd: None,
            model: Some("claude-sonnet-4".to_string()),
            parent_session_id: None,
            composited_child_session_id: None,
            raw_json: "{}".to_string(),
        }
    }

    fn tool_row(tool_success: Option<bool>) -> ToolUseRow {
        ToolUseRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a_2".to_string(),
            seq: 2,
            started_at_ns: Some(2_000),
            ended_at_ns: Some(5_000),
            updated_at: "2026-08-31T00:00:01Z".to_string(),
            state: RowState::Response,
            tool_name: Some("bash".to_string()),
            tool_success,
            tool_error: None,
            duration_ms: Some(120),
            tool_input_json: None,
            tool_output_json: None,
            is_subagent: Some(true),
            raw_json: "{}".to_string(),
        }
    }

    fn session_row(total_tokens: Option<i64>) -> AgentSessionRow {
        AgentSessionRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a".to_string(),
            seq: 3,
            started_at_ns: Some(3_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:02Z".to_string(),
            state: RowState::Update,
            total_tokens,
            total_messages: Some(4),
            total_cost_usd: Some(0.512),
            agent_name: Some("build".to_string()),
            raw_json: "{}".to_string(),
        }
    }

    fn arg(field: &str, op: CompareOp, value: serde_json::Value) -> QueryArg {
        QueryArg {
            field: vec![field.to_string()],
            op,
            value,
        }
    }

    fn validated(event_type: EventTypeArg, args: Vec<QueryArg>) -> ValidatedQuery {
        ValidatedQuery {
            spec: QuerySpec {
                event_type,
                args,
                selection: Vec::new(),
            },
        }
    }

    // ── Registry: register / unregister / idempotence ───────────────────────

    #[test]
    fn register_generates_unique_ids_and_counts() {
        let registry = SubscriptionRegistry::new();
        assert_eq!(registry.subscription_count(), 0);
        let id_a = registry.register(validated(EventTypeArg::Chat, vec![]));
        let id_b = registry.register(validated(EventTypeArg::ToolUse, vec![]));
        assert_eq!(registry.subscription_count(), 2);
        assert_ne!(id_a, id_b, "each registration gets its own id");
    }

    #[test]
    fn unregister_is_idempotent_and_unknown_ids_are_noops() {
        let registry = SubscriptionRegistry::new();
        let id = registry.register(validated(EventTypeArg::Chat, vec![]));
        registry.unregister(&id);
        assert_eq!(registry.subscription_count(), 0);
        registry.unregister(&id);
        registry.unregister("never-registered");
        assert_eq!(registry.subscription_count(), 0);
    }

    #[test]
    fn re_register_after_unregister_resumes_with_fresh_membership() {
        let registry = SubscriptionRegistry::new();
        let row = chat_row(1, Some(25), Some("reply"));
        let id = registry.register(validated(EventTypeArg::Chat, vec![]));
        let first = registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].kind, RowChangeKind::Insert);

        registry.unregister(&id);
        let id2 = registry.register(validated(EventTypeArg::Chat, vec![]));
        assert_ne!(id, id2);
        let again = registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert_eq!(again.len(), 1);
        assert_eq!(
            again[0].kind,
            RowChangeKind::Insert,
            "a fresh subscription has no membership history"
        );
        assert_eq!(again[0].query_id, id2);
    }

    // ── Matcher: hit/miss per CompareOp on number + string + bool ──────────

    #[test]
    fn eq_matches_numbers_strings_and_bools() {
        let registry = SubscriptionRegistry::new();

        // Number: exact hit.
        registry.register(validated(
            EventTypeArg::Chat,
            vec![arg("promptTokens", CompareOp::Eq, json!(25))],
        ));
        let row = chat_row(1, Some(25), None);
        let hits = registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert_eq!(hits.len(), 1, "Eq 25 == 25 must hit");

        // Number: miss on different value.
        let registry2 = SubscriptionRegistry::new();
        registry2.register(validated(
            EventTypeArg::Chat,
            vec![arg("promptTokens", CompareOp::Eq, json!(26))],
        ));
        let misses = registry2.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert!(misses.is_empty(), "Eq 26 != 25 must miss");

        // Number: cross-encoding 25 == 25.0.
        let registry3 = SubscriptionRegistry::new();
        registry3.register(validated(
            EventTypeArg::Chat,
            vec![arg("promptTokens", CompareOp::Eq, json!(25.0))],
        ));
        let cross = registry3.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert_eq!(cross.len(), 1, "numeric Eq spans integer/float encodings");

        // String.
        let registry4 = SubscriptionRegistry::new();
        registry4.register(validated(
            EventTypeArg::Chat,
            vec![arg("model", CompareOp::Eq, json!("claude-sonnet-4"))],
        ));
        let string_hit = registry4.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert_eq!(string_hit.len(), 1);

        // Bool (tool rows).
        let registry5 = SubscriptionRegistry::new();
        registry5.register(validated(
            EventTypeArg::ToolUse,
            vec![arg("toolSuccess", CompareOp::Eq, json!(true))],
        ));
        let tool = tool_row(Some(true));
        let bool_hit = registry5.match_mutation(
            EventTypeArg::ToolUse,
            &key("ses_a", "ses_a_2"),
            &RowSnapshot::ToolUse(&tool),
            &[],
        );
        assert_eq!(bool_hit.len(), 1, "toolSuccess == true must hit");

        // Bool false is a meaningful outcome and hits an Eq false query.
        let registry6 = SubscriptionRegistry::new();
        registry6.register(validated(
            EventTypeArg::ToolUse,
            vec![arg("toolSuccess", CompareOp::Eq, json!(false))],
        ));
        let failed_tool = tool_row(Some(false));
        let bool_false_hit = registry6.match_mutation(
            EventTypeArg::ToolUse,
            &key("ses_a", "ses_a_2"),
            &RowSnapshot::ToolUse(&failed_tool),
            &[],
        );
        assert_eq!(bool_false_hit.len(), 1);
    }

    #[test]
    fn ordering_ops_match_numbers_per_boundary() {
        let row = chat_row(1, Some(25), None);
        // (op, arg value, expected hit)
        let cases = [
            (CompareOp::Gt, json!(20), true),
            (CompareOp::Gt, json!(25), false),
            (CompareOp::Gte, json!(25), true),
            (CompareOp::Gte, json!(26), false),
            (CompareOp::Lt, json!(30), true),
            (CompareOp::Lt, json!(25), false),
            (CompareOp::Lte, json!(25), true),
            (CompareOp::Lte, json!(24), false),
        ];
        for (op, value, should_hit) in cases {
            let registry = SubscriptionRegistry::new();
            registry.register(validated(
                EventTypeArg::Chat,
                vec![arg("promptTokens", op, value.clone())],
            ));
            let deliveries = registry.match_mutation(
                EventTypeArg::Chat,
                &key("ses_a", "ses_a_1"),
                &RowSnapshot::Chat(&row),
                &[],
            );
            assert_eq!(
                deliveries.len(),
                if should_hit { 1 } else { 0 },
                "promptTokens=25 with {op:?} {:?} must {}",
                value,
                if should_hit { "hit" } else { "miss" }
            );
        }
    }

    #[test]
    fn ordering_ops_match_strings_lexicographically() {
        let row = chat_row(1, Some(25), None);
        let cases = [
            (CompareOp::Gt, "claude", true),
            (CompareOp::Gte, "claude-sonnet-4", true),
            (CompareOp::Lt, "z", true),
            (CompareOp::Lte, "claude-sonnet-4", true),
            (CompareOp::Gt, "claude-sonnet-4", false),
            (CompareOp::Lt, "claude", false),
        ];
        for (op, value, should_hit) in cases {
            let registry = SubscriptionRegistry::new();
            registry.register(validated(
                EventTypeArg::Chat,
                vec![arg("model", op, json!(value))],
            ));
            let deliveries = registry.match_mutation(
                EventTypeArg::Chat,
                &key("ses_a", "ses_a_1"),
                &RowSnapshot::Chat(&row),
                &[],
            );
            assert_eq!(
                deliveries.len(),
                if should_hit { 1 } else { 0 },
                "model Gt/Gte/Lt/Lte {value} must {}",
                if should_hit { "hit" } else { "miss" }
            );
        }
    }

    #[test]
    fn ordering_on_bools_never_matches() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(
            EventTypeArg::ToolUse,
            vec![arg("toolSuccess", CompareOp::Gt, json!(false))],
        ));
        let tool = tool_row(Some(true));
        let deliveries = registry.match_mutation(
            EventTypeArg::ToolUse,
            &key("ses_a", "ses_a_2"),
            &RowSnapshot::ToolUse(&tool),
            &[],
        );
        assert!(
            deliveries.is_empty(),
            "booleans support equality only — Gt must never match"
        );
    }

    #[test]
    fn missing_or_null_fields_never_match_any_op() {
        // agentReply is None on the row → JSON null → Eq null matches, all
        // orderings and Eq-with-value miss.
        let row = chat_row(1, Some(25), None);
        let cases = [
            (CompareOp::Eq, json!("some reply"), false),
            (CompareOp::Gt, json!(0), false),
            (CompareOp::Gte, json!(0), false),
            (CompareOp::Lt, json!(0), false),
            (CompareOp::Lte, json!(0), false),
        ];
        for (op, value, should_hit) in cases {
            let registry = SubscriptionRegistry::new();
            registry.register(validated(EventTypeArg::Chat, vec![arg("agentReply", op, value)]));
            let deliveries = registry.match_mutation(
                EventTypeArg::Chat,
                &key("ses_a", "ses_a_1"),
                &RowSnapshot::Chat(&row),
                &[],
            );
            assert_eq!(
                deliveries.len(),
                if should_hit { 1 } else { 0 },
                "null agentReply with {op:?} must {}",
                if should_hit { "hit" } else { "miss" }
            );
        }

        // A field name that does not exist on the row never matches.
        let registry2 = SubscriptionRegistry::new();
        registry2.register(validated(
            EventTypeArg::Chat,
            vec![arg("noSuchField", CompareOp::Eq, json!(1))],
        ));
        let misses = registry2.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert!(misses.is_empty());
    }

    #[test]
    fn all_args_must_pass() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(
            EventTypeArg::Chat,
            vec![
                arg("promptTokens", CompareOp::Gt, json!(20)),
                arg("model", CompareOp::Eq, json!("wrong-model")),
            ],
        ));
        let row = chat_row(1, Some(25), None);
        let deliveries = registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert!(deliveries.is_empty(), "one failing arg rejects the row");
    }

    #[test]
    fn state_matches_as_its_serialized_name() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(
            EventTypeArg::AgentSession,
            vec![arg("state", CompareOp::Eq, json!("Update"))],
        ));
        let row = session_row(Some(59_200));
        let deliveries = registry.match_mutation(
            EventTypeArg::AgentSession,
            &key("ses_a", "ses_a"),
            &RowSnapshot::AgentSession(&row),
            &[],
        );
        assert_eq!(deliveries.len(), 1, "RowState serializes as a string name");

        // Session-level numeric ordering.
        let registry2 = SubscriptionRegistry::new();
        registry2.register(validated(
            EventTypeArg::AgentSession,
            vec![arg("totalTokens", CompareOp::Gt, json!(50_000))],
        ));
        let big = registry2.match_mutation(
            EventTypeArg::AgentSession,
            &key("ses_a", "ses_a"),
            &RowSnapshot::AgentSession(&row),
            &[],
        );
        assert_eq!(big.len(), 1);
    }

    // ── Key-complete routing: insert / update / remove ─────────────────────

    #[test]
    fn insert_update_remove_route_key_completely() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(EventTypeArg::Chat, vec![]));
        let k = key("ses_a", "ses_a_1");

        // Insert: first sighting → full-row patch.
        let row1 = chat_row(1, Some(25), Some("partial"));
        let insert = registry.match_mutation(
            EventTypeArg::Chat,
            &k,
            &RowSnapshot::Chat(&row1),
            &["userMessage".to_string(), "seq".to_string()],
        );
        assert_eq!(insert.len(), 1);
        assert_eq!(insert[0].kind, RowChangeKind::Insert);
        let patch = insert[0].patch.as_ref().and_then(|p| p.as_object()).expect("insert patch object");
        assert_eq!(patch.len(), 17, "insert carries the FULL row (all chat fields)");
        assert_eq!(patch.get("userMessage"), Some(&json!("fix the bug")));
        assert_eq!(insert[0].seq, 1);

        // Update: merged row, changed fields only.
        let row2 = chat_row(2, Some(25), Some("full reply"));
        let update = registry.match_mutation(
            EventTypeArg::Chat,
            &k,
            &RowSnapshot::Chat(&row2),
            &["agentReply".to_string(), "seq".to_string()],
        );
        assert_eq!(update.len(), 1);
        assert_eq!(update[0].kind, RowChangeKind::Update);
        let patch = update[0].patch.as_ref().and_then(|p| p.as_object()).expect("update patch object");
        assert_eq!(patch.len(), 2, "update carries ONLY changed fields");
        assert_eq!(patch.get("agentReply"), Some(&json!("full reply")));
        assert_eq!(update[0].seq, 2, "seq carried from the merged row");

        // Remove: retention eviction → None patch, last delivered seq.
        let removal = registry.match_removal(EventTypeArg::Chat, &k);
        assert_eq!(removal.len(), 1);
        assert_eq!(removal[0].kind, RowChangeKind::Remove);
        assert_eq!(removal[0].patch, None);
        assert_eq!(removal[0].seq, 2, "removal seq is the last delivered seq");
        assert_eq!(removal[0].key, k);

        // Second removal: key already gone — no delivery.
        let second = registry.match_removal(EventTypeArg::Chat, &k);
        assert!(second.is_empty());

        // After eviction, a reappearance is a fresh insert.
        let row3 = chat_row(1, Some(30), Some("again"));
        let reinsert = registry.match_mutation(
            EventTypeArg::Chat,
            &k,
            &RowSnapshot::Chat(&row3),
            &[],
        );
        assert_eq!(reinsert.len(), 1);
        assert_eq!(reinsert[0].kind, RowChangeKind::Insert);
    }

    #[test]
    fn update_patch_respects_selection_intersection() {
        let registry = SubscriptionRegistry::new();
        let selection = vec![
            vec!["agentReply".to_string()],
            vec!["model".to_string()],
            vec!["promptTokens".to_string()],
        ];
        registry.register(validated_with_selection(
            EventTypeArg::Chat,
            vec![],
            selection,
        ));
        let row1 = chat_row(1, Some(25), Some("partial"));
        registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row1),
            &[],
        );

        let row2 = chat_row(2, Some(25), Some("full reply"));
        let update = registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row2),
            &["agentReply".to_string(), "promptTokens".to_string()],
        );
        assert_eq!(update.len(), 1);
        let patch = update[0].patch.as_ref().and_then(|p| p.as_object()).expect("patch object");
        assert_eq!(patch.len(), 2);
        assert!(patch.contains_key("agentReply"));
        assert!(patch.contains_key("promptTokens"));
        assert!(!patch.contains_key("model"), "selected but unchanged → excluded");
    }

    #[test]
    fn arg_failure_then_rematch_reinserts_full_row() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(
            EventTypeArg::Chat,
            vec![arg("promptTokens", CompareOp::Gt, json!(20))],
        ));
        let k = key("ses_a", "ses_a_1");

        let row1 = chat_row(1, Some(25), None);
        assert_eq!(
            registry.match_mutation(EventTypeArg::Chat, &k, &RowSnapshot::Chat(&row1), &[]).len(),
            1,
            "25 > 20 → insert"
        );

        // promptTokens drops to 10 (non-zero, applies) → leaves the result
        // set → NO delivery, and never a Remove (Remove is retention-only).
        let row2 = chat_row(2, Some(10), None);
        assert!(registry
            .match_mutation(EventTypeArg::Chat, &k, &RowSnapshot::Chat(&row2), &[])
            .is_empty());

        // Back above the threshold → re-Insert with a full-row re-sync.
        let row3 = chat_row(3, Some(30), Some("back"));
        let reentry = registry.match_mutation(
            EventTypeArg::Chat,
            &k,
            &RowSnapshot::Chat(&row3),
            &["promptTokens".to_string()],
        );
        assert_eq!(reentry.len(), 1);
        assert_eq!(reentry[0].kind, RowChangeKind::Insert);
        let patch = reentry[0].patch.as_ref().and_then(|p| p.as_object()).expect("full row");
        assert_eq!(patch.len(), 17);
    }

    #[test]
    fn removal_reaches_only_queries_that_delivered_the_key() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(
            EventTypeArg::ToolUse,
            vec![arg("toolSuccess", CompareOp::Eq, json!(true))],
        ));
        registry.register(validated(
            EventTypeArg::ToolUse,
            vec![arg("toolSuccess", CompareOp::Eq, json!(false))],
        ));
        let k = key("ses_a", "ses_a_2");

        let tool = tool_row(Some(true));
        let matched = registry.match_mutation(
            EventTypeArg::ToolUse,
            &k,
            &RowSnapshot::ToolUse(&tool),
            &[],
        );
        assert_eq!(matched.len(), 1, "only the true-query matches");

        let removals = registry.match_removal(EventTypeArg::ToolUse, &k);
        assert_eq!(removals.len(), 1, "only the query that delivered gets the remove");
        assert_eq!(removals[0].kind, RowChangeKind::Remove);
    }

    #[test]
    fn removal_of_never_seen_key_is_empty() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(EventTypeArg::Chat, vec![]));
        let removals = registry.match_removal(EventTypeArg::Chat, &key("ses_x", "ses_x_9"));
        assert!(removals.is_empty());
    }

    #[test]
    fn event_type_mismatch_never_routes() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(EventTypeArg::Chat, vec![]));

        let tool = tool_row(Some(true));
        let wrong_family = registry.match_mutation(
            EventTypeArg::ToolUse,
            &key("ses_a", "ses_a_2"),
            &RowSnapshot::ToolUse(&tool),
            &[],
        );
        assert!(wrong_family.is_empty());

        let wrong_removal = registry.match_removal(EventTypeArg::ToolUse, &key("ses_a", "ses_a_1"));
        assert!(wrong_removal.is_empty());
    }

    #[test]
    fn unregistered_query_stops_receiving_deliveries() {
        let registry = SubscriptionRegistry::new();
        let id = registry.register(validated(EventTypeArg::Chat, vec![]));
        registry.unregister(&id);
        let row = chat_row(1, Some(25), None);
        let deliveries = registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert!(deliveries.is_empty());
    }

    #[test]
    fn multiple_queries_on_the_same_key_each_get_a_delivery() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(EventTypeArg::Chat, vec![]));
        registry.register(validated(
            EventTypeArg::Chat,
            vec![arg("promptTokens", CompareOp::Gte, json!(0))],
        ));
        let row = chat_row(1, Some(25), None);
        let deliveries = registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert_eq!(deliveries.len(), 2);
        assert_ne!(deliveries[0].query_id, deliveries[1].query_id);
        for delivery in &deliveries {
            assert_eq!(delivery.kind, RowChangeKind::Insert);
            assert_eq!(delivery.seq, 1);
        }
    }

    #[test]
    fn deliveries_carry_camel_case_envelope_and_rfc3339_timestamp() {
        let registry = SubscriptionRegistry::new();
        registry.register(validated(EventTypeArg::Chat, vec![]));
        let row = chat_row(1, Some(25), Some("reply"));
        let deliveries = registry.match_mutation(
            EventTypeArg::Chat,
            &key("ses_a", "ses_a_1"),
            &RowSnapshot::Chat(&row),
            &[],
        );
        assert_eq!(deliveries.len(), 1);
        let json = serde_json::to_value(&deliveries[0]).expect("serialize delivery");
        let obj = json.as_object().expect("object");
        for key in ["queryId", "eventType", "kind", "seq", "key", "patch", "timestamp"] {
            assert!(obj.contains_key(key), "RowDelivery JSON missing {key}");
        }
        assert_eq!(json.get("eventType"), Some(&json!("Chat")));
        assert_eq!(json.get("kind"), Some(&json!("insert")));
        chrono::DateTime::parse_from_rfc3339(deliveries[0].timestamp.as_str())
            .expect("timestamp must be RFC3339");
    }

    fn validated_with_selection(
        event_type: EventTypeArg,
        args: Vec<QueryArg>,
        selection: Vec<Vec<String>>,
    ) -> ValidatedQuery {
        ValidatedQuery {
            spec: QuerySpec {
                event_type,
                args,
                selection,
            },
        }
    }
}
