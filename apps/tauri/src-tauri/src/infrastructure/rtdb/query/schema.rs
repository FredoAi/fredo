//! Schema registry for the RTDB query language (Spec #2788, P2.1, REQs
//! R-3a/R-3b).
//!
//! Field metadata is derived from the REAL P1.1 row structs
//! ([`super::super::rows`]): the canonical camelCase names, the JSON value
//! kind (`string | number | boolean | json | object`), and nullability from
//! `Option<T>`. The totality unit tests pin the tables against
//! `CHAT_FIELDS`/`TOOL_USE_FIELDS`/`AGENT_SESSION_FIELDS` AND against the
//! serde-serialized shape of a sample row, so a drift in either direction
//! fails the build.
//!
//! Every [`validate`] failure is a hard NAMED error whose message embeds a
//! rendered snippet of the offending query fragment — unknown fields
//! (including the P1.1 out-of-canonical names like `reasoningTokens`),
//! type-mismatched args, and comparisons on non-numeric fields. Nothing is
//! silently stripped.

use serde::{Deserialize, Serialize};

use super::{CompareOp, EventTypeArg, QueryArg, QuerySpec};

/// JSON value kind of a row column.
///
/// - `Json` — a serialized-JSON escape-hatch column (`rawJson`): args support
///   ONLY equality against the raw string form; selection sub-paths drill
///   into the JSON free-form.
/// - `Object` — the synthetic composite-key envelope `key` (`sessionId`,
///   `correlationId`, `seq` — the per-row-type composite key documented in
///   `rows.rs`); selection/arg sub-paths are free-form.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum FieldType {
    String,
    Number,
    Boolean,
    Json,
    Object,
}

impl FieldType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FieldType::String => "string",
            FieldType::Number => "number",
            FieldType::Boolean => "boolean",
            FieldType::Json => "json",
            FieldType::Object => "object",
        }
    }
}

/// Metadata for one row column (camelCase name — the serde wire shape).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldDef {
    pub name: &'static str,
    pub ty: FieldType,
    /// `true` iff the Rust field is `Option<T>`.
    pub nullable: bool,
}

/// Per-root-type schema table.
#[derive(Clone, Copy, Debug)]
pub struct RowSchema {
    pub root: EventTypeArg,
    pub fields: &'static [FieldDef],
}

/// `state` compares against the serde wire form of [`super::super::rows::RowState`]
/// (PascalCase: `"Init"`, `"Update"`, `"Response"`, `"Timeout"`, `"Error"`).
const STATE_FIELD: FieldDef = FieldDef {
    name: "state",
    ty: FieldType::String,
    nullable: false,
};

/// Synthetic composite-key envelope shared by every row type.
const KEY_FIELD: FieldDef = FieldDef {
    name: "key",
    ty: FieldType::Object,
    nullable: false,
};

pub static CHAT_SCHEMA: RowSchema = RowSchema {
    root: EventTypeArg::Chat,
    fields: &[
        FieldDef { name: "sessionId", ty: FieldType::String, nullable: false },
        FieldDef { name: "correlationId", ty: FieldType::String, nullable: false },
        FieldDef { name: "seq", ty: FieldType::Number, nullable: false },
        FieldDef { name: "startedAtNs", ty: FieldType::Number, nullable: true },
        FieldDef { name: "endedAtNs", ty: FieldType::Number, nullable: true },
        FieldDef { name: "updatedAt", ty: FieldType::String, nullable: false },
        STATE_FIELD,
        FieldDef { name: "userMessage", ty: FieldType::String, nullable: true },
        FieldDef { name: "agentReply", ty: FieldType::String, nullable: true },
        FieldDef { name: "promptTokens", ty: FieldType::Number, nullable: true },
        FieldDef { name: "completionTokens", ty: FieldType::Number, nullable: true },
        FieldDef { name: "cacheReadTokens", ty: FieldType::Number, nullable: true },
        FieldDef { name: "costUsd", ty: FieldType::Number, nullable: true },
        FieldDef { name: "model", ty: FieldType::String, nullable: true },
        FieldDef { name: "parentSessionId", ty: FieldType::String, nullable: true },
        FieldDef { name: "compositedChildSessionId", ty: FieldType::String, nullable: true },
        FieldDef { name: "rawJson", ty: FieldType::Json, nullable: false },
        KEY_FIELD,
    ],
};

