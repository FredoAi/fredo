//! ST-3 schema-browse tests (Spec #2950).
//!
//! Pins the pure, DB-free contract of `db_schema_list`:
//!
//! * the `parent_id` path grammar (lazy per-level dispatch, R-2.1/R-2.2);
//! * the stable typed node ids/kinds/details for every level (R-2.1/R-2.3);
//! * the read-only invariant — every level query is one `SELECT` over
//!   `pg_catalog`, never a DML/DDL statement and never a full-schema preload;
//! * the G-275 forced-failure seam for the inline node error (R-2.4) and the
//!   "not open" error when no pool is registered.
//!
//! No live PostgreSQL is needed here — the async `schema_list` error paths and
//! the pure mapping/query helpers are exercised directly (the live browse is the
//! tester's QA-2 receipt).

use std::path::PathBuf;

use super::super::seam::ForceFailStage;
use super::super::state::DbClientState;
use super::super::types::{DbObjectKind, DbSchemaListArgs, SchemaNode};
use super::{
    child_id, database_id, function_id, is_read_only_catalog_query, level_query, parse_parent,
    relation_child_nodes, relation_id, root_nodes, schema_id, schema_list, schema_object_nodes,
    schema_nodes, CatalogRow, SchemaLevel, RELATION_CHILDREN_QUERY, ROOT_QUERY,
    SCHEMA_OBJECTS_QUERY, SCHEMAS_QUERY,
};

fn catalog_row(kind: &str, name: &str, detail: Option<&str>) -> CatalogRow {
    CatalogRow {
        kind: kind.to_string(),
        name: name.to_string(),
        detail: detail.map(str::to_string),
    }
}

fn node_kinds(nodes: &[SchemaNode]) -> Vec<DbObjectKind> {
    nodes.iter().map(|node| node.kind).collect()
}

// ── Path grammar (R-2.1/R-2.2) ────────────────────────────────────────────────

#[test]
fn parse_parent_resolves_every_level() {
    assert_eq!(parse_parent(None).unwrap(), SchemaLevel::Root);
    assert_eq!(parse_parent(Some("")).unwrap(), SchemaLevel::Root);
    assert_eq!(parse_parent(Some("db")).unwrap(), SchemaLevel::Schemas);
    assert_eq!(
        parse_parent(Some("db/public")).unwrap(),
        SchemaLevel::SchemaObjects {
            schema: "public".to_string()
        }
    );
    assert_eq!(
        parse_parent(Some("db/public/t/users")).unwrap(),
        SchemaLevel::RelationChildren {
            schema: "public".to_string(),
            relation: "users".to_string(),
            kind: DbObjectKind::Table,
        }
    );
    assert_eq!(
        parse_parent(Some("db/public/v/active_users")).unwrap(),
        SchemaLevel::RelationChildren {
            schema: "public".to_string(),
            relation: "active_users".to_string(),
            kind: DbObjectKind::View,
        }
    );
}

#[test]
fn parse_parent_rejects_unknown_and_leaf_paths() {
    for bad in [
        "public",
        "db/public/t/users/c/id",
        "db/public/f/now",
        "db//t/x",
        "db/public/x/y",
    ] {
        let error = parse_parent(Some(bad)).expect_err("unknown path must be rejected");
        assert!(
            error.iter().any(|message| message.contains("unknown parent path")),
            "unexpected error for {bad}: {error:?}"
        );
    }
}

#[test]
fn path_ids_are_stable_and_typed() {
    assert_eq!(database_id(), "db");
    assert_eq!(schema_id("public"), "db/public");
    assert_eq!(relation_id("public", DbObjectKind::Table, "users"), "db/public/t/users");
    assert_eq!(relation_id("public", DbObjectKind::View, "v1"), "db/public/v/v1");
    assert_eq!(
        function_id("public", "f", "integer, text"),
        "db/public/f/f(integer, text)"
    );
    assert_eq!(
        child_id("public", 't', "users", 'c', "id"),
        "db/public/t/users/c/id"
    );
    assert_eq!(
        child_id("public", 'v', "v1", 'i', "v1_pkey"),
        "db/public/v/v1/i/v1_pkey"
    );
}

