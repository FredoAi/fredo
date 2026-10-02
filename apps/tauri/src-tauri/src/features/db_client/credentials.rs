//! OS-keychain credential storage for the Postgres client (Spec #2950, ST-2).
//!
//! This is the **only** place a connection password is read or written. The
//! production store is the OS keychain (Windows Credential Manager / macOS
//! Keychain / Linux Secret Service) via the `keyring` crate, addressed by the
//! frozen contract — service [`DBCLIENT_KEYRING_SERVICE`], account
//! `connection:<connectionId>:password` ([`keyring_account`]).
//!
//! # Secrecy invariants (R-5.5 / R-1.5)
//!
//! * A password never enters `settingsService`/AppStore, tracing/telemetry, a
//!   CSV export, or a returned [`crate::features::db_client::types::DbConnectionView`]
//!   (the view carries `has_password` only).
//! * Every read/write goes through the [`CredentialStore`] seam so tests inject
//!   [`MemoryCredentialStore`] and never touch the real credential store; the
//!   production path is [`KeyringCredentialStore`].
//!
//! # Error shape
//!
//! Keychain failures are surfaced as `String` (the module never swallows a
//! store error) and are mapped by the caller into the db-client error surface.
//! A **missing** entry is not an error — it is `Ok(None)` / `false`, so the
//! "no secret yet" state is distinguishable from "the store is unavailable".

use std::collections::HashMap;
use std::sync::Mutex;

use keyring::Entry;

use crate::features::db_client::types::{keyring_account, DBCLIENT_KEYRING_SERVICE};

/// The credential seam every db-client secret read/write goes through.
pub trait CredentialStore: Send + Sync {
    /// Store (or replace) the secret for `connection_id`.
    fn set_password(&self, connection_id: &str, password: &str) -> Result<(), String>;
    /// Read the secret for `connection_id`; `Ok(None)` when none is stored.
    fn get_password(&self, connection_id: &str) -> Result<Option<String>, String>;
    /// Remove the secret for `connection_id`; a missing entry is `Ok(())`.
    fn delete_password(&self, connection_id: &str) -> Result<(), String>;
    /// Whether a secret is stored for `connection_id`.
    fn has_password(&self, connection_id: &str) -> Result<bool, String>;
}

/// The OS-keychain-backed store (production).
#[derive(Clone, Copy, Debug, Default)]
pub struct KeyringCredentialStore;

/// Build the keychain entry for `connection_id` under the contract service.
pub fn keyring_entry(connection_id: &str) -> Result<Entry, String> {
    Entry::new(DBCLIENT_KEYRING_SERVICE, &keyring_account(connection_id))
        .map_err(|e| format!("credential store unavailable: {e}"))
}

impl CredentialStore for KeyringCredentialStore {
    fn set_password(&self, connection_id: &str, password: &str) -> Result<(), String> {
        keyring_entry(connection_id)?
            .set_password(password)
            .map_err(|e| format!("failed to store credential: {e}"))
    }

    fn get_password(&self, connection_id: &str) -> Result<Option<String>, String> {
        match keyring_entry(connection_id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("failed to read credential: {e}")),
        }
    }

    fn delete_password(&self, connection_id: &str) -> Result<(), String> {
        match keyring_entry(connection_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("failed to remove credential: {e}")),
        }
    }

    fn has_password(&self, connection_id: &str) -> Result<bool, String> {
        Ok(self.get_password(connection_id)?.is_some())
    }
}

/// In-memory credential store for deterministic tests (never the OS keychain).
#[derive(Debug, Default)]
pub struct MemoryCredentialStore {
    secrets: Mutex<HashMap<String, String>>,
}

impl MemoryCredentialStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn set_password(&self, connection_id: &str, password: &str) -> Result<(), String> {
        let mut secrets = self.secrets.lock().map_err(|e| e.to_string())?;
        secrets.insert(connection_id.to_string(), password.to_string());
        Ok(())
    }

    fn get_password(&self, connection_id: &str) -> Result<Option<String>, String> {
        let secrets = self.secrets.lock().map_err(|e| e.to_string())?;
        Ok(secrets.get(connection_id).cloned())
    }

    fn delete_password(&self, connection_id: &str) -> Result<(), String> {
        let mut secrets = self.secrets.lock().map_err(|e| e.to_string())?;
        secrets.remove(connection_id);
        Ok(())
    }

    fn has_password(&self, connection_id: &str) -> Result<bool, String> {
        let secrets = self.secrets.lock().map_err(|e| e.to_string())?;
        Ok(secrets.contains_key(connection_id))
    }
}
