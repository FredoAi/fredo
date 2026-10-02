//! Lazy per-level schema browse (Spec #2950, ST-3).
//!
//! `db_schema_list` fetches **one catalog level at a time** from
//! `pg_catalog` — the full schema is never preloaded (R-2.1/R-2.2). Each call
//! takes a `parent_id` path key (or `None` for the root) and returns the typed
//! children of that level as [`SchemaNode`]s.
//!
//! Levels:
//!
//! * `None`            → the connected database (one `database` node)
//! * `db`              → schemas
//! * `db/<schema>`     → tables / views / functions of that schema
//! * `db/<schema>/t/<relation>` (table) or `db/<schema>/v/<relation>` (view)
//!   → columns / indexes / keys
//!
//! Read-only invariant: every query is a single `SELECT` over `pg_catalog` /
//! `pg_namespace` — no user DDL, no writes, no session mutation (plan
//! non-goal). The fetch is bounded by [`SCHEMA_QUERY_TIMEOUT`] so a slow catalog
//! read can never wedge the command (G-263; "never blocks other connections").
//!
//! Pool lifecycle stays ST-2's: this module only reads the already-open pool for
//! the connection from [`DbClientState`]. `db_schema_list` never opens or closes
//! a pool.
//!
//! R-2.3 (inspector definition) is served by the same lazy fetch: the UI
//! inspector requests `parent_id = <selected node id>` to list columns+types /
//! indexes / keys, and leaf nodes carry their type / signature in `detail`.
//! R-2.4 (inline node errors) is served by returning the error to the caller so
//! the tree can render it on the failing node.

use std::time::Duration;

use sqlx::{PgPool, Row};

use super::seam::ForceFailStage;
use super::state::DbClientState;
use super::types::{DbObjectKind, DbSchemaListArgs, SchemaNode};

#[cfg(test)]
#[path = "tests_schema.rs"]
mod tests_schema;

/// Hard bound on one catalog-level fetch (G-263).
pub const SCHEMA_QUERY_TIMEOUT: Duration = Duration::from_secs(10);

/// Root: the connected database + its server version (R-2.1).
pub const ROOT_QUERY: &str = "SELECT current_database() AS name, \
     current_setting('server_version') AS detail";

/// Level 1: user-visible schemas of the connected database.
pub const SCHEMAS_QUERY: &str = "SELECT n.nspname AS name \
     FROM pg_catalog.pg_namespace n \
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
       AND n.nspname NOT LIKE 'pg_toast%' \
       AND n.nspname NOT LIKE 'pg_temp_%' \
       AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') \
     ORDER BY n.nspname";

/// Level 2: tables, views and functions of one schema (one row each).
pub const SCHEMA_OBJECTS_QUERY: &str = "SELECT t.kind, t.name, t.detail FROM ( \
     SELECT 0 AS sort_order, 'table' AS kind, c.relname AS name, \
            pg_catalog.obj_description(c.oid, 'pg_class') AS detail \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') \
     UNION ALL \
     SELECT 1, 'view', c.relname, pg_catalog.obj_description(c.oid, 'pg_class') \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') \
     UNION ALL \
     SELECT 2, 'function', p.proname, \
            pg_catalog.pg_get_function_identity_arguments(p.oid) \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 \
     ) t ORDER BY t.sort_order, t.name";

/// Level 3: columns, indexes and keys of one table/view (one row each).
pub const RELATION_CHILDREN_QUERY: &str = "SELECT t.kind, t.name, t.detail FROM ( \
     SELECT 0 AS sort_order, 'column' AS kind, a.attname AS name, \
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS detail \
     FROM pg_catalog.pg_attribute a \
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 \
       AND a.attnum > 0 AND NOT a.attisdropped \
     UNION ALL \
     SELECT 1, 'index', i.relname, pg_catalog.pg_get_indexdef(ix.indexrelid) \
     FROM pg_catalog.pg_index ix \
     JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid \
     JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 \
     UNION ALL \
     SELECT 2, 'key', con.conname, pg_catalog.pg_get_constraintdef(con.oid) \
     FROM pg_catalog.pg_constraint con \
     JOIN pg_catalog.pg_class c ON c.oid = con.conrelid \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IN ('p', 'f', 'u') \
     ) t ORDER BY t.sort_order, t.name";

/// One resolved level of the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemaLevel {
    /// The connected database (root).
    Root,
    /// Schemas of the connected database.
    Schemas,
    /// Tables / views / functions of `schema`.
    SchemaObjects { schema: String },
    /// Columns / indexes / keys of one relation.
    RelationChildren {
        schema: String,
        relation: String,
        kind: DbObjectKind,
    },
}

/// One raw `(kind, name, detail)` catalog row before it becomes a typed node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogRow {
    pub kind: String,
    pub name: String,
    pub detail: Option<String>,
}

/// Stable path key of the root database node.
pub fn database_id() -> String {
    "db".to_string()
}

