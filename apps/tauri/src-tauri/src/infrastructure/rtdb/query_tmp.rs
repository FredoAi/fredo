//! TEMPORARY (Spec #2788, work item P2.2) — mirror of the pinned P2.1 query
//! language types.
//!
//! P2.1 (`query/parse.rs` + `query/schema.rs`, types in `query/mod.rs`) is
//! being built in parallel by a peer. To keep `cargo check` green without
//! touching the peer's files, `rtdb/mod.rs` aliases THIS file as the
//! `rtdb::query` module:
//!
//! ```ignore
//! #[path = "query_tmp.rs"]
//! pub mod query;
//! ```
//!
//! Everything under `infrastructure/rtdb/` imports the pinned shapes from
//! `crate::infrastructure::rtdb::query::…` — the integration import path —
//! so switching to P2.1's real module requires NO import changes.
//!
//! AT INTEGRATION (merge with `origin/spec/2788`):
//! 1. In `rtdb/mod.rs`, keep the peer's `pub mod query;` line and DELETE the
//!    `#[path = "query_tmp.rs"] pub mod query;` line (union resolution).
//! 2. DELETE this file.
//! 3. Re-run `cargo check` + `cargo test` — if P2.1's real types differ from
//!    the pinned contract below, reconcile in `subscriptions.rs` /
//!    `project.rs` (this file must not survive the merge).
//!
//! The definitions below are the pinned contract shapes verbatim (P2.2
//! brief). Derives are a superset of what P2.2 consumes (`Clone` for the
//! delivery envelope, `Serialize` for the wire shape, `PartialEq` for tests).
//! `ValidatedQuery` is PROVISIONAL — its shape was not pinned; `register()`
//! consumes only `.spec`, so integration adapts at most the constructor.

use serde::{Deserialize, Serialize};

/// The row family a query addresses. Serializes as the bare variant names
/// (`Chat` | `ToolUse` | `AgentSession`) per the pinned contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EventTypeArg {
    Chat,
    ToolUse,
    AgentSession,
}

/// A parsed query: which row family, filter args (ALL must pass), and the
/// projected field paths.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuerySpec {
    pub event_type: EventTypeArg,
    pub args: Vec<QueryArg>,
    pub selection: Vec<Vec<String>>,
}

/// One filter predicate: `field` (a path into the row, camelCase segments)
/// `op value`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryArg {
    pub field: Vec<String>,
    pub op: CompareOp,
    pub value: serde_json::Value,
}

/// Supported comparison operators.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompareOp {
    Eq,
    Gt,
    Gte,
    Lt,
    Lte,
}

/// PROVISIONAL stand-in for P2.1's schema-validated query. Only `.spec` is
/// consumed by the subscription registry (`SubscriptionRegistry::register`).
#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedQuery {
    pub spec: QuerySpec,
}