pub static TOOL_USE_SCHEMA: RowSchema = RowSchema {
    root: EventTypeArg::ToolUse,
    fields: &[
        FieldDef { name: "sessionId", ty: FieldType::String, nullable: false },
        FieldDef { name: "correlationId", ty: FieldType::String, nullable: false },
        FieldDef { name: "seq", ty: FieldType::Number, nullable: false },
        FieldDef { name: "startedAtNs", ty: FieldType::Number, nullable: true },
        FieldDef { name: "endedAtNs", ty: FieldType::Number, nullable: true },
        FieldDef { name: "updatedAt", ty: FieldType::String, nullable: false },
        STATE_FIELD,
        FieldDef { name: "toolName", ty: FieldType::String, nullable: true },
        FieldDef { name: "toolSuccess", ty: FieldType::Boolean, nullable: true },
        FieldDef { name: "toolError", ty: FieldType::String, nullable: true },
        FieldDef { name: "durationMs", ty: FieldType::Number, nullable: true },
        FieldDef { name: "toolInputJson", ty: FieldType::String, nullable: true },
        FieldDef { name: "toolOutputJson", ty: FieldType::String, nullable: true },
        FieldDef { name: "isSubagent", ty: FieldType::Boolean, nullable: true },
        FieldDef { name: "rawJson", ty: FieldType::Json, nullable: false },
        KEY_FIELD,
    ],
};

pub static AGENT_SESSION_SCHEMA: RowSchema = RowSchema {
    root: EventTypeArg::AgentSession,
    fields: &[
        FieldDef { name: "sessionId", ty: FieldType::String, nullable: false },
        FieldDef { name: "correlationId", ty: FieldType::String, nullable: false },
        FieldDef { name: "seq", ty: FieldType::Number, nullable: false },
        FieldDef { name: "startedAtNs", ty: FieldType::Number, nullable: true },
        FieldDef { name: "endedAtNs", ty: FieldType::Number, nullable: true },
        FieldDef { name: "updatedAt", ty: FieldType::String, nullable: false },
        STATE_FIELD,
        FieldDef { name: "totalTokens", ty: FieldType::Number, nullable: true },
        FieldDef { name: "totalMessages", ty: FieldType::Number, nullable: true },
        FieldDef { name: "totalCostUsd", ty: FieldType::Number, nullable: true },
        FieldDef { name: "agentName", ty: FieldType::String, nullable: true },
        FieldDef { name: "rawJson", ty: FieldType::Json, nullable: false },
        KEY_FIELD,
    ],
};

/// The schema table for a root type.
pub fn schema_for(event_type: EventTypeArg) -> &'static RowSchema {
    match event_type {
        EventTypeArg::Chat => &CHAT_SCHEMA,
        EventTypeArg::ToolUse => &TOOL_USE_SCHEMA,
        EventTypeArg::AgentSession => &AGENT_SESSION_SCHEMA,
    }
}

/// How an arg path resolved against the schema.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PathTarget {
    /// A known top-level column.
    Field(&'static FieldDef),
    /// Drilled into a `Json`/`Object`-typed column — deeper segments are
    /// free-form interior paths.
    Interior(&'static FieldDef),
}

/// A schema-validated query — validated args + selection, ready for
/// matching/pushdown (P2.2/P2.3 consume this).
///
/// `args` are the POST-validation [`QueryArg`]s (same shape as the parsed
/// spec, type-correct by the `validate` contract) — the matcher/pushdown
/// layer evaluates them against the serialized row without re-resolving
/// schema types.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedQuery {
    pub event_type: EventTypeArg,
    pub args: Vec<QueryArg>,
    pub selection: Vec<Vec<String>>,
}

