//! OS-keychain storage for the managed PostgreSQL loopback password
//! (Spec #3005, ST-7).
//!
//! This is the **only** place the loopback password is read or written. It
//! mirrors the frozen db-client precedent (`applications/db_client/credentials.rs`
//! and `types.rs`, Spec #2950) — a keychain-backed production store plus an
//! in-memory test seam — addressed by the binding contract
//! ([`PG_KEYRING_SERVICE`] = `fredo.postgres`, [`PG_KEYRING_ACCOUNT`] =
//! `loopback:password`).
//!
//! # Secrecy invariants (R-3.1/R-3.2)
//!
//! * The password never enters the synchronous settings cache, the PostgreSQL
//!   `settings` table, `boot-config.json`, tracing/telemetry, or a log. The
//!   [`PG_LOOPBACK_FALLBACK_PASSWORD`] fallback is warned about **WITHOUT** its
//!   value.
//! * Every read/write goes through the [`PgCredentialStore`] seam, so tests
//!   inject [`MemoryPgCredential`] and never touch the host credential store; the
//!   production path is [`KeyringPgCredentialStore`].
//!
//! # Induction seams (G-317 / QA F-3)
//!
//! * [`PG_PASSWORD_FILE_ENV`] (`FREDO_PG_PASSWORD_FILE`): when set (non-blank) to
//!   a readable file, its first non-blank line is used as the loopback password —
//!   the AC3 sentinel seed. The file value is used directly and is **never**
//!   persisted by this module.
//! * [`PG_KEYCHAIN_DISABLED_ENV`] (`FREDO_PG_KEYCHAIN_DISABLED`): when set to a
//!   non-blank value other than `0`/`false`, the keychain is treated as
//!   unavailable, forcing the documented fallback path. Both are inert when
//!   unset — the default path is the keychain.
//!
//! # Error shape
//!
//! Keychain failures are surfaced as `String` (the module never swallows a store
//! error). A **missing** entry is not an error — it is `Ok(None)`, so the "no
//! secret yet" state is distinguishable from "the store is unavailable".

use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::Mutex;

use keyring::Entry;

/// OS-keychain service name for the managed PostgreSQL loopback credential.
pub const PG_KEYRING_SERVICE: &str = "fredo.postgres";
/// OS-keychain account for the managed PostgreSQL loopback credential.
pub const PG_KEYRING_ACCOUNT: &str = "loopback:password";
/// The documented, loopback-only fallback used when the OS keychain is
/// unavailable. NEVER persisted and NEVER logged with its value (R-3.3).
pub const PG_LOOPBACK_FALLBACK_PASSWORD: &str = "fredo-loopback-fallback";

/// **AC3 induction seam (G-317):** when set (non-blank) to a readable file, the
/// file's first non-blank line seeds the loopback password (a synthetic sentinel
/// the tester scans for absence). Inert when unset.
pub const PG_PASSWORD_FILE_ENV: &str = "FREDO_PG_PASSWORD_FILE";
/// **AC3 fallback seam (G-317):** when set to a non-blank value other than
/// `0`/`false`, the OS keychain is treated as unavailable, forcing the
/// documented [`PG_LOOPBACK_FALLBACK_PASSWORD`] path. Inert when unset.
pub const PG_KEYCHAIN_DISABLED_ENV: &str = "FREDO_PG_KEYCHAIN_DISABLED";

/// The credential seam every managed-PostgreSQL secret read/write goes through.
pub trait PgCredentialStore: Send + Sync {
    /// Store (or replace) the loopback password.
    fn set_password(&self, password: &str) -> Result<(), String>;
    /// Read the loopback password; `Ok(None)` when none is stored.
    fn get_password(&self) -> Result<Option<String>, String>;
}

/// The OS-keychain-backed store (production).
///
/// The service/account are owned `String`s so a test can address a throwaway
/// keychain entry without ever clobbering the real `fredo.postgres` /
/// `loopback:password` credential (G-222).
#[derive(Clone, Debug)]
pub struct KeyringPgCredentialStore {
    service: String,
    account: String,
}

impl KeyringPgCredentialStore {
    /// The production store bound to [`PG_KEYRING_SERVICE`]/[`PG_KEYRING_ACCOUNT`].
    pub fn new() -> Self {
        Self::default()
    }

    /// A store bound to an explicit keychain address (test-only, so the suite
    /// never writes the real product credential).
    #[cfg(test)]
    fn for_account(service: &str, account: &str) -> Self {
        Self {
            service: service.to_string(),
            account: account.to_string(),
        }
    }

    fn entry(&self) -> Result<Entry, String> {
        Entry::new(&self.service, &self.account)
            .map_err(|e| format!("credential store unavailable: {e}"))
    }
}