/// Stable path key of a schema node (`db/<schema>`).
pub fn schema_id(schema: &str) -> String {
    format!("db/{schema}")
}

/// Stable path key of a table/view node (`db/<schema>/t|v/<name>`).
pub fn relation_id(schema: &str, kind: DbObjectKind, name: &str) -> String {
    let marker = if kind == DbObjectKind::View { 'v' } else { 't' };
    format!("db/{schema}/{marker}/{name}")
}

/// Stable path key of a function node — the identity-args make overloaded
/// functions distinct (`db/<schema>/f/<name>(<args>)`).
pub fn function_id(schema: &str, name: &str, identity_args: &str) -> String {
    format!("db/{schema}/f/{name}({identity_args})")
}

/// Stable path key of a relation child (`db/<schema>/t|v/<rel>/c|i|k/<name>`).
pub fn child_id(schema: &str, rel_marker: char, relation: &str, child_marker: char, name: &str) -> String {
    format!("db/{schema}/{rel_marker}/{relation}/{child_marker}/{name}")
}

/// Resolve a `parent_id` path key to its level (R-2.1/R-2.2). `None`/blank is
/// the root. An unknown/leaf path is a typed error — the UI never expands a
/// leaf, so this is defensive.
pub fn parse_parent(parent_id: Option<&str>) -> Result<SchemaLevel, Vec<String>> {
    let Some(raw) = parent_id else {
        return Ok(SchemaLevel::Root);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(SchemaLevel::Root);
    }
    let segments: Vec<&str> = raw.split('/').collect();
    match segments.as_slice() {
        ["db"] => Ok(SchemaLevel::Schemas),
        ["db", schema] if !schema.is_empty() => Ok(SchemaLevel::SchemaObjects {
            schema: (*schema).to_string(),
        }),
        ["db", schema, "t", relation] if !schema.is_empty() && !relation.is_empty() => {
            Ok(SchemaLevel::RelationChildren {
                schema: (*schema).to_string(),
                relation: (*relation).to_string(),
                kind: DbObjectKind::Table,
            })
        }
        ["db", schema, "v", relation] if !schema.is_empty() && !relation.is_empty() => {
            Ok(SchemaLevel::RelationChildren {
                schema: (*schema).to_string(),
                relation: (*relation).to_string(),
                kind: DbObjectKind::View,
            })
        }
        _ => Err(vec![format!(
            "schema browse: unknown parent path '{raw}' (expected db, db/<schema>, or db/<schema>/t|v/<relation>)"
        )]),
    }
}

/// The read-only query for a level, paired with its bind count.
pub fn level_query(level: &SchemaLevel) -> (&'static str, usize) {
    match level {
        SchemaLevel::Root => (ROOT_QUERY, 0),
        SchemaLevel::Schemas => (SCHEMAS_QUERY, 0),
        SchemaLevel::SchemaObjects { .. } => (SCHEMA_OBJECTS_QUERY, 1),
        SchemaLevel::RelationChildren { .. } => (RELATION_CHILDREN_QUERY, 2),
    }
}

/// Root level — one `database` node (R-2.1).
pub fn root_nodes(database: &str, version: Option<String>) -> Vec<SchemaNode> {
    vec![SchemaNode {
        kind: DbObjectKind::Database,
        id: database_id(),
        name: database.to_string(),
        detail: version,
        has_children: true,
    }]
}

/// Schema level nodes (R-2.1).
pub fn schema_nodes(names: &[String]) -> Vec<SchemaNode> {
    names
        .iter()
        .map(|name| SchemaNode {
            kind: DbObjectKind::Schema,
            id: schema_id(name),
            name: name.clone(),
            detail: None,
            has_children: true,
        })
        .collect()
}

/// Table / view / function nodes of one schema (R-2.1). Functions are leaves
/// whose `detail` is the display signature (`name(args)`).
pub fn schema_object_nodes(schema: &str, rows: &[CatalogRow]) -> Vec<SchemaNode> {
    rows.iter()
        .filter_map(|row| {
            let kind = match row.kind.as_str() {
                "table" => DbObjectKind::Table,
                "view" => DbObjectKind::View,
                "function" => DbObjectKind::Function,
                _ => return None,
            };
            if kind == DbObjectKind::Function {
                let args = row.detail.clone().unwrap_or_default();
                let signature = format!("{}({args})", row.name);
                Some(SchemaNode {
                    kind,
                    id: function_id(schema, &row.name, &args),
                    name: row.name.clone(),
                    detail: Some(signature),
                    has_children: false,
                })
            } else {
                Some(SchemaNode {
                    kind,
                    id: relation_id(schema, kind, &row.name),
                    name: row.name.clone(),
                    detail: row.detail.clone(),
                    has_children: true,
                })
            }
        })
        .collect()
}