/// Validate a parsed query against the row-schema registry.
///
/// Returns one hard NAMED error per violation (not fail-fast) — each message
/// embeds the re-rendered query snippet, e.g.
/// `chat has no field 'promtTokens' — in: chat(sessionId="x") { promtTokens }`.
pub fn validate(spec: &QuerySpec) -> Result<ValidatedQuery, Vec<String>> {
    let schema = schema_for(spec.event_type);
    let mut errors = Vec::new();

    // Re-render the full query from the spec so every error message lets a
    // developer one-glance-locate the typo (validate() has no raw text).
    let args_rendered: Vec<String> = spec
        .args
        .iter()
        .map(|a| {
            format!(
                "{}{}{}",
                a.field.join("."),
                a.op.as_str(),
                render_value(&a.value)
            )
        })
        .collect();
    let snippet = format!(
        "{}({}) {{ {} }}",
        schema.root.as_str(),
        args_rendered.join(", "),
        spec.selection
            .iter()
            .map(|p| p.join("."))
            .collect::<Vec<_>>()
            .join(", "),
    );

    let mut args = Vec::new();
    for arg in &spec.args {
        match validate_arg(schema, arg, &snippet) {
            Ok(()) => args.push(arg.clone()),
            Err(message) => errors.push(message),
        }
    }

    let mut selection = Vec::new();
    for path in &spec.selection {
        match validate_selection_path(schema, path, &snippet) {
            Ok(()) => selection.push(path.clone()),
            Err(message) => errors.push(message),
        }
    }

    if errors.is_empty() {
        Ok(ValidatedQuery {
            event_type: spec.event_type,
            args,
            selection,
        })
    } else {
        Err(errors)
    }
}

fn validate_arg(schema: &RowSchema, arg: &QueryArg, snippet: &str) -> Result<(), String> {
    match resolve_path(schema, &arg.field, snippet)? {
        PathTarget::Field(field) => {
            check_field_value(schema, field, arg.op, &arg.value, snippet)
        }
        PathTarget::Interior(field) => {
            // Json/Object interiors: equality only (the grammar has no
            // object/array literals, and ordering a JSON subtree is
            // meaningless at this layer).
            if arg.op != CompareOp::Eq {
                return Err(format!(
                    "{} field '{}' is {}; comparison '{}' is not supported on sub-path '{}' (only '=') — in: {}",
                    schema.root.as_str(),
                    field.name,
                    field.ty.as_str(),
                    arg.op.as_str(),
                    arg.field.join("."),
                    snippet,
                ));
            }
            Ok(())
        }
    }
}

fn validate_selection_path(
    schema: &RowSchema,
    path: &[String],
    snippet: &str,
) -> Result<(), String> {
    match resolve_path(schema, path, snippet)? {
        PathTarget::Field(_) | PathTarget::Interior(_) => Ok(()),
    }
}

/// Resolve a dotted path: first segment must be a known field; drilling below
/// it is allowed only into `Json`/`Object`-typed columns (free-form interior).
fn resolve_path(
    schema: &RowSchema,
    path: &[String],
    snippet: &str,
) -> Result<PathTarget, String> {
    let first = path.first().ok_or_else(|| {
        format!(
            "{} has an empty field path — in: {}",
            schema.root.as_str(),
            snippet
        )
    })?;
    let field = schema
        .fields
        .iter()
        .find(|f| f.name == first)
        .ok_or_else(|| {
            format!(
                "{} has no field '{}' — in: {}",
                schema.root.as_str(),
                first,
                snippet
            )
        })?;
    if path.len() == 1 {
        return Ok(PathTarget::Field(field));
    }
    if matches!(field.ty, FieldType::Json | FieldType::Object) {
        return Ok(PathTarget::Interior(field));
    }
    Err(format!(
        "{} field '{}' is {}; cannot select sub-path '{}' — in: {}",
        schema.root.as_str(),
        field.name,
        field.ty.as_str(),
        path.join("."),
        snippet,
    ))
}