// ── Typed node mapping (R-2.1/R-2.3) ─────────────────────────────────────────

#[test]
fn root_level_is_one_expandable_database_node() {
    let nodes = root_nodes("fredo", Some("16.3".to_string()));
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].kind, DbObjectKind::Database);
    assert_eq!(nodes[0].id, "db");
    assert_eq!(nodes[0].name, "fredo");
    assert_eq!(nodes[0].detail.as_deref(), Some("16.3"));
    assert!(nodes[0].has_children);
}

#[test]
fn schema_level_nodes_are_expandable() {
    let names = vec!["public".to_string(), "qa_client".to_string()];
    let nodes = schema_nodes(&names);
    assert_eq!(node_kinds(&nodes), vec![DbObjectKind::Schema, DbObjectKind::Schema]);
    assert_eq!(nodes[0].id, "db/public");
    assert_eq!(nodes[1].id, "db/qa_client");
    assert!(nodes.iter().all(|node| node.has_children));
    assert!(nodes.iter().all(|node| node.detail.is_none()));
}

#[test]
fn schema_objects_map_tables_views_and_functions() {
    let rows = vec![
        catalog_row("table", "users", Some("app users")),
        catalog_row("view", "active_users", None),
        catalog_row("function", "now", Some("")),
        catalog_row("mystery", "ignored", None),
    ];
    let nodes = schema_object_nodes("public", &rows);
    assert_eq!(
        node_kinds(&nodes),
        vec![DbObjectKind::Table, DbObjectKind::View, DbObjectKind::Function]
    );
    assert_eq!(nodes[0].id, "db/public/t/users");
    assert_eq!(nodes[0].detail.as_deref(), Some("app users"));
    assert!(nodes[0].has_children);
    assert_eq!(nodes[1].id, "db/public/v/active_users");
    assert!(nodes[1].has_children);
    // Functions are leaves carrying the display signature (R-2.3).
    assert_eq!(nodes[2].id, "db/public/f/now()");
    assert_eq!(nodes[2].detail.as_deref(), Some("now()"));
    assert!(!nodes[2].has_children);
}

#[test]
fn function_ids_distinguish_overloaded_functions() {
    let rows = vec![
        catalog_row("function", "f", Some("integer")),
        catalog_row("function", "f", Some("text, integer")),
    ];
    let nodes = schema_object_nodes("public", &rows);
    assert_eq!(nodes[0].id, "db/public/f/f(integer)");
    assert_eq!(nodes[1].id, "db/public/f/f(text, integer)");
    assert_eq!(nodes[0].name, "f");
    assert_eq!(nodes[1].name, "f");
}

#[test]
fn relation_children_map_columns_indexes_and_keys() {
    let rows = vec![
        catalog_row("column", "id", Some("integer")),
        catalog_row("column", "email", Some("text")),
        catalog_row("index", "users_pkey", Some("CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)")),
        catalog_row("key", "users_pkey", Some("PRIMARY KEY (id)")),
        catalog_row("mystery", "ignored", None),
    ];
    let nodes = relation_child_nodes("public", "users", DbObjectKind::Table, &rows);
    assert_eq!(
        node_kinds(&nodes),
        vec![
            DbObjectKind::Column,
            DbObjectKind::Column,
            DbObjectKind::Index,
            DbObjectKind::Key
        ]
    );
    assert_eq!(nodes[0].id, "db/public/t/users/c/id");
    assert_eq!(nodes[0].detail.as_deref(), Some("integer"));
    assert_eq!(nodes[2].id, "db/public/t/users/i/users_pkey");
    assert!(nodes[2].detail.as_deref().unwrap().starts_with("CREATE UNIQUE INDEX"));
    assert_eq!(nodes[3].id, "db/public/t/users/k/users_pkey");
    assert!(nodes.iter().all(|node| !node.has_children));
}

#[test]
fn relation_children_use_the_view_marker_for_a_view_parent() {
    let rows = vec![catalog_row("column", "id", Some("integer"))];
    let nodes = relation_child_nodes("public", "v1", DbObjectKind::View, &rows);
    assert_eq!(nodes[0].id, "db/public/v/v1/c/id");
}