/// Column / index / key nodes of one relation (R-2.1/R-2.3). All leaves.
pub fn relation_child_nodes(
    schema: &str,
    relation: &str,
    parent_kind: DbObjectKind,
    rows: &[CatalogRow],
) -> Vec<SchemaNode> {
    let rel_marker = if parent_kind == DbObjectKind::View { 'v' } else { 't' };
    rows.iter()
        .filter_map(|row| {
            let (kind, marker) = match row.kind.as_str() {
                "column" => (DbObjectKind::Column, 'c'),
                "index" => (DbObjectKind::Index, 'i'),
                "key" => (DbObjectKind::Key, 'k'),
                _ => return None,
            };
            Some(SchemaNode {
                kind,
                id: child_id(schema, rel_marker, relation, marker, &row.name),
                name: row.name.clone(),
                detail: row.detail.clone(),
                has_children: false,
            })
        })
        .collect()
}

/// True when `sql` is a single read-only catalog `SELECT` (no DML/DDL).
/// Used by the tests to pin the plan's read-only invariant.
pub fn is_read_only_catalog_query(sql: &str) -> bool {
    let normalized = sql.trim_start().to_ascii_uppercase();
    if !normalized.starts_with("SELECT ") {
        return false;
    }
    const FORBIDDEN: [&str; 10] = [
        " INSERT ", " UPDATE ", " DELETE ", " DROP ", " ALTER ", " CREATE ", " TRUNCATE ",
        " GRANT ", " REVOKE ", " MERGE ",
    ];
    !FORBIDDEN.iter().any(|token| normalized.contains(token))
}

fn db_error(error: sqlx::Error) -> String {
    error.to_string()
}

fn catalog_rows(rows: &[sqlx::postgres::PgRow]) -> Result<Vec<CatalogRow>, String> {
    rows.iter()
        .map(|row| {
            Ok(CatalogRow {
                kind: row.try_get("kind").map_err(db_error)?,
                name: row.try_get("name").map_err(db_error)?,
                detail: row.try_get("detail").map_err(db_error)?,
            })
        })
        .collect()
}

async fn run_level(pool: &PgPool, level: &SchemaLevel) -> Result<Vec<SchemaNode>, String> {
    match level {
        SchemaLevel::Root => {
            let row = sqlx::query(ROOT_QUERY)
                .fetch_one(pool)
                .await
                .map_err(db_error)?;
            let name: String = row.try_get("name").map_err(db_error)?;
            let detail: Option<String> = row.try_get("detail").map_err(db_error)?;
            Ok(root_nodes(&name, detail))
        }
        SchemaLevel::Schemas => {
            let rows = sqlx::query(SCHEMAS_QUERY)
                .fetch_all(pool)
                .await
                .map_err(db_error)?;
            let names = rows
                .iter()
                .map(|row| row.try_get::<String, _>("name").map_err(db_error))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(schema_nodes(&names))
        }
        SchemaLevel::SchemaObjects { schema } => {
            let rows = sqlx::query(SCHEMA_OBJECTS_QUERY)
                .bind(schema)
                .fetch_all(pool)
                .await
                .map_err(db_error)?;
            Ok(schema_object_nodes(schema, &catalog_rows(&rows)?))
        }
        SchemaLevel::RelationChildren {
            schema,
            relation,
            kind,
        } => {
            let rows = sqlx::query(RELATION_CHILDREN_QUERY)
                .bind(schema)
                .bind(relation)
                .fetch_all(pool)
                .await
                .map_err(db_error)?;
            Ok(relation_child_nodes(
                schema,
                relation,
                *kind,
                &catalog_rows(&rows)?,
            ))
        }
    }
}

/// Fetch one schema-tree level (R-2.1/R-2.2). Bounded, read-only, per-level.
pub async fn schema_list(
    args: DbSchemaListArgs,
    state: &DbClientState,
) -> Result<Vec<SchemaNode>, Vec<String>> {
    // G-275 induction: `FREDO_DBCLIENT_FORCE_FAIL=query` makes a schema fetch
    // fail so the UI's inline node error + retry (R-2.4) can be driven live.
    if matches!(state.force_fail(), Some(ForceFailStage::Query)) {
        return Err(vec![
            "schema browse failed: forced query failure (FREDO_DBCLIENT_FORCE_FAIL=query)"
                .to_string(),
        ]);
    }

    let level = parse_parent(args.parent_id.as_deref())?;

    let Some(pool) = state.pool(&args.connection_id).await else {
        return Err(vec![format!(
            "connection {} is not open; connect before browsing the schema",
            args.connection_id
        )]);
    };

    match tokio::time::timeout(SCHEMA_QUERY_TIMEOUT, run_level(&pool, &level)).await {
        Err(_) => Err(vec![format!(
            "schema browse timed out after {}s",
            SCHEMA_QUERY_TIMEOUT.as_secs()
        )]),
        Ok(Err(error)) => Err(vec![format!("schema browse failed: {error}")]),
        Ok(Ok(nodes)) => Ok(nodes),
    }
}
