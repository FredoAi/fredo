//! Lazy per-level schema browse (Spec #2950).
//!
//! **ST-1 placeholder.** ST-3 fills this body (lazy `pg_catalog` browse with
//! typed nodes R-2.1/R-2.2, inspector detail R-2.3, inline node errors R-2.4).
//! ST-1 freezes the signature and returns the typed `NotImplemented` error.
//!
//! Non-goals for ST-1: no catalog SQL is issued here.

use super::not_implemented;
use super::state::DbClientState;
use super::types::{DbSchemaListArgs, SchemaNode};

/// Fetch one schema-tree level (R-2.1/R-2.2). ST-3.
pub async fn schema_list(
    _args: DbSchemaListArgs,
    _state: &DbClientState,
) -> Result<Vec<SchemaNode>, Vec<String>> {
    Err(not_implemented("schema::schema_list"))
}