fn check_field_value(
    schema: &RowSchema,
    field: &'static FieldDef,
    op: CompareOp,
    value: &serde_json::Value,
    snippet: &str,
) -> Result<(), String> {
    let root = schema.root.as_str();
    // rawJson: equality on the raw string form is the ONLY supported arg.
    if field.ty == FieldType::Json {
        if op != CompareOp::Eq {
            return Err(format!(
                "{} field '{}' is json; only '=' on the raw JSON string form is supported — in: {}",
                root,
                field.name,
                snippet,
            ));
        }
        return match value {
            serde_json::Value::String(_) => Ok(()),
            _ => Err(format!(
                "{} field '{}' is json; only '=' with a string literal (raw JSON form) is supported — in: {}",
                root,
                field.name,
                snippet,
            )),
        };
    }
    if op != CompareOp::Eq && field.ty != FieldType::Number {
        return Err(format!(
            "{} field '{}' is {}; comparison '{}' requires a number field — in: {}",
            root,
            field.name,
            field.ty.as_str(),
            op.as_str(),
            snippet,
        ));
    }
    let mismatch = |actual: &str| {
        Err(format!(
            "{} field '{}' is {}; cannot compare with {} {} — in: {}",
            root,
            field.name,
            field.ty.as_str(),
            actual,
            render_value(value),
            snippet,
        ))
    };
    match (value, field.ty) {
        (serde_json::Value::Null, _) => {
            if !field.nullable {
                return Err(format!(
                    "{} field '{}' is not nullable; cannot compare with null — in: {}",
                    root,
                    field.name,
                    snippet,
                ));
            }
            if op != CompareOp::Eq {
                return Err(format!(
                    "{} field '{}': null comparison only supports '=' — in: {}",
                    root,
                    field.name,
                    snippet,
                ));
            }
            Ok(())
        }
        (serde_json::Value::String(_), FieldType::String) => Ok(()),
        (serde_json::Value::Bool(_), FieldType::Boolean) => Ok(()),
        (serde_json::Value::Number(_), FieldType::Number) => Ok(()),
        (serde_json::Value::String(_), FieldType::Object)
        | (serde_json::Value::Bool(_), FieldType::Object)
        | (serde_json::Value::Number(_), FieldType::Object) => Err(format!(
            "{} field '{}' is object; only sub-path selection like '{}.sessionId' is supported — in: {}",
            root,
            field.name,
            field.name,
            snippet,
        )),
        (serde_json::Value::Array(_) | serde_json::Value::Object(_), _) => mismatch(value_kind(value)),
        (serde_json::Value::String(_), _)
        | (serde_json::Value::Bool(_), _)
        | (serde_json::Value::Number(_), _) => mismatch(value_kind(value)),
    }
}

