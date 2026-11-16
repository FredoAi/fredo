//! ST-2 credential-store tests (Spec #2950).
//!
//! The trait contract is pinned against [`MemoryCredentialStore`] so the suite
//! is deterministic and never depends on the host credential store (G-222). A
//! Windows-only round-trip additionally proves the production
//! [`KeyringCredentialStore`] wiring against the real OS keychain.

use super::credentials::{CredentialStore, KeyringCredentialStore, MemoryCredentialStore};
use crate::applications::db_client::types::{keyring_account, DBCLIENT_KEYRING_SERVICE};

#[test]
fn keyring_service_and_account_match_the_frozen_contract() {
    assert_eq!(DBCLIENT_KEYRING_SERVICE, "fredo.dbclient");
    assert_eq!(keyring_account("abc"), "connection:abc:password");
}

#[test]
fn memory_store_round_trips_and_distinguishes_missing_from_present() {
    let store = MemoryCredentialStore::new();
    assert!(!store.has_password("c1").unwrap());
    assert_eq!(store.get_password("c1").unwrap(), None);

    store.set_password("c1", "s3cr3t").unwrap();
    assert!(store.has_password("c1").unwrap());
    assert_eq!(store.get_password("c1").unwrap().as_deref(), Some("s3cr3t"));

    // Replace.
    store.set_password("c1", "next").unwrap();
    assert_eq!(store.get_password("c1").unwrap().as_deref(), Some("next"));

    // Per-connection isolation.
    store.set_password("c2", "other").unwrap();
    assert_eq!(store.get_password("c1").unwrap().as_deref(), Some("next"));
    assert_eq!(store.get_password("c2").unwrap().as_deref(), Some("other"));

    // Delete is idempotent.
    store.delete_password("c1").unwrap();
    assert!(!store.has_password("c1").unwrap());
    assert_eq!(store.get_password("c1").unwrap(), None);
    store.delete_password("c1").unwrap();
}

#[cfg(windows)]
#[test]
fn keyring_store_round_trips_a_secret_on_windows() {
    let store = KeyringCredentialStore;
    let id = format!("test-{}", uuid::Uuid::new_v4());
    store.set_password(&id, "sentinel-value").expect("store secret");
    assert_eq!(
        store.get_password(&id).unwrap().as_deref(),
        Some("sentinel-value")
    );
    assert!(store.has_password(&id).unwrap());
    store.delete_password(&id).expect("delete secret");
    assert!(!store.has_password(&id).unwrap());
}