impl Default for KeyringPgCredentialStore {
    fn default() -> Self {
        Self {
            service: PG_KEYRING_SERVICE.to_string(),
            account: PG_KEYRING_ACCOUNT.to_string(),
        }
    }
}

impl PgCredentialStore for KeyringPgCredentialStore {
    fn set_password(&self, password: &str) -> Result<(), String> {
        self.entry()?
            .set_password(password)
            .map_err(|e| format!("failed to store credential: {e}"))
    }

    fn get_password(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("failed to read credential: {e}")),
        }
    }
}

/// In-memory credential store for deterministic tests (mirrors
/// `db_client::credentials::MemoryCredentialStore`; never the OS keychain).
#[cfg(test)]
#[derive(Debug, Default)]
pub struct MemoryPgCredential {
    secret: Mutex<Option<String>>,
    fail_reads: AtomicBool,
    fail_writes: AtomicBool,
}

#[cfg(test)]
impl MemoryPgCredential {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a store already holding `password`.
    pub fn with_password(password: &str) -> Self {
        Self {
            secret: Mutex::new(Some(password.to_string())),
            ..Self::default()
        }
    }

    /// Make every subsequent [`PgCredentialStore::get_password`] fail (keychain
    /// read error).
    pub fn fail_reads(&self) {
        self.fail_reads.store(true, Ordering::SeqCst);
    }

