//! `db_*` Tauri command wrappers (Spec #2950, ST-1).
//!
//! All nine commands are registered exactly once in `lib.rs`'s
//! `tauri::generate_handler![…]` (additive to the existing entries). Each
//! wrapper takes a single `args` struct (the repo wire convention) and
//! delegates to the owning module — ST-1 registers typed stubs, ST-2/ST-3/ST-4
//! fill the bodies without changing these signatures (G-255).
//!
//! Errors are the HARD named `Vec<String>` shape and are never swallowed.

use std::sync::Arc;

use tauri::State;

use super::state::DbClientState;
use super::types::{
    DbConnectArgs, DbConnectionDeleteArgs, DbConnectionSaveArgs, DbConnectionTestArgs,
    DbConnectionView, DbQueryArgs, DbQueryOutcome, DbResultPageArgs, DbResultSet, DbSchemaListArgs,
    DbSessionInfo, DbTestResult, SchemaNode,
};
use super::{connect, query, schema};

/// List saved connections (R-1.5).
#[tauri::command]
pub async fn db_connection_list(
    state: State<'_, Arc<DbClientState>>,
) -> Result<Vec<DbConnectionView>, Vec<String>> {
    connect::connection_list(state.inner()).await
}

/// Test connection parameters before saving (R-1.3).
#[tauri::command]
pub async fn db_connection_test(
    args: DbConnectionTestArgs,
) -> Result<DbTestResult, Vec<String>> {
    connect::connection_test(args).await
}

/// Create or edit a saved connection (R-1.5/R-1.6).
#[tauri::command]
pub async fn db_connection_save(
    args: DbConnectionSaveArgs,
    state: State<'_, Arc<DbClientState>>,
) -> Result<DbConnectionView, Vec<String>> {
    connect::connection_save(args, state.inner()).await
}

/// Delete a connection and all four of its stores (R-1.7).
#[tauri::command]
pub async fn db_connection_delete(
    args: DbConnectionDeleteArgs,
    state: State<'_, Arc<DbClientState>>,
) -> Result<(), Vec<String>> {
    connect::connection_delete(args, state.inner()).await
}

/// Open a bounded external session (R-1.3).
#[tauri::command]
pub async fn db_connect(
    args: DbConnectArgs,
    state: State<'_, Arc<DbClientState>>,
) -> Result<DbSessionInfo, Vec<String>> {
    connect::connect(args, state.inner()).await
}

/// Close a session (R-3.8).
#[tauri::command]
pub async fn db_disconnect(
    args: DbConnectArgs,
    state: State<'_, Arc<DbClientState>>,
) -> Result<(), Vec<String>> {
    connect::disconnect(args, state.inner()).await
}

/// Fetch one lazy schema-tree level (R-2.1/R-2.2).
#[tauri::command]
pub async fn db_schema_list(
    args: DbSchemaListArgs,
    state: State<'_, Arc<DbClientState>>,
) -> Result<Vec<SchemaNode>, Vec<String>> {
    schema::schema_list(args, state.inner()).await
}

/// Execute a query under the safety gates (R-3.6/R-5.2/R-5.3/R-5.4).
#[tauri::command]
pub async fn db_query_execute(
    args: DbQueryArgs,
    state: State<'_, Arc<DbClientState>>,
) -> Result<DbQueryOutcome, Vec<String>> {
    query::query_execute(args, state.inner()).await
}

/// Slice the next page from an executed result set (R-3.3).
#[tauri::command]
pub async fn db_result_page(
    args: DbResultPageArgs,
    state: State<'_, Arc<DbClientState>>,
) -> Result<DbResultSet, Vec<String>> {
    query::result_page(args, state.inner()).await
}
