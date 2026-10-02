//! Connection management + session lifecycle (Spec #2950).
//!
//! **ST-1 placeholder.** ST-2 fills these bodies (bounded probe with typed
//! failures R-1.3/R-1.8, metadata persistence + keychain secret handling
//! R-1.5/R-1.6/R-1.7, read-only default + SSL mapping R-5.1/R-5.6). ST-1
//! freezes the signatures and returns the typed `NotImplemented` error so the
//! command wrappers can be registered and consumers can build (G-255).
//!
//! Non-goals for ST-1: no `sqlx` pool is opened and no credential is read or
//! written here.

use super::not_implemented;
use super::state::DbClientState;
use super::types::{
    DbConnectArgs, DbConnectionDeleteArgs, DbConnectionSaveArgs, DbConnectionTestArgs,
    DbConnectionView, DbSessionInfo, DbTestResult,
};

/// List saved connections (R-1.5). ST-2.
pub async fn connection_list(_state: &DbClientState) -> Result<Vec<DbConnectionView>, Vec<String>> {
    Err(not_implemented("connect::connection_list"))
}

/// Bounded test-before-save probe (R-1.3/R-1.4). ST-2.
pub async fn connection_test(_args: DbConnectionTestArgs) -> Result<DbTestResult, Vec<String>> {
    Err(not_implemented("connect::connection_test"))
}

/// Create or edit a saved connection (R-1.5/R-1.6). ST-2.
pub async fn connection_save(
    _args: DbConnectionSaveArgs,
    _state: &DbClientState,
) -> Result<DbConnectionView, Vec<String>> {
    Err(not_implemented("connect::connection_save"))
}

/// Delete a connection and all four of its stores (R-1.7). ST-2.
pub async fn connection_delete(
    _args: DbConnectionDeleteArgs,
    _state: &DbClientState,
) -> Result<(), Vec<String>> {
    Err(not_implemented("connect::connection_delete"))
}

/// Open a bounded external session (R-1.3). ST-2.
pub async fn connect(
    _args: DbConnectArgs,
    _state: &DbClientState,
) -> Result<DbSessionInfo, Vec<String>> {
    Err(not_implemented("connect::connect"))
}

/// Close a session and release its pool/result sets. ST-2.
pub async fn disconnect(_args: DbConnectArgs, _state: &DbClientState) -> Result<(), Vec<String>> {
    Err(not_implemented("connect::disconnect"))
}