// ── Read-only + per-level invariant ──────────────────────────────────────────

#[test]
fn every_level_query_is_a_single_read_only_select() {
    for query in [ROOT_QUERY, SCHEMAS_QUERY, SCHEMA_OBJECTS_QUERY, RELATION_CHILDREN_QUERY] {
        assert!(
            is_read_only_catalog_query(query),
            "query is not a read-only SELECT: {query}"
        );
        // One statement only — never a `;`-separated batch.
        assert!(!query.trim_end().ends_with(';'));
    }
    // The catalog levels read pg_catalog; the root reads the session only.
    for query in [SCHEMAS_QUERY, SCHEMA_OBJECTS_QUERY, RELATION_CHILDREN_QUERY] {
        assert!(query.contains("pg_catalog."), "not a catalog query: {query}");
    }
    assert!(ROOT_QUERY.contains("current_database()"));
    assert!(!is_read_only_catalog_query("INSERT INTO t VALUES (1)"));
    assert!(!is_read_only_catalog_query("SELECT 1; DROP TABLE t"));
}

#[test]
fn level_query_binds_match_the_level() {
    assert_eq!(level_query(&SchemaLevel::Root), (ROOT_QUERY, 0));
    assert_eq!(level_query(&SchemaLevel::Schemas), (SCHEMAS_QUERY, 0));
    assert_eq!(
        level_query(&SchemaLevel::SchemaObjects {
            schema: "public".to_string()
        })
        .1,
        1
    );
    assert_eq!(
        level_query(&SchemaLevel::RelationChildren {
            schema: "public".to_string(),
            relation: "users".to_string(),
            kind: DbObjectKind::Table,
        })
        .1,
        2
    );
}

// ── Error paths (R-2.4 / G-275) ──────────────────────────────────────────────

fn idle_state() -> DbClientState {
    DbClientState::new(None, PathBuf::from("C:/tmp/dbclient"))
}

#[tokio::test]
async fn schema_list_requires_an_open_connection() {
    let state = idle_state();
    let args = DbSchemaListArgs {
        connection_id: "c1".to_string(),
        parent_id: None,
    };
    let error = schema_list(args, &state)
        .await
        .expect_err("no pool => typed error");
    assert!(error.iter().any(|message| message.contains("not open")), "{error:?}");
    assert!(error.iter().any(|message| message.contains("c1")), "{error:?}");
}

#[tokio::test]
async fn schema_list_honours_the_forced_query_seam() {
    let state = DbClientState::new(Some(ForceFailStage::Query), PathBuf::from("C:/tmp/dbclient"));
    let args = DbSchemaListArgs {
        connection_id: "c1".to_string(),
        parent_id: None,
    };
    let error = schema_list(args, &state)
        .await
        .expect_err("forced query failure");
    assert!(error.iter().any(|message| message.contains("forced")), "{error:?}");
}

#[tokio::test]
async fn non_query_force_stages_do_not_affect_schema_list() {
    // The connect/auth/timeout stages belong to ST-2; the schema level must fall
    // through to its own "not open" path instead of injecting a schema failure.
    let state = DbClientState::new(Some(ForceFailStage::Connect), PathBuf::from("C:/tmp/dbclient"));
    let args = DbSchemaListArgs {
        connection_id: "c1".to_string(),
        parent_id: None,
    };
    let error = schema_list(args, &state)
        .await
        .expect_err("no pool => typed error");
    assert!(error.iter().any(|message| message.contains("not open")), "{error:?}");
    assert!(!error.iter().any(|message| message.contains("forced")), "{error:?}");
}

#[tokio::test]
async fn unknown_parent_path_is_rejected_before_any_pool_lookup() {
    let state = idle_state();
    let args = DbSchemaListArgs {
        connection_id: "c1".to_string(),
        parent_id: Some("db/public/t/users/c/id".to_string()),
    };
    let error = schema_list(args, &state)
        .await
        .expect_err("leaf path must be rejected");
    assert!(
        error.iter().any(|message| message.contains("unknown parent path")),
        "{error:?}"
    );
}
