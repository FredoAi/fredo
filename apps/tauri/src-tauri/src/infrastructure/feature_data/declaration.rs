//! `FeatureDataDeclaration` — the declared data-structure + source-mapping
//! model for the feature-owned data layer (Spec #2896, R-4).
//!
//! A feature declares its tables up front. The declaration is persisted, then
//! materialized idempotently (`CREATE TABLE IF NOT EXISTS`) by
//! [`super::registry::DeclarationRegistry`]; declared storage is backend-owned
//! and survives restarts. This module owns the model + its hard NAMED validation
//! (one message per violation, the `query/schema.rs::validate` precedent) — it
//! performs no I/O.
//!
//! JSON shape (serde `camelCase`) is the frontend contract in
//! `apps/ui/src/shared/feature-data/declaration.ts`.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::infrastructure::rtdb::rows::RowState;

/// Backend-managed reserved column names. They are never declared by a feature
/// (validation rejects them) and never writable by a feature-originated write
/// (see [`super::store::guard_feature_write`]).
pub const RESERVED_COLUMNS: [&str; 2] = ["_row_version", "_updated_at"];

/// `true` iff `name` is a backend-managed reserved column.
pub fn is_reserved_column(name: &str) -> bool {
    RESERVED_COLUMNS.contains(&name)
}

/// Canonical RTDB source a declaration reads rows from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivitySource {
    Chat,
    ToolUse,
    AgentSession,
}

impl ActivitySource {
    /// The canonical event-type name (matches `EventTypeArg` / the TS union).
    pub fn as_str(&self) -> &'static str {
        match self {
            ActivitySource::Chat => "chat",
            ActivitySource::ToolUse => "toolUse",
            ActivitySource::AgentSession => "agentSession",
        }
    }
}

/// Declared column type. `Boolean` uses SQLite INTEGER affinity and `Json` is
/// stored as TEXT (SQLite has no dedicated BOOLEAN/JSON storage class) — the
/// declared type is the logical type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DeclaredColumnType {
    Text,
    Integer,
    Real,
    Boolean,
    Json,
}

impl DeclaredColumnType {
    /// Parse the declared (uppercase) type name; `None` for an unknown type.
    pub fn parse_str(s: &str) -> Option<Self> {
        match s {
            "TEXT" => Some(Self::Text),
            "INTEGER" => Some(Self::Integer),
            "REAL" => Some(Self::Real),
            "BOOLEAN" => Some(Self::Boolean),
            "JSON" => Some(Self::Json),
            _ => None,
        }
    }

    /// Declared type name (the serde/wire form).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "TEXT",
            Self::Integer => "INTEGER",
            Self::Real => "REAL",
            Self::Boolean => "BOOLEAN",
            Self::Json => "JSON",
        }
    }

    /// Physical SQLite column type.
    pub fn as_sql_type(&self) -> &'static str {
        match self {
            Self::Text => "TEXT",
            Self::Integer => "INTEGER",
            Self::Real => "REAL",
            Self::Boolean => "INTEGER",
            Self::Json => "TEXT",
        }
    }
}

/// Who owns a declared column: the backend projection (`backend`) or feature
/// writes through `feature_data_write` (`feature`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnOwner {
    Backend,
    Feature,
}

/// One declared column.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: DeclaredColumnType,
    #[serde(default)]
    pub nullable: bool,
    pub owner: ColumnOwner,
}

/// A condition over canonical row fields (camelCase, `rows.rs` names).
///
/// Untagged so the wire shape is exactly the TS union
/// (`{ all } | { any } | { not } | { field, eq } | { field, isNull } | { field, in }`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WhereExpr {
    All {
        all: Vec<WhereExpr>,
    },
    Any {
        any: Vec<WhereExpr>,
    },
    Not {
        not: Box<WhereExpr>,
    },
    Eq {
        field: String,
        eq: JsonValue,
    },
    IsNull {
        field: String,
        #[serde(rename = "isNull")]
        is_null: bool,
    },
    In {
        field: String,
        #[serde(rename = "in")]
        r#in: Vec<JsonValue>,
    },
}

/// A single `select` mapping: the canonical field on the matched row, or a
/// literal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldMapping {
    Field { field: String },
    Literal { literal: JsonValue },
}

/// Discriminator for [`RowProjection`] (`"row"` on the wire).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RowProjectionKind {
    #[serde(rename = "row")]
    Row,
}