fn value_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// Render a literal for error snippets (strings re-quoted, everything else
/// via its JSON form).
fn render_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => format!("\"{}\"", s),
        other => serde_json::to_string(other)
            .unwrap_or_else(|_| "<unrenderable>".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::rtdb::rows::{
        AgentSessionRow, ChatRow, RowState, ToolUseRow, AGENT_SESSION_FIELDS, CHAT_FIELDS,
        TOOL_USE_FIELDS,
    };
    use serde_json;
    use serde_json::json;

    fn valid_spec(query: &str) -> QuerySpec {
        super::super::parse::parse(query).expect("valid query")
    }

    fn assert_single_error(query: &str, needle: &str) -> Vec<String> {
        let errs = validate(&valid_spec(query)).expect_err(query);
        assert_eq!(errs.len(), 1, "query {:?} → errors {:?}", query, errs);
        assert!(
            errs[0].contains(needle),
            "query {:?} → message {:?} missing {:?}",
            query,
            errs[0],
            needle
        );
        errs
    }

    #[test]
    fn schema_is_total_per_row_type() {
        for (fields, schema) in [
            (CHAT_FIELDS, &CHAT_SCHEMA),
            (TOOL_USE_FIELDS, &TOOL_USE_SCHEMA),
            (AGENT_SESSION_FIELDS, &AGENT_SESSION_SCHEMA),
        ] {
            for name in fields {
                assert!(
                    schema.fields.iter().any(|f| f.name == *name),
                    "{}: canonical field '{}' missing from schema",
                    schema.root.as_str(),
                    name
                );
            }
            for def in schema.fields {
                assert!(
                    def.name == "key" || fields.contains(&def.name),
                    "{}: schema field '{}' is not a canonical row field",
                    schema.root.as_str(),
                    def.name
                );
            }
        }
    }

    #[test]
    fn schema_names_match_serde_wire_shape() {
        // Grounds the registry against the REAL rows.rs serde shape.
        let chat = ChatRow {
            session_id: "s".into(),
            correlation_id: "c".into(),
            seq: 1,
            started_at_ns: Some(1),
            ended_at_ns: Some(2),
            updated_at: "t".into(),
            state: RowState::Init,
            user_message: Some("u".into()),
            agent_reply: Some("a".into()),
            prompt_tokens: Some(1),
            completion_tokens: Some(1),
            cache_read_tokens: Some(0),
            cost_usd: Some(0.0),
            model: Some("m".into()),
            parent_session_id: None,
            composited_child_session_id: None,
            raw_json: "{}".into(),
        };
        let tool_use = ToolUseRow {
            session_id: "s".into(),
            correlation_id: "c".into(),
            seq: 1,
            started_at_ns: Some(1),
            ended_at_ns: Some(2),
            updated_at: "t".into(),
            state: RowState::Update,
            tool_name: Some("t".into()),
            tool_success: Some(true),
            tool_error: None,
            duration_ms: Some(5),
            tool_input_json: Some("{}".to_string()),
            tool_output_json: None,
            is_subagent: Some(false),
            raw_json: "{}".into(),
        };
        let agent_session = AgentSessionRow {
            session_id: "s".into(),
            correlation_id: "c".into(),
            seq: 1,
            started_at_ns: Some(1),
            ended_at_ns: None,
            updated_at: "t".into(),
            state: RowState::Response,
            total_tokens: Some(10),
            total_messages: Some(2),
            total_cost_usd: Some(0.5),
            agent_name: Some("build".into()),
            raw_json: "{}".into(),
        };
        for (row, fields, schema) in [
            (
                serde_json::to_value(&chat).expect("serializable"),
                CHAT_FIELDS,
                &CHAT_SCHEMA,
            ),
            (
                serde_json::to_value(&tool_use).expect("serializable"),
                TOOL_USE_FIELDS,
                &TOOL_USE_SCHEMA,
            ),
            (
                serde_json::to_value(&agent_session).expect("serializable"),
                AGENT_SESSION_FIELDS,
                &AGENT_SESSION_SCHEMA,
            ),
        ] {
            let obj = row.as_object().expect("row serializes to an object");
            let mut wire: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
            wire.sort_unstable();
            let mut canonical: Vec<&str> = fields.to_vec();
            canonical.sort_unstable();
            assert_eq!(wire, canonical, "serde wire shape drifted from the field consts");
            for name in &canonical {
                assert!(
                    schema.fields.iter().any(|f| f.name == *name),
                    "schema missing serde wire field '{}'",
                    name
                );
            }
        }
    }

    #[test]
    fn validates_multi_arg_query_and_preserves_structure() {
        let validated = validate(&valid_spec(
            "chat(sessionId = \"ses_x\", promptTokens > 0) { userMessage, agentReply, promptTokens }",
        ))
        .expect("valid query");
        assert_eq!(validated.event_type, EventTypeArg::Chat);
        assert_eq!(validated.args.len(), 2);
        // Validated args preserve the parsed arg shape (type-correct by contract).
        assert_eq!(validated.args[0].field, vec!["sessionId"]);
        assert_eq!(validated.args[0].op, CompareOp::Eq);
        assert_eq!(validated.args[1].op, CompareOp::Gt);
        assert_eq!(validated.args[1].value, json!(0));
        assert_eq!(
            validated.selection,
            vec![
                vec!["userMessage"],
                vec!["agentReply"],
                vec!["promptTokens"]
            ]
        );
    }

    #[test]
    fn validates_any_depth_paths() {
        // ≥3-level paths over json/object columns are valid selections.
        let validated = validate(&valid_spec(
            "chat { rawJson.info.text, key.sessionId, promptTokens }",
        ))
        .expect("valid query");
        assert_eq!(
            validated.selection,
            vec![
                vec!["rawJson", "info", "text"],
                vec!["key", "sessionId"],
                vec!["promptTokens"]
            ]
        );
        // Interior equality arg is also valid.
        let validated =
            validate(&valid_spec("chat(key.seq = 3) { sessionId }")).expect("valid query");
        assert_eq!(validated.args[0].field, vec!["key", "seq"]);
        assert_eq!(validated.args[0].value, json!(3));
    }

    #[test]
    fn unknown_selection_field_is_hard_named_error() {
        let errs = assert_single_error(
            "chat(sessionId=\"x\") { promtTokens }",
            "chat has no field 'promtTokens'",
        );
        assert!(errs[0].contains("in: chat(sessionId=\"x\") { promtTokens }"),
            "actual: {:?}", errs[0]);
    }

    #[test]
    fn unknown_arg_key_is_hard_named_error() {
        assert_single_error(
            "chat(nosuchfield = \"x\") { sessionId }",
            "chat has no field 'nosuchfield'",
        );
    }

    #[test]
    fn out_of_canonical_fields_hard_error() {
        // P1.1 flagged these out-of-canonical — naming them is an error, not a gap.
        assert_single_error(
            "chat(reasoningTokens = 1) { sessionId }",
            "chat has no field 'reasoningTokens'",
        );
        assert_single_error(
            "agentSession { instruction }",
            "agentSession has no field 'instruction'",
        );
    }

    #[test]
    fn type_mismatch_is_hard_named_error() {
        assert_single_error(
            "chat(promptTokens = \"abc\") { sessionId }",
            "chat field 'promptTokens' is number; cannot compare with string \"abc\"",
        );
        assert_single_error(
            "toolUse(toolSuccess = \"yes\") { toolName }",
            "toolUse field 'toolSuccess' is boolean; cannot compare with string \"yes\"",
        );
        assert_single_error(
            "chat(seq = null) { seq }",
            "chat field 'seq' is not nullable; cannot compare with null",
        );
    }

    #[test]
    fn comparison_on_non_numeric_is_hard_named_error() {
        assert_single_error(
            "chat(sessionId > \"a\") { sessionId }",
            "chat field 'sessionId' is string; comparison '>' requires a number field",
        );
        assert_single_error(
            "agentSession(state >= \"Init\") { state }",
            "comparison '>=' requires a number field",
        );
        assert_single_error(
            "chat(userMessage > null) { userMessage }",
            "comparison '>' requires a number field",
        );
    }

    #[test]
    fn scalar_sub_paths_are_hard_named_errors() {
        assert_single_error(
            "chat(promptTokens.x = 1) { sessionId }",
            "chat field 'promptTokens' is number; cannot select sub-path 'promptTokens.x'",
        );
        assert_single_error(
            "chat { sessionId.foo }",
            "cannot select sub-path 'sessionId.foo'",
        );
    }

    #[test]
    fn json_column_rules() {
        // Equality on the raw string form is the ONLY arg against rawJson.
        let validated = validate(&valid_spec("chat(rawJson = \"{}\") { rawJson }"))
            .expect("valid query");
        assert_eq!(validated.args[0].field, vec!["rawJson"]);
        assert_eq!(validated.args[0].op, CompareOp::Eq);
        assert_single_error(
            "chat(rawJson > \"{}\") { rawJson }",
            "chat field 'rawJson' is json; only '=' on the raw JSON string form is supported",
        );
        assert_single_error(
            "chat(rawJson = 5) { rawJson }",
            "chat field 'rawJson' is json; only '=' with a string literal (raw JSON form) is supported",
        );
    }

    #[test]
    fn nullable_fields_accept_null_eq_only() {
        validate(&valid_spec("chat(userMessage = null) { userMessage }"))
            .expect("nullable field accepts null");
        // On a NUMBER + nullable column the null-only-Eq rule is the first
        // violation (the op check passes for number fields).
        assert_single_error(
            "chat(promptTokens > null) { promptTokens }",
            "chat field 'promptTokens': null comparison only supports '='",
        );
    }

    #[test]
    fn collects_all_errors_not_fail_fast() {
        let errs = validate(&valid_spec("chat(bogus = 1) { alsoBogus, sessionId }"))
            .expect_err("two errors");
        assert_eq!(errs.len(), 2, "errors: {:?}", errs);
    }
}
