//! Query execution + bounded result-set cache (Spec #2950).
//!
//! **ST-1 placeholder.** ST-4 fills these bodies (`sqlparser` classification +
//! splitting, read-only/destructive gating, single-statement default, bounded
//! result cache + pagination, typed errors with position — R-3.3/R-3.4/R-3.5/
//! R-3.6/R-3.8/R-5.2/R-5.3/R-5.4). ST-1 freezes the signatures and returns the
//! typed `NotImplemented` error.
//!
//! Non-goals for ST-1: no statement is classified or executed here.

use super::not_implemented;
use super::state::DbClientState;
use super::types::{DbQueryArgs, DbQueryOutcome, DbResultPageArgs, DbResultSet};

/// Execute one statement / an explicit "Run all" (R-3.2/R-3.6/R-5.4). ST-4.
pub async fn query_execute(
    _args: DbQueryArgs,
    _state: &DbClientState,
) -> Result<DbQueryOutcome, Vec<String>> {
    Err(not_implemented("query::query_execute"))
}

/// Slice the next page from a cached result set (R-3.3). ST-4.
pub async fn result_page(
    _args: DbResultPageArgs,
    _state: &DbClientState,
) -> Result<DbResultSet, Vec<String>> {
    Err(not_implemented("query::result_page"))
}