/// A column whose value is the named canonical field on the matched row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowProjection {
    pub kind: RowProjectionKind,
    pub from: ActivitySource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#where: Option<WhereExpr>,
    /// Declared column name → canonical field / literal.
    pub select: BTreeMap<String, FieldMapping>,
}

/// Discriminator for [`SessionRollupProjection`] (`"sessionRollup"` on the wire).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionRollupKind {
    #[serde(rename = "sessionRollup")]
    SessionRollup,
}

/// The Mission-Monitor list rollup — a CLOSED, documented projection kind
/// (deliberately not a general SQL/expression DSL; adding a kind is how a new
/// aggregate is introduced). Produced columns are fixed (contract (a)).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRollupProjection {
    pub kind: SessionRollupKind,
    /// Internal tool-execution agent names excluded from user-dispatch counting
    /// (single source for the rule; mirrors `rowDerivation.ts:212`).
    pub exclude_dispatch_names: Vec<String>,
    /// Row states whose chat row is terminal. `RowState` is PascalCase on the
    /// wire; backend SQL must use [`RowState::as_str`] (lowercase storage form).
    pub terminal_states: Vec<RowState>,
}

/// The declared source mapping for a table — either a row projection or the
/// closed session rollup.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DataSource {
    Row(RowProjection),
    SessionRollup(SessionRollupProjection),
}

/// Declared retention bound for a declared table (defaults applied by ST-7).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rows: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_days: Option<u64>,
}

/// One declared table.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataTableDeclaration {
    /// Logical table name; physical name is `feature_<sanitized featureId>_<name>`.
    pub name: String,
    pub primary_key: Vec<String>,
    pub columns: Vec<DeclaredColumn>,
    /// Omit for a purely feature-written table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<Retention>,
}

impl FeatureDataTableDeclaration {
    /// Look up a declared column by name.
    pub fn column(&self, name: &str) -> Option<&DeclaredColumn> {
        self.columns.iter().find(|c| c.name == name)
    }

    /// `true` iff `name` is one of the declared primary-key columns.
    pub fn is_primary_key(&self, name: &str) -> bool {
        self.primary_key.iter().any(|pk| pk == name)
    }
}

/// A feature's full declaration batch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataDeclaration {
    pub feature_id: String,
    /// Content hash of the declarations below (computed by the declaring
    /// feature). The registry performs a content comparison as well.
    pub declaration_revision: String,
    pub tables: Vec<FeatureDataTableDeclaration>,
}

impl FeatureDataDeclaration {
    /// Look up a declared table by logical name.
    pub fn table(&self, name: &str) -> Option<&FeatureDataTableDeclaration> {
        self.tables.iter().find(|t| t.name == name)
    }

    /// Validate the declaration model. Returns one hard NAMED error per
    /// violation (never fail-fast): unknown/invalid names, duplicate table or
    /// column names, a missing or unresolvable primary key, a `select` naming an
    /// undeclared or feature-owned column, reserved columns, and empty source
    /// lists.
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        let feature = if self.feature_id.trim().is_empty() {
            "<unnamed>"
        } else {
            self.feature_id.as_str()
        };

        if self.feature_id.trim().is_empty() {
            errors.push("feature data declaration has an empty featureId".to_string());
        } else if !is_feature_id(&self.feature_id) {
            errors.push(format!(
                "feature data declaration featureId '{}' is not a valid identifier",
                self.feature_id
            ));
        }

        if self.declaration_revision.trim().is_empty() {
            errors.push(format!(
                "feature '{feature}' declaration has an empty declarationRevision"
            ));
        }

        let mut seen_tables: BTreeSet<&str> = BTreeSet::new();
        for table in &self.tables {
            if !seen_tables.insert(table.name.as_str()) {
                errors.push(format!(
                    "feature '{feature}' declares table '{}' more than once",
                    table.name
                ));
            }
            validate_table(feature, table, &mut errors);
        }

