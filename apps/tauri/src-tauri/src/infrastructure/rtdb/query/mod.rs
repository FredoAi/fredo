//! RTDB query language — owned types, hand-rolled parser, schema registry
//! (Spec #2788, P2.1, REQs R-3a/R-3b).
//!
//! Syntax (see [`parse`] for the grammar): `chat(sessionId = "ses_x",
//! promptTokens > 0) { userMessage, agentReply, promptTokens }`. Selection
//! paths are dotted and legal at ANY depth syntactically; the schema registry
//! ([`schema::validate`]) validates them against the row field metadata
//! derived from the P1.1 row structs. All failures are hard named errors that
//! carry the offending query text — no silent stripping (kills the old
//! 2-level-path silent-strip rule).

pub mod parse;
pub mod schema;

pub use parse::{parse, QueryParseError};
pub use schema::{schema_for, validate, FieldDef, FieldType, RowSchema, ValidatedQuery};

use serde::{Deserialize, Serialize};

/// Root event type of a query — selects the row schema and (later, P2.2/P2.3)
/// the store partition to match against.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum EventTypeArg {
    Chat,
    ToolUse,
    AgentSession,
}

impl EventTypeArg {
    /// Language-level root keyword (the parse spelling).
    pub fn as_str(&self) -> &'static str {
        match self {
            EventTypeArg::Chat => "chat",
            EventTypeArg::ToolUse => "toolUse",
            EventTypeArg::AgentSession => "agentSession",
        }
    }
}

/// Comparison operator. Equality (`=`) is legal on any typed column; the
/// ordering ops are legal only on number columns (enforced by
/// [`schema::validate`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum CompareOp {
    Eq,
    Gt,
    Gte,
    Lt,
    Lte,
}

impl CompareOp {
    /// Source spelling of the operator, used in error messages.
    pub fn as_str(&self) -> &'static str {
        match self {
            CompareOp::Eq => "=",
            CompareOp::Gt => ">",
            CompareOp::Gte => ">=",
            CompareOp::Lt => "<",
            CompareOp::Lte => "<=",
        }
    }
}

/// One filter argument: `field.path op literal`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryArg {
    pub field: Vec<String>,
    pub op: CompareOp,
    pub value: serde_json::Value,
}

/// A parsed but NOT yet schema-validated query. Run through
/// [`schema::validate`] before matching/pushdown.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySpec {
    pub event_type: EventTypeArg,
    pub args: Vec<QueryArg>,
    pub selection: Vec<Vec<String>>,
}