    /// Make every subsequent [`PgCredentialStore::set_password`] fail (keychain
    /// write error).
    pub fn fail_writes(&self) {
        self.fail_writes.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
impl PgCredentialStore for MemoryPgCredential {
    fn set_password(&self, password: &str) -> Result<(), String> {
        if self.fail_writes.load(Ordering::SeqCst) {
            return Err("credential store unavailable (simulated write failure)".to_string());
        }
        *self.secret.lock().map_err(|e| e.to_string())? = Some(password.to_string());
        Ok(())
    }

    fn get_password(&self) -> Result<Option<String>, String> {
        if self.fail_reads.load(Ordering::SeqCst) {
            return Err("credential store unavailable (simulated read failure)".to_string());
        }
        Ok(self.secret.lock().map_err(|e| e.to_string())?.clone())
    }
}

/// Resolve the loopback password for a managed cluster, keychain-first, with the
/// documented fallback. The production entry point is [`PgCredential::resolve`].
pub struct PgCredential {
    backend: Arc<dyn PgCredentialStore>,
}

impl PgCredential {
    /// The production keychain-backed credential.
    pub fn keyring() -> Self {
        Self {
            backend: Arc::new(KeyringPgCredentialStore::new()),
        }
    }

    /// Build a credential over an arbitrary store (test seam).
    #[cfg(test)]
    pub fn with_store(store: Arc<dyn PgCredentialStore>) -> Self {
        Self { backend: store }
    }

    /// Store `password` in the backing keychain.
    pub fn store(&self, password: &str) -> Result<(), String> {
        self.backend.set_password(password)
    }

    /// Read the stored password from the backing keychain; `Ok(None)` when none.
    pub fn read(&self) -> Result<Option<String>, String> {
        self.backend.get_password()
    }

    /// Resolve the loopback password for this process:
    ///
    /// 1. the [`PG_PASSWORD_FILE_ENV`] sentinel seed (used directly, never stored);
    /// 2. the OS keychain (generate + store on first use, reuse thereafter);
    /// 3. the documented [`PG_LOOPBACK_FALLBACK_PASSWORD`] when the keychain is
    ///    unavailable or disabled — warned about WITHOUT its value.
    pub fn resolve(&self) -> String {
        let file = password_file_path();
        self.resolve_with(keychain_disabled(), file.as_deref())
    }

    /// The pure resolution rule (unit-testable without process-global env, G-222).
    fn resolve_with(&self, keychain_disabled: bool, password_file: Option<&Path>) -> String {
        if let Some(path) = password_file {
            if let Some(password) = read_password_file(path) {
                return password;
            }
            tracing::warn!(
                target: "fredo::pg_supervisor",
                path = %path.display(),
                "FREDO_PG_PASSWORD_FILE is set but unreadable or empty; falling back to the OS keychain"
            );
        }
        if keychain_disabled {
            return fallback_password("keychain-disabled");
        }
        match self.read() {
            Ok(Some(password)) if !password.is_empty() => password,
            Ok(_) => {
                let password = uuid::Uuid::new_v4().simple().to_string();
                match self.store(&password) {
                    Ok(()) => password,
                    Err(error) => fallback_password(&format!("store-error: {error}")),
                }
            }
            Err(error) => fallback_password(&format!("read-error: {error}")),
        }
    }
}

/// Return the documented fallback, warning WITHOUT its value (R-3.3). `reason`
/// never carries the secret — only the unavailable-keychain detail.
fn fallback_password(reason: &str) -> String {
    tracing::warn!(
        target: "fredo::pg_supervisor",
        reason,
        "OS keychain unavailable; using the documented loopback-only fallback password (value not logged)"
    );
    PG_LOOPBACK_FALLBACK_PASSWORD.to_string()
}

/// Read the [`PG_PASSWORD_FILE_ENV`] path (trimmed, non-blank only). Inert when
/// unset/blank.
fn password_file_path() -> Option<PathBuf> {
    password_file_path_with(std::env::var(PG_PASSWORD_FILE_ENV).ok().as_deref())
}

/// The pure password-file rule (unit-testable without process-global env, G-222).
fn password_file_path_with(value: Option<&str>) -> Option<PathBuf> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Read the first non-blank line of `path` as the seeded password; `None` when
/// the file is missing, unreadable, or has no non-blank line.
fn read_password_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(line.to_string())
}

/// Resolve the [`PG_KEYCHAIN_DISABLED_ENV`] lever: `true` when set to a
/// non-blank value other than `0`/`false`, else `false` (mirrors
/// `pg_supervisor::skip_server_knobs`). Inert by default.
pub fn keychain_disabled() -> bool {
    keychain_disabled_with(std::env::var(PG_KEYCHAIN_DISABLED_ENV).ok().as_deref())
}

/// The pure keychain-disabled rule (unit-testable without process-global env, G-222).
fn keychain_disabled_with(value: Option<&str>) -> bool {
    match value {
        Some(value) => {
            let raw = value.trim();
            !raw.is_empty() && !raw.eq_ignore_ascii_case("0") && !raw.eq_ignore_ascii_case("false")
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialises the env-mutating tests in this module (G-222).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// RAII: remove the two induction-seam env vars on drop, even on panic.
    struct SeamEnvGuard;

    impl Drop for SeamEnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(PG_PASSWORD_FILE_ENV);
            std::env::remove_var(PG_KEYCHAIN_DISABLED_ENV);
        }
    }

    #[test]
    fn binding_constants_match_the_frozen_contract() {
        assert_eq!(PG_KEYRING_SERVICE, "fredo.postgres");
        assert_eq!(PG_KEYRING_ACCOUNT, "loopback:password");
        assert_eq!(PG_LOOPBACK_FALLBACK_PASSWORD, "fredo-loopback-fallback");
    }

    #[test]
    fn keychain_disabled_rule_is_inert_by_default_and_reads_the_lever() {
        assert!(!keychain_disabled_with(None), "unset is inert");
        assert!(!keychain_disabled_with(Some("")), "blank is inert");
        assert!(!keychain_disabled_with(Some("   ")), "blank is inert");
        assert!(!keychain_disabled_with(Some("0")), "0 is inert");
        assert!(!keychain_disabled_with(Some("false")), "false is inert");
        assert!(!keychain_disabled_with(Some("FALSE")), "false is case-insensitive");
        assert!(keychain_disabled_with(Some("1")));
        assert!(keychain_disabled_with(Some("true")));
        assert!(keychain_disabled_with(Some("yes")));
    }

    #[test]
    fn password_file_path_rule_is_inert_by_default() {
        assert_eq!(password_file_path_with(None), None);
        assert_eq!(password_file_path_with(Some("")), None);
        assert_eq!(password_file_path_with(Some("   ")), None);
        assert_eq!(
            password_file_path_with(Some("  C:/tmp/pw.txt  ")),
            Some(PathBuf::from("C:/tmp/pw.txt"))
        );
    }

    #[test]
    fn memory_store_round_trips_and_distinguishes_missing_from_present() {
        let store = MemoryPgCredential::new();
        let credential = PgCredential::with_store(Arc::new(store));

        assert_eq!(credential.read().unwrap(), None, "a missing entry is Ok(None)");

        credential.store("s3cr3t").unwrap();
        assert_eq!(credential.read().unwrap().as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn resolve_generates_and_stores_a_fresh_secret_when_the_keychain_is_empty() {
        let credential =
            PgCredential::with_store(Arc::new(MemoryPgCredential::new()));

        let password = credential.resolve_with(false, None);

        assert!(!password.is_empty(), "a password is generated on first use");
        assert_ne!(password, PG_LOOPBACK_FALLBACK_PASSWORD, "not the fallback");
        assert_eq!(
            credential.read().unwrap().as_deref(),
            Some(password.as_str()),
            "the generated password is stored in the keychain"
        );
    }

    #[test]
    fn resolve_reuses_an_existing_keychain_secret_and_never_re_derives_it() {
        let credential =
            PgCredential::with_store(Arc::new(MemoryPgCredential::with_password("stored-secret")));

        assert_eq!(credential.resolve_with(false, None), "stored-secret");
    }

    #[test]
    fn resolve_falls_back_when_the_keychain_is_disabled() {
        let store = Arc::new(MemoryPgCredential::new());
        let credential = PgCredential::with_store(store);

        let password = credential.resolve_with(true, None);

        assert_eq!(password, PG_LOOPBACK_FALLBACK_PASSWORD);
        assert_eq!(
            credential.read().unwrap(),
            None,
            "the fallback is never persisted to the keychain"
        );
    }

    #[test]
    fn resolve_falls_back_on_a_keychain_read_error() {
        let store = MemoryPgCredential::new();
        store.fail_reads();
        let credential = PgCredential::with_store(Arc::new(store));

        assert_eq!(
            credential.resolve_with(false, None),
            PG_LOOPBACK_FALLBACK_PASSWORD
        );
    }

    #[test]
    fn resolve_falls_back_when_the_keychain_write_fails() {
        let store = Arc::new(MemoryPgCredential::new());
        store.fail_writes();
        let credential = PgCredential::with_store(store);

        assert_eq!(
            credential.resolve_with(false, None),
            PG_LOOPBACK_FALLBACK_PASSWORD
        );
    }

    #[test]
    fn resolve_reads_the_password_file_seam_and_never_stores_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pw.txt");
        std::fs::write(&path, "qa-3005-sentinel-abcd1234\n").expect("write sentinel");

        let credential =
            PgCredential::with_store(Arc::new(MemoryPgCredential::new()));
        let password = credential.resolve_with(false, Some(&path));

        assert_eq!(password, "qa-3005-sentinel-abcd1234");
        assert_eq!(
            credential.read().unwrap(),
            None,
            "the seeded sentinel is used directly and never persisted"
        );
    }

    #[test]
    fn resolve_prefers_the_password_file_over_the_keychain() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pw.txt");
        std::fs::write(&path, "sentinel\n").expect("write sentinel");

        let credential =
            PgCredential::with_store(Arc::new(MemoryPgCredential::with_password("keychain-secret")));
        assert_eq!(credential.resolve_with(false, Some(&path)), "sentinel");
        assert_eq!(
            credential.read().unwrap().as_deref(),
            Some("keychain-secret"),
            "the keychain entry is untouched by the file seam"
        );
    }

    #[test]
    fn resolve_ignores_an_empty_password_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pw.txt");
        std::fs::write(&path, "  \n\n").expect("write blank file");

        let credential =
            PgCredential::with_store(Arc::new(MemoryPgCredential::with_password("keychain-secret")));
        assert_eq!(
            credential.resolve_with(false, Some(&path)),
            "keychain-secret",
            "a blank file falls through to the keychain"
        );
    }