        errors
    }

    /// Parse + validate a raw JSON declaration. Unknown column types (which a
    /// typed `serde` decode would reject with an opaque message) are reported as
    /// hard named errors here, then the typed model is built and validated.
    pub fn parse(value: JsonValue) -> Result<Self, Vec<String>> {
        let mut errors = Vec::new();
        scan_unknown_column_types(&value, &mut errors);
        if !errors.is_empty() {
            return Err(errors);
        }

        let declaration: FeatureDataDeclaration = match serde_json::from_value(value) {
            Ok(declaration) => declaration,
            Err(e) => return Err(vec![format!("invalid feature data declaration: {e}")]),
        };

        let errors = declaration.validate();
        if errors.is_empty() {
            Ok(declaration)
        } else {
            Err(errors)
        }
    }

    /// Parse + validate a batch of raw JSON declarations, preserving input order.
    pub fn parse_slice(values: Vec<JsonValue>) -> Result<Vec<Self>, Vec<String>> {
        let mut parsed = Vec::with_capacity(values.len());
        let mut errors = Vec::new();
        for value in values {
            match Self::parse(value) {
                Ok(declaration) => parsed.push(declaration),
                Err(mut errs) => errors.append(&mut errs),
            }
        }
        if errors.is_empty() {
            Ok(parsed)
        } else {
            Err(errors)
        }
    }
}

/// Walk a raw declaration value and report unknown/missing column `type`s.
fn scan_unknown_column_types(value: &JsonValue, errors: &mut Vec<String>) {
    let feature = value
        .get("featureId")
        .and_then(JsonValue::as_str)
        .unwrap_or("<unnamed>");

    let Some(tables) = value.get("tables").and_then(JsonValue::as_array) else {
        return;
    };
    for table in tables {
        let table_name = table
            .get("name")
            .and_then(JsonValue::as_str)
            .unwrap_or("<unnamed>");
        let Some(columns) = table.get("columns").and_then(JsonValue::as_array) else {
            continue;
        };
        for column in columns {
            let column_name = column
                .get("name")
                .and_then(JsonValue::as_str)
                .unwrap_or("<unnamed>");
            match column.get("type").and_then(JsonValue::as_str) {
                Some(ty) if DeclaredColumnType::parse_str(ty).is_some() => {}
                Some(ty) => errors.push(format!(
                    "feature '{feature}' table '{table_name}' column '{column_name}' has unknown type '{ty}' \
                     (expected TEXT | INTEGER | REAL | BOOLEAN | JSON)"
                )),
                None => errors.push(format!(
                    "feature '{feature}' table '{table_name}' column '{column_name}' has no 'type'"
                )),
            }
        }
    }
}

fn validate_table(feature: &str, table: &FeatureDataTableDeclaration, errors: &mut Vec<String>) {
    let table_name = if table.name.trim().is_empty() {
        "<unnamed>"
    } else {
        table.name.as_str()
    };

    if table.name.trim().is_empty() {
        errors.push(format!(
            "feature '{feature}' declares a table with an empty name"
        ));
    } else if !is_identifier(&table.name) {
        errors.push(format!(
            "feature '{feature}' table '{}' name is not a valid SQL identifier",
            table.name
        ));
    }

    if table.primary_key.is_empty() {
        errors.push(format!(
            "feature '{feature}' table '{table_name}' declares no primary key column"
        ));
    }

    let mut seen_columns: BTreeSet<&str> = BTreeSet::new();
    let mut by_name: BTreeMap<&str, &DeclaredColumn> = BTreeMap::new();
    for column in &table.columns {
        if column.name.trim().is_empty() {
            errors.push(format!(
                "feature '{feature}' table '{table_name}' declares a column with an empty name"
            ));
            continue;
        }
        if is_reserved_column(&column.name) {
            errors.push(format!(
                "feature '{feature}' table '{table_name}' column '{}' is backend-managed and cannot be declared",
                column.name
            ));
        }
        if !is_identifier(&column.name) {
            errors.push(format!(
                "feature '{feature}' table '{table_name}' column '{}' is not a valid SQL identifier",
                column.name
            ));
        }
        if !seen_columns.insert(column.name.as_str()) {
            errors.push(format!(
                "feature '{feature}' table '{table_name}' declares column '{}' more than once",
                column.name
            ));
        }
        by_name.insert(column.name.as_str(), column);
    }

    let mut seen_pk: BTreeSet<&str> = BTreeSet::new();
    for pk in &table.primary_key {
        if !seen_pk.insert(pk.as_str()) {
            errors.push(format!(
                "feature '{feature}' table '{table_name}' lists primary key column '{pk}' more than once"
            ));
        }
        if !by_name.contains_key(pk.as_str()) {
            errors.push(format!(
                "feature '{feature}' table '{table_name}' primary key column '{pk}' is not present in columns"
            ));
        }
    }

    match &table.source {
        Some(DataSource::Row(row)) => {
            validate_row_projection(feature, table_name, row, &by_name, errors);
        }
        Some(DataSource::SessionRollup(rollup)) => {
            if rollup.terminal_states.is_empty() {
                errors.push(format!(
                    "feature '{feature}' table '{table_name}' sessionRollup declares no terminalStates"
                ));
            }
            if rollup.exclude_dispatch_names.is_empty() {
                errors.push(format!(
                    "feature '{feature}' table '{table_name}' sessionRollup declares no excludeDispatchNames"
                ));
            }
        }
        None => {}
    }
}

fn validate_row_projection(
    feature: &str,
    table_name: &str,
    row: &RowProjection,
    by_name: &BTreeMap<&str, &DeclaredColumn>,
    errors: &mut Vec<String>,
) {
    for (target, mapping) in &row.select {
        match by_name.get(target.as_str()) {
            None => errors.push(format!(
                "feature '{feature}' table '{table_name}' source select names column '{target}' which is not declared"
            )),
            Some(column) if column.owner == ColumnOwner::Feature => errors.push(format!(
                "feature '{feature}' table '{table_name}' source select targets feature-owned column '{target}' \
                 (only backend-owned columns can be projected)"
            )),
            Some(_) => {}
        }
        if let FieldMapping::Field { field } = mapping {
            if field.trim().is_empty() {
                errors.push(format!(
                    "feature '{feature}' table '{table_name}' source select for column '{target}' names an empty field"
                ));
            }
        }
    }
}

/// Valid identifier for a declared table/column name (SQL-safe as interpolated
/// into DDL).
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Feature ids may contain hyphens (`mission-monitor`); they are sanitized to
/// underscores for the physical table prefix.
fn is_feature_id(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, ty: DeclaredColumnType, owner: ColumnOwner) -> DeclaredColumn {
        DeclaredColumn {
            name: name.to_string(),
            col_type: ty,
            nullable: false,
            owner,
        }
    }

    fn mission_monitor_like() -> FeatureDataDeclaration {
        FeatureDataDeclaration {
            feature_id: "mission-monitor".to_string(),
            declaration_revision: "mm.sessions.v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "sessions".to_string(),
                primary_key: vec!["sessionId".to_string()],
                columns: vec![
                    column("sessionId", DeclaredColumnType::Text, ColumnOwner::Backend),
                    column(
                        "chatRowCount",
                        DeclaredColumnType::Integer,
                        ColumnOwner::Backend,
                    ),
                    DeclaredColumn {
                        name: "customName".to_string(),
                        col_type: DeclaredColumnType::Text,
                        nullable: true,
                        owner: ColumnOwner::Feature,
                    },
                ],
                source: Some(DataSource::SessionRollup(SessionRollupProjection {
                    kind: SessionRollupKind::SessionRollup,
                    exclude_dispatch_names: vec!["build".to_string(), "plan".to_string()],
                    terminal_states: vec![RowState::Response, RowState::Timeout],
                })),
                retention: Some(Retention {
                    max_rows: Some(500),
                    ttl_days: None,
                }),
            }],
        }
    }

    #[test]
    fn valid_declaration_passes() {
        assert!(mission_monitor_like().validate().is_empty());
    }

    #[test]
    fn unknown_column_type_is_a_named_error() {
        let raw = serde_json::json!({
            "featureId": "f",
            "declarationRevision": "v1",
            "tables": [{
                "name": "t",
                "primaryKey": ["id"],
                "columns": [
                    { "name": "id", "type": "TEXT", "owner": "backend" },
                    { "name": "n", "type": "NUMBER", "owner": "backend" }
                ]
            }]
        });
        let errors = FeatureDataDeclaration::parse(raw).unwrap_err();
        assert_eq!(errors.len(), 1, "errors: {errors:?}");
        assert!(errors[0].contains("unknown type 'NUMBER'"), "{errors:?}");
    }

    #[test]
    fn duplicate_table_name_is_a_named_error() {
        let mut decl = mission_monitor_like();
        decl.tables.push(decl.tables[0].clone());
        let errors = decl.validate();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("declares table 'sessions' more than once")),
            "{errors:?}"
        );
    }

    #[test]
    fn duplicate_column_is_a_named_error() {
        let mut decl = mission_monitor_like();
        let dup = decl.tables[0].columns[0].clone();
        decl.tables[0].columns.push(dup);
        let errors = decl.validate();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("declares column 'sessionId' more than once")),
            "{errors:?}"
        );
    }

    #[test]
    fn missing_primary_key_is_a_named_error() {
        let mut decl = mission_monitor_like();
        decl.tables[0].primary_key.clear();
        let errors = decl.validate();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("declares no primary key column")),
            "{errors:?}"
        );
    }

    #[test]
    fn primary_key_not_present_is_a_named_error() {
        let mut decl = mission_monitor_like();
        decl.tables[0].primary_key = vec!["missing".to_string()];
        let errors = decl.validate();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("primary key column 'missing' is not present")),
            "{errors:?}"
        );
    }

    #[test]
    fn select_naming_undeclared_column_is_a_named_error() {
        let decl = FeatureDataDeclaration {
            feature_id: "f".to_string(),
            declaration_revision: "v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "t".to_string(),
                primary_key: vec!["id".to_string()],
                columns: vec![
                    column("id", DeclaredColumnType::Text, ColumnOwner::Backend),
                    column("name", DeclaredColumnType::Text, ColumnOwner::Backend),
                ],
                source: Some(DataSource::Row(RowProjection {
                    kind: RowProjectionKind::Row,
                    from: ActivitySource::Chat,
                    r#where: None,
                    select: BTreeMap::from([
                        (
                            "id".to_string(),
                            FieldMapping::Field {
                                field: "sessionId".to_string(),
                            },
                        ),
                        (
                            "ghost".to_string(),
                            FieldMapping::Field {
                                field: "userMessage".to_string(),
                            },
                        ),
                    ]),
                })),
                retention: None,
            }],
        };
        let errors = decl.validate();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("source select names column 'ghost' which is not declared")),
            "{errors:?}"
        );
    }

    #[test]
    fn select_targeting_feature_owned_column_is_a_named_error() {
        let decl = FeatureDataDeclaration {
            feature_id: "f".to_string(),
            declaration_revision: "v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "t".to_string(),
                primary_key: vec!["id".to_string()],
                columns: vec![
                    column("id", DeclaredColumnType::Text, ColumnOwner::Backend),
                    DeclaredColumn {
                        name: "note".to_string(),
                        col_type: DeclaredColumnType::Text,
                        nullable: true,
                        owner: ColumnOwner::Feature,
                    },
                ],
                source: Some(DataSource::Row(RowProjection {
                    kind: RowProjectionKind::Row,
                    from: ActivitySource::Chat,
                    r#where: None,
                    select: BTreeMap::from([
                        (
                            "id".to_string(),
                            FieldMapping::Field {
                                field: "sessionId".to_string(),
                            },
                        ),
                        (
                            "note".to_string(),
                            FieldMapping::Field {
                                field: "agentReply".to_string(),
                            },
                        ),
                    ]),
                })),
                retention: None,
            }],
        };
        let errors = decl.validate();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("targets feature-owned column 'note'")),
            "{errors:?}"
        );
    }

    #[test]
    fn reserved_column_declaration_is_a_named_error() {
        let mut decl = mission_monitor_like();
        decl.tables[0].columns.push(column(
            "_row_version",
            DeclaredColumnType::Integer,
            ColumnOwner::Backend,
        ));
        let errors = decl.validate();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("'_row_version' is backend-managed")),
            "{errors:?}"
        );
    }

    #[test]
    fn json_round_trip_is_camel_case_and_kind_discriminated() {
        let decl = mission_monitor_like();
        let value = serde_json::to_value(&decl).unwrap();
        assert_eq!(value["featureId"], "mission-monitor");
        assert_eq!(value["declarationRevision"], "mm.sessions.v1");
        assert_eq!(value["tables"][0]["primaryKey"][0], "sessionId");
        assert_eq!(value["tables"][0]["columns"][0]["type"], "TEXT");
        assert_eq!(value["tables"][0]["source"]["kind"], "sessionRollup");
        assert_eq!(value["tables"][0]["retention"]["maxRows"], 500);

        let parsed: FeatureDataDeclaration = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, decl);
    }

    #[test]
    fn where_expr_untagged_round_trip() {
        let value = serde_json::json!({
            "kind": "row",
            "from": "toolUse",
            "where": { "all": [
                { "field": "toolName", "eq": "task" },
                { "field": "isSubagent", "isNull": false }
            ]},
            "select": { "id": { "field": "correlationId" }, "tag": { "literal": "x" } }
        });
        let projection: RowProjection = serde_json::from_value(value).unwrap();
        assert_eq!(projection.from, ActivitySource::ToolUse);
        assert!(projection.r#where.is_some());
        assert_eq!(
            projection.select.get("tag"),
            Some(&FieldMapping::Literal {
                literal: serde_json::json!("x")
            })
        );
    }
}