    #[test]
    fn resolve_is_driven_by_the_env_seams_end_to_end() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let credential =
            PgCredential::with_store(Arc::new(MemoryPgCredential::new()));

        // Disabled lever => the documented fallback.
        std::env::set_var(PG_KEYCHAIN_DISABLED_ENV, "1");
        let _guard = SeamEnvGuard;
        assert_eq!(credential.resolve(), PG_LOOPBACK_FALLBACK_PASSWORD);

        // Password-file lever wins over the disabled lever.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pw.txt");
        std::fs::write(&path, "qa-3005-sentinel-seam\n").expect("write sentinel");
        std::env::set_var(PG_PASSWORD_FILE_ENV, path.display().to_string());
        assert_eq!(credential.resolve(), "qa-3005-sentinel-seam");
    }

    #[cfg(windows)]
    #[test]
    fn production_keyring_store_round_trips_a_secret_on_windows() {
        // A throwaway keychain address so the suite never clobbers the real
        // `fredo.postgres`/`loopback:password` product credential.
        let store = KeyringPgCredentialStore::for_account(
            "fredo.postgres.tests",
            &format!("roundtrip-{}", uuid::Uuid::new_v4()),
        );
        store.set_password("sentinel-value").expect("store secret");
        assert_eq!(
            store.get_password().unwrap().as_deref(),
            Some("sentinel-value")
        );
        assert_eq!(
            store
                .entry()
                .expect("entry")
                .delete_credential()
                .map_err(|e| e.to_string()),
            Ok(())
        );
        assert_eq!(store.get_password().unwrap(), None);
    }
}
